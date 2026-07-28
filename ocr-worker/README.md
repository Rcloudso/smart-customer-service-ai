# ResolveWeave PaddleOCR Worker

This optional service adapts PaddleOCR PP-StructureV3 to ResolveWeave's bounded
`ocr-worker-request-v1` / `ocr-extraction-v1` contract. Paddle output remains a
review draft until an administrator publishes the complete document.

## Local CPU

Use Python 3.10, then install PaddlePaddle from the official CPU index and the
worker dependencies:

```bash
python -m venv .venv
source .venv/bin/activate
python -m pip install paddlepaddle==3.0.0 \
  --index-url https://www.paddlepaddle.org.cn/packages/stable/cpu/
python -m pip install -r requirements.txt
PADDLE_DEVICE=cpu \
  uvicorn app:app --host 127.0.0.1 --port 8001
```

The worker reports the installed `paddleocr` package version (`3.0.3` in the
pinned requirements) as its extraction engine version. Configure the Node
application with `OCR_SERVICE_URL=http://127.0.0.1:8001` and the matching
`OCR_ENGINE_VERSION=3.0.3`.
Set the same optional secret in `OCR_WORKER_TOKEN` and `OCR_SERVICE_TOKEN`.
`paddlex` is pinned to `3.0.3` as well because newer PaddleX releases are not
runtime-compatible with PaddleOCR `3.0.3` pipeline initialization.

## Docker Compose

From the repository root:

```bash
OCR_SERVICE_URL=http://ocr-worker:8001 \
  docker compose --profile ocr up --build
```

The first start downloads the PP-StructureV3 models. Keep model caches and
uploaded source files on trusted local storage; do not expose the worker
directly to the public internet.

## Contract Test

The mapper test does not load Paddle models:

```bash
cd ocr-worker
python -m unittest discover -s tests
```

The worker follows PaddleOCR's official PP-StructureV3 `predict()` integration
and maps `parsing_res_list`, table HTML and `overall_ocr_res` into stable
DocumentIR Blocks.

Official references:

- [PaddleOCR 3.x installation](https://paddlepaddle.github.io/PaddleOCR/main/version3.x/installation.html)
- [PP-StructureV3 pipeline usage](https://paddlepaddle.github.io/PaddleOCR/main/en/version3.x/pipeline_usage/PP-StructureV3.html)
- [PaddleOCR quick start](https://paddlepaddle.github.io/PaddleOCR/main/en/quick_start.html)
