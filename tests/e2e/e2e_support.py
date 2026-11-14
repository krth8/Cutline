"""Support code for the browser tests: server process, API client, page helpers.

Independent of tests/conftest.py (which imports the app in-process): the server here is a
separate `python server.py` process with its own throwaway database and folders, on a free port.
"""

import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
import struct
import zlib
from pathlib import Path


REPO = Path(__file__).resolve().parent.parent.parent
ADMIN = {"username": "admin", "password": "admin-password-123"}
PASSWORD = "user-password-123"

def _make_png(width=64, height=36):
    def chunk(kind, data):
        body = kind + data
        return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body) & 0xFFFFFFFF)
    row = bytes([0]) + bytes([128, 128, 128]) * width
    signature = bytes([137, 80, 78, 71, 13, 10, 26, 10])
    return (signature + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(row * height)) + chunk(b"IEND", b""))


TINY_PNG = _make_png()

_active_servers = []


def _free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class ApiError(Exception):
    def __init__(self, status, body):
        super().__init__(f"HTTP {status}: {body[:200]}")
        self.status = status


class Server:
    """A running Cutline instance plus a tiny JSON API client (bearer token, no cookies)."""

    def __init__(self, proc, tmp, port):
        self.proc = proc
        self.tmp = tmp
        self.port = port
        self.base_url = f"http://127.0.0.1:{port}"
        self.token = None
        self.admin_id = None
        self.admin = dict(ADMIN)

    def log_tail(self, lines=40):
        try:
            text = Path(self.tmp, "server.log").read_text(errors="replace")
            return "".join(text.splitlines(True)[-lines:])
        except OSError as e:
            return str(e)

    def api(self, path, body=None, token=None, method=None, raw=None, headers=None):
        """JSON request with the admin token unless `token` is given ("" = none). Returns parsed JSON."""
        data = raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
        req = urllib.request.Request(self.base_url + path, data=data,
                                     method=method or ("POST" if data is not None else "GET"))
        if raw is None:
            req.add_header("Content-Type", "application/json")
        for k, v in (headers or {}).items():
            req.add_header(k, v)
        tok = self.token if token is None else token
        if tok:
            req.add_header("Authorization", f"Bearer {tok}")
        try:
            with urllib.request.urlopen(req, timeout=15) as res:
                text = res.read().decode() or "null"
        except urllib.error.HTTPError as e:
            raise ApiError(e.code, e.read().decode(errors="replace")) from None
        return json.loads(text)

    # -- setup helpers
    def complete_setup(self):
        res = self.api("/api/setup/complete", self.admin, token="")
        self.token = res["token"]
        self.admin_id = res["user"]["id"]

    def create_user(self, username, password=PASSWORD):
        self.api("/api/admin/users", {"username": username, "password": password})
        users = self.api("/api/admin/users")["users"]
        return [u for u in users if u["username"] == username][0]["id"]

    def create_project(self, name="Spot"):
        return self.api("/api/projects", {"name": name})["project_id"]

    def grant_access(self, project_id, user_id, can_review=True, can_tasks=True):
        self.api(f"/api/projects/{project_id}/access",
                 {"userId": user_id, "canReview": can_review, "canTasks": can_tasks})

    def revoke_access(self, project_id, user_id):
        self.api(f"/api/projects/{project_id}/access/{user_id}", method="DELETE")

    def create_share_link(self, project_id):
        return self.api(f"/api/projects/{project_id}/share", {})["link"]["id"]

    def delete_share_link(self, link_id):
        self.api(f"/api/share/{link_id}", method="DELETE")

    def create_task(self, project_id, name):
        return self.api(f"/api/projects/{project_id}/tasks", {"name": name})

    def create_document(self, project_id, title, html=None):
        doc_id = self.api(f"/api/projects/{project_id}/documents", {"title": title})["id"]
        if html is not None:
            self.api(f"/api/documents/{doc_id}", {"content": html}, method="PATCH")
        return doc_id

    def upload_png_clip(self, project_id, filename="shot_010_v1.png"):
        """Upload a tiny PNG as a clip (multipart)."""
        boundary = "----e2eboundary"
        head = (f'--{boundary}\r\nContent-Disposition: form-data; name="files"; filename="{filename}"\r\n'
                f"Content-Type: image/png\r\n\r\n").encode()
        body = head + TINY_PNG + f"\r\n--{boundary}--\r\n".encode()
        return self.api(f"/api/projects/{project_id}/clips", raw=body,
                        headers={"Content-Type": f"multipart/form-data; boundary={boundary}"})

    def add_comment(self, project_id, text, frame=0):
        return self.api(f"/api/projects/{project_id}/comment",
                        {"frame": frame, "text": text, "clipBaseName": None})

    def stop(self):
        if self.proc.poll() is None:
            self.proc.terminate()
            try:
                self.proc.wait(timeout=10)
            except subprocess.TimeoutExpired:
                self.proc.kill()
                self.proc.wait(timeout=10)


def _start(extra_env=None):
    tmp = tempfile.mkdtemp(prefix="cutline-e2e-")
    port = _free_port()
    env = dict(os.environ)
    env.update({
        "PORT": str(port),
        "DB_PATH": os.path.join(tmp, "e2e.db"),
        "JWT_SECRET": "e2e-secret",
        "UPLOAD_DIR": os.path.join(tmp, "uploads"),
        "PROXY_DIR": os.path.join(tmp, "transcoded"),
        "THUMBNAIL_DIR": os.path.join(tmp, "thumbnails"),
        "COVERS_DIR": os.path.join(tmp, "covers"),
        "PROFILES_DIR": os.path.join(tmp, "profiles"),
        "HTML_PREVIEWS": "0",
        "IDLE_TIMEOUT_MINUTES": "60",
        "PYTHONUNBUFFERED": "1",
    })
    env.pop("DATABASE_URL", None)
    env.update({k: str(v) for k, v in (extra_env or {}).items()})
    log = open(os.path.join(tmp, "server.log"), "w")
    proc = subprocess.Popen([sys.executable, "server.py"], cwd=REPO, env=env,
                            stdout=log, stderr=subprocess.STDOUT)
    srv = Server(proc, tmp, port)
    deadline = time.time() + 30
    while True:
        if proc.poll() is not None or time.time() > deadline:
            srv.stop()
            raise RuntimeError("server did not start:\n" + srv.log_tail())
        try:
            urllib.request.urlopen(srv.base_url + "/api/setup/status", timeout=1).read()
            break
        except Exception:
            time.sleep(0.2)
    srv.complete_setup()
    return srv


# -- page helpers (the login overlay is #loginOverlay, hidden when logged in)

def login_visible(page):
    return page.evaluate("!document.getElementById('loginOverlay').classList.contains('hidden')")


def wait_logged_in(page, timeout=8000):
    page.wait_for_function("document.getElementById('loginOverlay').classList.contains('hidden')", timeout=timeout)


def wait_logged_out(page, timeout=8000):
    page.wait_for_function("!document.getElementById('loginOverlay').classList.contains('hidden')", timeout=timeout)


def login(page, base_url, username, password=PASSWORD, goto="/"):
    """Log in through the login form."""
    page.goto(base_url + goto)
    page.fill("#loginUsername", username)
    page.fill("#loginPassword", password)
    page.click("#mainLoginBtn")
    wait_logged_in(page)


def open_guest(page, server, link_id, name="Kim Guest"):
    """Open a share link and enter a guest name."""
    page.goto(f"{server.base_url}/s/{link_id}")
    page.wait_for_selector("#shareNameInput", timeout=8000)
    page.fill("#shareNameInput", name)
    page.evaluate("submitShareLinkName()")


def wait_js(page, expr, timeout=8000):
    """Wait until a JS expression is truthy in the page."""
    page.wait_for_function(expr, timeout=timeout)


