"""The "all tasks" live watch: task events of every project the user has task access to."""

import pytest

from api import auth as api_auth

from conftest import auth
from test_live import connect, nothing_pending  # noqa: F401  (connect is a fixture)


@pytest.fixture(autouse=True)
def no_rate_limit():
    api_auth.comment_attempts.clear()


def watch_all(ws, *project_ids):
    ws.send_json({"type": "watch", "projects": list(project_ids), "allTasks": True})
    reply = ws.receive_json()
    assert reply["type"] == "watching"
    return reply


def add_task(client, project_id, token, name="Task", client_id=None):
    headers = auth(token)
    if client_id:
        headers["X-Client-Id"] = client_id
    res = client.post(f"/api/projects/{project_id}/tasks", json={"name": name}, headers=headers)
    assert res.status_code == 200, res.text
    return res.json()


def types_until_quiet(ws):
    """Collect events until the socket has nothing more to say."""
    seen = []
    ws.send_json({"type": "ping"})
    while True:
        msg = ws.receive_json()
        if msg == {"type": "pong"}:
            return seen
        seen.append(msg)


def test_all_tasks_hears_every_project_with_task_access(client, admin, make_project, make_user, grant, connect):
    a, b, review_only, hidden = make_project("A"), make_project("B"), make_project("R"), make_project("H")
    user = make_user()
    grant(a, user["user"]["id"], can_tasks=True)
    grant(b, user["user"]["id"], can_tasks=True)
    grant(review_only, user["user"]["id"], can_tasks=False)
    with connect(user["token"], "tab") as ws:
        assert watch_all(ws)["allTasks"] is True
        for pid in (a, b):
            add_task(client, pid, admin["token"])
            events = types_until_quiet(ws)
            assert [e["type"] for e in events] == ["task_created", "rows_changed"]
            assert all(e["project"] == pid for e in events)
        add_task(client, review_only, admin["token"])
        add_task(client, hidden, admin["token"])
        assert nothing_pending(ws)


def test_not_watching_all_tasks_hears_nothing_unwatched(client, admin, make_project, make_user, grant, connect):
    pid = make_project()
    user = make_user()
    grant(pid, user["user"]["id"], can_tasks=True)
    with connect(user["token"], "tab") as ws:
        ws.send_json({"type": "watch", "projects": []})
        assert ws.receive_json()["allTasks"] is False
        add_task(client, pid, admin["token"])
        assert nothing_pending(ws)
        watch_all(ws)
        ws.send_json({"type": "watch", "projects": []})  # turned off again
        assert ws.receive_json()["allTasks"] is False
        add_task(client, pid, admin["token"])
        assert nothing_pending(ws)


def test_access_granted_and_removed_while_connected(client, admin, make_project, make_user, grant, connect):
    pid = make_project()
    user = make_user()
    uid = user["user"]["id"]
    with connect(user["token"], "tab") as ws:
        watch_all(ws)
        add_task(client, pid, admin["token"])
        assert nothing_pending(ws)

        grant(pid, uid, can_tasks=True)
        assert ws.receive_json() == {"type": "projects_changed"}
        add_task(client, pid, admin["token"], "now visible")
        assert [e["type"] for e in types_until_quiet(ws)] == ["task_created", "rows_changed"]

        res = client.patch(f"/api/projects/{pid}/access/{uid}", json={"canTasks": False}, headers=auth(admin["token"]))
        assert res.status_code == 200, res.text
        assert ws.receive_json() == {"type": "projects_changed"}
        add_task(client, pid, admin["token"])
        assert nothing_pending(ws)

        res = client.patch(f"/api/projects/{pid}/access/{uid}", json={"canTasks": True}, headers=auth(admin["token"]))
        assert ws.receive_json() == {"type": "projects_changed"}
        add_task(client, pid, admin["token"])
        assert len(types_until_quiet(ws)) == 2

        client.delete(f"/api/projects/{pid}/access/{uid}", headers=auth(admin["token"]))
        assert ws.receive_json() == {"type": "projects_changed"}
        add_task(client, pid, admin["token"])
        assert nothing_pending(ws)


def test_guests_cannot_watch_all_tasks(client, admin, make_project, share, connect):
    pid = make_project()
    guest = share(pid)
    with connect(guest["token"], "guest") as ws:
        assert watch_all(ws, pid)["allTasks"] is False
        add_task(client, pid, admin["token"])
        assert nothing_pending(ws)


def test_no_echo_to_the_originating_tab_but_other_tabs_hear(client, admin, make_project, connect):
    pid = make_project()
    with connect(admin["token"], "writer") as writer, connect(admin["token"], "other") as other:
        watch_all(writer)
        watch_all(other)
        add_task(client, pid, admin["token"], client_id="writer")
        assert nothing_pending(writer)
        assert [e["type"] for e in types_until_quiet(other)] == ["task_created", "rows_changed"]


def test_project_and_all_tasks_watch_deliver_once(client, admin, make_project, connect):
    pid = make_project()
    with connect(admin["token"], "tab") as ws:
        watch_all(ws, pid)
        add_task(client, pid, admin["token"])
        assert [e["type"] for e in types_until_quiet(ws)] == ["task_created", "rows_changed"]


def test_comments_do_not_go_to_all_tasks_watchers(client, admin, make_project, connect):
    pid = make_project()
    with connect(admin["token"], "tab") as ws:
        watch_all(ws)
        res = client.post(f"/api/projects/{pid}/comment", json={"frame": 1, "text": "Look"}, headers=auth(admin["token"]))
        assert res.status_code == 200, res.text
        assert nothing_pending(ws)


def test_all_tasks_project_column_sorts_filters_and_groups(client, admin, make_project):
    a, b = make_project("Alpha"), make_project("Beta")
    add_task(client, b, admin["token"], "in beta")
    add_task(client, a, admin["token"], "in alpha")

    def query(q):
        res = client.post("/api/tables/tasks:*/query", json=q, headers=auth(admin["token"]))
        assert res.status_code == 200, res.text
        return res.json()

    rows = query({"sort": [{"column": "project", "dir": "asc"}]})["rows"]
    assert [r["values"]["name"] for r in rows if r["values"]["project"] in (a, b)] == ["in alpha", "in beta"]
    assert [r["values"]["name"] for r in query({"filter": {"column": "project", "op": "eq", "value": b}})["rows"]] == ["in beta"]
    assert {g["key"] for g in query({"groupBy": "project"})["groups"]} >= {a, b}
