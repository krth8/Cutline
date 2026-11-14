"""The task API: every change is in the database when the 200 arrives (never only in memory)."""

import pytest

import database
from api.state import projects, tasks as task_cache

from conftest import auth
from test_live import connect, watch, nothing_pending  # noqa: F401  (connect is a fixture)


@pytest.fixture
def project(make_project):
    return make_project("Tasks")


@pytest.fixture
def editor(make_user, grant, project):
    """An editor with task access on the project."""
    u = make_user()
    grant(project, u["user"]["id"], can_review=True, can_tasks=True)
    return u


@pytest.fixture
def api(client):
    """call(method, path, user, json) -> response."""
    def call(method, path, user, json=None):
        return client.request(method, path, json=json, headers=auth(user["token"]))
    return call


@pytest.fixture
def new_task(api, project):
    def _new(user, name="Task", **extra):
        res = api("POST", f"/api/projects/{project}/tasks", user, {"name": name, **extra})
        assert res.status_code == 200, res.text
        return res.json()["task"]
    return _new


def stored(task_id):
    """What the database holds, not the in-memory copy."""
    task = database.db_get_task(task_id)
    assert task is not None
    return task


def add_clip(project, base_name):
    """A clip that exists in the database and in memory. Returns its database id."""
    clip_id = database.db_add_clip_version(project, base_name, 1, f"{base_name}.mp4")["clipId"]
    projects[project].setdefault("clips", {})[base_name] = {
        "activeVersion": 1, "versions": [{"version": 1, "filename": f"{base_name}.mp4", "uploadedAt": "2030-01-01T00:00:00"}]}
    return clip_id


# ---------- CRUD, saved immediately ----------

def test_create_is_in_the_database(admin, new_task):
    task = new_task(admin, "Grade shot 4", description="Warmer", priority="high", dueDate="2030-01-02",
                    stageTag="Lighting", customFields={"shot": 4})
    row = stored(task["id"])
    assert row["name"] == "Grade shot 4"
    assert row["description"] == "Warmer"
    assert row["priority"] == "high"
    assert row["dueDate"] == "2030-01-02"
    assert row["stageTag"] == "Lighting"
    assert row["customFields"] == {"shot": 4}
    assert row["createdBy"] == admin["user"]["id"]


def test_create_needs_a_name_and_a_project(api, admin, project):
    assert api("POST", f"/api/projects/{project}/tasks", admin, {}).status_code == 400
    assert api("POST", "/api/projects/nope/tasks", admin, {"name": "x"}).status_code == 404


def test_get_and_list(api, admin, project, new_task):
    a, b = new_task(admin, "A"), new_task(admin, "B", priority="low")
    assert api("GET", f"/api/tasks/{a['id']}", admin).json()["task"]["name"] == "A"
    assert api("GET", "/api/tasks/nope", admin).status_code == 404

    listed = api("GET", f"/api/projects/{project}/tasks", admin).json()["tasks"]
    assert [t["id"] for t in listed] == [a["id"], b["id"]]
    low = api("GET", f"/api/projects/{project}/tasks?priority=low", admin).json()["tasks"]
    assert [t["id"] for t in low] == [b["id"]]


def test_update_every_field_is_saved(api, admin, new_task):
    task = new_task(admin, "Old")
    status = database.db_create_status("Approved", "#00ff00")
    res = api("PATCH", f"/api/tasks/{task['id']}", admin, {
        "name": "New", "description": "Desc", "priority": "urgent", "dueDate": "2031-05-06",
        "stageTag": "FX", "statusId": status["id"], "customFields": {"a": 1}, "sortOrder": 7,
    })
    assert res.status_code == 200, res.text
    row = stored(task["id"])
    assert (row["name"], row["description"], row["priority"], row["dueDate"], row["stageTag"]) == \
        ("New", "Desc", "urgent", "2031-05-06", "FX")
    assert row["statusId"] == status["id"] and row["status"]["name"] == "Approved"
    assert row["customFields"] == {"a": 1}
    assert row["sortOrder"] == 7
    # the response and the in-memory copy agree with the database
    assert res.json()["task"]["status"]["name"] == "Approved"
    assert task_cache[task["id"]]["name"] == "New"


def test_a_partial_update_keeps_other_fields(api, admin, new_task):
    task = new_task(admin, "Keep", priority="high", description="d")
    api("PATCH", f"/api/tasks/{task['id']}", admin, {"name": "Renamed"})
    row = stored(task["id"])
    assert (row["name"], row["priority"], row["description"]) == ("Renamed", "high", "d")


def test_update_rejects_bad_input(api, admin, new_task):
    task = new_task(admin)
    assert api("PATCH", f"/api/tasks/{task['id']}", admin, {"name": ""}).status_code == 400
    assert api("PATCH", f"/api/tasks/{task['id']}", admin, {"statusId": "no-such-status"}).status_code == 400
    assert api("PATCH", f"/api/tasks/{task['id']}", admin, {"assigneeIds": ["ghost"]}).status_code == 400
    assert api("PATCH", "/api/tasks/nope", admin, {"name": "x"}).status_code == 404
    assert stored(task["id"])["name"] == "Task"


def test_delete_removes_the_task_and_its_subtasks(api, admin, new_task):
    parent = new_task(admin, "Parent")
    child = new_task(admin, "Child", parentId=parent["id"])
    grandchild = new_task(admin, "Grandchild", parentId=child["id"])
    assert api("DELETE", f"/api/tasks/{parent['id']}", admin).json() == {"success": True}
    for t in (parent, child, grandchild):
        assert database.db_get_task(t["id"]) is None
        assert t["id"] not in task_cache
    assert api("DELETE", f"/api/tasks/{parent['id']}", admin).status_code == 404


# ---------- subtasks ----------

def test_subtasks_and_child_count(api, admin, project, new_task):
    parent = new_task(admin, "Shot")
    one = new_task(admin, "Comp", parentId=parent["id"])
    two = new_task(admin, "Light", parentId=parent["id"])
    assert one["parentId"] == parent["id"]
    assert stored(parent["id"])["childCount"] == 2
    assert task_cache[parent["id"]]["childCount"] == 2

    # the root list hides subtasks, the parent filter shows them
    roots = api("GET", f"/api/projects/{project}/tasks", admin).json()["tasks"]
    assert parent["id"] in [t["id"] for t in roots] and one["id"] not in [t["id"] for t in roots]
    kids = api("GET", f"/api/projects/{project}/tasks?parent_id={parent['id']}", admin).json()["tasks"]
    assert {t["id"] for t in kids} == {one["id"], two["id"]}

    tree = api("GET", f"/api/projects/{project}/tasks?view=hierarchy", admin).json()["tasks"]
    node = next(t for t in tree if t["id"] == parent["id"])
    assert {c["id"] for c in node["children"]} == {one["id"], two["id"]}

    api("DELETE", f"/api/tasks/{one['id']}", admin)
    assert stored(parent["id"])["childCount"] == 1
    assert task_cache[parent["id"]]["childCount"] == 1


def test_moving_a_task_updates_both_parents(api, admin, new_task):
    a, b = new_task(admin, "A"), new_task(admin, "B")
    child = new_task(admin, "Child", parentId=a["id"])
    res = api("PATCH", f"/api/tasks/{child['id']}", admin, {"parentId": b["id"]})
    assert res.status_code == 200, res.text
    assert stored(child["id"])["parentId"] == b["id"]
    assert stored(a["id"])["childCount"] == 0 and task_cache[a["id"]]["childCount"] == 0
    assert stored(b["id"])["childCount"] == 1 and task_cache[b["id"]]["childCount"] == 1


def test_bad_parents_are_refused(api, admin, make_project, new_task):
    a = new_task(admin, "A")
    child = new_task(admin, "Child", parentId=a["id"])
    foreign = api("POST", f"/api/projects/{make_project()}/tasks", admin, {"name": "Elsewhere"}).json()["task"]

    assert api("PATCH", f"/api/tasks/{a['id']}", admin, {"parentId": a["id"]}).status_code == 400
    assert api("PATCH", f"/api/tasks/{a['id']}", admin, {"parentId": child["id"]}).status_code == 400
    assert api("PATCH", f"/api/tasks/{a['id']}", admin, {"parentId": foreign["id"]}).status_code == 400
    assert api("POST", f"/api/projects/{a['projectId']}/tasks", admin,
               {"name": "x", "parentId": "nope"}).status_code == 400
    assert stored(a["id"])["parentId"] is None


# ---------- assignees ----------

def test_assignees(api, admin, editor, make_user, project, new_task):
    other = make_user()
    me, them = editor["user"]["id"], other["user"]["id"]
    task = new_task(admin, "Assigned", assigneeIds=[me, them])
    assert [a["id"] for a in stored(task["id"])["assignees"]] == [me, them]
    assert stored(task["id"])["assignee"]["id"] == me

    api("PATCH", f"/api/tasks/{task['id']}", admin, {"assigneeIds": [them]})
    assert [a["id"] for a in stored(task["id"])["assignees"]] == [them]
    assert [a["id"] for a in task_cache[task["id"]]["assignees"]] == [them]

    # the single-assignee form still works
    api("PATCH", f"/api/tasks/{task['id']}", admin, {"assigneeId": me})
    assert [a["id"] for a in stored(task["id"])["assignees"]] == [me]

    mine = api("GET", f"/api/projects/{project}/tasks?assignee_id={me}", admin).json()["tasks"]
    assert [t["id"] for t in mine] == [task["id"]]

    assert api("PATCH", f"/api/tasks/{task['id']}", admin, {"assigneeIds": []}).status_code == 200
    assert stored(task["id"])["assignees"] == []
    assert "assignee" not in stored(task["id"]) and "assignee" not in task_cache[task["id"]]


def test_unknown_assignee_on_create_is_refused(api, admin, project):
    res = api("POST", f"/api/projects/{project}/tasks", admin, {"name": "x", "assigneeIds": ["ghost"]})
    assert res.status_code == 400


# ---------- reorder ----------

def test_reorder_is_saved(api, admin, project, new_task):
    a, b, c = new_task(admin, "A"), new_task(admin, "B"), new_task(admin, "C")
    res = api("POST", f"/api/projects/{project}/tasks/reorder", admin, {"taskIds": [c["id"], a["id"], b["id"]]})
    assert res.json() == {"success": True}
    assert [stored(t["id"])["sortOrder"] for t in (c, a, b)] == [0, 1, 2]
    listed = api("GET", f"/api/projects/{project}/tasks", admin).json()["tasks"]
    assert [t["id"] for t in listed] == [c["id"], a["id"], b["id"]]
    assert api("POST", f"/api/projects/{project}/tasks/reorder", admin, {}).status_code == 400


def test_reorder_ignores_tasks_of_other_projects(api, admin, make_project, project, new_task):
    mine = new_task(admin, "Mine")
    foreign = api("POST", f"/api/projects/{make_project()}/tasks", admin, {"name": "Theirs"}).json()["task"]
    api("PATCH", f"/api/tasks/{foreign['id']}", admin, {"sortOrder": 9})
    api("POST", f"/api/projects/{project}/tasks/reorder", admin, {"taskIds": [foreign["id"], mine["id"]]})
    assert stored(foreign["id"])["sortOrder"] == 9
    assert stored(mine["id"])["sortOrder"] == 0


# ---------- stages ----------

def test_stages(api, admin, project, new_task):
    new_task(admin, "A", stageTag="Lighting")
    new_task(admin, "B", stageTag="Animation")
    new_task(admin, "C", stageTag="Lighting")
    new_task(admin, "D")
    stages = api("GET", f"/api/projects/{project}/tasks/stages", admin).json()
    assert stages["usedStages"] == ["Animation", "Lighting"]
    assert "Previz" in stages["suggestedStages"]
    filtered = api("GET", f"/api/projects/{project}/tasks?stage_tag=Animation", admin).json()["tasks"]
    assert [t["name"] for t in filtered] == ["B"]


# ---------- checklist ----------

def test_checklist(api, admin, new_task):
    task = new_task(admin)
    base = f"/api/tasks/{task['id']}/checklist"
    assert api("POST", base, admin, {"text": "  "}).status_code == 400
    item = api("POST", base, admin, {"text": "Check audio"}).json()["item"]
    assert [i["text"] for i in database.db_list_checklist_items(task["id"])] == ["Check audio"]

    assert api("PATCH", f"{base}/{item['id']}", admin, {"isChecked": True}).status_code == 200
    assert database.db_list_checklist_items(task["id"])[0]["isChecked"]
    assert api("GET", base, admin).json()["items"][0]["text"] == "Check audio"
    assert api("PATCH", f"{base}/nope", admin, {"text": "x"}).status_code == 404

    assert api("DELETE", f"{base}/{item['id']}", admin).json() == {"success": True}
    assert database.db_list_checklist_items(task["id"]) == []
    assert api("DELETE", f"{base}/{item['id']}", admin).status_code == 404


# ---------- task comments ----------

def test_task_comments(api, admin, editor, new_task):
    task = new_task(admin)
    base = f"/api/tasks/{task['id']}/comments"
    assert api("POST", base, admin, {"text": " "}).status_code == 400
    comment = api("POST", base, editor, {"text": "On it"}).json()["comment"]
    assert [c["text"] for c in api("GET", base, admin).json()["comments"]] == ["On it"]

    # only the author or an admin deletes
    note = api("POST", base, admin, {"text": "Admin note"}).json()["comment"]
    assert api("DELETE", f"{base}/{note['id']}", editor).status_code == 403
    assert api("DELETE", f"{base}/{comment['id']}", editor).json() == {"success": True}
    assert api("DELETE", f"{base}/{note['id']}", admin).json() == {"success": True}
    assert api("GET", base, admin).json()["comments"] == []
    assert api("DELETE", f"{base}/nope", admin).status_code == 404


# ---------- clip links ----------

def test_clip_links(api, admin, project, new_task):
    clip_id = add_clip(project, "shot_010")
    task, other = new_task(admin), new_task(admin, "Other")
    base = f"/api/tasks/{task['id']}/clips"

    assert api("POST", base, admin, {}).status_code == 400
    assert api("POST", base, admin, {"clipId": clip_id}).json() == {"success": True}
    assert [c["id"] for c in database.db_get_task_clips(task["id"])] == [clip_id]
    assert [c["baseName"] for c in api("GET", base, admin).json()["clips"]] == ["shot_010"]
    assert [t["id"] for t in api("GET", f"/api/clips/{clip_id}/tasks", admin).json()["tasks"]] == [task["id"]]
    assert api("GET", f"/api/projects/{project}/untagged-clips", admin).json()["clips"] == []

    assert api("DELETE", f"{base}/{clip_id}", admin).json() == {"success": True}
    assert database.db_get_task_clips(task["id"]) == []
    assert api("DELETE", f"{base}/{clip_id}", admin).status_code == 404
    assert api("GET", "/api/clips/999999/tasks", admin).status_code == 404
    assert api("GET", f"/api/tasks/{other['id']}/clips", admin).json()["clips"] == []


# ---------- clip status ----------

def test_clip_status_is_saved(api, admin, project):
    add_clip(project, "grade")
    status = database.db_create_status("In review", "#ff8800")
    path = f"/api/projects/{project}/clips/grade/status"

    assert api("PATCH", path, admin, {"statusId": status["id"]}).json() == {"success": True}
    assert database.db_get_clip_status(project, "grade")["name"] == "In review"
    assert projects[project]["clips"]["grade"]["statusId"] == status["id"]

    assert api("PATCH", path, admin, {"statusId": "nope"}).status_code == 400
    assert database.db_get_clip_status(project, "grade")["id"] == status["id"]

    assert api("PATCH", path, admin, {"statusId": None}).status_code == 200
    assert database.db_get_clip_status(project, "grade") is None
    assert "statusId" not in projects[project]["clips"]["grade"]
    assert api("PATCH", f"/api/projects/{project}/clips/missing/status", admin, {}).status_code == 404


def test_saving_a_clip_keeps_its_task_links(api, admin, project, new_task):
    """Writing a clip must update it, not delete and re-create it (that dropped its task links)."""
    import server
    clip_id = add_clip(project, "linked")
    task = new_task(admin)
    api("POST", f"/api/tasks/{task['id']}/clips", admin, {"clipId": clip_id})
    import asyncio
    asyncio.run(server.save_clip(project, "linked"))
    assert [c["id"] for c in database.db_get_task_clips(task["id"])] == [clip_id]


# ---------- access rules ----------

def test_no_access_at_all(api, project, new_task, admin, make_user):
    task = new_task(admin)
    outsider = make_user()
    for method, path, body in [
        ("GET", f"/api/projects/{project}/tasks", None),
        ("POST", f"/api/projects/{project}/tasks", {"name": "x"}),
        ("POST", f"/api/projects/{project}/tasks/reorder", {"taskIds": [task["id"]]}),
        ("GET", f"/api/projects/{project}/tasks/stages", None),
        ("GET", f"/api/projects/{project}/untagged-clips", None),
        ("GET", f"/api/tasks/{task['id']}", None),
        ("PATCH", f"/api/tasks/{task['id']}", {"name": "hacked"}),
        ("DELETE", f"/api/tasks/{task['id']}", None),
        ("GET", f"/api/tasks/{task['id']}/comments", None),
        ("POST", f"/api/tasks/{task['id']}/comments", {"text": "hi"}),
        ("GET", f"/api/tasks/{task['id']}/clips", None),
        ("POST", f"/api/tasks/{task['id']}/clips", {"clipId": 1}),
        ("GET", f"/api/tasks/{task['id']}/checklist", None),
        ("POST", f"/api/tasks/{task['id']}/checklist", {"text": "x"}),
    ]:
        res = api(method, path, outsider, body)
        assert res.status_code == 403, (method, path, res.status_code)
    assert stored(task["id"])["name"] == "Task"


def test_review_access_without_task_access(api, project, new_task, admin, make_user, grant):
    task = new_task(admin)
    reviewer = make_user()
    grant(project, reviewer["user"]["id"], can_review=True, can_tasks=False)
    assert api("GET", f"/api/projects/{project}/tasks", reviewer).status_code == 403
    assert api("GET", f"/api/tasks/{task['id']}", reviewer).status_code == 403
    assert api("GET", f"/api/tasks/{task['id']}/comments", reviewer).status_code == 403
    assert api("PATCH", f"/api/tasks/{task['id']}", reviewer, {"name": "x"}).status_code == 403
    assert api("POST", f"/api/projects/{project}/tasks", reviewer, {"name": "x"}).status_code == 403
    assert api("DELETE", f"/api/tasks/{task['id']}", reviewer).status_code == 403
    # the project's clips are still theirs to see
    assert api("GET", f"/api/projects/{project}/untagged-clips", reviewer).status_code == 200
    assert stored(task["id"])["name"] == "Task"


def test_task_access_lets_an_editor_do_everything(api, editor, project):
    res = api("POST", f"/api/projects/{project}/tasks", editor, {"name": "Mine"})
    assert res.status_code == 200
    task = res.json()["task"]
    assert api("PATCH", f"/api/tasks/{task['id']}", editor, {"name": "Mine 2"}).status_code == 200
    assert stored(task["id"])["name"] == "Mine 2"
    assert api("DELETE", f"/api/tasks/{task['id']}", editor).status_code == 200
    assert database.db_get_task(task["id"]) is None


def test_viewers_can_read_but_not_edit(api, admin, make_user, grant, project, new_task):
    task = new_task(admin)
    viewer = make_user("viewer")
    grant(project, viewer["user"]["id"], can_review=True, can_tasks=True)
    assert api("GET", f"/api/projects/{project}/tasks", viewer).status_code == 200
    assert api("GET", f"/api/tasks/{task['id']}", viewer).status_code == 200
    for method, path, body in [
        ("POST", f"/api/projects/{project}/tasks", {"name": "x"}),
        ("PATCH", f"/api/tasks/{task['id']}", {"name": "x"}),
        ("DELETE", f"/api/tasks/{task['id']}", None),
        ("POST", f"/api/projects/{project}/tasks/reorder", {"taskIds": [task["id"]]}),
        ("POST", f"/api/tasks/{task['id']}/clips", {"clipId": 1}),
        ("POST", f"/api/tasks/{task['id']}/checklist", {"text": "x"}),
    ]:
        assert api(method, path, viewer, body).status_code == 403, (method, path)
    assert stored(task["id"])["name"] == "Task"


def test_guests_are_refused(client, admin, project, share, new_task):
    task = new_task(admin)
    headers = auth(share(project)["token"])
    refused = (401, 403)
    assert client.get(f"/api/projects/{project}/tasks", headers=headers).status_code in refused
    assert client.get(f"/api/tasks/{task['id']}", headers=headers).status_code in refused
    assert client.post(f"/api/projects/{project}/tasks", json={"name": "x"}, headers=headers).status_code in refused
    assert client.patch(f"/api/tasks/{task['id']}", json={"name": "x"}, headers=headers).status_code in refused
    assert client.delete(f"/api/tasks/{task['id']}", headers=headers).status_code in refused
    assert stored(task["id"])["name"] == "Task"


def test_not_logged_in(client, project):
    assert client.get(f"/api/projects/{project}/tasks").status_code == 401
    assert client.post(f"/api/projects/{project}/tasks", json={"name": "x"}).status_code == 401


# ---------- live events ----------

def test_live_events_for_task_changes(client, admin, project, connect):
    with connect(admin["token"], "writer") as writer, connect(admin["token"], "watcher") as watcher:
        watch(writer, project)
        watch(watcher, project)
        h = {**auth(admin["token"]), "X-Client-Id": "writer"}

        task = client.post(f"/api/projects/{project}/tasks", json={"name": "Live"}, headers=h).json()["task"]
        event = watcher.receive_json()
        assert event["type"] == "task_created" and event["task"]["id"] == task["id"]
        assert watcher.receive_json()["type"] == "rows_changed"  # table views hear of it too
        assert nothing_pending(writer)  # the tab that made the change is not told

        client.patch(f"/api/tasks/{task['id']}", json={"name": "Live 2"}, headers=h)
        event = watcher.receive_json()
        assert event["type"] == "task_updated" and event["task"]["name"] == "Live 2"
        assert watcher.receive_json()["type"] == "rows_changed"

        client.post(f"/api/projects/{project}/tasks/reorder", json={"taskIds": [task["id"]]}, headers=h)
        assert watcher.receive_json() == {"type": "tasks_reordered", "project": project}
        assert watcher.receive_json()["type"] == "rows_changed"

        item = client.post(f"/api/tasks/{task['id']}/checklist", json={"text": "x"}, headers=h).json()["item"]
        assert watcher.receive_json() == {"type": "task_checklist_changed", "taskId": task["id"], "project": project}
        client.delete(f"/api/tasks/{task['id']}/checklist/{item['id']}", headers=h)
        assert watcher.receive_json()["type"] == "task_checklist_changed"

        client.post(f"/api/tasks/{task['id']}/comments", json={"text": "hi"}, headers=h)
        assert watcher.receive_json() == {"type": "task_comments_changed", "taskId": task["id"], "project": project}

        clip_id = add_clip(project, "live_clip")
        client.post(f"/api/tasks/{task['id']}/clips", json={"clipId": clip_id}, headers=h)
        assert watcher.receive_json() == {"type": "task_clips_changed", "taskId": task["id"], "project": project}

        client.delete(f"/api/tasks/{task['id']}", headers=h)
        assert watcher.receive_json() == {"type": "task_deleted", "taskId": task["id"], "parentId": None,
                                          "project": project}
        assert watcher.receive_json()["type"] == "rows_changed"
        assert nothing_pending(writer)


def test_clip_status_change_reaches_other_tabs(client, admin, project, connect):
    add_clip(project, "live_status")
    status = database.db_create_status("Live", "#abcdef")
    with connect(admin["token"], "writer") as writer, connect(admin["token"], "watcher") as watcher:
        watch(writer, project)
        watch(watcher, project)
        client.patch(f"/api/projects/{project}/clips/live_status/status", json={"statusId": status["id"]},
                     headers={**auth(admin["token"]), "X-Client-Id": "writer"})
        event = watcher.receive_json()
        assert event["type"] == "clip_updated" and event["clip"]["statusId"] == status["id"]
        assert nothing_pending(writer)
