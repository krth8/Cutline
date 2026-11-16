"""The dashboard of a project: creation with a project, the stored document and its views, protection, and
migration 024 (a dashboard for every project; the old fixed Tasks page becomes an ordinary page)."""

import importlib.util
import shutil
import sqlite3
from contextlib import contextmanager

import pytest
from pycrdt import Doc, XmlFragment

from database import migrate
from database.engine import execute, fetchall, fetchone
from database.migrate import MIGRATIONS_DIR
from database.engine import init_schema
from database.pages import db_load_page_state
from database.dashboard_page import ALL_TASKS, HIDDEN_COLUMNS, VISIBLE_COLUMNS
from database.utils import get_db

from conftest import auth
from test_pages import create, patch, team, tree  # noqa: F401  (team is a fixture)


def system_pages(project_id):
    with get_db() as conn:
        return fetchall(execute(conn, "SELECT * FROM pages WHERE project_id = ? AND system_key = 'dashboard'", (project_id,)))


def stored_document(page_id):
    snapshot, updates = db_load_page_state(page_id)
    doc = Doc()
    if snapshot:
        doc.apply_update(snapshot)
    for _id, data in updates:
        doc.apply_update(data)
    return doc.get("default", type=XmlFragment)


# ---------- a new project ----------

def test_a_new_project_gets_one_dashboard_pinned_first_and_no_tasks_page(client, team):
    pages = system_pages(team["project"])
    assert len(pages) == 1
    page = pages[0]
    assert page["title"] == "Dashboard" and page["kind"] == "page" and page["parent_id"] is None
    # other pages sort after it; the tree lists it with its system marker; there is no fixed Tasks page
    other = create(client, team["member"], team["space"], "Notes")
    assert other["sortOrder"] > page["sort_order"]
    rows = client.get(f"/api/spaces/{team['space']}/pages", headers=auth(team["member"])).json()
    assert [(r["title"], r["system"]) for r in rows] == [("Dashboard", "dashboard"), ("Notes", None)]


def test_the_dashboard_is_built_from_blocks_over_views_it_owns(client, team):
    page = system_pages(team["project"])[0]
    fragment = stored_document(page["id"])
    tags = [getattr(c, "tag", None) for c in fragment.children]
    assert tags == ["chart", "paragraph", "viewBlock", "viewBlock", "heading", "pageList", "paragraph"]
    chart = fragment.children[0]
    assert chart.attributes["type"] == "donut" and chart.attributes["groupBy"] == "status"

    views = client.get(f"/api/views?ownerPageId={page['id']}", headers=auth(team["member"])).json()["views"]
    by_name = {v["name"]: v for v in views}
    assert sorted(by_name) == ["All tasks", "My tasks", "Open tasks", "Overdue", "Schedule"]
    assert all(v["tableRef"] == f"tasks:{team['project']}" and v["ownerPageId"] == page["id"] for v in views)
    # every view a block points at exists
    ids = {v["id"] for v in views}
    pointed = [c.attributes["viewId"] for c in fragment.children if getattr(c, "tag", None) in ("chart", "viewBlock")]
    pointed += [c.attributes["viewId"] for c in fragment.children[1].children if getattr(c, "tag", None) == "summaryInline"]
    assert len(pointed) == 7 and set(pointed) <= ids
    assert fragment.children[5].attributes["scope"] == f"p:{team['project']}"

    # "All tasks" is the table the Tasks route opens full page: nested subtasks, the columns of the old list
    everything = client.get(f"/api/views/{by_name[ALL_TASKS]['id']}", headers=auth(team["member"])).json()
    assert chart.attributes["viewId"] == everything["id"] and everything["layout"] == "table"
    assert everything["config"]["query"] == {"parentId": None}
    columns = everything["config"]["columns"]
    assert [c["key"] for c in columns if not c.get("hidden")] == VISIBLE_COLUMNS
    assert [c["key"] for c in columns if c.get("hidden")] == HIDDEN_COLUMNS
    assert by_name["Schedule"]["layout"] == "gantt" and by_name["My tasks"]["layout"] == "list"


def test_the_page_reads_through_the_page_api_and_has_content(client, team):
    page = system_pages(team["project"])[0]
    body = client.get(f"/api/pages/{page['id']}", headers=auth(team["member"])).json()
    assert body["system"] == "dashboard" and body["canEdit"] is True and body["needsImport"] is False


# ---------- protection ----------

def test_cannot_archive_delete_or_move_it(client, team, make_project):
    t = team["member"]
    page_id = system_pages(team["project"])[0]["id"]
    res = patch(client, t, page_id, archived=True)
    assert res.status_code == 400 and "dashboard" in res.json()["detail"]
    assert client.delete(f"/api/pages/{page_id}", headers=auth(t)).status_code == 409  # not archived, never will be

    # even a page that is somehow archived cannot be deleted
    with get_db() as conn:
        execute(conn, "UPDATE pages SET archived_at = '2030-01-01' WHERE id = ?", (page_id,))
    res = client.delete(f"/api/pages/{page_id}", headers=auth(t))
    assert res.status_code == 400 and "cannot be deleted" in res.json()["detail"]
    with get_db() as conn:
        execute(conn, "UPDATE pages SET archived_at = NULL WHERE id = ?", (page_id,))

    other = make_project()
    res = client.post(f"/api/pages/{page_id}/move", json={"space": "me"}, headers=auth(t))
    assert res.status_code == 400 and "cannot be moved" in res.json()["detail"]
    res = client.get(f"/api/pages/{page_id}/move-preview?space=me", headers=auth(t))
    assert res.status_code == 400
    assert other  # (a second project exists; the page stays in its own)

    sub = create(client, t, team["space"], "Sub")
    res = patch(client, t, page_id, parentId=sub["id"])
    assert res.status_code == 400 and "cannot be moved" in res.json()["detail"]
    assert system_pages(team["project"])[0]["parent_id"] is None


def test_it_can_be_edited_like_any_page(client, team):
    t = team["member"]
    page_id = system_pages(team["project"])[0]["id"]
    assert patch(client, t, page_id, title="Work").status_code == 200
    child = create(client, t, team["space"], "Under the dashboard", parent=page_id)
    assert child["parentId"] == page_id
    assert len(system_pages(team["project"])) == 1  # still found by its marker, whatever its title


def test_a_viewer_reads_it_but_cannot_edit_it_and_review_alone_does_not_read_it(client, team):
    page_id = system_pages(team["project"])[0]["id"]
    body = client.get(f"/api/pages/{page_id}", headers=auth(team["viewer"])).json()
    assert body["canEdit"] is False
    assert client.get(f"/api/pages/{page_id}", headers=auth(team["reviewer"])).status_code == 403


def test_the_page_opens_over_the_sync_socket_with_its_blocks(client, team, ticket):
    page_id = system_pages(team["project"])[0]["id"]
    with client.websocket_connect(f"/ws/pages/{page_id}?ticket={ticket(team['member'])}") as ws:
        first = ws.receive_bytes()
    assert first[0] == 0
    doc = Doc()
    doc.apply_update(first[1:])
    tags = [getattr(c, "tag", None) for c in doc.get("default", type=XmlFragment).children]
    assert tags[0] == "chart"


# ---------- migration 024 ----------

@pytest.fixture
def old_db(tmp_path):
    """A database at migration 023: three projects, each with the fixed Tasks page of migration 013 and no
    dashboard. Returns (connect, migration module)."""
    db = tmp_path / "old.db"

    @contextmanager
    def connect():
        conn = sqlite3.connect(db)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys=ON")
        try:
            yield conn
            conn.commit()
        except Exception:
            conn.rollback()
            raise
        finally:
            conn.close()

    before = tmp_path / "before"
    before.mkdir()
    for src in MIGRATIONS_DIR.glob("*.py"):
        if src.name[:3].isdigit() and int(src.name[:3]) <= 12:
            shutil.copy(src, before / src.name)
    with connect() as conn:
        init_schema(conn)
    migrate.run_migrations(connect, before)
    with connect() as c:
        c.execute("INSERT INTO users (id, username, password_hash, created_at) VALUES ('u1', 'ann', 'x', '2024-01-01')")
        for pid, by in (("p1", "u1"), ("p2", None), ("p3", "gone")):
            c.execute("PRAGMA foreign_keys=OFF")
            c.execute("INSERT INTO projects (id, name, created_at, created_by) VALUES (?, ?, '2024-01-01', ?)", (pid, pid, by))
        c.execute("INSERT INTO pages (id, kind, space_type, project_id, title, sort_order, created_at, updated_at) "
                  "VALUES ('pg1', 'page', 'project', 'p1', 'Old', 5, '2024-01-01', '2024-01-01')")
    for src in MIGRATIONS_DIR.glob("*.py"):
        if src.name[:3].isdigit() and 12 < int(src.name[:3]) <= 23:
            shutil.copy(src, before / src.name)
    migrate.run_migrations(connect, before)  # 013 gives every project its fixed Tasks page
    spec = importlib.util.spec_from_file_location("m024", MIGRATIONS_DIR / "024_project_dashboard.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return connect, module


def test_migration_gives_every_project_one_dashboard_and_is_idempotent(old_db):
    connect, module = old_db
    for _ in range(2):  # the second run changes nothing
        with connect() as conn:
            module.up(conn)
        with connect() as conn:
            rows = fetchall(execute(conn, "SELECT id, project_id, title, sort_order, created_by FROM pages "
                                          "WHERE system_key = 'dashboard' ORDER BY project_id"))
            assert [r["project_id"] for r in rows] == ["p1", "p2", "p3"]
            assert all(r["title"] == "Dashboard" for r in rows)
            p1 = next(r for r in rows if r["project_id"] == "p1")
            assert p1["created_by"] == "u1"
            assert next(r for r in rows if r["project_id"] == "p3")["created_by"] is None  # creator no longer exists
            # first in the project, before the pages that were there
            others = fetchall(execute(conn, "SELECT sort_order FROM pages WHERE project_id = 'p1' AND id <> ?", (p1["id"],)))
            assert others and all(p1["sort_order"] < o["sort_order"] for o in others)
            for row in rows:
                owned = fetchone(execute(conn, "SELECT COUNT(*) AS n FROM views WHERE owner_page_id = ?", (row["id"],)))
                assert owned["n"] == 5


def test_migration_unlocks_the_old_tasks_pages_and_keeps_them(old_db):
    connect, module = old_db
    with connect() as conn:
        before = fetchall(execute(conn, "SELECT id FROM pages WHERE system_key = 'tasks' ORDER BY id"))
        assert len(before) == 3
        views = fetchone(execute(conn, "SELECT COUNT(*) AS n FROM views"))["n"]
    with connect() as conn:
        module.up(conn)
    with connect() as conn:
        assert fetchall(execute(conn, "SELECT id FROM pages WHERE system_key = 'tasks'")) == []
        kept = fetchall(execute(conn, "SELECT id, title, system_key, ydoc FROM pages WHERE id IN (?, ?, ?) ORDER BY id",
                                tuple(r["id"] for r in before)))
        # still there, with their name, content and view: ordinary pages now
        assert [r["id"] for r in kept] == [r["id"] for r in before]
        assert all(r["title"] == "Tasks" and r["system_key"] is None and r["ydoc"] for r in kept)
        assert fetchone(execute(conn, "SELECT COUNT(*) AS n FROM views"))["n"] == views + 15
        assert fetchone(execute(conn, "SELECT COUNT(*) AS n FROM pages WHERE id = 'pg1'"))["n"] == 1


def test_the_task_and_view_routes_serve_the_app(client):
    for path in ("/p/abc/tasks", "/p/abc/view/v1", "/me/view/v1"):
        res = client.get(path)
        assert res.status_code == 200 and "text/html" in res.headers["content-type"], path
