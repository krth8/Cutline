"""Files in pages: upload rules, who may fetch them, type sniffing, resizing, clean-up with the page."""

import io
import os

import pytest
from fastapi.testclient import TestClient
from PIL import Image

import server
from api.routes import page_files
from conftest import ADMIN, PASSWORD, auth


def png_bytes(size=(20, 10), color=(200, 30, 30)):
    out = io.BytesIO()
    Image.new("RGB", size, color).save(out, "PNG")
    return out.getvalue()


def upload(client, token, page_id, data, name="a.png", ctype="image/png", **form):
    return client.post(f"/api/pages/{page_id}/files", headers=auth(token),
                       files={"file": (name, data, ctype)}, data=form)


@pytest.fixture
def team(client, admin, make_project, make_user, grant):
    project_id = make_project()
    editor = make_user()
    grant(project_id, editor["user"]["id"], can_tasks=True)
    reader = make_user("viewer")  # reads the project's pages, edits nothing
    grant(project_id, reader["user"]["id"], can_tasks=True)
    outsider = make_user()
    res = client.post(f"/api/spaces/p:{project_id}/pages", json={"title": "P"}, headers=auth(editor["token"]))
    assert res.status_code == 200, res.text
    return {"project": project_id, "page": res.json()["id"], "editor": editor["token"], "reader": reader["token"],
            "outsider": outsider["token"], "editor_user": editor}


def browser(username=None, password=PASSWORD):
    """A client with its own cookie jar, like a separate browser."""
    b = TestClient(server.app)
    if username:
        assert b.post("/api/auth/login", json={"username": username, "password": password}).json()["valid"]
    return b


# ---------- upload and fetch ----------

def test_editor_uploads_an_image_and_fetches_it(client, team):
    res = upload(client, team["editor"], team["page"], png_bytes())
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["url"] == f"/api/pages/{team['page']}/files/{body['id']}"
    assert (body["name"], body["mime"], body["kind"], body["width"], body["height"]) == ("a.png", "image/png", "image", 20, 10)
    got = client.get(body["url"], headers=auth(team["reader"]))
    assert got.status_code == 200
    assert got.headers["content-type"] == "image/png"
    assert got.headers["content-disposition"].startswith("inline")
    assert got.headers["x-content-type-options"] == "nosniff"
    assert "private" in got.headers["cache-control"]
    assert Image.open(io.BytesIO(got.content)).size == (20, 10)


def test_stored_under_a_random_name_in_the_page_folder(client, team):
    body = upload(client, team["editor"], team["page"], png_bytes(), name="../../evil.png").json()
    assert body["name"] == "evil.png"
    folder = os.path.join(page_files.PAGES_DIR, team["page"])
    assert os.listdir(folder) == [body["id"]]


@pytest.mark.parametrize("name", ["..\\..\\x.txt", "/etc/passwd", "a/b/../../c.txt", "\x00bad.txt", "...", ""])
def test_hostile_file_names_stay_labels(client, team, name):
    res = upload(client, team["editor"], team["page"], b"hello", name=name or "x", ctype="text/plain")
    assert res.status_code == 200, res.text
    assert "/" not in res.json()["name"] and "\\" not in res.json()["name"] and ".." not in res.json()["name"][:2]
    folder = os.path.join(page_files.PAGES_DIR, team["page"])
    assert res.json()["id"] in os.listdir(folder)


def test_plain_file_is_an_attachment(client, team):
    body = upload(client, team["editor"], team["page"], b"%PDF-1.4 data", name="Plan v2.pdf", ctype="application/pdf").json()
    assert (body["kind"], body["mime"], body["size"]) == ("file", "application/pdf", 13)
    assert "width" not in body
    got = client.get(body["url"], headers=auth(team["editor"]))
    assert got.headers["content-disposition"].startswith("attachment")
    assert got.headers["content-type"] == "application/octet-stream"
    assert got.content == b"%PDF-1.4 data"


# ---------- access ----------

def test_reader_can_fetch_but_not_upload(client, team):
    body = upload(client, team["editor"], team["page"], png_bytes()).json()
    assert client.get(body["url"], headers=auth(team["reader"])).status_code == 200
    assert upload(client, team["reader"], team["page"], png_bytes()).status_code == 403


def test_member_of_another_project_is_refused(client, team):
    body = upload(client, team["editor"], team["page"], png_bytes()).json()
    assert client.get(body["url"], headers=auth(team["outsider"])).status_code == 403
    assert upload(client, team["outsider"], team["page"], png_bytes()).status_code == 403
    assert browser().get(body["url"]).status_code == 401


def test_anonymous_is_refused(client, team):
    body = upload(client, team["editor"], team["page"], png_bytes()).json()
    anonymous = browser()
    assert anonymous.get(body["url"]).status_code == 401
    assert anonymous.post(f"/api/pages/{team['page']}/files", files={"file": ("a.png", png_bytes(), "image/png")}).status_code == 401


def test_cookie_login_serves_img_tags_and_only_to_readers(client, team, admin, make_user, grant):
    body = upload(client, team["editor"], team["page"], png_bytes()).json()
    reader = make_user()
    grant(team["project"], reader["user"]["id"], can_tasks=True)
    b = browser(reader["user"]["username"])
    assert b.get(body["url"]).status_code == 200  # no Authorization header, like <img src>
    stranger = make_user()
    c = browser(stranger["user"]["username"])
    assert c.get(body["url"]).status_code == 403


def test_guest_cannot_fetch_page_files(client, team, share):
    body = upload(client, team["editor"], team["page"], png_bytes()).json()
    guest = share(team["project"])
    assert client.get(body["url"], headers=auth(guest["token"])).status_code == 403
    assert upload(client, guest["token"], team["page"], png_bytes()).status_code == 403


def test_personal_page_files_are_private(client, make_user):
    owner, other = make_user(), make_user()
    page = client.post("/api/spaces/me/pages", json={"title": "Mine"}, headers=auth(owner["token"])).json()
    body = upload(client, owner["token"], page["id"], png_bytes()).json()
    assert client.get(body["url"], headers=auth(owner["token"])).status_code == 200
    assert client.get(body["url"], headers=auth(other["token"])).status_code == 403
    assert upload(client, other["token"], page["id"], png_bytes()).status_code == 403


def test_file_is_only_reachable_through_its_own_page(client, team):
    other = client.post(f"/api/spaces/p:{team['project']}/pages", json={"title": "O"}, headers=auth(team["editor"])).json()
    body = upload(client, team["editor"], team["page"], png_bytes()).json()
    assert client.get(f"/api/pages/{other['id']}/files/{body['id']}", headers=auth(team["editor"])).status_code == 404
    assert client.get(f"/api/pages/{team['page']}/files/nope", headers=auth(team["editor"])).status_code == 404
    assert client.get(f"/api/pages/{team['page']}/files/..%2F..%2Ftest.db", headers=auth(team["editor"])).status_code == 404
    assert upload(client, team["editor"], "missing", png_bytes()).status_code == 404


def test_files_follow_the_page_between_spaces(client, team):
    # Access is decided from the page at request time, so changing who can see the page changes who can fetch
    body = upload(client, team["editor"], team["page"], png_bytes()).json()
    assert client.get(body["url"], headers=auth(team["outsider"])).status_code == 403
    from database.engine import execute
    from database.utils import get_db
    with get_db() as conn:
        execute(conn, "UPDATE pages SET space_type = 'personal', project_id = NULL, owner_id = ? WHERE id = ?",
                (team["editor_user"]["user"]["id"], team["page"]))
    assert client.get(body["url"], headers=auth(team["editor"])).status_code == 200
    assert client.get(body["url"], headers=auth(team["reader"])).status_code == 403


# ---------- limits and types ----------

def test_size_limits(client, team, monkeypatch):
    monkeypatch.setattr(page_files, "MAX_IMAGE_BYTES", 1000)
    monkeypatch.setattr(page_files, "MAX_FILE_BYTES", 5000)
    noisy = io.BytesIO()
    Image.frombytes("RGB", (60, 60), os.urandom(60 * 60 * 3)).save(noisy, "PNG")
    assert upload(client, team["editor"], team["page"], noisy.getvalue()).status_code == 413
    assert upload(client, team["editor"], team["page"], b"x" * 4000, name="a.bin", ctype="application/octet-stream").status_code == 200
    assert upload(client, team["editor"], team["page"], b"x" * 6000, name="a.bin", ctype="application/octet-stream").status_code == 413
    folder = os.path.join(page_files.PAGES_DIR, team["page"])
    assert len(os.listdir(folder)) == 1  # the refused uploads left nothing behind


def test_default_limits():
    assert page_files.MAX_IMAGE_BYTES == 20 * 1024 * 1024
    assert page_files.MAX_FILE_BYTES == 100 * 1024 * 1024


def test_type_comes_from_the_content_not_the_name(client, team):
    # A PNG called .txt is an image; text called .png is a plain attachment
    img = upload(client, team["editor"], team["page"], png_bytes(), name="photo.txt", ctype="text/plain").json()
    assert (img["kind"], img["mime"]) == ("image", "image/png")
    txt = upload(client, team["editor"], team["page"], b"just words", name="pic.png", ctype="image/png").json()
    assert (txt["kind"], txt["mime"]) == ("file", "image/png")  # the label, but never served inline
    got = client.get(txt["url"], headers=auth(team["editor"]))
    assert got.headers["content-disposition"].startswith("attachment")


def test_image_kind_refuses_non_images(client, team):
    res = upload(client, team["editor"], team["page"], b"just words", name="pic.png", ctype="image/png", kind="image")
    assert res.status_code == 415


@pytest.mark.parametrize("name,data,ctype", [
    ("x.svg", b'<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>', "image/svg+xml"),
    ("x.html", b"<html><script>alert(1)</script></html>", "text/html"),
])
def test_svg_and_html_are_never_inline_images(client, team, name, data, ctype):
    assert upload(client, team["editor"], team["page"], data, name=name, ctype=ctype, kind="image").status_code == 415
    body = upload(client, team["editor"], team["page"], data, name=name, ctype=ctype).json()
    assert body["kind"] == "file"
    got = client.get(body["url"], headers=auth(team["editor"]))
    assert got.headers["content-disposition"].startswith("attachment")
    assert got.headers["content-type"] == "application/octet-stream"


def test_broken_image_is_refused(client, team):
    assert upload(client, team["editor"], team["page"], b"\x89PNG\r\n\x1a\nbroken").status_code == 415
    assert os.listdir(os.path.join(page_files.PAGES_DIR, team["page"])) == []


# ---------- resizing ----------

def test_large_image_is_scaled_down(client, team):
    body = upload(client, team["editor"], team["page"], png_bytes((3200, 1600))).json()
    assert (body["width"], body["height"]) == (2560, 1280)
    got = client.get(body["url"], headers=auth(team["editor"]))
    assert Image.open(io.BytesIO(got.content)).size == (2560, 1280)
    assert body["size"] == len(got.content)


def test_exif_orientation_is_applied_and_metadata_dropped(client, team):
    image = Image.new("RGB", (40, 20), (10, 120, 200))
    exif = Image.Exif()
    exif[0x0112] = 6  # rotate 90 degrees clockwise to display
    exif[0x010E] = "secret description"
    out = io.BytesIO()
    image.save(out, "JPEG", exif=exif)
    body = upload(client, team["editor"], team["page"], out.getvalue(), name="p.jpg", ctype="image/jpeg").json()
    assert (body["width"], body["height"]) == (20, 40)
    stored = Image.open(io.BytesIO(client.get(body["url"], headers=auth(team["editor"])).content))
    assert stored.size == (20, 40)
    assert not stored.getexif()


def test_animated_gif_is_stored_untouched(client, team):
    frames = [Image.new("P", (30, 30), i * 40) for i in range(3)]
    out = io.BytesIO()
    frames[0].save(out, "GIF", save_all=True, append_images=frames[1:], duration=50, loop=0)
    data = out.getvalue()
    body = upload(client, team["editor"], team["page"], data, name="a.gif", ctype="image/gif").json()
    assert body["mime"] == "image/gif" and body["size"] == len(data)
    assert client.get(body["url"], headers=auth(team["editor"])).content == data


# ---------- clean-up ----------

def test_files_are_removed_with_the_page(client, team):
    child = client.post(f"/api/spaces/p:{team['project']}/pages", json={"title": "C", "parentId": team["page"]},
                        headers=auth(team["editor"])).json()
    a = upload(client, team["editor"], team["page"], png_bytes()).json()
    b = upload(client, team["editor"], child["id"], b"data", name="d.txt", ctype="text/plain").json()
    folders = [os.path.join(page_files.PAGES_DIR, team["page"]), os.path.join(page_files.PAGES_DIR, child["id"])]
    assert all(os.path.isdir(f) for f in folders)
    # A live page can be deleted straight away (the client asks first); its files and its sub-page's go with it
    assert client.delete(f"/api/pages/{team['page']}", headers=auth(team["editor"])).status_code == 200
    assert not any(os.path.exists(f) for f in folders)
    from database.engine import execute, fetchall
    from database.utils import get_db
    with get_db() as conn:
        left = fetchall(execute(conn, "SELECT id FROM page_files WHERE id IN (?, ?)", (a["id"], b["id"])))
    assert left == []
    assert client.get(a["url"], headers=auth(team["editor"])).status_code == 403


def test_migration_created_the_table():
    from database.engine import execute
    from database.utils import get_db
    with get_db() as conn:
        cols = {r[1] for r in execute(conn, "PRAGMA table_info(page_files)").fetchall()}
    assert {"id", "page_id", "name", "mime", "size", "is_image", "width", "height", "created_by", "created_at"} <= cols
