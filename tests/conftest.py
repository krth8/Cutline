"""Test setup: a throwaway database and storage folders, one running app for the whole run."""

import os
import sys
import tempfile
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
_tmp = tempfile.mkdtemp(prefix="cutline-tests-")

# Must be set before the app is imported (database and folders are created on import)
os.environ.update({
    "DB_PATH": os.path.join(_tmp, "test.db"),
    "JWT_SECRET": "test-secret",
    "UPLOAD_DIR": os.path.join(_tmp, "uploads"),
    "PROXY_DIR": os.path.join(_tmp, "transcoded"),
    "THUMBNAIL_DIR": os.path.join(_tmp, "thumbnails"),
    "COVERS_DIR": os.path.join(_tmp, "covers"),
    "PROFILES_DIR": os.path.join(_tmp, "profiles"),
    "HTML_PREVIEWS": "0",
})
os.environ.pop("DATABASE_URL", None)
os.chdir(ROOT)
sys.path.insert(0, str(ROOT))

from fastapi.testclient import TestClient  # noqa: E402

import server  # noqa: E402

ADMIN = {"username": "admin", "password": "admin-password-123"}
PASSWORD = "user-password-123"


def auth(token):
    return {"Authorization": f"Bearer {token}"}


@pytest.fixture
def ticket(client):
    """A one-time WebSocket ticket for a token (what the browser fetches before opening a socket)."""
    def _ticket(token):
        res = client.post("/api/auth/ws-ticket", headers=auth(token))
        return res.json()["ticket"] if res.status_code == 200 else "no-ticket"
    return _ticket


class ApiClient(TestClient):
    """Talks to the API like a script: tokens in headers, no cookie jar.

    (Tests that need browser behaviour create their own TestClient.)
    """

    def request(self, *args, **kwargs):
        try:
            return super().request(*args, **kwargs)
        finally:
            self.cookies.clear()


@pytest.fixture(scope="session")
def client():
    with ApiClient(server.app) as c:
        yield c


@pytest.fixture(scope="session")
def admin(client):
    """The first admin, created through the setup endpoint. Returns {token, user}."""
    res = client.post("/api/setup/complete", json=ADMIN)
    assert res.status_code == 200, res.text
    return res.json()


@pytest.fixture
def login(client):
    def _login(username, password=PASSWORD):
        res = client.post("/api/auth/login", json={"username": username, "password": password})
        assert res.status_code == 200, res.text
        data = res.json()
        assert data["valid"], data
        return data
    return _login


_counter = iter(range(1, 10_000))


@pytest.fixture
def make_user(client, admin, login):
    """Create a user with a role and log them in. Returns {token, user}."""
    def _make(role="editor"):
        username = f"{role}{next(_counter)}"
        res = client.post("/api/admin/users", json={"username": username, "password": PASSWORD},
                          headers=auth(admin["token"]))
        assert res.status_code == 200, res.text
        user_id = res.json()["user"]["id"]
        if role != "editor":
            res = client.patch(f"/api/admin/users/{user_id}", json={"role": role}, headers=auth(admin["token"]))
            assert res.status_code == 200, res.text
        return login(username)
    return _make


@pytest.fixture
def make_project(client, admin):
    def _make(name="Project", token=None):
        res = client.post("/api/projects", json={"name": name}, headers=auth(token or admin["token"]))
        assert res.status_code == 200, res.text
        return res.json()["project_id"]
    return _make


@pytest.fixture
def grant(client, admin):
    def _grant(project_id, user_id, can_review=True, can_tasks=False):
        res = client.post(f"/api/projects/{project_id}/access",
                          json={"userId": user_id, "canReview": can_review, "canTasks": can_tasks},
                          headers=auth(admin["token"]))
        assert res.status_code == 200, res.text
    return _grant


@pytest.fixture
def share(client, admin):
    """Create a share link for a project and open it as a guest. Returns {linkId, token}."""
    def _share(project_id):
        res = client.post(f"/api/projects/{project_id}/share", json={}, headers=auth(admin["token"]))
        assert res.status_code == 200, res.text
        link_id = res.json()["link"]["id"]
        res = client.post(f"/api/share/{link_id}/access", json={})
        assert res.json()["valid"], res.text
        return {"linkId": link_id, "token": res.json()["guestToken"]}
    return _share
