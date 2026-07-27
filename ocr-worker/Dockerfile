FROM python:3.10-slim

WORKDIR /worker

RUN python -m pip install --no-cache-dir \
      paddlepaddle==3.0.0 \
      --index-url https://www.paddlepaddle.org.cn/packages/stable/cpu/

COPY requirements.txt .
RUN python -m pip install --no-cache-dir -r requirements.txt

COPY app.py contract_mapper.py ./

EXPOSE 8001

CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8001", "--workers", "1"]
