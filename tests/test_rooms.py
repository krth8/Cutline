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


def test_document_edits_reach_other_people_and_other_tabs(client, team, ticket):
    project_id, anna, ben = team
    doc = client.post(f"/api/projects/{project_id}/documents", json={"title": "Notes"}, headers=auth(anna["token"])).json()
    url = f"/ws/docs/{doc['id']}/"

    # Anna claims to be Ben in the URL; the server goes by her token
    with client.websocket_connect(f"{url}{ben['user']['id']}?name=Ben&ticket={ticket(anna['token'])}") as tab1:
        init = tab1.receive_json()
        assert [u["id"] for u in init["users"]] == [anna["user"]["id"]]
        assert init["users"][0]["name"] == anna["user"]["username"]

        with client.websocket_connect(f"{url}x?ticket={ticket(anna['token'])}") as tab2, \
                client.websocket_connect(f"{url}x?ticket={ticket(ben['token'])}") as bens:
            assert len(tab2.receive_json()["users"]) == 1       # still one Anna
            assert tab1.receive_json()["type"] == "user_joined"  # (her second tab)
            assert len(bens.receive_json()["users"]) == 2
            assert tab1.receive_json()["user_id"] == ben["user"]["id"]
            assert tab2.receive_json()["user_id"] == ben["user"]["id"]

            tab1.send_json({"type": "content_update", "content": "<p>Hello</p>", "baseVersion": 0})
            assert tab1.receive_json() == {"type": "content_saved", "version": 1}
            for other in (tab2, bens):
                update = other.receive_json()
                assert update == {"type": "content_update", "user_id": anna["user"]["id"],
                                  "content": "<p>Hello</p>", "version": 1}

        # Anna's second tab and Ben left; only Ben is announced as gone
        assert tab1.receive_json() == {"type": "user_left", "user_id": ben["user"]["id"]}

    saved = client.get(f"/api/documents/{doc['id']}", headers=auth(anna["token"])).json()
    assert saved["content"] == "<p>Hello</p>"


def test_document_socket_needs_project_access(client, team, make_user, share, ticket):
    project_id, anna, _ = team
    doc = client.post(f"/api/projects/{project_id}/documents", json={"title": "Notes"}, headers=auth(anna["token"])).json()
    outsider = make_user()
    guest = share(project_id)
    for token in (outsider["token"], guest["token"], "nonsense"):
        with pytest.raises(WebSocketDisconnect):
            with client.websocket_connect(f"/ws/docs/{doc['id']}/x?ticket={ticket(token)}") as ws:
                ws.receive_json()


def test_chat_messages_reach_every_tab(client, team, ticket):
    project_id, anna, ben = team
    room = client.get(f"/api/projects/{project_id}/chat", headers=auth(anna["token"])).json()
    def anna_url():
        return f"/ws/chat/{room['id']}/{anna['user']['id']}?ticket={ticket(anna['token'])}"
    ben_url = f"/ws/chat/{room['id']}/{ben['user']['id']}?ticket={ticket(ben['token'])}"

    with client.websocket_connect(anna_url()) as tab1, client.websocket_connect(anna_url()) as tab2:
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


def test_chat_socket_is_only_for_yourself(client, team, ticket):
    project_id, anna, ben = team
    room = client.get(f"/api/projects/{project_id}/chat", headers=auth(anna["token"])).json()
    with pytest.raises(WebSocketDisconnect):
        with client.websocket_connect(f"/ws/chat/{room['id']}/{ben['user']['id']}?ticket={ticket(anna['token'])}") as ws:
            ws.receive_json()


def test_a_stale_document_edit_is_not_saved(client, team, ticket):
    """Two people edit the same version: the second save must not overwrite the first."""
    project_id, anna, ben = team
    doc = client.post(f"/api/projects/{project_id}/documents", json={"title": "Notes"}, headers=auth(anna["token"])).json()
    url = f"/ws/docs/{doc['id']}/x"

    with client.websocket_connect(f"{url}?ticket={ticket(anna['token'])}") as annas, \
            client.websocket_connect(f"{url}?ticket={ticket(ben['token'])}") as bens:
        assert annas.receive_json()["version"] == 0
        annas.receive_json()  # Ben joined
        assert bens.receive_json()["version"] == 0

        annas.send_json({"type": "content_update", "content": "<p>Anna</p>", "baseVersion": 0})
        assert annas.receive_json() == {"type": "content_saved", "version": 1}

        # Ben had not seen Anna's change when he sent his
        bens.send_json({"type": "content_update", "content": "<p>Ben</p>", "baseVersion": 0})
        assert bens.receive_json()["type"] == "content_update"  # Anna's change arriving
        conflict = bens.receive_json()
        assert conflict == {"type": "content_conflict", "content": "<p>Anna</p>", "version": 1}

        # He merges and sends again on top of the current version
        bens.send_json({"type": "content_update", "content": "<p>Anna</p><p>Ben</p>", "baseVersion": 1})
        assert bens.receive_json() == {"type": "content_saved", "version": 2}
        assert annas.receive_json()["content"] == "<p>Anna</p><p>Ben</p>"

    saved = client.get(f"/api/documents/{doc['id']}", headers=auth(anna["token"])).json()
    assert saved["content"] == "<p>Anna</p><p>Ben</p>" and saved["version"] == 2


def test_document_save_over_http_checks_the_version_too(client, team, ticket):
    project_id, anna, ben = team
    doc = client.post(f"/api/projects/{project_id}/documents", json={"title": "Notes"}, headers=auth(anna["token"])).json()
    path = f"/api/documents/{doc['id']}"

    first = client.patch(path, json={"content": "<p>One</p>", "baseVersion": 0}, headers=auth(anna["token"]))
    assert first.status_code == 200 and first.json()["version"] == 1

    stale = client.patch(path, json={"content": "<p>Two</p>", "baseVersion": 0}, headers=auth(ben["token"]))
    assert stale.status_code == 409
    assert stale.json()["content"] == "<p>One</p>" and stale.json()["version"] == 1

    # A rename does not touch the content or its version
    renamed = client.patch(path, json={"title": "Plan"}, headers=auth(ben["token"])).json()
    assert renamed["title"] == "Plan" and renamed["content"] == "<p>One</p>" and renamed["version"] == 1

    # People with the document open are told about a save made over HTTP
    with client.websocket_connect(f"/ws/docs/{doc['id']}/x?ticket={ticket(anna['token'])}") as ws:
        ws.receive_json()
        client.patch(path, json={"content": "<p>Three</p>", "baseVersion": 1}, headers=auth(ben["token"]))
        update = ws.receive_json()
        assert update["type"] == "content_update" and update["content"] == "<p>Three</p>" and update["version"] == 2
