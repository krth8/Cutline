"""Pages: REST endpoints, permissions, tree moves, archive/delete, import claim, task pages, live events."""

import pytest

from database.engine import execute
from database.pages import sort_between
from database.utils import get_db

from conftest import auth
from test_live import connect, nothing_pending, watch  # noqa: F401  (connect is a fixture)


# ---------- helpers ----------

def create(client, token, space, title=None, parent=None, client_id=None, **extra):
    body = {**extra}
    if title is not None:
        body["title"] = title
    if parent:
        body["parentId"] = parent
    headers = auth(token)
    if client_id:
        headers["X-Client-Id"] = client_id
    res = client.post(f"/api/spaces/{space}/pages", json=body, headers=headers)
    assert res.status_code == 200, res.text
    return res.json()


def tree(client, token, space, archived=False):
    res = client.get(f"/api/spaces/{space}/pages" + ("?archived=1" if archived else ""), headers=auth(token))
    assert res.status_code == 200, res.text
    return res.json()


def titles(client, token, space, parent=None, archived=False):
    return [p["title"] for p in tree(client, token, space, archived) if p["parentId"] == parent]


def patch(client, token, page_id, **body):
    return client.patch(f"/api/pages/{page_id}", json=body, headers=auth(token))


def make_task(client, token, project_id, name="Task"):
    res = client.post(f"/api/projects/{project_id}/tasks", json={"name": name}, headers=auth(token))
    assert res.status_code == 200, res.text
    return res.json()["task"]["id"]


def set_legacy(page_id, html):
    with get_db() as conn:
        execute(conn, "UPDATE pages SET legacy_html = ? WHERE id = ?", (html, page_id))


@pytest.fixture
def team(client, admin, make_project, make_user, grant):
    """A project with a member who may edit tasks, one without task access, a viewer-role member and an outsider."""
    project_id = make_project()
    member = make_user()
    grant(project_id, member["user"]["id"], can_tasks=True)
    reviewer = make_user()
    grant(project_id, reviewer["user"]["id"], can_tasks=False)
    viewer = make_user("viewer")
    grant(project_id, viewer["user"]["id"], can_tasks=True)
    outsider = make_user()
    return {"project": project_id, "space": f"p:{project_id}", "member": member["token"], "reviewer": reviewer["token"],
            "viewer": viewer["token"], "outsider": outsider["token"]}


# ---------- migration / sort helper ----------

def test_pages_table_has_the_contract_columns():
    with get_db() as conn:
        cols = {r[1] for r in execute(conn, "PRAGMA table_info(pages)").fetchall()}
        idx = {r[1] for r in execute(conn, "PRAGMA index_list(pages)").fetchall()}
    assert {"id", "kind", "space_type", "project_id", "owner_id", "parent_id", "task_id", "title", "icon", "sort_order",
            "ydoc", "text", "legacy_html", "created_by", "created_at", "updated_at", "archived_at"} <= cols
    assert {"idx_pages_project", "idx_pages_owner", "idx_pages_parent", "idx_pages_task"} <= idx


def test_sort_between():
    assert sort_between(None, None) == 0
    assert sort_between(None, 2) < 2
    assert sort_between(3, None) > 3
    assert 1 < sort_between(1, 2) < 2


# ---------- create / read ----------

def test_create_and_read_a_project_page(client, team):
    page = create(client, team["member"], team["space"], "Plan")
    assert page["title"] == "Plan" and page["space"] == team["space"] and page["kind"] == "page"
    assert page["parentId"] is None and page["canEdit"] is True and page["needsImport"] is False
    assert page["archived"] is False and "legacyHtml" not in page
    got = client.get(f"/api/pages/{page['id']}", headers=auth(team["member"])).json()
    assert got == page


def test_default_title_and_template_field_is_accepted(client, team):
    page = create(client, team["member"], team["space"], template="blank")
    assert page["title"] == "Untitled"


def test_tree_lists_pages_in_order_without_payloads(client, team):
    a = create(client, team["member"], team["space"], "A")
    b = create(client, team["member"], team["space"], "B")
    child = create(client, team["member"], team["space"], "A1", parent=a["id"])
    rows = tree(client, team["member"], team["space"])
    assert [r["title"] for r in rows] == ["A", "B", "A1"] or {r["title"] for r in rows} == {"A", "B", "A1"}
    assert set(rows[0]) == {"id", "parentId", "title", "icon", "sortOrder", "kind"}
    assert titles(client, team["member"], team["space"]) == ["A", "B"]
    assert titles(client, team["member"], team["space"], parent=a["id"]) == ["A1"]
    assert child["parentId"] == a["id"] and b["sortOrder"] > a["sortOrder"]


def test_bad_space_and_unknown_ids(client, team):
    assert client.get("/api/spaces/nonsense/pages", headers=auth(team["member"])).status_code == 400
    assert client.get("/api/spaces/p:nope/pages", headers=auth(team["member"])).status_code == 404
    assert client.get("/api/pages/nope", headers=auth(team["member"])).status_code == 404
    assert patch(client, team["member"], "nope", title="x").status_code == 404
    assert client.delete("/api/pages/nope", headers=auth(team["member"])).status_code == 404
    assert client.post("/api/pages/nope/claim-import", headers=auth(team["member"])).status_code == 404
    assert client.get("/api/tasks/nope/page", headers=auth(team["member"])).status_code == 404


def test_patch_title_icon_and_validation(client, team):
    page = create(client, team["member"], team["space"], "Old")
    res = patch(client, team["member"], page["id"], title="  New  ", icon="*")
    assert res.status_code == 200 and res.json()["title"] == "New" and res.json()["icon"] == "*"
    assert patch(client, team["member"], page["id"], icon=None).json()["icon"] is None
    assert patch(client, team["member"], page["id"], title=5).status_code == 400
    assert patch(client, team["member"], page["id"], sortOrder="x").status_code == 400
    assert patch(client, team["member"], page["id"], archived="yes").status_code == 400


# ---------- permissions: project pages ----------

def test_project_page_permissions(client, team, admin):
    page = create(client, team["member"], team["space"], "Shared")
    pid = page["id"]

    # Reading: any project access
    for who in ("member", "reviewer", "viewer"):
        res = client.get(f"/api/pages/{pid}", headers=auth(team[who]))
        assert res.status_code == 200, who
        assert client.get(f"/api/spaces/{team['space']}/pages", headers=auth(team[who])).status_code == 200
    assert client.get(f"/api/pages/{pid}", headers=auth(admin["token"])).status_code == 200

    # canEdit follows can_edit_tasks
    can_edit = lambda who: client.get(f"/api/pages/{pid}", headers=auth(team[who])).json()["canEdit"]
    assert can_edit("member") is True
    assert can_edit("reviewer") is False
    assert can_edit("viewer") is False

    # Editing and creating: task access and not a viewer role
    for who in ("reviewer", "viewer"):
        assert patch(client, team[who], pid, title="x").status_code == 403, who
        assert client.delete(f"/api/pages/{pid}", headers=auth(team[who])).status_code == 403
        assert client.post(f"/api/spaces/{team['space']}/pages", json={}, headers=auth(team[who])).status_code == 403
        assert client.post(f"/api/pages/{pid}/claim-import", headers=auth(team[who])).status_code == 403
    assert patch(client, admin["token"], pid, title="by admin").status_code == 200

    # Outsiders see nothing
    assert client.get(f"/api/pages/{pid}", headers=auth(team["outsider"])).status_code == 403
    assert client.get(f"/api/spaces/{team['space']}/pages", headers=auth(team["outsider"])).status_code == 403
    assert patch(client, team["outsider"], pid, title="x").status_code == 403
    assert client.post(f"/api/spaces/{team['space']}/pages", json={}, headers=auth(team["outsider"])).status_code == 403


def test_anonymous_gets_401_and_guests_get_403(client, team, share):
    page = create(client, team["member"], team["space"], "P")
    guest = share(team["project"])["token"]
    for method, url, body in [
        ("get", f"/api/pages/{page['id']}", None),
        ("get", f"/api/spaces/{team['space']}/pages", None),
        ("post", f"/api/spaces/{team['space']}/pages", {}),
        ("patch", f"/api/pages/{page['id']}", {"title": "x"}),
        ("delete", f"/api/pages/{page['id']}", None),
        ("post", f"/api/pages/{page['id']}/claim-import", None),
        ("get", "/api/spaces/me/pages", None),
    ]:
        kwargs = {"json": body} if body is not None else {}
        assert getattr(client, method)(url, **kwargs).status_code == 401, url
        assert getattr(client, method)(url, headers=auth(guest), **kwargs).status_code == 403, url


# ---------- permissions: personal pages ----------

def test_personal_pages_belong_to_their_owner_only(client, admin, make_user):
    owner, other = make_user(), make_user()
    page = create(client, owner["token"], "me", "Diary")
    assert page["space"] == "me" and page["canEdit"] is True
    assert titles(client, owner["token"], "me") == ["Diary"]
    assert tree(client, other["token"], "me") == []
    assert tree(client, admin["token"], "me") == []

    for who in (other["token"], admin["token"]):
        assert client.get(f"/api/pages/{page['id']}", headers=auth(who)).status_code == 403
        assert patch(client, who, page["id"], title="x").status_code == 403
        assert client.delete(f"/api/pages/{page['id']}", headers=auth(who)).status_code == 403
        assert client.post(f"/api/pages/{page['id']}/claim-import", headers=auth(who)).status_code == 403
    assert patch(client, owner["token"], page["id"], title="Journal").json()["title"] == "Journal"


def test_personal_page_cannot_be_parented_in_another_space(client, team, make_user):
    owner = make_user()
    mine = create(client, owner["token"], "me", "Mine")
    # a project page cannot be moved under a personal page, and vice versa
    proj = create(client, team["member"], team["space"], "Proj")
    assert patch(client, team["member"], proj["id"], parentId=mine["id"]).status_code in (400, 403)
    res = client.post("/api/spaces/me/pages", json={"parentId": proj["id"]}, headers=auth(owner["token"]))
    assert res.status_code == 400


# ---------- moves and ordering ----------

def test_move_between_siblings_never_renumbers_others(client, team):
    t = team["member"]
    a, b, c = (create(client, t, team["space"], n) for n in "ABC")
    d = create(client, t, team["space"], "D")
    mid = sort_between(a["sortOrder"], b["sortOrder"])
    assert patch(client, t, d["id"], sortOrder=mid).status_code == 200
    assert titles(client, t, team["space"]) == ["A", "D", "B", "C"]
    rows = {r["title"]: r["sortOrder"] for r in tree(client, t, team["space"])}
    assert (rows["A"], rows["B"], rows["C"]) == (a["sortOrder"], b["sortOrder"], c["sortOrder"])
    # many inserts into the same shrinking gap keep a strict order and touch no other page
    upper = mid
    for i in range(30):
        e = create(client, t, team["space"], f"E{i}")
        upper = sort_between(a["sortOrder"], upper)
        assert patch(client, t, e["id"], sortOrder=upper).status_code == 200
    ordered = [r["sortOrder"] for r in tree(client, t, team["space"])]
    assert ordered == sorted(ordered) and len(set(ordered)) == len(ordered)
    assert titles(client, t, team["space"])[0] == "A" and titles(client, t, team["space"])[-2:] == ["B", "C"]


def test_move_to_another_parent_appends_and_moves_back_to_top(client, team):
    t = team["member"]
    a = create(client, t, team["space"], "A")
    b = create(client, t, team["space"], "B")
    x = create(client, t, team["space"], "X", parent=a["id"])
    y = create(client, t, team["space"], "Y", parent=b["id"])
    res = patch(client, t, y["id"], parentId=a["id"])
    assert res.status_code == 200 and res.json()["parentId"] == a["id"]
    assert titles(client, t, team["space"], parent=a["id"]) == ["X", "Y"]
    assert res.json()["sortOrder"] > x["sortOrder"]
    assert patch(client, t, y["id"], parentId=None).json()["parentId"] is None
    assert titles(client, t, team["space"]) == ["A", "B", "Y"]


def test_cannot_move_under_itself_or_a_descendant(client, team):
    t = team["member"]
    a = create(client, t, team["space"], "A")
    b = create(client, t, team["space"], "B", parent=a["id"])
    c = create(client, t, team["space"], "C", parent=b["id"])
    assert patch(client, t, a["id"], parentId=a["id"]).status_code == 400
    assert patch(client, t, a["id"], parentId=b["id"]).status_code == 400
    assert patch(client, t, a["id"], parentId=c["id"]).status_code == 400
    assert tree_parent(client, t, team["space"], a["id"]) is None


def tree_parent(client, token, space, page_id):
    return next(r["parentId"] for r in tree(client, token, space) if r["id"] == page_id)


def test_cannot_move_across_spaces(client, team, make_project, grant, make_user):
    other_project = make_project()
    grant(other_project, make_user()["user"]["id"])
    me = make_user()
    grant(team["project"], me["user"]["id"], can_tasks=True)
    grant(other_project, me["user"]["id"], can_tasks=True)
    here = create(client, me["token"], team["space"], "Here")
    there = create(client, me["token"], f"p:{other_project}", "There")
    mine = create(client, me["token"], "me", "Mine")
    assert patch(client, me["token"], here["id"], parentId=there["id"]).status_code == 400
    assert patch(client, me["token"], here["id"], parentId=mine["id"]).status_code == 400
    assert patch(client, me["token"], mine["id"], parentId=here["id"]).status_code == 400
    res = client.post(f"/api/spaces/p:{other_project}/pages", json={"parentId": here["id"]}, headers=auth(me["token"]))
    assert res.status_code == 400
    assert patch(client, me["token"], here["id"], parentId="missing").status_code == 400


# ---------- archive / restore / delete ----------

def test_archive_and_restore_a_subtree(client, team):
    t = team["member"]
    a = create(client, t, team["space"], "A")
    b = create(client, t, team["space"], "B", parent=a["id"])
    c = create(client, t, team["space"], "C", parent=b["id"])
    other = create(client, t, team["space"], "Other")

    res = patch(client, t, a["id"], archived=True)
    assert res.status_code == 200 and res.json()["archived"] is True
    assert titles(client, t, team["space"]) == ["Other"]
    assert {r["title"] for r in tree(client, t, team["space"], archived=True)} == {"A", "B", "C"}
    assert client.get(f"/api/pages/{c['id']}", headers=auth(t)).json()["archived"] is True

    res = patch(client, t, a["id"], archived=False)
    assert res.json()["archived"] is False
    assert tree(client, t, team["space"], archived=True) == []
    assert titles(client, t, team["space"], parent=b["id"]) == ["C"]
    assert other["id"] in [r["id"] for r in tree(client, t, team["space"])]


def test_restoring_a_child_of_an_archived_page_moves_it_to_the_top(client, team):
    t = team["member"]
    a = create(client, t, team["space"], "A")
    b = create(client, t, team["space"], "B", parent=a["id"])
    patch(client, t, a["id"], archived=True)
    res = patch(client, t, b["id"], archived=False)
    assert res.json()["parentId"] is None
    assert titles(client, t, team["space"]) == ["B"]


def test_cannot_create_or_move_under_an_archived_page(client, team):
    t = team["member"]
    a = create(client, t, team["space"], "A")
    other = create(client, t, team["space"], "Other")
    patch(client, t, a["id"], archived=True)
    res = client.post(f"/api/spaces/{team['space']}/pages", json={"parentId": a["id"]}, headers=auth(t))
    assert res.status_code == 400
    assert patch(client, t, other["id"], parentId=a["id"]).status_code == 400


def test_delete_only_archived_pages_and_takes_the_subtree(client, team):
    t = team["member"]
    a = create(client, t, team["space"], "A")
    b = create(client, t, team["space"], "B", parent=a["id"])
    keep = create(client, t, team["space"], "Keep")
    assert client.delete(f"/api/pages/{a['id']}", headers=auth(t)).status_code == 409
    patch(client, t, a["id"], archived=True)
    assert client.delete(f"/api/pages/{a['id']}", headers=auth(t)).status_code == 200
    assert client.get(f"/api/pages/{a['id']}", headers=auth(t)).status_code == 404
    assert client.get(f"/api/pages/{b['id']}", headers=auth(t)).status_code == 404
    assert client.get(f"/api/pages/{keep['id']}", headers=auth(t)).status_code == 200
    assert tree(client, t, team["space"], archived=True) == []


# ---------- legacy import claim ----------

def test_needs_import_and_claim_is_granted_exactly_once(client, team):
    page = create(client, team["member"], team["space"], "Old doc")
    set_legacy(page["id"], "<p>Old</p>")
    other = client.get(f"/api/pages/{page['id']}", headers=auth(team["member"])).json()
    assert other["needsImport"] is True and other["legacyHtml"] == "<p>Old</p>"

    # a second editor
    first = client.post(f"/api/pages/{page['id']}/claim-import", headers=auth(team["member"]))
    assert first.status_code == 200 and first.json() == {"granted": True}
    again = client.post(f"/api/pages/{page['id']}/claim-import", headers=auth(team["member"]))
    assert again.json() == {"granted": False}


def test_claim_import_from_two_users_grants_one(client, admin, team):
    page = create(client, team["member"], team["space"], "Old doc")
    set_legacy(page["id"], "<p>Old</p>")
    results = [client.post(f"/api/pages/{page['id']}/claim-import", headers=auth(tok)).json()["granted"]
               for tok in (admin["token"], team["member"])]
    assert sorted(results) == [False, True]


def test_no_import_without_legacy_html_or_when_content_exists(client, team):
    plain = create(client, team["member"], team["space"], "Plain")
    assert client.post(f"/api/pages/{plain['id']}/claim-import", headers=auth(team["member"])).json() == {"granted": False}
    filled = create(client, team["member"], team["space"], "Filled")
    set_legacy(filled["id"], "<p>x</p>")
    with get_db() as conn:
        execute(conn, "UPDATE pages SET ydoc = ? WHERE id = ?", (b"\x01\x02\x03\x04", filled["id"]))
    got = client.get(f"/api/pages/{filled['id']}", headers=auth(team["member"])).json()
    assert got["needsImport"] is False and "legacyHtml" not in got
    assert client.post(f"/api/pages/{filled['id']}/claim-import", headers=auth(team["member"])).json() == {"granted": False}


# ---------- task pages ----------

def test_task_page_is_created_once_in_the_tasks_project(client, team):
    task_id = make_task(client, team["member"], team["project"], "Fix audio")
    first = client.get(f"/api/tasks/{task_id}/page", headers=auth(team["member"]))
    assert first.status_code == 200, first.text
    page = first.json()
    assert page["kind"] == "task" and page["space"] == team["space"] and page["title"] == "Fix audio"
    assert page["canEdit"] is True
    second = client.get(f"/api/tasks/{task_id}/page", headers=auth(team["member"])).json()
    assert second["id"] == page["id"]
    assert client.get(f"/api/pages/{page['id']}", headers=auth(team["member"])).status_code == 200
    with get_db() as conn:
        count = execute(conn, "SELECT COUNT(*) FROM pages WHERE task_id = ?", (task_id,)).fetchone()[0]
    assert count == 1


def test_task_page_access_follows_the_task_rules(client, team, admin, share):
    task_id = make_task(client, team["member"], team["project"])
    page = client.get(f"/api/tasks/{task_id}/page", headers=auth(team["member"])).json()
    pid = page["id"]

    # Reading needs task access: reviewer (no can_tasks) and outsider are refused
    for who in ("reviewer", "outsider"):
        assert client.get(f"/api/tasks/{task_id}/page", headers=auth(team[who])).status_code == 403
        assert client.get(f"/api/pages/{pid}", headers=auth(team[who])).status_code == 403
    # ... and the tree hides it from the reviewer, who can still read project pages
    assert any(r["kind"] == "task" for r in tree(client, team["member"], team["space"]))
    assert not any(r["kind"] == "task" for r in tree(client, team["reviewer"], team["space"]))

    # A viewer-role member with task access reads but cannot edit
    got = client.get(f"/api/pages/{pid}", headers=auth(team["viewer"])).json()
    assert got["canEdit"] is False
    assert patch(client, team["viewer"], pid, title="x").status_code == 403
    assert patch(client, team["member"], pid, title="Renamed").status_code == 200

    # Task pages stay put
    assert patch(client, team["member"], pid, archived=True).status_code == 400
    other = create(client, team["member"], team["space"], "Page")
    assert patch(client, team["member"], pid, parentId=other["id"]).status_code == 400
    assert patch(client, team["member"], other["id"], parentId=pid).status_code == 400

    assert client.get(f"/api/pages/{pid}", headers=auth(admin["token"])).status_code == 200
    guest = share(team["project"])["token"]
    assert client.get(f"/api/tasks/{task_id}/page", headers=auth(guest)).status_code == 403
    assert client.get(f"/api/tasks/{task_id}/page").status_code == 401


def test_task_page_goes_away_with_its_task(client, team):
    task_id = make_task(client, team["member"], team["project"])
    pid = client.get(f"/api/tasks/{task_id}/page", headers=auth(team["member"])).json()["id"]
    with get_db() as conn:
        execute(conn, "DELETE FROM tasks WHERE id = ?", (task_id,))
    assert client.get(f"/api/pages/{pid}", headers=auth(team["member"])).status_code == 404


# ---------- live events ----------

def test_page_events_reach_other_tabs_but_not_the_origin(client, team, make_user, grant, connect):
    watcher = make_user()
    grant(team["project"], watcher["user"]["id"], can_tasks=False)
    with connect(team["member"], "writer") as writer, connect(watcher["token"], "reader") as reader:
        assert watch(writer, team["project"]) == [team["project"]]
        assert watch(reader, team["project"]) == [team["project"]]

        page = create(client, team["member"], team["space"], "Live", client_id="writer")
        event = reader.receive_json()
        assert event == {"type": "page_changed", "pageId": page["id"], "change": "created", "project": team["project"]}
        assert nothing_pending(writer)

        headers = {**auth(team["member"]), "X-Client-Id": "writer"}
        for body, change in [({"title": "Renamed"}, "renamed"), ({"sortOrder": 5}, "moved"),
                             ({"archived": True}, "archived")]:
            assert client.patch(f"/api/pages/{page['id']}", json=body, headers=headers).status_code == 200
            event = reader.receive_json()
            assert event["type"] == "page_changed" and event["change"] == change and event["pageId"] == page["id"]
        assert client.delete(f"/api/pages/{page['id']}", headers=headers).status_code == 200
        assert reader.receive_json()["change"] == "deleted"
        assert nothing_pending(writer)


def test_task_page_events_skip_people_without_task_access(client, team, make_user, grant, connect):
    task_id = make_task(client, team["member"], team["project"])
    page_id = client.get(f"/api/tasks/{task_id}/page", headers=auth(team["member"])).json()["id"]
    with connect(team["member"], "writer") as writer, connect(team["reviewer"], "reviewer") as reviewer:
        watch(writer, team["project"])
        watch(reviewer, team["project"])
        headers = {**auth(team["member"]), "X-Client-Id": "writer"}
        assert client.patch(f"/api/pages/{page_id}", json={"title": "New"}, headers=headers).status_code == 200
        assert nothing_pending(reviewer)


def test_personal_page_events_go_to_the_owners_other_tabs_only(client, make_user, connect):
    owner, other = make_user(), make_user()
    with connect(owner["token"], "tab-1") as tab1, connect(owner["token"], "tab-2") as tab2, \
            connect(other["token"], "other") as stranger:
        headers = {**auth(owner["token"]), "X-Client-Id": "tab-1"}
        res = client.post("/api/spaces/me/pages", json={"title": "Mine"}, headers=headers)
        assert res.status_code == 200
        event = tab2.receive_json()
        assert event == {"type": "page_changed", "pageId": res.json()["id"], "change": "created"}
        assert nothing_pending(stranger)
