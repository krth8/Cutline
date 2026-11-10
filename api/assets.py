"""Static asset caching and compression.

index.html is served with every local script/stylesheet URL stamped with the
file's modification time (?v=<mtime>). Those exact URLs are cached by the
browser for a year; when a file changes, its URL changes. Everything else
under /static, /covers and /profiles is revalidated (cheap 304s).
"""

import os
import re
from typing import Optional

from starlette.middleware.gzip import GZipMiddleware
from starlette.responses import HTMLResponse

STATIC_ROOT = "static"
INDEX_PATH = os.path.join(STATIC_ROOT, "index.html")

IMMUTABLE = "public, max-age=31536000, immutable"
REVALIDATE = "no-cache"

_ASSET_URL = re.compile(r'((?:src|href)=")(/static/[^"?#]+)(?:\?[^"#]*)?(")')
_CACHED_PREFIXES = ("/static/", "/covers/", "/profiles/")
# Media is already compressed and must keep byte-range support
_NO_GZIP_PREFIXES = ("/video/", "/thumbnail/", "/chat_uploads/", "/covers/", "/profiles/")


def asset_version(url_path: str) -> Optional[str]:
    """Version string for a /static/... URL path, or None if the file doesn't exist."""
    rel = url_path[len("/static/"):] if url_path.startswith("/static/") else None
    if not rel or ".." in rel.split("/"):
        return None
    try:
        return str(int(os.path.getmtime(os.path.join(STATIC_ROOT, rel))))
    except OSError:
        return None


def _stamp(match: re.Match) -> str:
    prefix, path, suffix = match.groups()
    version = asset_version(path)
    if version is None:
        return match.group(0)
    return f"{prefix}{path}?v={version}{suffix}"


def index_response() -> HTMLResponse:
    """index.html with versioned asset URLs; the page itself is always revalidated."""
    with open(INDEX_PATH, encoding="utf-8") as f:
        html = _ASSET_URL.sub(_stamp, f.read())
    return HTMLResponse(html, headers={"Cache-Control": REVALIDATE})


class AssetMiddleware:
    """Sets Cache-Control on static files and gzips text responses (pure ASGI)."""

    def __init__(self, app):
        self.app = app
        self.gzip = GZipMiddleware(app, minimum_size=1024)

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        path = scope.get("path", "")
        cache_control = None
        if path.startswith(_CACHED_PREFIXES):
            query = scope.get("query_string", b"").decode("latin-1")
            version = re.search(r"(?:^|&)v=([^&]*)", query)
            current = asset_version(path)
            if version and current and version.group(1) == current:
                cache_control = IMMUTABLE
            else:
                cache_control = REVALIDATE

        async def send_with_headers(message):
            if cache_control and message["type"] == "http.response.start":
                headers = [(k, v) for k, v in message.get("headers", []) if k.lower() not in (b"cache-control", b"pragma", b"expires")]
                headers.append((b"cache-control", cache_control.encode()))
                message = {**message, "headers": headers}
            await send(message)

        target = self.app if path.startswith(_NO_GZIP_PREFIXES) else self.gzip
        await target(scope, receive, send_with_headers)
