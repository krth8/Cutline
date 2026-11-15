"""View CRUD over HTTP: permissions per table and page, config merge, live events, cleanup with pages."""

import pytest

from conftest import auth
from test_live import connect, watch, nothing_pending  # noqa: F401  (connect is a fixture)


@pytest.fixture
def project(make_project):
    return make_project("Views")


@pytest.fixture
def editor(make_user, grant, project):
    u = make_user()
    grant(project, u["user"]["id"], can_review=True, can_tasks=True)
    return u


@pytest.fixture
def api(client):
    def call(method, path, user, json=None, headers=None):
        h = auth(user["token"]) if user else {}
        return client.request(method, path, json=json, headers={**h, **(headers or {})})
    return call


def make_view(api, user, ref, **extra):
    body = {"tableRef": ref, "name": "V", "layout": "table",
            "config": {"query": {"sort": [{"column": "name", "dir": "asc"}]}}, **extra}
    res = api("POST", "/api/views", user, body)
    assert res.status_code == 200, res.text
    return res.json()


def test_create_get_update_delete(api, admin, project):
    ref = f"tasks:{project}"
    view = make_view(api, admin, ref)
    assert view["tableRef"] == ref and view["name"] == "V" and view["layout"] == "table" and view["canEdit"]
    assert view["config"]["query"]["sort"][0]["column"] == "name"

    assert api("GET", f"/api/views/{view['id']}", admin).json() == view

    res = api("PATCH", f"/api/views/{view['id']}", admin, {"name": "Renamed", "layout": "board"})
    assert res.json()["name"] == "Renamed" and res.json()["layout"] == "board"
    assert res.json()["config"] == view["config"]

    assert api("DELETE", f"/api/views/{view['id']}", admin).status_code == 200
    assert api("GET", f"/api/views/{view['id']}", admin).status_code == 404
    assert api("DELETE", f"/api/views/{view['id']}", admin).status_code == 404


def test_config_patch_replaces_only_the_keys_given(api, admin, project):
    view = make_view(api, admin, f"tasks:{project}",
                     config={"query": {"groupBy": "status"}, "columns": [{"key": "name"}]})
    res = api("PATCH", f"/api/views/{view['id']}", admin, {"config": {"query": {"search": "x"}}})
    assert res.json()["config"] == {"query": {"search": "x"}, "columns": [{"key": "name"}]}


def test_validation(api, admin, project):
    ref = f"tasks:{project}"
    bad = [
        {"tableRef": ref, "layout": "pie"},
        {"tableRef": ref, "layout": "table", "config": []},
        {"tableRef": ref, "layout": "table", "config": {"query": 3}},
        {"tableRef": ref, "layout": "table", "name": 5},
        {"layout": "table"},
    ]
    for body in bad:
        assert api("POST", "/api/views", admin, body).status_code == 400, body
    assert api("POST", "/api/views", admin, {"tableRef": "nope", "layout": "table"}).status_code == 404
    assert api("POST", "/api/views", admin, {"tableRef": "tasks:missing", "layout": "table"}).status_code == 404
    assert api("POST", "/api/views", admin, {"tableRef": ref, "layout": "table", "ownerPageId": "none"}).status_code == 404
    view = make_view(api, admin, ref)
    assert api("PATCH", f"/api/views/{view['id']}", admin, {"layout": "pie"}).status_code == 400
    assert api("PATCH", f"/api/views/{view['id']}", admin, {"name": "  "}).json()["name"] == "Untitled view"


def test_needs_login_and_guests_are_refused(api, admin, project, share):
    view = make_view(api, admin, f"tasks:{project}")
    assert api("GET", f"/api/views/{view['id']}", None).status_code == 401
    guest = {"token": share(project)["token"]}
    assert api("GET", f"/api/views/{view['id']}", guest).status_code == 403
    assert api("POST", "/api/views", guest, {"tableRef": f"tasks:{project}", "layout": "table"}).status_code == 403
    assert api("PATCH", f"/api/views/{view['id']}", guest, {"name": "x"}).status_code == 403
    assert api("DELETE", f"/api/views/{view['id']}", guest).status_code == 403


def test_project_view_permissions(api, admin, project, editor, make_user, grant):
    ref = f"tasks:{project}"
    view = make_view(api, editor, ref)  # editors with task access may create
    assert api("PATCH", f"/api/views/{view['id']}", admin, {"name": "By admin"}).status_code == 200

    outsider = make_user()
    for method, body in (("GET", None), ("PATCH", {"name": "x"}), ("DELETE", None)):
        assert api(method, f"/api/views/{view['id']}", outsider, body).status_code == 403
    assert api("POST", "/api/views", outsider, {"tableRef": ref, "layout": "table"}).status_code == 403

    # Review-only access: may read the view but not change it
    reviewer = make_user()
    grant(project, reviewer["user"]["id"], can_review=True, can_tasks=False)
    got = api("GET", f"/api/views/{view['id']}", reviewer)
    assert got.status_code == 200 and got.json()["canEdit"] is False
    assert api("PATCH", f"/api/views/{view['id']}", reviewer, {"name": "x"}).status_code == 403
    assert api("DELETE", f"/api/views/{view['id']}", reviewer).status_code == 403
    assert api("POST", "/api/views", reviewer, {"tableRef": ref, "layout": "table"}).status_code == 403

    # A viewer role with task access reads only
    viewer = make_user("viewer")
    grant(project, viewer["user"]["id"], can_review=True, can_tasks=True)
    assert api("GET", f"/api/views/{view['id']}", viewer).json()["canEdit"] is False
    assert api("PATCH", f"/api/views/{view['id']}", viewer, {"name": "x"}).status_code == 403
    assert api("POST", "/api/views", viewer, {"tableRef": ref, "layout": "table"}).status_code == 403


def test_all_projects_view_is_private_to_its_creator(api, admin, make_user):
    a, b = make_user(), make_user()
    view = make_view(api, a, "tasks:*")
    assert api("GET", f"/api/views/{view['id']}", a).status_code == 200
    for method, body in (("GET", None), ("PATCH", {"name": "x"}), ("DELETE", None)):
        assert api(method, f"/api/views/{view['id']}", b, body).status_code == 403
    assert api("PATCH", f"/api/views/{view['id']}", admin, {"name": "ok"}).status_code == 200
    assert api("DELETE", f"/api/views/{view['id']}", a).status_code == 200


def test_page_views_follow_the_page(api, admin, project, editor, make_user, grant):
    ref = f"tasks:{project}"
    page = api("POST", f"/api/spaces/p:{project}/pages", editor, {"title": "P"}).json()
    view = make_view(api, editor, ref, ownerPageId=page["id"])
    assert view["ownerPageId"] == page["id"]

    outsider = make_user()
    assert api("GET", f"/api/views/{view['id']}", outsider).status_code == 403
    body = {"tableRef": ref, "layout": "table", "ownerPageId": page["id"]}
    assert api("POST", "/api/views", outsider, body).status_code == 403

    reviewer = make_user()
    grant(project, reviewer["user"]["id"], can_review=True, can_tasks=False)
    assert api("GET", f"/api/views/{view['id']}", reviewer).status_code == 200
    assert api("PATCH", f"/api/views/{view['id']}", reviewer, {"name": "x"}).status_code == 403


def test_personal_page_views_belong_to_the_page_owner(api, admin, make_user):
    a, b = make_user(), make_user()
    page = api("POST", "/api/spaces/me/pages", a, {"title": "Mine"}).json()
    view = make_view(api, a, "tasks:*", ownerPageId=page["id"])
    assert api("PATCH", f"/api/views/{view['id']}", a, {"name": "n"}).status_code == 200
    assert api("GET", f"/api/views/{view['id']}", b).status_code == 403
    assert api("GET", f"/api/views/{view['id']}", admin).status_code == 403  # personal pages: owner only
    body = {"tableRef": "tasks:*", "layout": "table", "ownerPageId": page["id"]}
    assert api("POST", "/api/views", b, body).status_code == 403


def test_deleting_a_page_deletes_its_views(api, admin, project):
    page = api("POST", f"/api/spaces/p:{project}/pages", admin, {"title": "Gone"}).json()
    child = api("POST", f"/api/spaces/p:{project}/pages", admin, {"title": "Child", "parentId": page["id"]}).json()
    owned = make_view(api, admin, f"tasks:{project}", ownerPageId=page["id"])
    nested = make_view(api, admin, f"tasks:{project}", ownerPageId=child["id"])
    free = make_view(api, admin, f"tasks:{project}")
    assert api("PATCH", f"/api/pages/{page['id']}", admin, {"archived": True}).status_code == 200
    assert api("DELETE", f"/api/pages/{page['id']}", admin).status_code == 200
    assert api("GET", f"/api/views/{owned['id']}", admin).status_code == 404
    assert api("GET", f"/api/views/{nested['id']}", admin).status_code == 404
    assert api("GET", f"/api/views/{free['id']}", admin).status_code == 200


def test_view_changed_events(client, admin, project, connect):
    with connect(admin["token"], "writer") as writer, connect(admin["token"], "watcher") as watcher:
        watch(writer, project)
        watch(watcher, project)
        h = {**auth(admin["token"]), "X-Client-Id": "writer"}
        res = client.post("/api/views", json={"tableRef": f"tasks:{project}", "layout": "table"}, headers=h)
        vid = res.json()["id"]
        assert watcher.receive_json() == {"type": "view_changed", "viewId": vid, "project": project}
        client.patch(f"/api/views/{vid}", json={"name": "N"}, headers=h)
        assert watcher.receive_json()["viewId"] == vid
        client.delete(f"/api/views/{vid}", headers=h)
        assert watcher.receive_json()["type"] == "view_changed"
        assert nothing_pending(writer)  # never echoed to the tab that made the change


def test_view_changed_for_all_projects_view_goes_to_the_creators_other_tabs(client, admin, connect):
    with connect(admin["token"], "writer") as writer, connect(admin["token"], "other") as other:
        h = {**auth(admin["token"]), "X-Client-Id": "writer"}
        vid = client.post("/api/views", json={"tableRef": "tasks:*", "layout": "table"}, headers=h).json()["id"]
        assert other.receive_json() == {"type": "view_changed", "viewId": vid}
        assert nothing_pending(writer)
