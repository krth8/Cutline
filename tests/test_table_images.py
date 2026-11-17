"""Image columns: upload an image for a cell, store it in the row, serve it only to readers of the table;
the currency setting of number columns."""

import io

import pytest
from PIL import Image

import database
from conftest import auth


def png_bytes(size=(40, 20)):
    out = io.BytesIO()
    Image.new("RGB", size, (20, 120, 200)).save(out, "PNG")
    return out.getvalue()


@pytest.fixture
def setup(client, make_project, make_user, grant):
    project = make_project("Images")
    owner = make_user()
    database.db_grant_project_access(owner["user"]["id"], project, can_review=True, can_tasks=True, is_owner=True)
    outsider = make_user()
    ref = f"tasks:{project}"
    col = client.post(f"/api/tables/{ref}/columns", json={"name": "Thumbnail", "type": "image"},
                      headers=auth(owner["token"]))
    assert col.status_code == 200, col.text
    task = client.post(f"/api/tables/{ref}/rows", json={"values": {"name": "Shot"}}, headers=auth(owner["token"]))
    assert task.status_code == 200, task.text
    return {"ref": ref, "owner": owner["token"], "outsider": outsider["token"], "key": col.json()["key"],
            "row": task.json()["id"]}


def upload(client, token, ref, data, name="a.png"):
    return client.post(f"/api/tables/{ref}/images", headers=auth(token), files={"file": (name, data, "image/png")})


def test_the_schema_says_where_an_image_column_uploads_to(client, setup):
    schema = client.get(f"/api/tables/{setup['ref']}/schema", headers=auth(setup["owner"])).json()
    col = next(c for c in schema["columns"] if c["key"] == setup["key"])
    assert col["type"] == "image" and col["config"]["uploadRef"] == setup["ref"]


def test_an_uploaded_image_goes_into_a_cell_and_is_served_to_readers_only(client, setup):
    res = upload(client, setup["owner"], setup["ref"], png_bytes())
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["value"].startswith(setup["ref"].replace(":", ".") + "/img_") and body["value"].endswith(".png")
    assert body["url"] == f"/api/table-images/{body['value']}"
    saved = client.patch(f"/api/tables/{setup['ref']}/rows/{setup['row']}", json={"values": {setup["key"]: body["value"]}},
                         headers=auth(setup["owner"]))
    assert saved.status_code == 200, saved.text
    assert saved.json()["values"][setup["key"]] == body["value"]
    got = client.get(body["url"], headers=auth(setup["owner"]))
    assert got.status_code == 200 and got.headers["content-type"] == "image/png"
    assert Image.open(io.BytesIO(got.content)).size == (40, 20)
    assert client.get(body["url"], headers=auth(setup["outsider"])).status_code == 403
    client.cookies.clear()
    assert client.get(body["url"]).status_code == 401


def test_only_images_are_accepted(client, setup):
    assert upload(client, setup["owner"], setup["ref"], b"not an image", name="a.txt").status_code == 415
    assert upload(client, setup["outsider"], setup["ref"], png_bytes()).status_code in (403, 404)


@pytest.mark.parametrize("value", ["../../etc/passwd", "tasks.x/img_00.png", "https://example.com/a.png", 5])
def test_a_cell_only_takes_an_uploaded_image(client, setup, value):
    res = client.patch(f"/api/tables/{setup['ref']}/rows/{setup['row']}", json={"values": {setup["key"]: value}},
                       headers=auth(setup["owner"]))
    assert res.status_code == 400


def test_a_bad_image_path_is_not_found(client, setup):
    assert client.get("/api/table-images/tasks.x/..%2F..%2Fsecret", headers=auth(setup["owner"])).status_code == 404


def test_a_number_column_keeps_its_currency(client, setup):
    ref, token = setup["ref"], setup["owner"]
    res = client.post(f"/api/tables/{ref}/columns", json={"name": "Budget", "type": "number", "config": {"currency": "NOK"}},
                      headers=auth(token))
    assert res.status_code == 200, res.text
    assert res.json()["config"] == {"currency": "NOK"}
    bad = client.post(f"/api/tables/{ref}/columns", json={"name": "Cost", "type": "number", "config": {"currency": "kroner"}},
                      headers=auth(token))
    assert bad.status_code == 400
