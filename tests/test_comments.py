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
