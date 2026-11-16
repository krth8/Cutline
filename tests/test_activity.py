"""The activity log: what is recorded, the list for one project and the list of what concerns me."""

import pytest

from api import auth as api_auth

from conftest import auth


@pytest.fixture(autouse=True)
def no_rate_limit():
    api_auth.comment_attempts.clear()


def activity(client, token, **params):
    res = client.get("/api/activity", params=params, headers=auth(token))
    assert res.status_code == 200, res.text
    return res.json()["events"]


def make_task(client, token, project_id, **body):
    res = client.post(f"/api/projects/{project_id}/tasks", json={"name": "Grade pass", **body}, headers=auth(token))
    assert res.status_code == 200, res.text
    return res.json()["task"]


def patch_task(client, token, task_id, **body):
    res = client.patch(f"/api/tasks/{task_id}", json=body, headers=auth(token))
    assert res.status_code == 200, res.text
    return res.json()["task"]


def test_task_changes_are_recorded_one_event_per_thing(client, admin, make_project, make_user, grant):
    project_id = make_project()
    rita = make_user()
    grant(project_id, rita["user"]["id"], can_tasks=True)
    task = make_task(client, admin["token"], project_id)
    other = client.post("/api/statuses", json={"name": "In grade"}, headers=auth(admin["token"])).json()["status"]
    patch_task(client, admin["token"], task["id"], statusId=other["id"], assigneeIds=[rita["user"]["id"]],
               dueDate="2026-12-01", name="Grade pass v2")
    # a change that touches none of the four is not an event
    patch_task(client, admin["token"], task["id"], description="notes")

    events = activity(client, admin["token"], scope="project", projectId=project_id)
    assert sorted(e["kind"] for e in events) == ["task.assigned", "task.created", "task.due", "task.renamed", "task.status"]
    by_kind = {e["kind"]: e for e in events}
    assert by_kind["task.status"]["detail"]["to"] == other["name"]
    assert by_kind["task.assigned"]["detail"]["to"] == [rita["user"]["username"]]
    assert by_kind["task.due"]["detail"] == {"from": None, "to": "2026-12-01"}
    assert by_kind["task.renamed"]["detail"] == {"from": "Grade pass"} and by_kind["task.renamed"]["title"] == "Grade pass v2"
    assert all(e["actorName"] == "admin" and e["projectName"] and e["link"].endswith(f"?task={task['id']}") for e in events)


def test_for_me_is_what_others_did_that_concerns_me(client, admin, make_project, make_user, grant):
    project_id = make_project()
    rita = make_user()
    grant(project_id, rita["user"]["id"], can_tasks=True)
    mine = make_task(client, admin["token"], project_id, assigneeIds=[rita["user"]["id"]], name="For Rita")
    make_task(client, admin["token"], project_id, name="Not hers")
    patch_task(client, rita["token"], mine["id"], dueDate="2026-12-02")  # her own change

    seen = activity(client, rita["token"], scope="me")
    assert [(e["kind"], e["title"]) for e in seen] == [("task.created", "For Rita")]
    # the admin made the task, so Rita's change concerns the admin
    assert [(e["kind"], e["actorName"]) for e in activity(client, admin["token"], scope="me")] == [("task.due", rita["user"]["username"])]


def test_pages_and_comments_are_recorded_and_follow_the_tabs(client, admin, make_project, make_user, grant):
    project_id = make_project()
    reviewer, planner = make_user(), make_user()
    grant(project_id, reviewer["user"]["id"], can_review=True, can_tasks=False)
    grant(project_id, planner["user"]["id"], can_review=False, can_tasks=True)
    res = client.post(f"/api/spaces/p:{project_id}/pages", json={"title": "Brief"}, headers=auth(admin["token"]))
    assert res.status_code in (200, 201), res.text
    make_task(client, admin["token"], project_id)
    res = client.post(f"/api/projects/{project_id}/comment", headers=auth(admin["token"]),
                      json={"frame": 3, "text": f"@{reviewer['user']['username']} too dark", "clipBaseName": "shot_010"})
    assert res.status_code == 200, res.text

    kinds = lambda who: sorted(e["kind"] for e in activity(client, who["token"], scope="project", projectId=project_id))
    assert kinds(admin) == ["comment.added", "page.created", "task.created"]
    assert kinds(reviewer) == ["comment.added"]            # Review only: no tasks or pages
    assert kinds(planner) == ["page.created", "task.created"]  # Home only: no review comments
    tagged = activity(client, reviewer["token"], scope="me")
    assert [e["kind"] for e in tagged] == ["comment.added"] and tagged[0]["detail"]["text"].endswith("too dark")


def test_other_peoples_projects_are_closed(client, admin, make_project, make_user):
    project_id = make_project()
    stranger = make_user()
    make_task(client, admin["token"], project_id)
    assert activity(client, stranger["token"], scope="me") == []
    res = client.get("/api/activity", params={"scope": "project", "projectId": project_id}, headers=auth(stranger["token"]))
    assert res.status_code == 404
    assert client.get("/api/activity").status_code == 401
