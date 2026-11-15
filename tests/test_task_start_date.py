"""tasks.start_date (WP T9): table API, old task API, query, events and the migration."""

import sqlite3

import pytest

import conftest  # noqa: F401
import database
from api.state import tasks as task_cache
from database import migrate
from database.engine import DB_TYPE, DatabaseType

from conftest import auth
from test_tables import api, editor, project, stored, table  # noqa: F401  (fixtures)
from test_live import connect, watch, nothing_pending  # noqa: F401


def test_schema_column_sits_before_due_date(table, admin, project):
    cols = table(admin, f"tasks:{project}").schema().json()["columns"]
    keys = [c["key"] for c in cols]
    assert keys.index("startDate") == keys.index("dueDate") - 1
    col = cols[keys.index("startDate")]
    assert (col["name"], col["type"], col["builtin"]) == ("Start date", "date", True)
    assert not col.get("readonly")


def test_create_update_and_clear_through_the_table_api(table, admin, project):
    t = table(admin, f"tasks:{project}")
    row = t.create({"name": "A", "startDate": "2030-01-02", "dueDate": "2030-01-09"}).json()
    assert row["values"]["startDate"] == "2030-01-02"
    assert stored(row["id"])["startDate"] == "2030-01-02"
    assert task_cache[row["id"]]["startDate"] == "2030-01-02"

    out = t.update(row["id"], {"startDate": "2030-02-01"}).json()
    assert out["values"]["startDate"] == "2030-02-01" and out["values"]["dueDate"] == "2030-01-09"
    assert stored(row["id"])["startDate"] == "2030-02-01"

    # The server does not force start <= due
    assert t.update(row["id"], {"startDate": "2031-01-01"}).status_code == 200

    out = t.update(row["id"], {"startDate": None}).json()
    assert out["values"]["startDate"] is None
    assert stored(row["id"])["startDate"] is None
    assert t.update(row["id"], {"startDate": ""}).status_code == 200


@pytest.mark.parametrize("bad", ["2030-1-2", "2030-13-01", "2030-02-30", "20300102", "tomorrow", 5, "2030-01-02T00:00"])
def test_bad_dates_are_400_and_change_nothing(table, admin, project, bad):
    t = table(admin, f"tasks:{project}")
    row = t.create({"name": "A", "startDate": "2030-01-02"}).json()
    assert t.update(row["id"], {"startDate": bad}).status_code == 400
    assert t.create({"name": "B", "startDate": bad}).status_code == 400
    assert stored(row["id"])["startDate"] == "2030-01-02"


def test_old_task_api_reads_and_writes_start_date(api, admin, project):
    res = api("POST", f"/api/projects/{project}/tasks", admin, {"name": "Old", "startDate": "2030-03-01"})
    assert res.status_code == 200, res.text
    task = res.json()["task"]
    assert task["startDate"] == "2030-03-01"
    assert stored(task["id"])["startDate"] == "2030-03-01"

    res = api("PATCH", f"/api/tasks/{task['id']}", admin, {"startDate": "2030-03-05", "dueDate": "2030-03-07"})
    assert res.status_code == 200, res.text
    assert res.json()["task"]["startDate"] == "2030-03-05"
    assert task_cache[task["id"]]["startDate"] == "2030-03-05"

    assert api("PATCH", f"/api/tasks/{task['id']}", admin, {"startDate": "soon"}).status_code == 400
    res = api("PATCH", f"/api/tasks/{task['id']}", admin, {"startDate": None})
    assert res.status_code == 200 and stored(task["id"])["startDate"] is None

    # list endpoint carries it too
    api("PATCH", f"/api/tasks/{task['id']}", admin, {"startDate": "2030-04-01"})
    listed = api("GET", f"/api/projects/{project}/tasks", admin).json()
    items = listed["tasks"] if isinstance(listed, dict) else listed
    assert [t["startDate"] for t in items if t["id"] == task["id"]] == ["2030-04-01"]


def test_table_and_old_api_see_each_others_writes(table, api, admin, project):
    t = table(admin, f"tasks:{project}")
    row = t.add("X")
    api("PATCH", f"/api/tasks/{row['id']}", admin, {"startDate": "2030-06-01"})
    assert [r["values"]["startDate"] for r in t.rows()] == ["2030-06-01"]


def test_filter_and_sort_by_start_date(table, admin, project):
    t = table(admin, f"tasks:{project}")
    for name, start in [("late", "2030-03-01"), ("early", "2030-01-01"), ("none", None), ("mid", "2030-02-01")]:
        t.create({"name": name, "startDate": start})
    assert t.names({"sort": [{"column": "startDate", "dir": "asc"}]})[:3] == ["early", "mid", "late"]
    assert t.names({"sort": [{"column": "startDate", "dir": "desc"}]})[:3] == ["late", "mid", "early"]
    assert t.names({"filter": {"column": "startDate", "op": "empty"}}) == ["none"]
    assert sorted(t.names({"filter": {"column": "startDate", "op": "before", "value": "2030-02-15"}})) == ["early", "mid"]
    res = t.query({"groupBy": "startDate"}).json()
    assert {g["key"] for g in res["groups"]} == {"2030-03-01", "2030-01-01", None, "2030-02-01"}


def test_table_write_sends_events(table, admin, project, connect):
    t = table(admin, f"tasks:{project}")
    row = t.add("E")
    with connect(admin["token"], "writer") as writer, connect(admin["token"], "watcher") as watcher:
        watch(writer, project)
        watch(watcher, project)
        assert t.update(row["id"], {"startDate": "2030-07-01"}).status_code == 200
        event = watcher.receive_json()
        assert event["type"] == "task_updated" and event["task"]["startDate"] == "2030-07-01"
        assert watcher.receive_json()["type"] == "rows_changed"


@pytest.mark.skipif(DB_TYPE != DatabaseType.SQLITE, reason="uses a temporary SQLite file")
def test_migration_adds_the_column_and_keeps_data(tmp_path):
    db = tmp_path / "old.db"
    conn = sqlite3.connect(db)
    conn.execute("CREATE TABLE tasks (id TEXT PRIMARY KEY, name TEXT NOT NULL, due_date TEXT)")
    conn.execute("INSERT INTO tasks VALUES ('t1', 'Old task', '2030-01-31')")
    conn.commit()
    conn.close()

    from contextlib import contextmanager

    @contextmanager
    def open_db():
        c = sqlite3.connect(db)
        c.row_factory = sqlite3.Row
        try:
            yield c
            c.commit()
        finally:
            c.close()

    mdir = tmp_path / "m"
    mdir.mkdir()
    src = (conftest_dir() / "database" / "migrations" / "007_task_start_date.py").read_text()
    (mdir / "007_task_start_date.py").write_text(src)
    assert migrate.run_migrations(open_db, mdir) == ["007"]
    with open_db() as c:
        row = c.execute("SELECT name, due_date, start_date FROM tasks").fetchone()
    assert tuple(row) == ("Old task", "2030-01-31", None)
    assert migrate.run_migrations(open_db, mdir) == []


def conftest_dir():
    from pathlib import Path
    return Path(__file__).resolve().parent.parent
