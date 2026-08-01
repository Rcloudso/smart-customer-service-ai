from __future__ import annotations

import base64
import asyncio
import hashlib
import json
import os
import tempfile
import threading
import time
from importlib.metadata import version as package_version
from pathlib import Path
from typing import Any
from concurrent.futures import ThreadPoolExecutor

from fastapi import FastAPI, Header, HTTPException, Request
from paddleocr import PPStructureV3

from contract_mapper import has_expected_signature, map_ppstructure_results
from request_contract import (
    RequestContractError,
    is_authorized,
    parse_extraction_request,
    read_request_body_bounded,
    schedule_forced_exit,
    validate_source_complexity,
)

MAX_SOURCE_BYTES = 10 * 1024 * 1024
MAX_REQUEST_BYTES = 15 * 1024 * 1024
MAX_PAGES = int(os.getenv("OCR_MAX_PAGES", "100"))
MAX_IMAGE_PIXELS = int(os.getenv("OCR_MAX_IMAGE_PIXELS", "40000000"))
MAX_IMAGE_DIMENSION = int(os.getenv("OCR_MAX_IMAGE_DIMENSION", "20000"))
MAX_RAW_RESULT_BYTES = int(os.getenv("OCR_MAX_RAW_RESULT_BYTES", str(16 * 1024 * 1024)))
MAX_RESULT_BYTES = int(os.getenv("OCR_MAX_RESULT_BYTES", str(8 * 1024 * 1024)))
PROCESSING_TIMEOUT_SECONDS = float(os.getenv("OCR_PROCESSING_TIMEOUT_SECONDS", "120"))
ALLOWED_MIME_TYPES = {
    "application/pdf": ".pdf",
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/webp": ".webp",
}
ENGINE_VERSION = package_version("paddleocr")
WORKER_TOKEN = os.getenv("OCR_WORKER_TOKEN", "").strip()
DEVICE = os.getenv("PADDLE_DEVICE", "cpu").strip()

if not WORKER_TOKEN:
    raise RuntimeError("OCR_WORKER_TOKEN is required")

app = FastAPI(title="ResolveWeave PaddleOCR Worker", version=ENGINE_VERSION)
_pipeline: PPStructureV3 | None = None
_pipeline_lock = threading.Lock()
_extraction_slot = threading.BoundedSemaphore(1)
_extraction_executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="ocr-extraction")


@app.get("/health")
def health() -> dict[str, Any]:
    return {
        "status": "ok",
        "engine": "paddleocr_ppstructurev3",
        "version": ENGINE_VERSION,
        "device": DEVICE,
    }


@app.post("/v1/extractions")
async def extract(
    request: Request,
    authorization: str | None = Header(default=None),
) -> dict[str, Any]:
    if not is_authorized(WORKER_TOKEN, authorization):
        raise HTTPException(status_code=401, detail="Unauthorized")
    try:
        raw = await read_request_body_bounded(request, MAX_REQUEST_BYTES)
        _, source, mime_type, encoded = parse_extraction_request(
            raw,
            ENGINE_VERSION,
            set(ALLOWED_MIME_TYPES),
        )
    except RequestContractError as error:
        raise HTTPException(status_code=error.status_code, detail=error.detail)
    try:
        content = base64.b64decode(encoded, validate=True)
    except (TypeError, ValueError):
        raise HTTPException(status_code=400, detail="Invalid source encoding")
    if not content or len(content) > MAX_SOURCE_BYTES:
        raise HTTPException(status_code=413, detail="Source is empty or too large")
    if hashlib.sha256(content).hexdigest() != source.get("sha256"):
        raise HTTPException(status_code=422, detail="Source hash mismatch")
    if not has_expected_signature(mime_type, content):
        raise HTTPException(status_code=422, detail="Source signature mismatch")
    try:
        validate_source_complexity(
            mime_type,
            content,
            MAX_PAGES,
            MAX_IMAGE_PIXELS,
            MAX_IMAGE_DIMENSION,
        )
    except RequestContractError as error:
        raise HTTPException(status_code=error.status_code, detail=error.detail)

    suffix = ALLOWED_MIME_TYPES[mime_type]
    temporary_path: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as temporary:
            temporary.write(content)
            temporary_path = Path(temporary.name)
        if not _extraction_slot.acquire(blocking=False):
            raise HTTPException(status_code=503, detail="OCR worker is busy")
        loop = asyncio.get_running_loop()
        try:
            future = loop.run_in_executor(
                _extraction_executor,
                _run_extraction,
                temporary_path,
            )
        except Exception:
            _extraction_slot.release()
            raise
        temporary_path = None
        future.add_done_callback(_release_extraction_slot)
        try:
            result = await asyncio.wait_for(
                asyncio.shield(future),
                timeout=PROCESSING_TIMEOUT_SECONDS,
            )
        except asyncio.TimeoutError:
            schedule_forced_exit(exit_code=70, delay_seconds=1.0)
            raise HTTPException(status_code=504, detail="OCR extraction timed out")
        return {"code": 0, "data": result, "message": "ok"}
    except HTTPException:
        raise
    except Exception:
        raise HTTPException(status_code=502, detail="OCR extraction failed")
    finally:
        if temporary_path is not None:
            temporary_path.unlink(missing_ok=True)


def _get_pipeline() -> PPStructureV3:
    global _pipeline
    if _pipeline is not None:
        return _pipeline
    with _pipeline_lock:
        if _pipeline is None:
            _pipeline = PPStructureV3(
                device=DEVICE,
                use_doc_orientation_classify=True,
                use_doc_unwarping=False,
                use_textline_orientation=True,
                use_table_recognition=True,
                use_formula_recognition=False,
                use_chart_recognition=False,
                use_seal_recognition=False,
            )
    return _pipeline


def _release_extraction_slot(future: asyncio.Future[Any]) -> None:
    _extraction_slot.release()
    if not future.cancelled():
        future.exception()


def _run_extraction(temporary_path: Path) -> dict[str, Any]:
    started = time.perf_counter()
    page_results: list[dict[str, Any]] = []
    raw_result_bytes = 0
    try:
        for provider_result in _get_pipeline().predict(str(temporary_path)):
            payload = _result_payload(provider_result)
            page_results.append(payload)
            if len(page_results) > MAX_PAGES:
                raise ValueError("OCR result exceeds page limit")
            raw_result_bytes += len(
                json.dumps(payload, ensure_ascii=False).encode("utf-8")
            )
            if raw_result_bytes > MAX_RAW_RESULT_BYTES:
                raise ValueError("OCR provider result exceeds size limit")
        result = map_ppstructure_results(
            page_results,
            ENGINE_VERSION,
            (time.perf_counter() - started) * 1000,
        )
        if len(json.dumps(result, ensure_ascii=False).encode("utf-8")) > MAX_RESULT_BYTES:
            raise ValueError("OCR response exceeds size limit")
        return result
    finally:
        temporary_path.unlink(missing_ok=True)


def _result_payload(result: Any) -> dict[str, Any]:
    value = getattr(result, "json", result)
    if callable(value):
        value = value()
    if isinstance(value, str):
        value = json.loads(value)
    if not isinstance(value, dict):
        raise ValueError("PaddleOCR result is not a mapping")
    nested = value.get("res")
    return nested if isinstance(nested, dict) else value
