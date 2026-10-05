# syntax=docker/dockerfile:1
# One image for linux/amd64, linux/arm64 and linux/ppc64le.
# Every dependency ships as a prebuilt wheel for all three, so no compiler is needed.
ARG BASE_IMAGE=python:3.12-slim
FROM ${BASE_IMAGE}

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    HMCSCAN_DATA_DIR=/data \
    HMCSCAN_PORT=8843 \
    HMCSCAN_ADMIN_PORT=8844

WORKDIR /opt/hmcscan
COPY requirements.txt .
RUN pip install --only-binary=:all: -r requirements.txt

COPY app ./app
RUN useradd --system --uid 10001 --home-dir /data hmcscan \
 && mkdir -p /data && chown hmcscan:hmcscan /data

USER hmcscan
VOLUME ["/data"]
EXPOSE 8843 8844

HEALTHCHECK --interval=30s --timeout=6s --start-period=20s --retries=3 CMD \
  python -c "import os,ssl,urllib.request as u; t=os.getenv('HMCSCAN_TLS','1').lower() not in ('0','false','no','off'); u.urlopen(('https' if t else 'http')+'://127.0.0.1:'+os.getenv('HMCSCAN_PORT','8843')+'/healthz', context=ssl._create_unverified_context(), timeout=5)"

ENTRYPOINT ["python", "-m", "app"]
