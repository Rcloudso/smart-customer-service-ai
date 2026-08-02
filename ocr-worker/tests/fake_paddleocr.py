from __future__ import annotations

import os
import time
from typing import Any, Iterator


class PPStructureV3:
    def __init__(self, **_options: Any) -> None:
        pass

    def predict(self, _path: str) -> Iterator[dict[str, Any]]:
        time.sleep(float(os.getenv("OCR_RESTART_SMOKE_DELAY_SECONDS", "10")))
        yield {"res": {"page_index": 0, "parsing_res_list": []}}
