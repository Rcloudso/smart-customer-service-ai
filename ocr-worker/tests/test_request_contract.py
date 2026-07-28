from __future__ import annotations

import asyncio
import json
import unittest

from request_contract import (
    RequestContractError,
    is_authorized,
    parse_extraction_request,
    read_request_body_bounded,
)


class FakeRequest:
    def __init__(self, chunks: list[bytes], content_length: str | None = None) -> None:
        self._chunks = chunks
        self.headers = (
            {"content-length": content_length}
            if content_length is not None
            else {}
        )

    async def stream(self):
        for chunk in self._chunks:
            yield chunk


class RequestContractTest(unittest.TestCase):
    def test_authentication_is_fail_closed_when_configured(self) -> None:
        self.assertTrue(is_authorized("", None))
        self.assertFalse(is_authorized("secret", None))
        self.assertFalse(is_authorized("secret", "Bearer wrong"))
        self.assertTrue(is_authorized("secret", "Bearer secret"))

    def test_rejects_malformed_requested_engine_shape(self) -> None:
        payload = {
            "contractVersion": "ocr-worker-request-v1",
            "source": {
                "mimeType": "image/png",
                "contentBase64": "AA==",
            },
            "requestedEngine": "paddleocr_ppstructurev3",
        }
        with self.assertRaises(RequestContractError) as captured:
            parse_extraction_request(
                json.dumps(payload).encode(),
                "3.0.3",
                {"image/png"},
            )
        self.assertEqual(captured.exception.status_code, 400)

    def test_stream_and_content_length_limits_are_enforced(self) -> None:
        with self.assertRaises(RequestContractError) as declared:
            asyncio.run(read_request_body_bounded(
                FakeRequest([b"small"], content_length="11"),
                10,
            ))
        self.assertEqual(declared.exception.status_code, 413)

        with self.assertRaises(RequestContractError) as streamed:
            asyncio.run(read_request_body_bounded(
                FakeRequest([b"12345", b"678901"]),
                10,
            ))
        self.assertEqual(streamed.exception.status_code, 413)


if __name__ == "__main__":
    unittest.main()
