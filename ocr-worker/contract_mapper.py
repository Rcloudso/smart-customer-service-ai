from __future__ import annotations

import re
from html.parser import HTMLParser
from typing import Any


def has_expected_signature(mime_type: str, content: bytes) -> bool:
    if mime_type == "application/pdf":
        return content.startswith(b"%PDF-")
    if mime_type == "image/png":
        return content.startswith(b"\x89PNG\r\n\x1a\n")
    if mime_type == "image/jpeg":
        return content.startswith(b"\xff\xd8\xff")
    if mime_type == "image/webp":
        return (
            len(content) >= 12
            and content.startswith(b"RIFF")
            and content[8:12] == b"WEBP"
        )
    return False


def map_ppstructure_results(
    page_results: list[dict[str, Any]],
    engine_version: str,
    elapsed_ms: float,
) -> dict[str, Any]:
    blocks: list[dict[str, Any]] = []
    warnings: list[dict[str, Any]] = []
    for page_offset, page in enumerate(page_results):
        page_number = int(page.get("page_index", page_offset) or 0) + 1
        parsing = page.get("parsing_res_list")
        if not isinstance(parsing, list):
            parsing = []
        page_blocks = _map_parsing_blocks(parsing, page_number, len(blocks))
        if not page_blocks:
            page_blocks = _map_ocr_lines(page.get("overall_ocr_res"), page_number, len(blocks))
        if not page_blocks:
            warnings.append({
                "code": "ocr_empty_page",
                "detail": f"No text block was extracted from page {page_number}",
                "blockIds": [],
            })
        blocks.extend(page_blocks)

    for index, block in enumerate(blocks):
        block["id"] = f"block-{index + 1:06d}"
        block["order"] = index
        confidence = block.get("confidence")
        if isinstance(confidence, (int, float)) and confidence < 0.6:
            warnings.append({
                "code": "ocr_low_confidence",
                "detail": f"Block confidence is {confidence:.3f}",
                "blockIds": [block["id"]],
            })

    pages = {block["pageNumber"] for block in blocks}
    return {
        "contractVersion": "ocr-extraction-v1",
        "engine": {
            "name": "paddleocr_ppstructurev3",
            "version": engine_version,
        },
        "blocks": blocks,
        "warnings": warnings,
        "metrics": {
            "pageCount": len(pages),
            "blockCount": len(blocks),
            "elapsedMs": max(0.0, float(elapsed_ms)),
        },
    }


def _map_parsing_blocks(
    parsing: list[Any],
    page_number: int,
    start_index: int,
) -> list[dict[str, Any]]:
    blocks: list[dict[str, Any]] = []
    heading_path: list[str] = []
    for item in parsing:
        if not isinstance(item, dict):
            continue
        content = _clean_text(item.get("block_content"))
        label = str(item.get("sub_label") or item.get("block_label") or "text").lower()
        if not content and label not in {"image", "figure", "table", "table_text"}:
            continue
        common = _common_block(
            start_index + len(blocks),
            page_number,
            heading_path,
            item.get("block_bbox"),
            item.get("score"),
        )
        if label in {"title", "title_text", "heading", "doc_title"}:
            heading_path = [content]
            blocks.append({
                **common,
                "kind": "heading",
                "headingPath": list(heading_path),
                "level": 1,
                "text": content,
            })
        elif label in {"table", "table_text"}:
            rows = _table_rows(item)
            if rows:
                blocks.append({
                    **common,
                    "kind": "table",
                    "rowCount": len(rows),
                    "columnCount": max(len(row) for row in rows),
                    "cells": [
                        {
                            "rowIndex": row_index,
                            "columnIndex": column_index,
                            "rowSpan": 1,
                            "columnSpan": 1,
                            "text": value,
                            "isHeader": row_index == 0,
                        }
                        for row_index, row in enumerate(rows)
                        for column_index, value in enumerate(row)
                    ],
                })
            elif content:
                blocks.append({**common, "kind": "paragraph", "text": content})
        elif label in {"list", "list_item", "ordered_list", "unordered_list"}:
            items = [
                re.sub(r"^\s*(?:[-*•]|\d+[.)])\s*", "", line).strip()
                for line in content.splitlines()
                if line.strip()
            ]
            blocks.append({
                **common,
                "kind": "list",
                "ordered": label == "ordered_list",
                "items": [
                    {"ordinal": index, "text": value}
                    for index, value in enumerate(items)
                ],
            })
        elif label in {"key_value", "key-value"}:
            pairs = []
            for line in content.splitlines():
                key, separator, value = line.partition(":")
                if separator and key.strip():
                    pairs.append({"key": key.strip(), "value": value.strip()})
            blocks.append(
                {**common, "kind": "key_value", "pairs": pairs}
                if pairs
                else {**common, "kind": "paragraph", "text": content}
            )
        elif label in {"image", "figure"}:
            blocks.append({
                **common,
                "kind": "image_ref",
                "relationshipId": None,
                "contentType": None,
                "altText": content or None,
                "requiresVisualProcessing": True,
                "excluded": True,
                "exclusionReason": "visual_processing_required",
            })
        else:
            blocks.append({**common, "kind": "paragraph", "text": content})
    return blocks


def _map_ocr_lines(
    raw: Any,
    page_number: int,
    start_index: int,
) -> list[dict[str, Any]]:
    if not isinstance(raw, dict):
        return []
    texts = raw.get("rec_texts")
    scores = raw.get("rec_scores")
    boxes = raw.get("rec_boxes")
    if not isinstance(texts, list):
        return []
    blocks: list[dict[str, Any]] = []
    for index, value in enumerate(texts):
        text = _clean_text(value)
        if not text:
            continue
        score = scores[index] if isinstance(scores, list) and index < len(scores) else None
        box = boxes[index] if isinstance(boxes, list) and index < len(boxes) else None
        blocks.append({
            **_common_block(start_index + len(blocks), page_number, [], box, score),
            "kind": "paragraph",
            "text": text,
        })
    return blocks


def _common_block(
    index: int,
    page_number: int,
    heading_path: list[str],
    raw_box: Any,
    raw_confidence: Any,
) -> dict[str, Any]:
    confidence = (
        max(0.0, min(1.0, float(raw_confidence)))
        if isinstance(raw_confidence, (int, float))
        else None
    )
    return {
        "id": f"block-{index + 1:06d}",
        "order": index,
        "pageNumber": page_number,
        "headingPath": list(heading_path),
        "confidence": confidence,
        "layout": _layout(raw_box),
        "excluded": False,
        "exclusionReason": None,
    }


def _layout(raw_box: Any) -> dict[str, float] | None:
    if not isinstance(raw_box, list) or not raw_box:
        return None
    if len(raw_box) == 4 and all(isinstance(value, (int, float)) for value in raw_box):
        x1, y1, x2, y2 = [float(value) for value in raw_box]
    else:
        points = [
            point for point in raw_box
            if isinstance(point, list)
            and len(point) >= 2
            and all(isinstance(value, (int, float)) for value in point[:2])
        ]
        if not points:
            return None
        x_values = [float(point[0]) for point in points]
        y_values = [float(point[1]) for point in points]
        x1, y1, x2, y2 = min(x_values), min(y_values), max(x_values), max(y_values)
    return {
        "x": max(0.0, x1),
        "y": max(0.0, y1),
        "width": max(0.0, x2 - x1),
        "height": max(0.0, y2 - y1),
    }


def _table_rows(item: dict[str, Any]) -> list[list[str]]:
    direct_rows = item.get("rows")
    if isinstance(direct_rows, list):
        rows = [
            [_clean_text(cell) for cell in row]
            for row in direct_rows
            if isinstance(row, list)
        ]
        return [row for row in rows if any(row)]
    html = item.get("pred_html")
    if not isinstance(html, str):
        table_result = item.get("table_res")
        html = table_result.get("pred_html") if isinstance(table_result, dict) else None
    if not isinstance(html, str):
        return []
    parser = _TableParser()
    parser.feed(html)
    return [row for row in parser.rows if any(row)]


def _clean_text(value: Any) -> str:
    return re.sub(r"\s+", " ", str(value or "")).strip()


class _TableParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.rows: list[list[str]] = []
        self._row: list[str] | None = None
        self._cell: list[str] | None = None

    def handle_starttag(self, tag: str, _attrs: list[tuple[str, str | None]]) -> None:
        if tag == "tr":
            self._row = []
        elif tag in {"td", "th"} and self._row is not None:
            self._cell = []

    def handle_data(self, data: str) -> None:
        if self._cell is not None:
            self._cell.append(data)

    def handle_endtag(self, tag: str) -> None:
        if tag in {"td", "th"} and self._row is not None and self._cell is not None:
            self._row.append(_clean_text("".join(self._cell)))
            self._cell = None
        elif tag == "tr" and self._row is not None:
            self.rows.append(self._row)
            self._row = None
