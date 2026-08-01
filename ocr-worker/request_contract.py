from __future__ import annotations

import json
import hmac
import os
import re
import threading
from typing import Any


class RequestContractError(Exception):
    def __init__(self, status_code: int, detail: str) -> None:
        super().__init__(detail)
        self.status_code = status_code
        self.detail = detail


def schedule_forced_exit(exit_code: int, delay_seconds: float) -> None:
    """Exit after the timeout response has had a short window to flush."""
    timer = threading.Timer(delay_seconds, os._exit, args=(exit_code,))
    timer.daemon = True
    timer.start()


def is_authorized(worker_token: str, authorization: str | None) -> bool:
    if not worker_token or not authorization or not authorization.startswith("Bearer "):
        return False
    provided_token = authorization[len("Bearer "):]
    return hmac.compare_digest(worker_token.encode(), provided_token.encode())


def validate_source_complexity(
    mime_type: str,
    content: bytes,
    max_pages: int,
    max_pixels: int,
    max_dimension: int,
) -> None:
    if mime_type == "application/pdf":
        page_count = len(re.findall(rb"/Type\s*/Page\b", content))
        if page_count > max_pages:
            raise RequestContractError(413, "PDF exceeds page limit")
        return

    dimensions = _image_dimensions(mime_type, content)
    if dimensions is None:
        raise RequestContractError(422, "Unable to validate image dimensions")
    width, height = dimensions
    if (
        width <= 0
        or height <= 0
        or width > max_dimension
        or height > max_dimension
        or width * height > max_pixels
    ):
        raise RequestContractError(413, "Image dimensions exceed processing limits")


def _image_dimensions(mime_type: str, content: bytes) -> tuple[int, int] | None:
    if mime_type == "image/png" and len(content) >= 24:
        return int.from_bytes(content[16:20], "big"), int.from_bytes(content[20:24], "big")
    if mime_type == "image/jpeg":
        return _jpeg_dimensions(content)
    if mime_type == "image/webp":
        return _webp_dimensions(content)
    return None


def _jpeg_dimensions(content: bytes) -> tuple[int, int] | None:
    offset = 2
    start_of_frame = {
        0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7,
        0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF,
    }
    while offset + 8 < len(content):
        if content[offset] != 0xFF:
            offset += 1
            continue
        marker = content[offset + 1]
        if marker in start_of_frame:
            height = int.from_bytes(content[offset + 5:offset + 7], "big")
            width = int.from_bytes(content[offset + 7:offset + 9], "big")
            return width, height
        if marker in {0xD8, 0xD9}:
            offset += 2
            continue
        segment_length = int.from_bytes(content[offset + 2:offset + 4], "big")
        if segment_length < 2:
            return None
        offset += 2 + segment_length
    return None


def _webp_dimensions(content: bytes) -> tuple[int, int] | None:
    if len(content) < 30:
        return None
    chunk_type = content[12:16]
    if chunk_type == b"VP8X":
        width = 1 + int.from_bytes(content[24:27], "little")
        height = 1 + int.from_bytes(content[27:30], "little")
        return width, height
    if chunk_type == b"VP8L" and content[20] == 0x2F:
        bits = int.from_bytes(content[21:25], "little")
        return (bits & 0x3FFF) + 1, ((bits >> 14) & 0x3FFF) + 1
    if chunk_type == b"VP8 " and content[23:26] == b"\x9d\x01\x2a":
        width = int.from_bytes(content[26:28], "little") & 0x3FFF
        height = int.from_bytes(content[28:30], "little") & 0x3FFF
        return width, height
    return None


async def read_request_body_bounded(request: Any, max_bytes: int) -> bytes:
    content_length = request.headers.get("content-length")
    if content_length:
        try:
            if int(content_length) > max_bytes:
                raise RequestContractError(413, "Request is too large")
        except ValueError:
            raise RequestContractError(400, "Invalid content length")
    chunks: list[bytes] = []
    received = 0
    async for chunk in request.stream():
        received += len(chunk)
        if received > max_bytes:
            raise RequestContractError(413, "Request is too large")
        chunks.append(chunk)
    return b"".join(chunks)


def parse_extraction_request(
    raw: bytes,
    engine_version: str,
    allowed_mime_types: set[str],
) -> tuple[dict[str, Any], dict[str, Any], str, Any]:
    try:
        payload = json.loads(raw)
    except (TypeError, json.JSONDecodeError):
        raise RequestContractError(400, "Invalid extraction request")
    if not isinstance(payload, dict):
        raise RequestContractError(400, "Invalid extraction request")
    source = payload.get("source")
    requested_engine = payload.get("requestedEngine")
    if not isinstance(source, dict) or not isinstance(requested_engine, dict):
        raise RequestContractError(400, "Invalid extraction request")
    mime_type = source.get("mimeType")
    encoded = source.get("contentBase64")
    if (
        payload.get("contractVersion") != "ocr-worker-request-v1"
        or requested_engine.get("name") != "paddleocr_ppstructurev3"
        or requested_engine.get("version") != engine_version
        or mime_type not in allowed_mime_types
    ):
        raise RequestContractError(422, "Unsupported extraction contract")
    return payload, source, mime_type, encoded
