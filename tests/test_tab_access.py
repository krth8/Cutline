"""Access per tab: a person's access to a project is three switches, Main (can_tasks: pages and tasks),
Review (can_review) and Lounge (can_lounge). Each one opens its own data and nothing else."""

import pytest

from conftest import auth


@pytest.fixture
def project(make_project):
    return make_project("Tabs")


def give(client, admin, project, user, **flags):
    body = {"userId": user["user"]["id"], "canReview": False, "canTasks": False, "canLounge": False, **flags}
    res = client.post(f"/api/projects/{project}/access", json=body, headers=auth(admin["token"]))
    assert res.status_code == 200, res.text
    return res.json()["access"]


def listed(client, user, project):
    projects = client.get("/api/projects", headers=auth(user["token"])).json()["projects"]
    return next((p for p in projects if p["id"] == project), None)


def can(client, user, project):
    """What the user reaches: (pages of the project, its clips, its chat room)."""
    h = auth(user["token"])
    return (
        client.get(f"/api/spaces/p:{project}/pages", headers=h).status_code == 200,
        client.get(f"/api/projects/{project}", headers=h).status_code == 200,
        client.get(f"/api/projects/{project}/chat", headers=h).status_code == 200,
    )


def test_each_switch_opens_its_own_tab_and_nothing_else(client, admin, make_user, project):
    main, review, lounge, none = make_user(), make_user(), make_user(), make_user()
    assert give(client, admin, project, main, canTasks=True)["canLounge"] is False
    give(client, admin, project, review, canReview=True)
    give(client, admin, project, lounge, canLounge=True)
    assert can(client, main, project) == (True, False, False)
    assert can(client, review, project) == (False, True, False)
    assert can(client, lounge, project) == (False, False, True)
    assert can(client, none, project) == (False, False, False)
    assert can(client, admin, project) == (True, True, True)
    # the project list tells the client which tabs to show
    seen = listed(client, lounge, project)
    assert (seen["canTasks"], seen["canReview"], seen["canLounge"]) == (False, False, True)


def test_the_lounge_switch_guards_the_room_and_its_messages(client, admin, make_user, project):
    member, reviewer = make_user(), make_user()
    give(client, admin, project, member, canLounge=True)
    give(client, admin, project, reviewer, canReview=True)
    room = client.get(f"/api/projects/{project}/chat", headers=auth(member["token"])).json()["id"]
    assert client.get(f"/api/chat/rooms/{room}", headers=auth(member["token"])).status_code == 200
    assert client.get(f"/api/chat/rooms/{room}/messages", headers=auth(member["token"])).status_code == 200
    assert client.get(f"/api/chat/rooms/{room}", headers=auth(reviewer["token"])).status_code == 403
    assert client.get(f"/api/chat/rooms/{room}/messages", headers=auth(reviewer["token"])).status_code == 403


def test_a_switch_can_be_changed_later(client, admin, make_user, project):
    user = make_user()
    give(client, admin, project, user, canReview=True, canLounge=True)
    assert can(client, user, project) == (False, True, True)
    res = client.patch(f"/api/projects/{project}/access/{user['user']['id']}", json={"canLounge": False, "canTasks": True},
                       headers=auth(admin["token"]))
    assert res.status_code == 200, res.text
    assert can(client, user, project) == (True, True, False)


def test_access_granted_without_saying_keeps_the_lounge(client, admin, make_user, project, grant):
    user = make_user()
    grant(project, user["user"]["id"])  # the old call: review, no tasks, nothing said about the Lounge
    assert can(client, user, project) == (False, True, True)


def test_an_invite_carries_the_tabs(client, admin, project):
    res = client.post("/api/admin/invites", json={"role": "viewer", "projectId": project, "canReview": False,
                                                  "canTasks": False, "canLounge": True}, headers=auth(admin["token"]))
    assert res.status_code == 200, res.text
    invite = res.json()["invite"]
    assert (invite["canReview"], invite["canTasks"], invite["canLounge"]) == (False, False, True)
    shown = [i for i in client.get("/api/admin/invites", headers=auth(admin["token"])).json()["invites"] if i["id"] == invite["id"]]
    assert shown and shown[0]["canLounge"] is True and shown[0]["canReview"] is False
