"""Notifications about tasks: assignment, comments (with @tags) and status changes for followers, follow and unfollow,
each person's choices, editing a comment, and due-date reminders."""

from datetime import date, datetime, timedelta

import pytest

from api import notify
from conftest import auth


@pytest.fixture
def team(client, make_project, make_user, grant):
    project = make_project("Notify")
    people = {name: make_user() for name in ("ann", "bob", "cy")}
    for p in people.values():
        grant(project, p["user"]["id"], can_review=True, can_tasks=True)
    outsider = make_user()
    return {"project": project, **people, "outsider": outsider}


def notes(client, person):
    return client.get("/api/notifications", headers=auth(person["token"])).json()["notifications"]


def kinds(client, person):
    return [n["type"] for n in notes(client, person)]


def new_task(client, team, who="ann", **body):
    res = client.post(f"/api/projects/{team['project']}/tasks", json={"name": "Grade pass", **body},
                      headers=auth(team[who]["token"]))
    assert res.status_code == 200, res.text
    return res.json()["task"]


def test_assigning_tells_the_new_assignee_but_not_the_one_who_assigned(client, team):
    task = new_task(client, team, assigneeIds=[team["bob"]["user"]["id"], team["ann"]["user"]["id"]])
    assert kinds(client, team["bob"]) == ["task_assigned"]
    assert notes(client, team["bob"])[0]["link"].endswith(f"task={task['id']}")
    assert kinds(client, team["ann"]) == []
    client.patch(f"/api/tasks/{task['id']}", json={"assigneeIds": [team["bob"]["user"]["id"], team["cy"]["user"]["id"]]},
                 headers=auth(team["ann"]["token"]))
    assert kinds(client, team["cy"]) == ["task_assigned"]
    assert kinds(client, team["bob"]) == ["task_assigned"]  # already on it: nothing new


def test_comments_reach_followers_and_tags_reach_the_tagged(client, team):
    task = new_task(client, team, assigneeIds=[team["bob"]["user"]["id"]])
    before = len(notes(client, team["bob"]))
    cy_name = team["cy"]["user"]["username"]
    res = client.post(f"/api/tasks/{task['id']}/comments", json={"text": f"Looks good @{cy_name}"},
                      headers=auth(team["ann"]["token"]))
    assert res.status_code == 200, res.text
    bob = notes(client, team["bob"])
    assert len(bob) == before + 1 and bob[0]["type"] == "task_comment" and "Looks good" in bob[0]["message"]
    assert kinds(client, team["cy"]) == ["mention"]
    # the writer follows now: a comment from bob reaches ann (the creator anyway) and cy (who was only tagged) not
    client.post(f"/api/tasks/{task['id']}/comments", json={"text": "Thanks"}, headers=auth(team["bob"]["token"]))
    assert kinds(client, team["ann"]) == ["task_comment"]
    assert kinds(client, team["cy"]) == ["mention"]


def test_status_changes_reach_followers_and_unfollow_stops_them(client, team, admin):
    task = new_task(client, team, assigneeIds=[team["bob"]["user"]["id"]])
    statuses = [client.post("/api/statuses", json={"name": n}, headers=auth(admin["token"])).json()["status"]
                for n in ("Notify A", "Notify B")]
    client.patch(f"/api/tasks/{task['id']}", json={"statusId": statuses[0]["id"]}, headers=auth(team["ann"]["token"]))
    assert "task_status" in kinds(client, team["bob"])
    assert "task_status" not in kinds(client, team["ann"])  # her own change

    assert client.get(f"/api/tasks/{task['id']}/follow", headers=auth(team["bob"]["token"])).json() == {"following": True}
    res = client.put(f"/api/tasks/{task['id']}/follow", json={"following": False}, headers=auth(team["bob"]["token"]))
    assert res.json() == {"following": False}
    count = len(notes(client, team["bob"]))
    client.patch(f"/api/tasks/{task['id']}", json={"statusId": statuses[1]["id"]}, headers=auth(team["ann"]["token"]))
    client.post(f"/api/tasks/{task['id']}/comments", json={"text": "Any news?"}, headers=auth(team["ann"]["token"]))
    assert len(notes(client, team["bob"])) == count
    # cy follows by hand and hears the next change
    client.put(f"/api/tasks/{task['id']}/follow", json={"following": True}, headers=auth(team["cy"]["token"]))
    client.patch(f"/api/tasks/{task['id']}", json={"statusId": statuses[0]["id"]}, headers=auth(team["ann"]["token"]))
    assert "task_status" in kinds(client, team["cy"])
    assert client.get(f"/api/tasks/{task['id']}/follow", headers=auth(team["outsider"]["token"])).status_code == 403


def test_a_kind_that_is_turned_off_is_not_stored(client, team):
    prefs = client.get("/api/notifications/prefs", headers=auth(team["bob"]["token"])).json()["kinds"]
    by_kind = {k["kind"]: k["enabled"] for k in prefs}
    assert by_kind["task_assigned"] is True and by_kind["session_joined"] is False
    res = client.put("/api/notifications/prefs", json={"task_assigned": False}, headers=auth(team["bob"]["token"]))
    assert {k["kind"]: k["enabled"] for k in res.json()["kinds"]}["task_assigned"] is False
    new_task(client, team, assigneeIds=[team["bob"]["user"]["id"]])
    assert kinds(client, team["bob"]) == []
    assert client.put("/api/notifications/prefs", json={"nope": True}, headers=auth(team["bob"]["token"])).status_code == 400


def test_only_the_writer_edits_a_comment(client, team):
    task = new_task(client, team)
    comment = client.post(f"/api/tasks/{task['id']}/comments", json={"text": "Frist fredag"},
                          headers=auth(team["ann"]["token"])).json()["comment"]
    url = f"/api/tasks/{task['id']}/comments/{comment['id']}"
    assert client.patch(url, json={"text": "Frist torsdag"}, headers=auth(team["bob"]["token"])).status_code == 403
    res = client.patch(url, json={"text": "Frist torsdag"}, headers=auth(team["ann"]["token"]))
    assert res.status_code == 200 and res.json()["comment"]["text"] == "Frist torsdag" and res.json()["comment"]["updatedAt"]


def test_due_reminders_go_out_once_for_today_and_yesterday(client, team):
    today = date.today()
    bob = team["bob"]["user"]["id"]
    due_today = new_task(client, team, assigneeIds=[bob], dueDate=today.isoformat())
    new_task(client, team, assigneeIds=[bob], dueDate=(today - timedelta(days=1)).isoformat())
    new_task(client, team, assigneeIds=[bob], dueDate=(today - timedelta(days=9)).isoformat())  # long overdue: quiet
    before = len(notes(client, team["bob"]))
    early = datetime.combine(today, datetime.min.time()).replace(hour=notify.REMINDER_HOUR - 1)
    assert notify.due_reminders([due_today], early) == []

    import asyncio
    morning = datetime.combine(today, datetime.min.time()).replace(hour=notify.REMINDER_HOUR)
    asyncio.run(notify.send_due_reminders(morning))
    asyncio.run(notify.send_due_reminders(morning))  # twice: still once each
    titles = [n["title"] for n in notes(client, team["bob"])][: len(notes(client, team["bob"])) - before]
    assert sorted(t.split(":")[0] for t in titles) == ["Due today", "Overdue"]
