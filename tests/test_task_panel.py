"""Server parts of the task panel (T11): the single-row endpoint, the old description as legacy
page content, and the "counts as done" flag of statuses."""

import pytest

import database
from conftest import auth


@pytest.fixture
def project(make_project):
    return make_project("Panel")


@pytest.fixture
def editor(make_user, grant, project):
    u = make_user()
    grant(project, u["user"]["id"], can_review=True, can_tasks=True)
    return u


@pytest.fixture
def outsider(make_user):
    return make_user()


def make_task(client, user, project, name="Task", **extra):
    res = client.post(f"/api/projects/{project}/tasks", json={"name": name, **extra}, headers=auth(user["token"]))
    assert res.status_code == 200, res.text
    return res.json()["task"]["id"]


# ---------------------------------------------------------------- single row

def test_get_row_through_the_project_table_and_through_tasks_star(client, editor, project):
    task_id = make_task(client, editor, project, "One")
    for ref in (f"tasks:{project}", "tasks:*", "tasks%3A%2A"):
        res = client.get(f"/api/tables/{ref}/rows/{task_id}", headers=auth(editor["token"]))
        assert res.status_code == 200, res.text
        row = res.json()
        assert row["id"] == task_id and row["values"]["name"] == "One"
        assert row["tableRef"] == f"tasks:{project}" and row["canEdit"] is True


def test_get_row_is_404_when_the_caller_may_not_read_it(client, editor, outsider, project):
    task_id = make_task(client, editor, project)
    assert client.get(f"/api/tables/tasks:*/rows/{task_id}", headers=auth(outsider["token"])).status_code == 404
    assert client.get(f"/api/tables/tasks:{project}/rows/{task_id}", headers=auth(outsider["token"])).status_code in (403, 404)
    assert client.get("/api/tables/tasks:*/rows/nope", headers=auth(editor["token"])).status_code == 404
    assert client.get(f"/api/tables/tasks:*/rows/{task_id}").status_code == 401


def test_get_row_in_another_project_is_404_for_a_project_table(client, editor, project, make_project):
    other = make_project("Other")
    task_id = make_task(client, editor, project)
    res = client.get(f"/api/tables/tasks:{other}/rows/{task_id}", headers=auth(editor["token"]))
    assert res.status_code in (403, 404)


# ---------------------------------------------------------------- description as legacy content

def test_task_page_takes_the_old_description_as_legacy_html(client, editor, project):
    task_id = make_task(client, editor, project, "Described", description="First <b>line</b>\nsecond line\n\nNext paragraph")
    page = client.get(f"/api/tasks/{task_id}/page", headers=auth(editor["token"])).json()
    assert page["needsImport"] is True
    assert page["legacyHtml"] == "<p>First &lt;b&gt;line&lt;/b&gt;<br>second line</p><p>Next paragraph</p>"
    # the old field stays readable
    assert database.db_get_task(task_id)["description"].startswith("First")
    # a second call does not import again
    again = client.get(f"/api/tasks/{task_id}/page", headers=auth(editor["token"])).json()
    assert again["id"] == page["id"]


def test_task_page_without_a_description_needs_no_import(client, editor, project):
    task_id = make_task(client, editor, project, "Plain")
    page = client.get(f"/api/tasks/{task_id}/page", headers=auth(editor["token"])).json()
    assert page["needsImport"] is False and "legacyHtml" not in page


# ---------------------------------------------------------------- done flag

def test_status_done_flag_defaults_from_the_name_and_can_be_changed(client, admin):
    done = client.post("/api/statuses", json={"name": "Done"}, headers=auth(admin["token"])).json()["status"]
    wip = client.post("/api/statuses", json={"name": "In progress"}, headers=auth(admin["token"])).json()["status"]
    explicit = client.post("/api/statuses", json={"name": "Approved", "isDone": True}, headers=auth(admin["token"])).json()["status"]
    assert (done["isDone"], wip["isDone"], explicit["isDone"]) == (True, False, True)
    listed = {s["id"]: s for s in client.get("/api/statuses").json()["statuses"]}
    assert listed[done["id"]]["isDone"] is True and listed[wip["id"]]["isDone"] is False
    assert client.patch(f"/api/statuses/{wip['id']}", json={"isDone": True}, headers=auth(admin["token"])).status_code == 200
    assert database.db_list_statuses() and {s["id"]: s for s in database.db_list_statuses()}[wip["id"]]["isDone"] is True
    # renaming does not touch the flag
    client.patch(f"/api/statuses/{wip['id']}", json={"name": "Working"}, headers=auth(admin["token"]))
    assert {s["id"]: s for s in database.db_list_statuses()}[wip["id"]]["isDone"] is True
    assert client.post("/api/statuses", json={"name": "X", "isDone": "yes"}, headers=auth(admin["token"])).status_code == 400


def test_schema_marks_done_statuses_on_the_options(client, admin, project):
    done = client.post("/api/statuses", json={"name": "Finished"}, headers=auth(admin["token"])).json()["status"]
    open_ = client.post("/api/statuses", json={"name": "Later"}, headers=auth(admin["token"])).json()["status"]
    schema = client.get(f"/api/tables/tasks:{project}/schema", headers=auth(admin["token"])).json()
    options = {o["value"]: o for c in schema["columns"] if c["key"] == "status" for o in c["options"]}
    assert options[done["id"]].get("done") is True
    assert options[open_["id"]]["done"] is False


def test_migration_flags_statuses_that_match_the_old_name_guess():
    import importlib.util
    import sqlite3
    from pathlib import Path
    spec = importlib.util.spec_from_file_location(
        "m012", Path(__file__).resolve().parents[1] / "database" / "migrations" / "012_status_done_flag.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    conn.execute("CREATE TABLE clip_statuses (id TEXT PRIMARY KEY, name TEXT NOT NULL)")
    for i, name in enumerate(["Done", " completed ", "Closed", "Approved", "In Progress"]):
        conn.execute("INSERT INTO clip_statuses VALUES (?, ?)", (str(i), name))
    module.up(conn)
    flags = {r["name"].strip(): r["is_done"] for r in conn.execute("SELECT name, is_done FROM clip_statuses")}
    assert flags == {"Done": 1, "completed": 1, "Closed": 1, "Approved": 0, "In Progress": 0}
