"""The live-updates socket: who gets told about what."""

import pytest
from starlette.websockets import WebSocketDisconnect

from api import auth as api_auth

from conftest import auth


@pytest.fixture(autouse=True)
def no_rate_limit():
    api_auth.comment_attempts.clear()


def connect(client, token, client_id):
    return client.websocket_connect(f"/ws/live?client_id={client_id}&token={token}")


def watch(ws, *project_ids):
    """Watch projects. Returns the ids the server let us watch."""
    ws.send_json({"type": "watch", "projects": list(project_ids)})
    reply = ws.receive_json()
    assert reply["type"] == "watching"
    for _ in range(len(project_ids) - len(reply["projects"])):
        assert ws.receive_json()["type"] == "access_removed"
    return reply["projects"]


def nothing_pending(ws):
    """True if no event is waiting: the next thing the socket says is the answer to our ping."""
    ws.send_json({"type": "ping"})
    return ws.receive_json() == {"type": "pong"}


def comment(client, project_id, token, client_id=None):
    headers = auth(token)
    if client_id:
        headers["X-Client-Id"] = client_id
    res = client.post(f"/api/projects/{project_id}/comment", json={"frame": 1, "text": "Look"}, headers=headers)
    assert res.status_code == 200, res.text
    return res.json()


def test_dead_token_is_told_the_login_is_over(client):
    with pytest.raises(WebSocketDisconnect) as closed:
        with connect(client, "not-a-token", "tab") as ws:
            ws.receive_json()
    assert closed.value.code == 4401


def test_comments_reach_everyone_watching_but_not_the_tab_that_wrote_them(client, admin, make_project, make_user, grant):
    project_id = make_project()
    user = make_user()
    grant(project_id, user["user"]["id"])

    with connect(client, admin["token"], "admin-tab") as writer, connect(client, user["token"], "user-tab") as reader:
        assert watch(writer, project_id) == [project_id]
        assert watch(reader, project_id) == [project_id]

        posted = comment(client, project_id, admin["token"], client_id="admin-tab")
        event = reader.receive_json()
        assert event["type"] == "comment_added"
        assert event["comment"]["id"] == posted["id"]
        assert nothing_pending(writer)

        client.patch(f"/api/projects/{project_id}/comment/{posted['id']}/resolved", json={"resolved": True},
                     headers={**auth(admin["token"]), "X-Client-Id": "admin-tab"})
        assert reader.receive_json() == {"type": "comment_updated", "commentId": posted["id"], "resolved": True,
                                         "project": project_id}

        client.delete(f"/api/projects/{project_id}/comment/{posted['id']}",
                      headers={**auth(admin["token"]), "X-Client-Id": "admin-tab"})
        assert reader.receive_json() == {"type": "comment_deleted", "commentId": posted["id"], "project": project_id}


def test_a_second_tab_of_the_same_user_is_updated(client, admin, make_project):
    project_id = make_project()
    with connect(client, admin["token"], "tab-1") as one, connect(client, admin["token"], "tab-2") as two:
        watch(one, project_id)
        watch(two, project_id)
        comment(client, project_id, admin["token"], client_id="tab-1")
        assert two.receive_json()["type"] == "comment_added"
        assert nothing_pending(one)


def test_only_the_watched_project_is_heard(client, admin, make_project):
    watched, other = make_project(), make_project()
    with connect(client, admin["token"], "tab") as ws:
        watch(ws, watched)
        comment(client, other, admin["token"])
        assert nothing_pending(ws)


def test_cannot_watch_a_project_without_access(client, make_project, make_user, share):
    project_id, other = make_project(), make_project()
    outsider = make_user()
    guest = share(other)
    with connect(client, outsider["token"], "tab") as ws:
        assert watch(ws, project_id) == []
    with connect(client, guest["token"], "guest-tab") as ws:
        assert watch(ws, project_id, other) == [other]


def test_guests_get_comments_but_not_tasks(client, admin, make_project, share):
    project_id = make_project()
    guest = share(project_id)
    with connect(client, guest["token"], "guest-tab") as ws:
        watch(ws, project_id)
        res = client.post(f"/api/projects/{project_id}/tasks", json={"name": "Secret task"}, headers=auth(admin["token"]))
        assert res.status_code == 200, res.text
        assert nothing_pending(ws)
        comment(client, project_id, admin["token"])
        assert ws.receive_json()["type"] == "comment_added"


def test_task_changes_reach_members_with_task_access(client, admin, make_project, make_user, grant):
    project_id = make_project()
    tasker, reviewer = make_user(), make_user()
    grant(project_id, tasker["user"]["id"], can_tasks=True)
    grant(project_id, reviewer["user"]["id"], can_tasks=False)
    with connect(client, tasker["token"], "t") as with_tasks, connect(client, reviewer["token"], "r") as without:
        watch(with_tasks, project_id)
        watch(without, project_id)
        task = client.post(f"/api/projects/{project_id}/tasks", json={"name": "Grade shot 4"},
                           headers=auth(admin["token"])).json()
        event = with_tasks.receive_json()
        assert event["type"] == "task_created"
        assert nothing_pending(without)

        task_id = event["task"]["id"]
        res = client.post(f"/api/tasks/{task_id}/comments", json={"text": "On it"}, headers=auth(admin["token"]))
        assert res.status_code == 200, res.text
        assert with_tasks.receive_json() == {"type": "task_comments_changed", "taskId": task_id, "project": project_id}


def test_revoking_access_stops_the_updates(client, admin, make_project, make_user, grant):
    project_id = make_project()
    user = make_user()
    grant(project_id, user["user"]["id"])
    with connect(client, user["token"], "tab") as ws:
        watch(ws, project_id)
        client.delete(f"/api/projects/{project_id}/access/{user['user']['id']}", headers=auth(admin["token"]))
        assert ws.receive_json() == {"type": "access_removed", "project": project_id}
        assert ws.receive_json() == {"type": "projects_changed"}
        comment(client, project_id, admin["token"])
        assert nothing_pending(ws)


def test_logout_closes_the_socket(client, make_user):
    user = make_user()
    with pytest.raises(WebSocketDisconnect) as closed:
        with connect(client, user["token"], "tab") as ws:
            assert nothing_pending(ws)
            client.post("/api/auth/logout", headers=auth(user["token"]))
            ws.receive_json()
    assert closed.value.code == 4401


def test_new_projects_show_up_for_other_users(client, admin, make_project, make_user):
    user = make_user()
    with connect(client, user["token"], "tab") as ws:
        assert nothing_pending(ws)
        make_project()
        assert ws.receive_json() == {"type": "projects_changed"}


def test_a_tab_can_watch_two_projects(client, admin, make_project):
    review, tasks = make_project(), make_project()
    with connect(client, admin["token"], "tab") as ws:
        assert watch(ws, review, tasks) == [review, tasks]
        comment(client, tasks, admin["token"])
        assert ws.receive_json()["project"] == tasks
        comment(client, review, admin["token"])
        assert ws.receive_json()["project"] == review
