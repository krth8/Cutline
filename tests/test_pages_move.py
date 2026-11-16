"""Moving pages between spaces: permissions, subtree, ordering, events, sockets, views, preview."""

import pytest
from starlette.websockets import WebSocketDisconnect

from conftest import auth
from test_live import connect, nothing_pending, watch  # noqa: F401  (connect is a fixture)
from test_pages import create, patch, titles, tree
from test_pagesync import Peer, connect_page, wait_closed  # noqa: F401  (connect_page is a fixture)


def move(client, token, page_id, space, parent=None, client_id=None):
    body = {"space": space}
    if parent:
        body["parentId"] = parent
    headers = auth(token)
    if client_id:
        headers["X-Client-Id"] = client_id
    return client.post(f"/api/pages/{page_id}/move", json=body, headers=headers)


def preview(client, token, page_id, space):
    return client.get(f"/api/pages/{page_id}/move-preview", params={"space": space}, headers=auth(token))


def add_view(client, token, page_id, ref):
    res = client.post("/api/views", json={"tableRef": ref, "name": "V", "layout": "table", "ownerPageId": page_id},
                      headers=auth(token))
    assert res.status_code == 200, res.text
    return res.json()["id"]


@pytest.fixture
def world(client, make_project, make_user, grant):
    """Alpha: a and b edit tasks, reviewer has no task access, viewer has the viewer role. Beta: only b."""
    pa, pb = make_project("Alpha"), make_project("Beta")
    a, b, reviewer, viewer, outsider = make_user(), make_user(), make_user(), make_user("viewer"), make_user()
    grant(pa, a["user"]["id"], can_tasks=True)
    grant(pa, b["user"]["id"], can_tasks=True)
    grant(pa, reviewer["user"]["id"], can_tasks=False)
    grant(pa, viewer["user"]["id"], can_tasks=True)
    grant(pb, b["user"]["id"], can_tasks=True)
    return {"pa": pa, "pb": pb, "sa": f"p:{pa}", "sb": f"p:{pb}", "a": a["token"], "b": b["token"],
            "reviewer": reviewer["token"], "viewer": viewer["token"], "outsider": outsider["token"]}


# ---------- both directions, subtree, order ----------

def test_personal_page_with_subtree_moves_into_a_project(client, world):
    root = create(client, world["a"], "me", "Root")
    child = create(client, world["a"], "me", "Child", parent=root["id"])
    grand = create(client, world["a"], "me", "Grand", parent=child["id"])
    existing = create(client, world["a"], world["sa"], "Existing")

    res = move(client, world["a"], root["id"], world["sa"])
    assert res.status_code == 200, res.text
    assert res.json()["space"] == world["sa"] and res.json()["parentId"] is None
    assert res.json()["sortOrder"] > existing["sortOrder"]  # end of the top level

    rows = {r["id"]: r for r in tree(client, world["b"], world["sa"])}
    assert {root["id"], child["id"], grand["id"], existing["id"]} <= set(rows)
    assert rows[child["id"]]["parentId"] == root["id"] and rows[grand["id"]]["parentId"] == child["id"]
    assert tree(client, world["a"], "me") == []
    assert client.get(f"/api/pages/{grand['id']}", headers=auth(world["b"])).json()["space"] == world["sa"]


def test_project_page_moves_to_personal_and_the_mover_owns_it(client, world):
    root = create(client, world["a"], world["sa"], "Team page")
    child = create(client, world["a"], world["sa"], "Sub", parent=root["id"])
    assert move(client, world["b"], root["id"], "me").status_code == 200  # b moves a's page
    assert [p["title"] for p in tree(client, world["b"], "me")] == ["Team page", "Sub"]
    assert tree(client, world["a"], "me") == []
    assert client.get(f"/api/pages/{child['id']}", headers=auth(world["a"])).status_code == 403
    assert client.get(f"/api/pages/{child['id']}", headers=auth(world["b"])).json()["space"] == "me"
    assert tree(client, world["a"], world["sa"]) == []


def test_project_to_project_under_a_chosen_parent(client, world):
    page = create(client, world["b"], world["sa"], "Mover")
    sub = create(client, world["b"], world["sa"], "Sub", parent=page["id"])
    target = create(client, world["b"], world["sb"], "Target")
    first = create(client, world["b"], world["sb"], "First", parent=target["id"])
    res = move(client, world["b"], page["id"], world["sb"], parent=target["id"])
    assert res.status_code == 200 and res.json()["parentId"] == target["id"]
    assert res.json()["sortOrder"] > first["sortOrder"]
    assert titles(client, world["b"], world["sb"], parent=target["id"]) == ["First", "Mover"]
    assert client.get(f"/api/pages/{sub['id']}", headers=auth(world["b"])).json()["space"] == world["sb"]
    assert client.get(f"/api/pages/{page['id']}", headers=auth(world["a"])).status_code == 403  # a is not in Beta


def test_archived_children_move_along_and_stay_archived(client, world):
    root = create(client, world["a"], "me", "Root")
    child = create(client, world["a"], "me", "Old", parent=root["id"])
    patch(client, world["a"], child["id"], archived=True)
    assert move(client, world["a"], root["id"], world["sa"]).status_code == 200
    assert titles(client, world["a"], world["sa"], parent=root["id"], archived=True) == ["Old"]
    assert tree(client, world["a"], "me", archived=True) == []


# ---------- permissions and refusals ----------

def test_permission_cases(client, world):
    mine = create(client, world["a"], "me", "Mine")
    team_page = create(client, world["a"], world["sa"], "Team")

    # a personal page is for its owner only
    assert move(client, world["b"], mine["id"], world["sa"]).status_code == 403
    # the mover needs create rights in the destination
    assert move(client, world["a"], mine["id"], world["sb"]).status_code == 403  # not a member of Beta
    # and edit rights where the page is
    assert move(client, world["reviewer"], team_page["id"], "me").status_code == 403  # no task access
    assert move(client, world["viewer"], team_page["id"], "me").status_code == 403  # viewer role
    assert move(client, world["outsider"], team_page["id"], "me").status_code == 403
    assert move(client, world["a"], team_page["id"], world["sb"]).status_code == 403  # a cannot create in Beta
    # a project page whose editor may create in the destination moves
    beta_page = create(client, world["b"], world["sb"], "Beta page")
    assert move(client, world["b"], beta_page["id"], world["sa"]).status_code == 200
    # nothing changed after the refusals
    assert client.get(f"/api/pages/{mine['id']}", headers=auth(world["a"])).json()["space"] == "me"
    assert client.get(f"/api/pages/{team_page['id']}", headers=auth(world["a"])).json()["space"] == world["sa"]


def test_admin_can_move_a_project_page_but_not_touch_a_personal_one(client, admin, world):
    page = create(client, world["a"], world["sa"], "Team")
    personal = create(client, world["a"], "me", "Private")
    assert client.get(f"/api/pages/{personal['id']}", headers=auth(admin["token"])).status_code == 403
    assert move(client, admin["token"], personal["id"], world["sa"]).status_code == 403
    assert move(client, admin["token"], page["id"], "me").status_code == 200
    assert client.get(f"/api/pages/{page['id']}", headers=auth(world["a"])).status_code == 403
    assert move(client, admin["token"], page["id"], world["sa"]).status_code == 200  # leave the shared admin's space empty


def test_bad_requests(client, world, share):
    page = create(client, world["a"], world["sa"], "P")
    other = create(client, world["a"], "me", "O")
    assert move(client, world["a"], page["id"], world["sa"]).status_code == 400  # already there
    assert client.post(f"/api/pages/{page['id']}/move", json={}, headers=auth(world["a"])).status_code == 400
    assert move(client, world["a"], page["id"], "nonsense").status_code == 400
    assert move(client, world["a"], page["id"], "p:does-not-exist").status_code == 404
    assert move(client, world["a"], "no-such-page", "me").status_code == 404
    assert move(client, world["a"], other["id"], world["sa"], parent=other["id"]).status_code == 400  # parent not in destination
    link = share(world["pa"])
    assert move(client, link["token"], page["id"], "me").status_code in (401, 403)
    patch(client, world["a"], page["id"], archived=True)
    assert move(client, world["a"], page["id"], "me").status_code == 400  # archived: restore first


def test_task_pages_cannot_be_moved(client, world):
    res = client.post(f"/api/projects/{world['pa']}/tasks", json={"name": "T"}, headers=auth(world["a"]))
    task_id = res.json()["task"]["id"]
    page = client.get(f"/api/tasks/{task_id}/page", headers=auth(world["a"])).json()
    assert move(client, world["a"], page["id"], "me").status_code == 400


def test_parent_must_be_a_live_page_in_the_destination(client, world):
    page = create(client, world["a"], "me", "P")
    archived = create(client, world["a"], world["sa"], "Gone")
    patch(client, world["a"], archived["id"], archived=True)
    assert move(client, world["a"], page["id"], world["sa"], parent=archived["id"]).status_code == 400


# ---------- events ----------

def test_both_spaces_get_a_page_changed_event(client, world, connect):
    page = create(client, world["a"], "me", "Event")
    child = create(client, world["a"], "me", "Event child", parent=page["id"])
    with connect(world["a"], "mover") as mover, connect(world["a"], "other-tab") as other_tab, \
            connect(world["b"], "reader") as reader:
        watch(mover, world["pa"])
        watch(other_tab, world["pa"])
        watch(reader, world["pa"])
        assert move(client, world["a"], page["id"], world["sa"], client_id="mover").status_code == 200
        event = reader.receive_json()
        assert event["type"] == "page_changed" and event["change"] == "moved" and event["project"] == world["pa"]
        assert event["pageId"] == page["id"] and set(event["pageIds"]) == {page["id"], child["id"]}
        # the owner's other tab hears about the personal space losing it and the project gaining it
        got = [other_tab.receive_json(), other_tab.receive_json()]
        assert {(m.get("project"), m["change"]) for m in got} == {(None, "moved"), (world["pa"], "moved")}
        assert nothing_pending(reader)

        # back to personal: the project's watchers hear it
        assert move(client, world["a"], page["id"], "me", client_id="mover").status_code == 200
        event = reader.receive_json()
        assert event["change"] == "moved" and event["project"] == world["pa"]


def test_project_to_project_notifies_the_old_project(client, world, connect):
    page = create(client, world["b"], world["sa"], "Across")
    with connect(world["b"], "mover") as mover, connect(world["a"], "watcher-a") as in_a:
        watch(mover, world["pb"])
        watch(in_a, world["pa"])
        assert move(client, world["b"], page["id"], world["sb"], client_id="mover").status_code == 200
        assert in_a.receive_json()["project"] == world["pa"]
        assert nothing_pending(mover)  # the mover's own tab is not echoed


# ---------- sockets ----------

def test_a_connected_reader_who_loses_access_is_disconnected(client, world, connect_page):
    page = create(client, world["a"], world["sa"], "Shared")
    child = create(client, world["a"], world["sa"], "Shared child", parent=page["id"])
    with pytest.raises(WebSocketDisconnect) as closed:
        with connect_page(world["reviewer"], child["id"]) as ws:
            Peer(ws)
            assert move(client, world["a"], page["id"], "me").status_code == 200
            wait_closed(ws)
    assert closed.value.code == 4403


def test_people_who_keep_access_stay_connected(client, world, connect_page):
    page = create(client, world["b"], world["sa"], "Stay")
    with connect_page(world["a"], page["id"]) as lost_ws, connect_page(world["b"], page["id"]) as kept_ws:
        Peer(lost_ws)
        kept = Peer(kept_ws)
        assert move(client, world["b"], page["id"], world["sb"]).status_code == 200  # Beta: b yes, a no
        with pytest.raises(WebSocketDisconnect) as closed:
            wait_closed(lost_ws)
        assert closed.value.code == 4403
        assert kept.sync() == []  # b's socket still answers


def test_personal_to_project_does_not_disconnect_the_owner(client, world, connect_page):
    page = create(client, world["a"], "me", "Mine")
    with connect_page(world["a"], page["id"]) as ws:
        peer = Peer(ws)
        assert move(client, world["a"], page["id"], world["sa"]).status_code == 200
        assert peer.sync() == []


# ---------- views follow the page ----------

def test_views_owned_by_moved_pages_follow_the_new_permissions(client, world):
    page = create(client, world["a"], "me", "With view")
    ref = f"tasks:{world['pa']}"
    vid = add_view(client, world["a"], page["id"], ref)
    assert client.get(f"/api/views/{vid}", headers=auth(world["b"])).status_code == 403  # personal: owner only

    assert move(client, world["a"], page["id"], world["sa"]).status_code == 200
    seen = client.get(f"/api/views/{vid}", headers=auth(world["b"]))
    assert seen.status_code == 200 and seen.json()["tableRef"] == ref  # the table ref is not rewritten
    assert seen.json()["canEdit"] is True
    assert client.get(f"/api/views/{vid}", headers=auth(world["reviewer"])).status_code == 403  # review only: no pages
    assert client.get(f"/api/views/{vid}", headers=auth(world["outsider"])).status_code == 403

    assert move(client, world["b"], page["id"], "me").status_code == 200  # b takes it to personal
    assert client.get(f"/api/views/{vid}", headers=auth(world["a"])).status_code == 403
    assert client.get(f"/api/views/{vid}", headers=auth(world["b"])).status_code == 200


# ---------- preview ----------

def test_preview_says_who_gains_and_who_loses(client, admin, world):
    # Every admin in the shared test database sees every project
    users = client.get("/api/admin/users", headers=auth(admin["token"])).json()["users"]
    admins = sum(1 for u in users if u["role"] == "admin" or u.get("isAdmin"))
    page = create(client, world["a"], "me", "Plan")
    create(client, world["a"], "me", "Sub 1", parent=page["id"])
    sub2 = create(client, world["a"], "me", "Sub 2", parent=page["id"])
    patch(client, world["a"], sub2["id"], archived=True)  # archived sub-pages are not counted

    res = preview(client, world["a"], page["id"], world["sa"])
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["from"] == "me" and body["to"] == world["sa"] and body["subPages"] == 1
    # b, reviewer, viewer and the admins gain access (a is the caller)
    assert body["gain"]["count"] == 3 + admins and body["lose"]["count"] == 0
    assert "admin" in body["gain"]["names"]

    assert move(client, world["a"], page["id"], world["sa"]).status_code == 200
    back = preview(client, world["a"], page["id"], "me").json()
    assert back["gain"]["count"] == 0 and back["lose"]["count"] == 3 + admins

    to_beta = preview(client, world["b"], page["id"], world["sb"]).json()
    assert to_beta["gain"]["count"] == 0  # b and the admin already see Alpha pages and Beta has nobody else
    assert to_beta["lose"]["count"] == 3  # a, reviewer, viewer (the admin sees both projects)


def test_preview_warns_about_views_the_new_readers_cannot_fill(client, world):
    page = create(client, world["a"], "me", "Dash")
    add_view(client, world["a"], page["id"], f"tasks:{world['pa']}")
    add_view(client, world["a"], page["id"], "tasks:*")  # per reader anyway: no warning
    limited = preview(client, world["a"], page["id"], world["sa"]).json()["limitedViews"]
    assert limited == [{"projectId": world["pa"], "projectName": "Alpha", "viewCount": 1, "readersWithoutAccess": 1}]

    mine = create(client, world["b"], "me", "B dash")
    add_view(client, world["b"], mine["id"], f"tasks:{world['pa']}")
    # Beta's only other reader is the admin, who can see every project's tasks: nothing to warn about
    assert preview(client, world["b"], mine["id"], world["sb"]).json()["limitedViews"] == []


def test_preview_checks_the_same_rights_as_the_move(client, world):
    mine = create(client, world["a"], "me", "Mine")
    assert preview(client, world["b"], mine["id"], world["sa"]).status_code == 403
    assert preview(client, world["a"], mine["id"], world["sb"]).status_code == 403
    assert preview(client, world["a"], mine["id"], "nonsense").status_code == 400
