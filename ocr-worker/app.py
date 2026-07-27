from __future__ import annotations

import base64
import hashlib
import json
import os
import tempfile
import threading
import time
from pathlib import Path
from typing import Any

from fastapi import FastAPI, Header, HTTPException, Request
from paddleocr import PPStructureV3

from contract_mapper import has_expected_signature, map_ppstructure_results

MAX_SOURCE_BYTES = 10 * 1024 * 1024
MAX_REQUEST_BYTES = 15 * 1024 * 1024
ALLOWED_MIME_TYPES = {
    "application/pdf": ".pdf",
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/webp": ".webp",
}
ENGINE_VERSION = os.getenv("OCR_ENGINE_VERSION", "3.0.0").strip()
WORKER_TOKEN = os.getenv("OCR_WORKER_TOKEN", "").strip()
DEVICE = os.getenv("PADDLE_DEVICE", "cpu").strip()

app = FastAPI(title="ResolveWeave PaddleOCR Worker", version=ENGINE_VERSION)
_pipeline: PPStructureV3 | None = None
_pipeline_lock = threading.Lock()


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
    if WORKER_TOKEN and authorization != f"Bearer {WORKER_TOKEN}":
        raise HTTPException(status_code=401, detail="Unauthorized")
    raw = await request.body()
    if len(raw) > MAX_REQUEST_BYTES:
        raise HTTPException(status_code=413, detail="Request is too large")
    try:
        payload = json.loads(raw)
        source = payload["source"]
        requested_engine = payload["requestedEngine"]
        mime_type = source["mimeType"]
        encoded = source["contentBase64"]
    except (KeyError, TypeError, json.JSONDecodeError):
        raise HTTPException(status_code=400, detail="Invalid extraction request")
    if (
        payload.get("contractVersion") != "ocr-worker-request-v1"
        or requested_engine.get("name") != "paddleocr_ppstructurev3"
        or requested_engine.get("version") != ENGINE_VERSION
        or mime_type not in ALLOWED_MIME_TYPES
    ):
        raise HTTPException(status_code=422, detail="Unsupported extraction contract")
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

    suffix = ALLOWED_MIME_TYPES[mime_type]
    temporary_path: Path | None = None
    started = time.perf_counter()
    try:
        with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as temporary:
            temporary.write(content)
            temporary_path = Path(temporary.name)
        page_results = [
            _result_payload(result)
            for result in _get_pipeline().predict(str(temporary_path))
        ]
        result = map_ppstructure_results(
            page_results,
            ENGINE_VERSION,
            (time.perf_counter() - started) * 1000,
        )
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
