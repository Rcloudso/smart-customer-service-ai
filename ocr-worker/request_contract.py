from __future__ import annotations

import json
from typing import Any


class RequestContractError(Exception):
    def __init__(self, status_code: int, detail: str) -> None:
        super().__init__(detail)
        self.status_code = status_code
        self.detail = detail


def is_authorized(worker_token: str, authorization: str | None) -> bool:
    return not worker_token or authorization == f"Bearer {worker_token}"


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
