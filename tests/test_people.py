"""The people of a project and what they are doing: tabs tell their place over the live socket, Lounge reads it."""

import pytest

from api import auth as api_auth

from conftest import auth
from test_live import connect, nothing_pending  # noqa: F401  (connect is a fixture)


@pytest.fixture(autouse=True)
def no_rate_limit():
    api_auth.comment_attempts.clear()


def people(client, token, project_id):
    res = client.get(f"/api/projects/{project_id}/people", headers=auth(token))
    assert res.status_code == 200, res.text
    return {p["username"]: p for p in res.json()["people"]}


def test_people_are_the_members_and_the_admins_with_their_place(client, admin, make_project, make_user, grant, connect):
    project_id = make_project()
    rita, lars, stranger = make_user(), make_user(), make_user()
    grant(project_id, rita["user"]["id"])
    grant(project_id, lars["user"]["id"])
    rname, lname = rita["user"]["username"], lars["user"]["username"]

    seen = people(client, admin["token"], project_id)
    # the members and every admin (other tests may have made more admins); the stranger is not one of them
    assert {"admin", rname, lname} <= set(seen)
    assert all(p["role"] == "admin" for name, p in seen.items() if name not in ("admin", rname, lname))  # (admin owns it)
    assert stranger["user"]["username"] not in seen
    assert not any(p["online"] for p in seen.values())

    with connect(rita["token"], "rita-tab") as rita_ws, connect(lars["token"], "lars-tab") as lars_ws:
        rita_ws.send_json({"type": "place", "place": {"projectId": project_id, "label": "Review: shot_010"}})
        # every tab hears that someone moved, the mover's own too (each fetches the list again)
        assert lars_ws.receive_json() == {"type": "presence", "userId": rita["user"]["id"]}
        assert rita_ws.receive_json() == {"type": "presence", "userId": rita["user"]["id"]}
        lars_ws.send_json({"type": "place", "place": {"projectId": "elsewhere", "label": "Brief"}})
        assert rita_ws.receive_json() == {"type": "presence", "userId": lars["user"]["id"]}
        assert lars_ws.receive_json() == {"type": "presence", "userId": lars["user"]["id"]}
        seen = people(client, admin["token"], project_id)
        assert seen[rname]["online"] and seen[rname]["place"] == "Review: shot_010"
        assert seen[lname]["online"] and seen[lname]["place"] is None  # online, but in another project
        # the same place again is not news
        rita_ws.send_json({"type": "place", "place": {"projectId": project_id, "label": "Review: shot_010"}})
        assert nothing_pending(lars_ws) and nothing_pending(rita_ws)
        # online people with a place first
        assert list(people(client, admin["token"], project_id))[:2] == [rname, lname]

    seen = people(client, admin["token"], project_id)
    assert not seen[rname]["online"] and seen[rname]["place"] is None and seen[rname]["lastSeen"]


def test_members_are_the_people_of_the_project_not_every_user(client, admin, make_project, make_user, grant):
    project_id = make_project()
    rita, stranger = make_user(), make_user()
    grant(project_id, rita["user"]["id"])
    res = client.get(f"/api/projects/{project_id}/members", headers=auth(rita["token"]))
    assert res.status_code == 200, res.text
    names = {m["username"]: m for m in res.json()["members"]}
    assert {"admin", rita["user"]["username"]} <= set(names)
    assert stranger["user"]["username"] not in names
    assert all(m["role"] == "admin" for name, m in names.items() if name != rita["user"]["username"])


def test_people_need_the_lounge_tab(client, admin, make_project, make_user):
    project_id = make_project()
    reviewer, stranger = make_user(), make_user()
    res = client.post(f"/api/projects/{project_id}/access", headers=auth(admin["token"]),
                      json={"userId": reviewer["user"]["id"], "canReview": True, "canTasks": False, "canLounge": False})
    assert res.status_code == 200, res.text
    for who in (reviewer, stranger):
        assert client.get(f"/api/projects/{project_id}/people", headers=auth(who["token"])).status_code == 403
    assert client.get("/api/projects/nope/people", headers=auth(admin["token"])).status_code == 404
