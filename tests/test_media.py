"""Clip files and thumbnails are only served to people who can open their project."""

import os

import pytest
from fastapi.testclient import TestClient

import server
from api.config import THUMBNAILS_DIR, TRANSCODED_DIR

from conftest import ADMIN, PASSWORD, auth


@pytest.fixture
def clip(make_project):
    """A project with one clip version whose files exist on disk. Returns (project_id, video, thumbnail)."""
    project_id = make_project()
    video, thumbnail = f"{project_id}_shot_v1.mp4", f"{project_id}_shot_v1.jpg"
    for folder, name in ((TRANSCODED_DIR, video), (THUMBNAILS_DIR, thumbnail)):
        with open(os.path.join(folder, name), "wb") as f:
            f.write(b"not really media")
    server.projects[project_id]["clips"]["shot"] = {
        "activeVersion": 1,
        "versions": [{"version": 1, "versionStr": "v1", "filename": video, "thumbnail": thumbnail,
                      "proxies": {"720p": video}, "mediaType": "video"}],
    }
    return project_id, video, thumbnail


@pytest.fixture
def browser():
    """A client with its own cookie jar, like a separate browser."""
    return lambda: TestClient(server.app)


def test_media_needs_a_login(clip, browser):
    _, video, thumbnail = clip
    anonymous = browser()
    assert anonymous.get(f"/video/{video}").status_code == 401
    assert anonymous.get(f"/thumbnail/{thumbnail}").status_code == 401


def test_login_cookie_opens_media_for_img_and_video_tags(clip, browser):
    _, video, thumbnail = clip
    b = browser()
    res = b.post("/api/auth/login", json=ADMIN)
    assert res.json()["valid"]
    assert "httponly" in res.headers["set-cookie"].lower()
    # No Authorization header, as for <video src> and <img src>
    assert b.get(f"/video/{video}").status_code == 200
    assert b.get(f"/thumbnail/{thumbnail}").status_code == 200
    assert b.get(f"/thumbnail/{thumbnail[:-4]}").status_code == 200


def test_media_cookie_dies_with_the_login(clip, browser, admin):
    _, video, _ = clip
    b = browser()
    token = b.post("/api/auth/login", json=ADMIN).json()["token"]
    assert b.get(f"/video/{video}").status_code == 200
    kept_cookie = dict(b.cookies)
    b.post("/api/auth/logout", headers=auth(token))
    assert b.get(f"/video/{video}").status_code == 401
    # Even a copy of the old cookie is useless
    stolen = browser()
    stolen.cookies.update(kept_cookie)
    assert stolen.get(f"/video/{video}").status_code == 401


def test_users_only_get_media_from_their_projects(clip, browser, make_user, grant):
    project_id, video, thumbnail = clip
    user = make_user()
    b = browser()
    b.post("/api/auth/login", json={"username": user["user"]["username"], "password": PASSWORD})
    assert b.get(f"/video/{video}").status_code == 403
    assert b.get(f"/thumbnail/{thumbnail}").status_code == 403
    grant(project_id, user["user"]["id"])
    assert b.get(f"/video/{video}").status_code == 200


def test_guests_get_media_from_the_shared_project_only(clip, browser, admin, make_project):
    project_id, video, _ = clip
    other = make_project()
    links = {}
    for pid in (project_id, other):
        links[pid] = admin_client_share(pid, admin)

    right, wrong = browser(), browser()
    assert right.post(f"/api/share/{links[project_id]}/access", json={}).json()["valid"]
    assert wrong.post(f"/api/share/{links[other]}/access", json={}).json()["valid"]
    assert right.get(f"/video/{video}").status_code == 200
    assert wrong.get(f"/video/{video}").status_code == 403


def admin_client_share(project_id, admin):
    res = TestClient(server.app).post(f"/api/projects/{project_id}/share", json={}, headers=auth(admin["token"]))
    return res.json()["link"]["id"]


def test_fetching_media_is_not_user_activity(clip, browser):
    import time
    from api import sessions as auth_sessions
    from api.auth import verify_jwt_token

    _, video, _ = clip
    b = browser()
    token = b.post("/api/auth/login", json=ADMIN).json()["token"]
    session = auth_sessions._all()[verify_jwt_token(token)["sid"]]
    before = session["last_activity"] = int(time.time()) - 500
    assert b.get(f"/video/{video}").status_code == 200
    assert session["last_activity"] == before


def test_unknown_files_are_not_served(browser, admin):
    b = browser()
    b.post("/api/auth/login", json=ADMIN)
    assert b.get("/video/nothing.mp4").status_code == 404
    assert b.get("/video/..%2Fserver.py").status_code in (400, 404)
    assert b.get("/thumbnail/nothing").status_code == 404
