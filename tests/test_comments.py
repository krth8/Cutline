"""Review comments: who wrote them, who may delete them, and that they are saved at once."""

import pytest

from api import auth as api_auth
from database import db_get_project

from conftest import auth


@pytest.fixture(autouse=True)
def no_rate_limit():
    api_auth.comment_attempts.clear()


def post(client, project_id, token, **body):
    return client.post(f"/api/projects/{project_id}/comment", json={"frame": 12, "text": "Hi", **body},
                       headers=auth(token))


def test_author_comes_from_the_token(client, make_project, make_user, grant):
    project_id = make_project()
    user = make_user()
    grant(project_id, user["user"]["id"])
    res = post(client, project_id, user["token"], user="someone-else", userName="Someone Else", id="chosen", resolved=True)
    assert res.status_code == 200, res.text
    comment = res.json()
    assert comment["user"] == user["user"]["id"]
    assert comment["userName"] == user["user"]["username"]
    assert comment["id"] != "chosen"
    assert comment["resolved"] is False
    assert comment["frame"] == 12


def test_comment_is_saved_immediately(client, admin, make_project):
    project_id = make_project()
    comment = post(client, project_id, admin["token"], text="Saved?").json()
    stored = db_get_project(project_id)["comments"]
    assert [c["id"] for c in stored] == [comment["id"]]
    assert stored[0]["text"] == "Saved?"

    client.patch(f"/api/projects/{project_id}/comment/{comment['id']}/resolved", json={"resolved": True},
                 headers=auth(admin["token"]))
    assert db_get_project(project_id)["comments"][0]["resolved"] is True

    client.delete(f"/api/projects/{project_id}/comment/{comment['id']}", headers=auth(admin["token"]))
    assert db_get_project(project_id)["comments"] == []


def test_empty_comment_is_rejected(client, admin, make_project):
    project_id = make_project()
    assert post(client, project_id, admin["token"], text="   ").status_code == 400


def test_commenting_needs_project_access(client, make_project, make_user):
    project_id = make_project()
    outsider = make_user()
    assert post(client, project_id, outsider["token"]).status_code == 403
    assert client.post(f"/api/projects/{project_id}/comment", json={"text": "x"}).status_code == 401


def test_guest_comments_under_their_own_name(client, make_project, share):
    project_id = make_project()
    guest = share(project_id)
    comment = post(client, project_id, guest["token"], userName="Kim from the agency", user="admin").json()
    assert comment["userName"] == "Kim from the agency"
    assert comment["user"].startswith("guest_")


def test_only_author_or_admin_deletes(client, admin, make_project, make_user, grant, share):
    project_id = make_project()
    author, other = make_user(), make_user()
    grant(project_id, author["user"]["id"])
    grant(project_id, other["user"]["id"])
    guest = share(project_id)

    def delete(comment, token):
        return client.delete(f"/api/projects/{project_id}/comment/{comment['id']}", headers=auth(token)).status_code

    comment = post(client, project_id, author["token"]).json()
    assert delete(comment, other["token"]) == 403
    assert delete(comment, guest["token"]) == 403
    assert delete(comment, author["token"]) == 200

    comment = post(client, project_id, author["token"]).json()
    assert delete(comment, admin["token"]) == 200

    guest_comment = post(client, project_id, guest["token"], userName="Kim").json()
    other_guest = share(project_id)
    assert delete(guest_comment, other_guest["token"]) == 403
    assert delete(guest_comment, guest["token"]) == 200


def test_reply_must_point_at_a_comment_in_the_project(client, admin, make_project):
    project_id = make_project()
    parent = post(client, project_id, admin["token"]).json()
    assert post(client, project_id, admin["token"], parentId=parent["id"]).json()["parentId"] == parent["id"]
    assert post(client, project_id, admin["token"], parentId="nope").json()["parentId"] is None


def _mentions(client, token):
    res = client.get("/api/notifications", headers=auth(token))
    return [n for n in res.json()["notifications"] if n["type"] == "mention"]


def test_tagging_someone_tells_them_once_and_only_people_with_review(client, admin, make_project, make_user, grant):
    project_id = make_project()
    rita, lars = make_user(), make_user()
    grant(project_id, rita["user"]["id"])
    grant(project_id, lars["user"]["id"], can_review=False, can_tasks=True)  # no Review tab
    text = f"@{rita['user']['username']} and @{lars['user']['username']}, see this. Again @{rita['user']['username']}."
    post(client, project_id, admin["token"], text=text, clipBaseName="shot_010")
    told = _mentions(client, rita["token"])
    assert len(told) == 1
    assert "tagged you on shot_010" in told[0]["title"]
    assert told[0]["link"] == f"/p/{project_id}/review?clip=shot_010"
    assert _mentions(client, lars["token"]) == []
    # tagging yourself tells nobody
    post(client, project_id, rita["token"], text=f"note to @{rita['user']['username']}")
    assert len(_mentions(client, rita["token"])) == 1


def test_a_reply_tells_the_author_of_the_comment(client, admin, make_project, make_user, grant):
    project_id = make_project()
    rita = make_user()
    grant(project_id, rita["user"]["id"])
    parent = post(client, project_id, rita["token"], text="Too dark?").json()
    drawing = {"strokes": [{"x": 1, "y": 1}, {"x": 2, "y": 2}], "frame": 12}
    reply = post(client, project_id, admin["token"], text="Like this", parentId=parent["id"], drawing=drawing).json()
    assert reply["parentId"] == parent["id"] and reply["drawing"]["strokes"]
    told = _mentions(client, rita["token"])
    assert [n["title"] for n in told] == ["admin replied to your comment on a clip"]
    # answering yourself tells nobody
    post(client, project_id, rita["token"], text="ok", parentId=parent["id"])
    assert len(_mentions(client, rita["token"])) == 1
