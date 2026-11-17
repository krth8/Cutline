"""Trash for tasks (H3): delete hides a task everywhere, restore brings it back with everything attached."""

import asyncio
from datetime import datetime, timedelta

import pytest

import database
import server
from api import trash as trash_job
from api.state import tasks as task_cache
from api.tables.source import TableSource
from database import execute, fetchone, get_db
from database.pages import db_get_page, db_get_task_page, db_write_page_snapshot
from database.task_trash import db_get_trashed_task
from database.tasks import db_get_clip_row_id, db_get_task_by_clip
from fastapi import HTTPException

from conftest import auth
from test_comment_tasks import add_clip, add_comment, make_task as task_from_comment
from test_live import connect, watch, nothing_pending  # noqa: F401  (connect is a fixture)


@pytest.fixture(autouse=True)
def empty_trash_first():
    """The database is shared by the whole run: start every test with an empty trash."""
    with get_db() as conn:
        execute(conn, "DELETE FROM tasks WHERE deleted_at IS NOT NULL")


@pytest.fixture
def project(make_project):
    return make_project("Trash")


@pytest.fixture
def editor(make_user, grant, project):
    u = make_user()
    grant(project, u["user"]["id"], can_review=True, can_tasks=True)
    return u


@pytest.fixture
def other_editor(make_user, grant, project):
    u = make_user()
    grant(project, u["user"]["id"], can_review=True, can_tasks=True)
    return u


@pytest.fixture
def api(client):
    def call(method, path, user, json=None):
        return client.request(method, path, json=json, headers=auth(user["token"]) if user else {})
    return call


@pytest.fixture
def add(api, project):
    def _add(user, name, parent=None, **values):
        res = api("POST", f"/api/tables/tasks:{project}/rows", user,
                  {"values": {"name": name, **values}, **({"parentId": parent} if parent else {})})
        assert res.status_code == 200, res.text
        return res.json()["id"]
    return _add


def names(api, user, ref):
    res = api("POST", f"/api/tables/{ref}/query", user, {})
    assert res.status_code == 200, res.text
    return [r["values"]["name"] for r in res.json()["rows"]]


def trash(api, user, ref):
    res = api("GET", f"/api/tables/{ref}/trash", user)
    assert res.status_code == 200, res.text
    return res.json()["items"]


def attach(api, user, task_id, clip_id=None):
    """A comment and (optionally) a clip link on a task."""
    assert api("POST", f"/api/tasks/{task_id}/comments", user, {"text": "A remark"}).status_code == 200
    if clip_id:
        assert api("POST", f"/api/tasks/{task_id}/clips", user, {"clipId": clip_id}).status_code == 200


def count(sql, *params):
    with get_db() as conn:
        return fetchone(execute(conn, sql, params))["n"]


# ---------------------------------------------------------------- delete hides the task on every read path

def test_delete_hides_the_task_on_every_read_path(client, api, add, editor, project):
    add_clip(project)
    clip_id = db_get_clip_row_id(project, "shot_010")
    comment = add_comment(client, project, editor["token"], text="Findable remark")
    task_id = task_from_comment(client, project, comment["id"], editor["token"]).json()["task"]["id"]
    other = add(editor, "Other task")
    ref = f"tasks:{project}"
    assert api("GET", f"/api/clips/{clip_id}/tasks", editor).json()["tasks"][0]["id"] == task_id
    assert api("GET", f"/api/tasks/{task_id}/page", editor).status_code == 200  # creates the task page
    found = api("GET", f"/api/mentions/search?q=Findable&space=p:{project}", editor).json()["tasks"]
    assert [t["id"] for t in found] == [task_id]

    assert api("DELETE", f"/api/tables/{ref}/rows/{task_id}", editor).status_code == 200

    assert task_id not in task_cache                                                        # in-memory state
    assert names(api, editor, ref) == ["Other task"]                                        # table query
    assert names(api, editor, "tasks:*") == ["Other task"]                                  # all-tasks query
    assert api("GET", f"/api/tables/{ref}/rows/{task_id}", editor).status_code == 404       # get_row
    assert api("GET", f"/api/tasks/{task_id}", editor).status_code == 404                   # old task endpoint
    listed = api("GET", f"/api/projects/{project}/tasks", editor).json()["tasks"]
    assert [t["id"] for t in listed] == [other]                                             # old list endpoint
    assert api("GET", f"/api/tasks/{task_id}/comments", editor).status_code == 404
    assert api("GET", f"/api/clips/{clip_id}/tasks", editor).json()["tasks"] == []          # clip -> linked tasks
    in_memory = [c for c in server.projects[project]["comments"] if c["id"] == comment["id"]][0]
    assert "taskId" not in in_memory                                                        # review "Task" chip
    reloaded = [c for c in database.db_get_project(project)["comments"] if c["id"] == comment["id"]][0]
    assert "taskId" not in reloaded
    assert api("GET", f"/api/mentions/search?q=Findable&space=p:{project}", editor).json()["tasks"] == []
    resolved = api("POST", "/api/mentions/resolve", editor, {"items": [{"kind": "task", "id": task_id}]})
    assert resolved.json()["items"] == [{"kind": "task", "id": task_id, "ok": False}]       # mention resolve
    assert api("GET", f"/api/backlinks?kind=task&id={task_id}", editor).json() == {"pages": []}
    assert api("GET", f"/api/tasks/{task_id}/page", editor).status_code == 404              # task page
    assert database.db_get_task(task_id) is None and db_get_task_by_clip(clip_id) is None
    assert [t["id"] for t in database.db_list_tasks(project, include_children=True)] == [other]


def test_the_old_task_api_deletes_softly_too(api, add, editor, project):
    task_id = add(editor, "Old way")
    assert api("DELETE", f"/api/tasks/{task_id}", editor).status_code == 200
    assert db_get_trashed_task(task_id)["name"] == "Old way"
    assert [t["name"] for t in trash(api, editor, f"tasks:{project}")] == ["Old way"]


# ---------------------------------------------------------------- attached data survives and comes back

def test_restore_brings_back_everything_attached(client, api, add, editor, project):
    add_clip(project)
    clip_id = db_get_clip_row_id(project, "shot_010")
    comment = add_comment(client, project, editor["token"])
    sibling = add(editor, "Sibling")
    parent = task_from_comment(client, project, comment["id"], editor["token"]).json()["task"]["id"]
    child = add(editor, "Child", parent=parent)
    grandchild = add(editor, "Grandchild", parent=child)
    attach(api, editor, parent, clip_id)
    attach(api, editor, child)
    ref = f"tasks:{project}"
    assert api("PATCH", f"/api/tables/{ref}/rows/{parent}", editor, {"values": {"priority": "high"}}).status_code == 200
    page = api("GET", f"/api/tasks/{parent}/page", editor).json()
    db_write_page_snapshot(page["id"], b"\x00", "The page text", 0)
    order_before = names(api, editor, ref)
    position = task_cache[parent]["sortOrder"]

    assert api("DELETE", f"/api/tables/{ref}/rows/{parent}", editor).status_code == 200
    assert names(api, editor, ref) == ["Sibling"]
    # nothing attached is destroyed while the task is in the trash
    assert count("SELECT COUNT(*) AS n FROM task_comments WHERE task_id IN (?, ?)", parent, child) == 2
    assert count("SELECT COUNT(*) AS n FROM task_clips WHERE task_id = ?", parent) == 1
    assert count("SELECT COUNT(*) AS n FROM tasks WHERE id IN (?, ?, ?)", parent, child, grandchild) == 3
    assert count("SELECT COUNT(*) AS n FROM tasks WHERE id = ? AND comment_id = ?", parent, comment["id"]) == 1
    assert count("SELECT COUNT(*) AS n FROM pages WHERE id = ? AND text = ?", page["id"], "The page text") == 1
    assert db_get_task_page(parent) is not None
    assert db_get_page(page["id"]) is None  # hidden while in the trash

    items = trash(api, editor, ref)
    assert [(i["id"], i["subtaskCount"], i["parentName"]) for i in items] == [(parent, 2, None)]
    assert items[0]["deletedBy"] == editor["user"]["id"] and items[0]["deletedAt"] and items[0]["name"]

    res = api("POST", f"/api/tables/{ref}/rows/{parent}/restore", editor)
    assert res.status_code == 200 and res.json()["id"] == parent
    assert names(api, editor, ref) == order_before
    assert task_cache[parent]["sortOrder"] == position and task_cache[parent]["priority"] == "high"
    assert task_cache[child]["parentId"] == parent and task_cache[grandchild]["parentId"] == child
    assert task_cache[parent]["childCount"] == 1
    assert len(api("GET", f"/api/tasks/{parent}/comments", editor).json()["comments"]) == 1
    assert [c["id"] for c in api("GET", f"/api/tasks/{parent}/clips", editor).json()["clips"]] == [clip_id]
    assert api("GET", f"/api/clips/{clip_id}/tasks", editor).json()["tasks"][0]["id"] == parent
    assert api("GET", f"/api/tasks/{parent}/page", editor).json()["id"] == page["id"]
    assert [c for c in server.projects[project]["comments"] if c["id"] == comment["id"]][0]["taskId"] == parent
    assert trash(api, editor, ref) == []
    assert sibling in task_cache


def test_restoring_a_subtask_alone_when_its_parent_is_still_deleted_puts_it_at_top_level(api, add, editor, project):
    ref = f"tasks:{project}"
    parent = add(editor, "Parent")
    child = add(editor, "Child", parent=parent)
    api("DELETE", f"/api/tables/{ref}/rows/{child}", editor)
    api("DELETE", f"/api/tables/{ref}/rows/{parent}", editor)
    items = {i["id"]: i for i in trash(api, editor, ref)}
    assert set(items) == {parent, child}  # deleted at different times: two entries
    assert items[child]["parentName"] == "Parent"
    assert api("POST", f"/api/tables/{ref}/rows/{child}/restore", editor).json()["parentId"] is None
    # restoring the parent now does not drag the subtask along again
    assert api("POST", f"/api/tables/{ref}/rows/{parent}/restore", editor).status_code == 200
    assert task_cache[parent]["childCount"] == 0 and task_cache[child]["parentId"] is None


def test_a_subtask_deleted_with_its_parent_is_one_trash_entry(api, add, editor, project):
    ref = f"tasks:{project}"
    parent = add(editor, "P")
    child = add(editor, "C", parent=parent)
    api("DELETE", f"/api/tables/{ref}/rows/{parent}", editor)
    assert [(i["id"], i["subtaskCount"]) for i in trash(api, editor, ref)] == [(parent, 1)]
    # restore as a set: the parent comes back first, the subtask stays below it
    res = api("POST", f"/api/tables/{ref}/rows/restore", editor, {"ids": [child, parent]})
    assert res.status_code == 200 and sorted(res.json()["restored"]) == sorted([parent, child])
    assert task_cache[child]["parentId"] == parent


def test_a_subtask_restored_under_a_live_parent_stays_below_it(api, add, editor, project):
    ref = f"tasks:{project}"
    parent = add(editor, "P")
    child = add(editor, "C", parent=parent)
    api("DELETE", f"/api/tables/{ref}/rows/{child}", editor)
    assert task_cache[parent]["childCount"] == 0
    api("POST", f"/api/tables/{ref}/rows/{child}/restore", editor)
    assert task_cache[child]["parentId"] == parent and task_cache[parent]["childCount"] == 1


# ---------------------------------------------------------------- comment link

def test_the_comment_link_is_dropped_when_the_comment_got_another_task(client, api, editor, project):
    add_clip(project)
    comment = add_comment(client, project, editor["token"])
    first = task_from_comment(client, project, comment["id"], editor["token"]).json()["task"]["id"]
    api("DELETE", f"/api/tasks/{first}", editor)
    second = task_from_comment(client, project, comment["id"], editor["token"]).json()
    assert second["created"] is True and second["task"]["id"] != first
    assert api("POST", f"/api/tables/tasks:{project}/rows/{first}/restore", editor).status_code == 200
    assert task_cache[first]["commentId"] is None
    chip = [c for c in server.projects[project]["comments"] if c["id"] == comment["id"]][0]["taskId"]
    assert chip == second["task"]["id"]


# ---------------------------------------------------------------- permissions

def test_permissions(api, add, editor, other_editor, make_user, grant, project):
    ref = f"tasks:{project}"
    viewer = make_user("viewer")
    grant(project, viewer["user"]["id"], can_review=True, can_tasks=True)
    outsider = make_user()
    task_id = add(editor, "Mine")
    assert api("DELETE", f"/api/tables/{ref}/rows/{task_id}", viewer).status_code == 403
    assert api("DELETE", f"/api/tables/{ref}/rows/{task_id}", outsider).status_code in (403, 404)
    assert api("DELETE", f"/api/tables/{ref}/rows/{task_id}", None).status_code == 401
    assert api("DELETE", f"/api/tables/{ref}/rows/{task_id}", other_editor).status_code == 200
    for user in (viewer, outsider):
        assert api("GET", f"/api/tables/{ref}/trash", user).status_code in (403, 404)
        assert api("POST", f"/api/tables/{ref}/rows/{task_id}/restore", user).status_code in (403, 404)
        assert api("DELETE", f"/api/tables/{ref}/trash/{task_id}", user).status_code in (403, 404)
    assert api("GET", f"/api/tables/{ref}/trash", None).status_code == 401
    assert api("DELETE", f"/api/tables/{ref}/trash", editor).status_code == 403  # empty trash: owner/admin only
    assert api("POST", f"/api/tables/{ref}/rows/{task_id}/restore", editor).status_code == 200
    assert api("POST", f"/api/tables/{ref}/rows/{task_id}/restore", editor).status_code == 404  # not in the trash now


def test_tasks_star_lists_only_projects_the_caller_may_edit(api, add, editor, make_project, admin, project):
    other = make_project("Other")
    mine = add(editor, "Mine")
    theirs = api("POST", f"/api/tables/tasks:{other}/rows", admin, {"values": {"name": "Theirs"}}).json()["id"]
    api("DELETE", f"/api/tables/tasks:{project}/rows/{mine}", editor)
    api("DELETE", f"/api/tables/tasks:{other}/rows/{theirs}", admin)
    assert [i["name"] for i in trash(api, editor, "tasks:*")] == ["Mine"]
    assert {i["name"] for i in trash(api, admin, "tasks:*")} == {"Mine", "Theirs"}
    assert all(i["tableRef"].startswith("tasks:") for i in trash(api, admin, "tasks:*"))
    # restoring through tasks:* works, and skips a project the caller cannot read
    assert api("POST", "/api/tables/tasks:*/rows/restore", editor, {"ids": [theirs]}).json() == {"restored": []}
    assert api("POST", "/api/tables/tasks:*/rows/restore", editor, {"ids": [mine]}).json() == {"restored": [mine]}
    # the project table does not restore rows of another project
    assert api("POST", f"/api/tables/tasks:{project}/rows/restore", admin, {"ids": [theirs]}).json() == {"restored": []}


def test_empty_trash_and_delete_forever(api, add, editor, admin, project):
    ref = f"tasks:{project}"
    ids = [add(editor, f"T{i}") for i in range(3)]
    assert api("GET", f"/api/tasks/{ids[0]}/page", editor).status_code == 200
    child = add(editor, "Kid", parent=ids[0])
    for tid in ids:
        api("DELETE", f"/api/tables/{ref}/rows/{tid}", editor)
    assert api("DELETE", f"/api/tables/{ref}/trash/{ids[0]}", editor).status_code == 200
    assert api("DELETE", f"/api/tables/{ref}/trash/{ids[0]}", editor).status_code == 404
    assert db_get_task_page(ids[0]) is None                            # the page went with it
    assert count("SELECT COUNT(*) AS n FROM tasks WHERE id IN (?, ?)", ids[0], child) == 0  # and its subtask
    assert {i["id"] for i in trash(api, editor, ref)} == set(ids[1:])
    assert api("DELETE", f"/api/tables/{ref}/trash", editor).status_code == 403
    res = api("DELETE", f"/api/tables/{ref}/trash", admin)
    assert res.status_code == 200 and res.json() == {"removed": 2}
    assert trash(api, admin, ref) == []
    assert api("DELETE", "/api/tables/tasks:*/trash", admin).status_code == 400
    # a live task is never touched by "delete forever"
    live = add(editor, "Live")
    assert api("DELETE", f"/api/tables/{ref}/trash/{live}", editor).status_code == 404
    assert live in task_cache


def test_sources_without_a_trash_answer_400():
    source = TableSource()
    assert source.supports_trash is False
    with pytest.raises(HTTPException) as err:
        source.list_trash({})
    assert err.value.status_code == 400


# ---------------------------------------------------------------- purge, restart, events

def test_purge_after_30_days(api, add, editor, project):
    ref = f"tasks:{project}"
    old, recent = add(editor, "Old"), add(editor, "Recent")
    api("DELETE", f"/api/tables/{ref}/rows/{old}", editor)
    api("DELETE", f"/api/tables/{ref}/rows/{recent}", editor)
    long_ago = (datetime.now() - timedelta(days=31)).isoformat()
    with get_db() as conn:
        execute(conn, "UPDATE tasks SET deleted_at = ? WHERE id = ?", (long_ago, old))
    assert asyncio.run(trash_job.purge_expired()) == 1
    assert db_get_trashed_task(old) is None and db_get_trashed_task(recent) is not None
    # with the clock moved to day 29 nothing is due, on day 31 the rest is
    assert asyncio.run(trash_job.purge_expired(datetime.now() + timedelta(days=29))) == 0
    assert asyncio.run(trash_job.purge_expired(datetime.now() + timedelta(days=31))) == 1
    assert trash(api, editor, ref) == []


def test_a_restart_keeps_the_trash_and_does_not_bring_deleted_tasks_back(api, add, editor, project):
    ref = f"tasks:{project}"
    gone, kept = add(editor, "Gone"), add(editor, "Kept")
    api("DELETE", f"/api/tables/{ref}/rows/{gone}", editor)
    server.load_data_from_db()  # what start-up does
    assert gone not in task_cache and kept in task_cache
    assert [i["id"] for i in trash(api, editor, ref)] == [gone]
    assert api("POST", f"/api/tables/{ref}/rows/{gone}/restore", editor).status_code == 200
    assert gone in task_cache


def test_events_on_delete_and_restore(api, add, editor, other_editor, connect, project):
    ref = f"tasks:{project}"
    parent = add(editor, "P")
    child = add(editor, "C", parent=parent)
    with connect(other_editor["token"], "tab") as ws:
        watch(ws, project)
        api("DELETE", f"/api/tables/{ref}/rows/{parent}", editor)
        first, second = ws.receive_json(), ws.receive_json()
        assert first == {"type": "task_deleted", "taskId": parent, "parentId": None, "project": project}
        assert second["type"] == "rows_changed" and second["change"] == "deleted"
        assert sorted(second["ids"]) == sorted([parent, child])
        api("POST", f"/api/tables/{ref}/rows/{parent}/restore", editor)
        got = [ws.receive_json() for _ in range(3)]
        assert [e["type"] for e in got] == ["task_created", "task_created", "rows_changed"]
        assert {e["task"]["id"] for e in got[:2]} == {parent, child}
        assert got[2]["change"] == "created" and sorted(got[2]["ids"]) == sorted([parent, child])
        assert nothing_pending(ws)
