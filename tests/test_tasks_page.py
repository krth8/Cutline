"""The Tasks page of a project (T13): migration 013, creation with a project, the stored document, protection."""

import importlib.util
import json
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
from database.tasks_page import HIDDEN_COLUMNS, VISIBLE_COLUMNS
from database.utils import get_db

from conftest import auth
from test_pages import create, patch, team, tree  # noqa: F401  (team is a fixture)


def system_pages(project_id):
    with get_db() as conn:
        return fetchall(execute(conn, "SELECT * FROM pages WHERE project_id = ? AND system_key = 'tasks'", (project_id,)))


def stored_document(page_id):
    snapshot, updates = db_load_page_state(page_id)
    doc = Doc()
    if snapshot:
        doc.apply_update(snapshot)
    for _id, data in updates:
        doc.apply_update(data)
    return doc.get("default", type=XmlFragment)


# ---------- a new project ----------

def test_a_new_project_gets_one_tasks_page_pinned_first(client, team):
    pages = system_pages(team["project"])
    assert len(pages) == 1
    page = pages[0]
    assert page["title"] == "Tasks" and page["kind"] == "page" and page["parent_id"] is None
    # other pages sort after it; the tree lists it with its system marker
    other = create(client, team["member"], team["space"], "Notes")
    assert other["sortOrder"] > page["sort_order"]
    rows = client.get(f"/api/spaces/{team['space']}/pages", headers=auth(team["member"])).json()
    assert [r["title"] for r in rows][:2] == ["Tasks", "Notes"]
    assert next(r for r in rows if r["title"] == "Tasks")["system"] == "tasks"
    assert next(r for r in rows if r["title"] == "Notes")["system"] is None


def test_the_page_holds_one_view_block_of_a_valid_document(client, team):
    page = system_pages(team["project"])[0]
    fragment = stored_document(page["id"])
    blocks = [c for c in fragment.children if getattr(c, "tag", None) == "viewBlock"]
    assert len(blocks) == 1
    view_id = blocks[0].attributes["viewId"]

    view = client.get(f"/api/views/{view_id}", headers=auth(team["member"])).json()
    assert view["tableRef"] == f"tasks:{team['project']}"
    assert view["layout"] == "table"
    assert view["ownerPageId"] == page["id"]
    query = view["config"]["query"]
    assert query == {"parentId": None}  # nested subtasks; no grouping, like the old list
    columns = view["config"]["columns"]
    assert [c["key"] for c in columns if not c.get("hidden")] == VISIBLE_COLUMNS
    assert [c["key"] for c in columns if c.get("hidden")] == HIDDEN_COLUMNS


def test_the_page_reads_through_the_page_api_and_has_content(client, team):
    page = system_pages(team["project"])[0]
    body = client.get(f"/api/pages/{page['id']}", headers=auth(team["member"])).json()
    assert body["system"] == "tasks" and body["canEdit"] is True and body["needsImport"] is False


# ---------- protection ----------

def test_cannot_archive_delete_or_move_it(client, team, make_project):
    t = team["member"]
    page_id = system_pages(team["project"])[0]["id"]
    res = patch(client, t, page_id, archived=True)
    assert res.status_code == 400 and "Tasks page" in res.json()["detail"]
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
    child = create(client, t, team["space"], "Under tasks", parent=page_id)
    assert child["parentId"] == page_id
    assert len(system_pages(team["project"])) == 1  # still found by its marker, whatever its title


def test_a_viewer_reads_it_but_cannot_edit_it_and_review_alone_does_not_read_it(client, team):
    page_id = system_pages(team["project"])[0]["id"]
    body = client.get(f"/api/pages/{page_id}", headers=auth(team["viewer"])).json()
    assert body["canEdit"] is False
    assert client.get(f"/api/pages/{page_id}", headers=auth(team["reviewer"])).status_code == 403


def test_the_page_opens_over_the_sync_socket_with_its_view_block(client, team, ticket):
    page_id = system_pages(team["project"])[0]["id"]
    with client.websocket_connect(f"/ws/pages/{page_id}?ticket={ticket(team['member'])}") as ws:
        first = ws.receive_bytes()
    assert first[0] == 0
    doc = Doc()
    doc.apply_update(first[1:])
    tags = [getattr(c, "tag", None) for c in doc.get("default", type=XmlFragment).children]
    assert tags[0] == "viewBlock"


# ---------- migration 013 ----------

@pytest.fixture
def old_db(tmp_path):
    """A database at migration 012 with three projects and no Tasks pages. Returns (connect, migration module)."""
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
        # a project that already has ordinary pages: the Tasks page goes before them
        c.execute("INSERT INTO pages (id, kind, space_type, project_id, title, sort_order, created_at, updated_at) "
                  "VALUES ('pg1', 'page', 'project', 'p1', 'Old', 5, '2024-01-01', '2024-01-01')")
    spec = importlib.util.spec_from_file_location("m013", MIGRATIONS_DIR / "013_tasks_page.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return connect, module


def test_migration_gives_every_project_exactly_one_tasks_page_and_is_idempotent(old_db):
    connect, module = old_db
    for _ in range(2):  # the second run changes nothing
        with connect() as conn:
            module.up(conn)
        with connect() as conn:
            rows = fetchall(execute(conn, "SELECT project_id, title, sort_order, created_by FROM pages "
                                          "WHERE system_key = 'tasks' ORDER BY project_id"))
            assert [r["project_id"] for r in rows] == ["p1", "p2", "p3"]
            assert all(r["title"] == "Tasks" for r in rows)
            assert fetchone(execute(conn, "SELECT COUNT(*) AS n FROM views"))["n"] == 3
            p1 = next(r for r in rows if r["project_id"] == "p1")
            assert p1["sort_order"] < 5 and p1["created_by"] == "u1"
            assert next(r for r in rows if r["project_id"] == "p3")["created_by"] is None  # creator no longer exists
            assert fetchone(execute(conn, "SELECT COUNT(*) AS n FROM pages WHERE id = 'pg1'"))["n"] == 1


def test_migration_documents_contain_their_own_views(old_db):
    connect, module = old_db
    with connect() as conn:
        module.up(conn)
        for row in fetchall(execute(conn, "SELECT id, project_id, ydoc FROM pages WHERE system_key = 'tasks'")):
            doc = Doc()
            doc.apply_update(bytes(row["ydoc"]))
            block = doc.get("default", type=XmlFragment).children[0]
            view = fetchone(execute(conn, "SELECT * FROM views WHERE id = ?", (block.attributes["viewId"],)))
            assert view["owner_page_id"] == row["id"] and view["table_ref"] == f"tasks:{row['project_id']}"
            assert json.loads(view["config"])["query"] == {"parentId": None}


def test_the_task_and_view_routes_serve_the_app(client):
    for path in ("/p/abc/tasks", "/p/abc/view/v1", "/me/view/v1"):
        res = client.get(path)
        assert res.status_code == 200 and "text/html" in res.headers["content-type"], path
