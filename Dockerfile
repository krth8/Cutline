FROM python:3.12-slim-bookworm

# ffmpeg/ffprobe for transcoding and thumbnails
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PORT=8099 \
    DB_PATH=/data/cutline.db \
    UPLOAD_DIR=/data/uploads \
    PROXY_DIR=/data/transcoded \
    THUMBNAIL_DIR=/data/thumbnails \
    COVERS_DIR=/data/covers \
    PROFILES_DIR=/data/profiles \
    CHAT_UPLOADS_DIR=/data/chat_uploads \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Headless Chromium for HTML clip previews (set HTML_PREVIEWS=0 to turn them off)
RUN playwright install --with-deps --only-shell chromium \
    && rm -rf /var/lib/apt/lists/*

COPY . .

RUN useradd --create-home --uid 1000 cutline \
    && mkdir -p /data \
    && chown -R cutline:cutline /data /app
USER cutline

# Name and icon for Docker dashboards (Unraid, CasaOS and others read these)
LABEL org.opencontainers.image.title="Cutline"       org.opencontainers.image.description="Review and feedback for video, images and HTML pages"       net.unraid.docker.icon="https://raw.githubusercontent.com/krth8/Cutline/main/static/icon-512.png"       net.unraid.docker.webui="http://[IP]:[PORT:8099]/"       icon="https://raw.githubusercontent.com/krth8/Cutline/main/static/icon-512.png"

VOLUME /data
EXPOSE 8099

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD python -c "import os, urllib.request; urllib.request.urlopen(f'http://127.0.0.1:{os.environ.get(\"PORT\", \"8099\")}/api/setup/status', timeout=4)"

CMD ["python", "server.py"]
