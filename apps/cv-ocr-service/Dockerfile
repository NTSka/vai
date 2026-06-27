FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    tesseract-ocr \
    tesseract-ocr-eng \
    tesseract-ocr-rus \
  && rm -rf /var/lib/apt/lists/*

COPY apps/cv-ocr-service/pyproject.toml ./apps/cv-ocr-service/pyproject.toml
COPY apps/cv-ocr-service/src ./apps/cv-ocr-service/src
COPY apps/cv-ocr-service/scripts ./apps/cv-ocr-service/scripts
COPY packages/proto ./packages/proto

WORKDIR /app/apps/cv-ocr-service

RUN pip install --no-cache-dir -e . && python scripts/generate_proto.py

EXPOSE 50051

CMD ["python", "-m", "vai_cv_ocr_service"]
