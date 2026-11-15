"""Home (S4): the home page pointer, the "My dashboard" template, the done filter and /api/pages/recent."""

from datetime import date, timedelta

import pytest
from pycrdt import Doc, XmlElement, XmlFragment

from database.engine import execute, fetchall
from database.utils import get_db

from conftest import auth
from test_pages import create, patch


@pytest.fixture
def me(make_user):
    return make_user()


def open_home(client, user):
    res = client.post("/api/home/open", headers=auth(user["token"]))
    assert res.status_code == 200, res.text
    return res.json()


def get_home(client, user):
    res = client.get("/api/home", headers=auth(user["token"]))
    assert res.status_code == 200, res.text
    return res.json()["pageId"]


def dashboards(user_id):
    with get_db() as conn:
        return fetchall(execute(conn, "SELECT id FROM pages WHERE owner_id = ? AND title = 'My dashboard'", (user_id,)))


def document_of(client, ticket, token, page_id):
    """The page as a browser sees it: connect, take the sync-state frame, return the XmlFragment's top-level nodes."""
    with client.websocket_connect(f"/ws/pages/{page_id}?ticket={ticket(token)}") as ws:
        frame = ws.receive_bytes()
    assert frame[0] == 0
    doc = Doc()
    doc.apply_update(frame[1:])
    return [n for n in doc.get("default", type=XmlFragment).children]


# ---------- the pointer ----------

def test_nothing_is_created_until_home_is_opened(client, me):
    assert get_home(client, me) is None
    assert dashboards(me["user"]["id"]) == []
    assert client.get("/api/auth/me", headers=auth(me["token"])).json()["homePageId"] is None


def test_the_dashboard_is_created_once_on_first_open(client, me):
    first = open_home(client, me)
    assert first["created"] is True
    again = open_home(client, me)
    assert again == {"pageId": first["pageId"], "created": False}
    assert len(dashboards(me["user"]["id"])) == 1
    assert get_home(client, me) == first["pageId"]
    assert client.get("/api/auth/me", headers=auth(me["token"])).json()["homePageId"] == first["pageId"]


def test_every_user_gets_their_own_dashboard(client, me, make_user):
    other = make_user()
    a, b = open_home(client, me)["pageId"], open_home(client, other)["pageId"]
    assert a != b
    assert client.get(f"/api/pages/{a}", headers=auth(other["token"])).status_code == 403
    assert client.get(f"/api/pages/{b}", headers=auth(me["token"])).status_code == 403


def test_guests_are_refused(client, admin, make_project, share):
    guest = {"token": share(make_project())["token"]}
    assert client.get("/api/home", headers=auth(guest["token"])).status_code == 403
    assert client.post("/api/home/open", headers=auth(guest["token"])).status_code == 403
    assert client.put("/api/home", json={"pageId": "x"}, headers=auth(guest["token"])).status_code == 403
    assert client.get("/api/pages/recent", headers=auth(guest["token"])).status_code == 403
    assert client.get("/api/home").status_code == 401


def test_set_home_accepts_only_own_live_personal_pages(client, me, make_user, make_project, grant):
    token = me["token"]
    mine = create(client, token, "me", "Mine")["id"]
    assert client.put("/api/home", json={"pageId": mine}, headers=auth(token)).json() == {"pageId": mine}
    assert get_home(client, me) == mine

    other = make_user()
    theirs = create(client, other["token"], "me", "Theirs")["id"]
    assert client.put("/api/home", json={"pageId": theirs}, headers=auth(token)).status_code == 404
    assert client.put("/api/home", json={"pageId": "nope"}, headers=auth(token)).status_code == 404
    assert client.put("/api/home", json={}, headers=auth(token)).status_code == 400

    project = make_project()
    grant(project, me["user"]["id"], can_tasks=True)
    shared = create(client, token, f"p:{project}", "Shared")["id"]
    assert client.put("/api/home", json={"pageId": shared}, headers=auth(token)).status_code == 404

    gone = create(client, token, "me", "Archived")["id"]
    assert patch(client, token, gone, archived=True).status_code == 200
    assert client.put("/api/home", json={"pageId": gone}, headers=auth(token)).status_code == 400
    assert get_home(client, me) == mine


def test_the_pointer_is_cleared_when_the_page_is_archived_and_a_fresh_dashboard_follows(client, me):
    first = open_home(client, me)["pageId"]
    assert patch(client, me["token"], first, archived=True).status_code == 200
    assert get_home(client, me) is None
    second = open_home(client, me)
    assert second["created"] is True and second["pageId"] != first


def test_the_pointer_is_cleared_when_the_page_is_deleted(client, me):
    mine = create(client, me["token"], "me", "Home soon")["id"]
    client.put("/api/home", json={"pageId": mine}, headers=auth(me["token"]))
    patch(client, me["token"], mine, archived=True)
    assert client.delete(f"/api/pages/{mine}", headers=auth(me["token"])).status_code == 200
    assert get_home(client, me) is None


def test_the_pointer_is_cleared_when_the_page_moves_to_a_project(client, me, make_project, grant):
    project = make_project()
    grant(project, me["user"]["id"], can_tasks=True)
    mine = create(client, me["token"], "me", "Moving")["id"]
    client.put("/api/home", json={"pageId": mine}, headers=auth(me["token"]))
    res = client.post(f"/api/pages/{mine}/move", json={"space": f"p:{project}"}, headers=auth(me["token"]))
    assert res.status_code == 200, res.text
    assert get_home(client, me) is None


# ---------- the template ----------

def test_the_dashboard_document_has_the_expected_blocks(client, me, ticket):
    page_id = open_home(client, me)["pageId"]
    page = client.get(f"/api/pages/{page_id}", headers=auth(me["token"])).json()
    assert page["title"] == "My dashboard" and page["space"] == "me" and page["canEdit"] and not page["needsImport"]

    nodes = document_of(client, ticket, me["token"], page_id)
    tags = [n.tag for n in nodes if isinstance(n, XmlElement)]
    assert tags == ["heading", "paragraph", "viewBlock", "viewBlock", "heading", "pageList", "paragraph"]
    assert dict(nodes[0].attributes)["level"] in (2, "2")

    views = {v["name"]: v for v in client.get(f"/api/views?ownerPageId={page_id}", headers=auth(me["token"])).json()["views"]}
    assert set(views) == {"My open tasks", "Due this week", "Overdue"}
    assert all(v["layout"] == "list" and v["tableRef"] == "tasks:*" for v in views.values())

    # the blocks point at views the page owns
    block_ids = [dict(n.attributes)["viewId"] for n in nodes if isinstance(n, XmlElement) and n.tag == "viewBlock"]
    assert block_ids == [views["My open tasks"]["id"], views["Due this week"]["id"]]
    inline = [c for c in nodes[1].children if isinstance(c, XmlElement)]
    assert [c.tag for c in inline] == ["summaryInline"] * 3
    assert [dict(c.attributes)["viewId"] for c in inline] == [
        views["My open tasks"]["id"], views["Due this week"]["id"], views["Overdue"]["id"]]
    assert all(dict(c.attributes)["fn"] == "count" for c in inline)
    assert dict(nodes[5].attributes) == {"scope": "all", "limit": 8}
    # the plain text for search is filled in
    with get_db() as conn:
        text = fetchall(execute(conn, "SELECT text FROM pages WHERE id = ?", (page_id,)))[0]["text"]
    assert "Recently changed pages" in text


def test_dashboard_views_are_private_to_the_owner(client, me, make_user, admin):
    page_id = open_home(client, me)["pageId"]
    views = client.get(f"/api/views?ownerPageId={page_id}", headers=auth(me["token"])).json()["views"]
    assert len(views) == 3
    other = make_user()
    for v in views:
        assert client.get(f"/api/views/{v['id']}", headers=auth(other["token"])).status_code == 403
        assert client.patch(f"/api/views/{v['id']}", json={"name": "x"}, headers=auth(other["token"])).status_code == 403
    assert client.get(f"/api/views?ownerPageId={page_id}", headers=auth(other["token"])).json()["views"] == []


def test_dashboard_views_count_my_open_tasks_and_follow_the_page(client, me, admin, make_project, grant):
    project = make_project("Dash")
    grant(project, me["user"]["id"], can_tasks=True)
    done = client.post("/api/statuses", json={"name": "Wrapped up", "isDone": True}, headers=auth(admin["token"])).json()["status"]
    wip = client.post("/api/statuses", json={"name": "Working on it", "isDone": False}, headers=auth(admin["token"])).json()["status"]
    mine, other = me["user"]["id"], admin["user"]["id"]
    today = date.today()

    def row(name, assignee, status=None, due=None):
        values = {"name": name, "assignees": [assignee], "status": status, "dueDate": due.isoformat() if due else None}
        res = client.post(f"/api/tables/tasks:{project}/rows", json={"values": values}, headers=auth(me["token"]))
        assert res.status_code == 200, res.text

    row("open soon", mine, wip["id"], today + timedelta(days=2))
    row("open late", mine, None, today - timedelta(days=3))
    row("open later", mine, wip["id"], today + timedelta(days=30))
    row("finished", mine, done["id"], today + timedelta(days=1))
    row("not mine", other, wip["id"], today + timedelta(days=1))

    page_id = open_home(client, me)["pageId"]
    views = {v["name"]: v for v in client.get(f"/api/views?ownerPageId={page_id}", headers=auth(me["token"])).json()["views"]}

    def names(view_name):
        config = client.get(f"/api/views/{views[view_name]['id']}", headers=auth(me["token"])).json()["config"]
        res = client.post("/api/tables/tasks:*/query", json=config["query"], headers=auth(me["token"]))
        assert res.status_code == 200, res.text
        return [r["values"]["name"] for r in res.json()["rows"]]

    assert names("My open tasks") == ["open late", "open soon", "open later"]  # by due date
    assert names("Due this week") == ["open soon"]
    assert names("Overdue") == ["open late"]


# ---------- the done filter ----------

def test_done_and_not_done_operators(client, admin, make_project):
    project = make_project("Done filter")
    done = client.post("/api/statuses", json={"name": "Shipped", "isDone": True}, headers=auth(admin["token"])).json()["status"]
    wip = client.post("/api/statuses", json={"name": "Building", "isDone": False}, headers=auth(admin["token"])).json()["status"]
    for name, status in (("a", done["id"]), ("b", wip["id"]), ("c", None)):
        client.post(f"/api/tables/tasks:{project}/rows", json={"values": {"name": name, "status": status}},
                    headers=auth(admin["token"]))

    def names(op):
        res = client.post(f"/api/tables/tasks:{project}/query", json={"filter": {"column": "status", "op": op}},
                          headers=auth(admin["token"]))
        assert res.status_code == 200, res.text
        return sorted(r["values"]["name"] for r in res.json()["rows"])

    assert names("done") == ["a"]
    assert names("notDone") == ["b", "c"]
    # other column types do not take them
    res = client.post(f"/api/tables/tasks:{project}/query", json={"filter": {"column": "name", "op": "done"}},
                      headers=auth(admin["token"]))
    assert res.status_code == 400


# ---------- recent pages ----------

def test_recent_pages_are_permission_filtered_and_newest_first(client, me, make_user, make_project, grant):
    project = make_project("Recent")
    grant(project, me["user"]["id"], can_tasks=True)
    stranger = make_user()
    old = create(client, me["token"], "me", "Older")["id"]
    shared = create(client, me["token"], f"p:{project}", "Shared one")["id"]
    theirs = create(client, stranger["token"], "me", "Strangers private")["id"]
    archived = create(client, me["token"], "me", "Gone")["id"]
    patch(client, me["token"], archived, archived=True)
    with get_db() as conn:
        execute(conn, "UPDATE pages SET updated_at = '2000-01-01T00:00:00' WHERE id = ?", (old,))

    def ids(token, scope="all", limit=None):
        url = f"/api/pages/recent?scope={scope}" + (f"&limit={limit}" if limit else "")
        res = client.get(url, headers=auth(token))
        assert res.status_code == 200, res.text
        return [p["id"] for p in res.json()["pages"]]

    mine = ids(me["token"])
    assert shared in mine and old in mine and theirs not in mine and archived not in mine
    assert mine.index(shared) < mine.index(old)
    in_project = ids(me["token"], f"p:{project}")  # the page made here and the project's own Tasks page
    assert ids(me["token"], "me") == [i for i in mine if i not in in_project]
    # the project also has its own Tasks page, older than the one made here
    assert ids(me["token"], f"p:{project}")[0] == shared
    assert len(ids(me["token"], limit=1)) == 1
    # a stranger sees neither my personal pages nor the project's
    assert not {old, shared} & set(ids(stranger["token"]))
    assert client.get(f"/api/pages/recent?scope=p:{project}", headers=auth(stranger["token"])).status_code == 403
    assert client.get("/api/pages/recent?scope=bad", headers=auth(me["token"])).status_code == 400
    assert client.get("/api/pages/recent?scope=p:missing", headers=auth(me["token"])).status_code == 404
    entry = client.get(f"/api/pages/recent?scope=p:{project}", headers=auth(me["token"])).json()["pages"][0]
    assert entry["space"] == f"p:{project}" and entry["projectName"] == "Recent" and entry["title"] == "Shared one"


def test_recent_pages_never_list_task_pages(client, me, make_project, grant):
    project = make_project("Tasks")
    grant(project, me["user"]["id"], can_tasks=True)
    task = client.post(f"/api/projects/{project}/tasks", json={"name": "T"}, headers=auth(me["token"])).json()["task"]["id"]
    page = client.get(f"/api/tasks/{task}/page", headers=auth(me["token"])).json()
    res = client.get(f"/api/pages/recent?scope=p:{project}", headers=auth(me["token"])).json()
    assert page["id"] not in [p["id"] for p in res["pages"]]
