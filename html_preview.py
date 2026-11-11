"""Preview thumbnails for HTML clips.

Renders the uploaded page in headless Chromium (Playwright) and saves a
screenshot as a JPEG thumbnail. Optional: if Playwright or its browser is
missing, render_html_preview() just returns False and the clip keeps the
placeholder icon.

The page is untrusted, so the browser is kept on a short leash:
- the page itself is served from memory, never from Cutline's own server
- requests may only go to public internet hosts (no localhost/LAN/metadata IPs)
- WebSockets, service workers and non-proxied WebRTC are blocked
"""
import asyncio
import ipaddress
import os
import socket
from io import BytesIO
from urllib.parse import urlparse

from PIL import Image

PAGE_URL = "https://cutline-preview.invalid/index.html"
VIEWPORT = {"width": 1280, "height": 720}
SETTLE_MS = 2500        # time for intros, fonts and WebGL scenes to come up
LOAD_TIMEOUT_MS = 15000

ENABLED = os.environ.get("HTML_PREVIEWS", "1") != "0"

_lock = asyncio.Lock()   # one browser at a time
_unavailable = False     # set once if Playwright can't start, so we stop retrying


async def _is_public_host(host: str) -> bool:
    if not host:
        return False
    try:
        infos = await asyncio.get_running_loop().getaddrinfo(host, None, type=socket.SOCK_STREAM)
    except OSError:
        return False
    addrs = {info[4][0] for info in infos}
    return bool(addrs) and all(ipaddress.ip_address(a.split('%')[0]).is_global for a in addrs)


async def render_html_preview(html_path: str, out_path: str, max_size: int = 512) -> bool:
    """Screenshot an HTML file into a JPEG thumbnail. Returns True on success."""
    global _unavailable
    if not ENABLED or _unavailable:
        return False
    try:
        from playwright.async_api import async_playwright
    except ImportError:
        _unavailable = True
        print("HTML previews off: Playwright is not installed")
        return False

    with open(html_path, "rb") as f:
        body = f.read()

    async def guard(route):
        url = route.request.url
        if url.split('#')[0] == PAGE_URL:
            await route.fulfill(status=200, body=body, content_type="text/html; charset=utf-8")
            return
        parsed = urlparse(url)
        if parsed.scheme in ("http", "https") and await _is_public_host(parsed.hostname):
            await route.continue_()
        else:
            await route.abort()

    async def block_socket(ws):
        await ws.close()

    async with _lock:
        try:
            async with async_playwright() as p:
                browser = await p.chromium.launch(args=[
                    "--use-angle=swiftshader",
                    "--enable-unsafe-swiftshader",
                    "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
                    "--webrtc-ip-handling-policy=disable_non_proxied_udp",
                ])
                try:
                    context = await browser.new_context(
                        viewport=VIEWPORT, device_scale_factor=1, service_workers="block",
                        accept_downloads=False,
                    )
                    page = await context.new_page()
                    await page.route("**/*", guard)
                    await page.route_web_socket("**/*", block_socket)
                    try:
                        await page.goto(PAGE_URL, wait_until="load", timeout=LOAD_TIMEOUT_MS)
                    except Exception as e:
                        # A slow CDN shouldn't cost us the preview; shoot what we have
                        print(f"HTML preview: page did not finish loading ({e.__class__.__name__})")
                    await page.wait_for_timeout(SETTLE_MS)
                    shot = await page.screenshot(type="png", timeout=10000)
                finally:
                    await browser.close()
        except Exception as e:
            if "Executable doesn't exist" in str(e):
                _unavailable = True
                print("HTML previews off: Chromium for Playwright is not installed (playwright install chromium)")
            else:
                print(f"HTML preview failed: {e}")
            return False

    img = Image.open(BytesIO(shot)).convert("RGB")
    img.thumbnail((max_size, max_size), Image.Resampling.LANCZOS)
    img.save(out_path, "JPEG", quality=85)
    return True
