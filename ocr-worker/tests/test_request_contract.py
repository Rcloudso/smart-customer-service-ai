from __future__ import annotations

import asyncio
import json
import os
import subprocess
import sys
import unittest
from unittest.mock import patch

from request_contract import (
    RequestContractError,
    is_authorized,
    parse_extraction_request,
    read_request_body_bounded,
    schedule_forced_exit,
    validate_source_complexity,
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
    def test_authentication_is_always_fail_closed(self) -> None:
        self.assertFalse(is_authorized("", None))
        self.assertFalse(is_authorized("", "Bearer anything"))
        self.assertFalse(is_authorized("secret", None))
        self.assertFalse(is_authorized("secret", "Bearer wrong"))
        self.assertTrue(is_authorized("secret", "Bearer secret"))

    @patch("request_contract.threading.Timer")
    def test_timeout_schedules_a_forced_worker_exit(self, timer_factory) -> None:
        timer = timer_factory.return_value

        schedule_forced_exit(exit_code=70, delay_seconds=0.5)

        timer_factory.assert_called_once_with(0.5, os._exit, args=(70,))
        self.assertTrue(timer.daemon)
        timer.start.assert_called_once_with()

    def test_forced_exit_terminates_the_worker_process(self) -> None:
        completed = subprocess.run(
            [
                sys.executable,
                "-c",
                (
                    "import time; "
                    "from request_contract import schedule_forced_exit; "
                    "schedule_forced_exit(70, 0.01); "
                    "time.sleep(1)"
                ),
            ],
            check=False,
        )

        self.assertEqual(completed.returncode, 70)

    def test_rejects_oversized_image_dimensions(self) -> None:
        png = (
            b"\x89PNG\r\n\x1a\n"
            + b"\x00\x00\x00\x0dIHDR"
            + (100_000).to_bytes(4, "big")
            + (100_000).to_bytes(4, "big")
            + b"\x08\x02\x00\x00\x00"
        )
        with self.assertRaises(RequestContractError) as captured:
            validate_source_complexity("image/png", png, 100, 40_000_000, 20_000)
        self.assertEqual(captured.exception.status_code, 413)

    def test_rejects_pdf_page_bombs(self) -> None:
        pdf = b"%PDF-1.7\n" + b"/Type /Page\n" * 101
        with self.assertRaises(RequestContractError) as captured:
            validate_source_complexity("application/pdf", pdf, 100, 40_000_000, 20_000)
        self.assertEqual(captured.exception.status_code, 413)

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
