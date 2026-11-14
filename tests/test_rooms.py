"""Document and chat sockets: identity comes from the token, and a user can have several tabs open."""

import pytest
from starlette.websockets import WebSocketDisconnect

from conftest import auth


@pytest.fixture
def team(make_project, make_user, grant):
    """A project with two members. Returns (project_id, anna, ben)."""
    project_id = make_project()
    anna, ben = make_user(), make_user()
    for user in (anna, ben):
        grant(project_id, user["user"]["id"], can_tasks=True)
    return project_id, anna, ben


def test_document_edits_reach_other_people_and_other_tabs(client, team):
    project_id, anna, ben = team
    doc = client.post(f"/api/projects/{project_id}/documents", json={"title": "Notes"}, headers=auth(anna["token"])).json()
    url = f"/ws/docs/{doc['id']}/"

    # Anna claims to be Ben in the URL; the server goes by her token
    with client.websocket_connect(f"{url}{ben['user']['id']}?name=Ben&token={anna['token']}") as tab1:
        init = tab1.receive_json()
        assert [u["id"] for u in init["users"]] == [anna["user"]["id"]]
        assert init["users"][0]["name"] == anna["user"]["username"]

        with client.websocket_connect(f"{url}x?token={anna['token']}") as tab2, \
                client.websocket_connect(f"{url}x?token={ben['token']}") as bens:
            assert len(tab2.receive_json()["users"]) == 1       # still one Anna
            assert tab1.receive_json()["type"] == "user_joined"  # (her second tab)
            assert len(bens.receive_json()["users"]) == 2
            assert tab1.receive_json()["user_id"] == ben["user"]["id"]
            assert tab2.receive_json()["user_id"] == ben["user"]["id"]

            tab1.send_json({"type": "content_update", "content": "<p>Hello</p>"})
            for other in (tab2, bens):
                update = other.receive_json()
                assert update == {"type": "content_update", "user_id": anna["user"]["id"], "content": "<p>Hello</p>"}

        # Anna's second tab and Ben left; only Ben is announced as gone
        assert tab1.receive_json() == {"type": "user_left", "user_id": ben["user"]["id"]}

    saved = client.get(f"/api/documents/{doc['id']}", headers=auth(anna["token"])).json()
    assert saved["content"] == "<p>Hello</p>"


def test_document_socket_needs_project_access(client, team, make_user, share):
    project_id, anna, _ = team
    doc = client.post(f"/api/projects/{project_id}/documents", json={"title": "Notes"}, headers=auth(anna["token"])).json()
    outsider = make_user()
    guest = share(project_id)
    for token in (outsider["token"], guest["token"], "nonsense"):
        with pytest.raises(WebSocketDisconnect):
            with client.websocket_connect(f"/ws/docs/{doc['id']}/x?token={token}") as ws:
                ws.receive_json()


def test_chat_messages_reach_every_tab(client, team):
    project_id, anna, ben = team
    room = client.get(f"/api/projects/{project_id}/chat", headers=auth(anna["token"])).json()
    anna_url = f"/ws/chat/{room['id']}/{anna['user']['id']}?token={anna['token']}"
    ben_url = f"/ws/chat/{room['id']}/{ben['user']['id']}?token={ben['token']}"

    with client.websocket_connect(anna_url) as tab1, client.websocket_connect(anna_url) as tab2:
        tab1.receive_json()  # init
        tab2.receive_json()
        assert tab1.receive_json()["type"] == "user_joined"
        with client.websocket_connect(ben_url) as bens:
            assert len(bens.receive_json()["users"]) == 2
            tab1.receive_json()  # Ben joined
            tab2.receive_json()

            res = client.post(f"/api/chat/rooms/{room['id']}/messages", json={"text": "Lunch?"}, headers=auth(ben["token"]))
            assert res.status_code == 200, res.text
            for ws in (tab1, tab2, bens):
                message = ws.receive_json()
                assert message["type"] == "message"
                assert message["message"]["text"] == "Lunch?"


def test_chat_socket_is_only_for_yourself(client, team):
    project_id, anna, ben = team
    room = client.get(f"/api/projects/{project_id}/chat", headers=auth(anna["token"])).json()
    with pytest.raises(WebSocketDisconnect):
        with client.websocket_connect(f"/ws/chat/{room['id']}/{ben['user']['id']}?token={anna['token']}") as ws:
            ws.receive_json()
