"""Migration 006: the old Docs (doc_folders, documents) become pages.

The structure tests run on a temporary SQLite database that is built like a production one
(baseline schema, migrations 001-005, old Docs data) and then migrated. The permission tests run
against the app's own test database.
"""

import shutil
import sqlite3
from contextlib import contextmanager

import pytest

import conftest  # noqa: F401  (sets up the test environment before database is imported)
from conftest import auth
from database import migrate
from database.docs_to_pages import copy_docs_to_pages, docs_moved
from database.engine import DB_TYPE, DatabaseType, init_schema
from database.utils import get_db

pytestmark = pytest.mark.skipif(DB_TYPE != DatabaseType.SQLITE, reason="uses a temporary SQLite file")

ODD_TITLE = "Ünïcödé ✓ <b>&amp; \"quotes\" 'single' 日本語"
LONG_TITLE = "L" * 500


# ---------- the old database ----------

@pytest.fixture
def old_db(tmp_path):
    """A database at migration 005 with old Docs data. Returns (connect, migrate_to_006, query)."""
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

    before, after = tmp_path / "before", tmp_path / "after"
    before.mkdir()
    after.mkdir()
    for src in migrate.MIGRATIONS_DIR.glob("00*.py"):
        shutil.copy(src, after / src.name)
        if not src.name.startswith("006"):
            shutil.copy(src, before / src.name)

    with connect() as conn:
        init_schema(conn)
    migrate.run_migrations(connect, before)
    seed(connect)

    def migrate_to_006():
        return migrate.run_migrations(connect, after)

    def query(sql, params=()):
        with connect() as c:
            return [dict(r) for r in c.execute(sql, params).fetchall()]

    return connect, migrate_to_006, query


def seed(connect):
    with connect() as c:
        c.execute("PRAGMA foreign_keys=OFF")  # the damaged rows below could not be inserted otherwise
        for uid in ("u1", "u2"):
            c.execute("INSERT INTO users (id, username, password_hash, created_at) VALUES (?, ?, 'x', '2024-01-01')",
                      (uid, uid))
        for pid in ("P1", "P2", "P3"):
            c.execute("INSERT INTO projects (id, name, created_at) VALUES (?, ?, '2024-01-01')", (pid, pid))

        def folder(fid, project, parent, name, order, created="2024-02-01T10:00:00"):
            c.execute("INSERT INTO doc_folders (id, project_id, parent_id, name, sort_order, created_at, updated_at) "
                      "VALUES (?, ?, ?, ?, ?, ?, ?)", (fid, project, parent, name, order, created, created + "1"))

        def doc(did, project, folder_id, title, content, order, by="u1", created="2024-03-01T10:00:00"):
            c.execute("INSERT INTO documents (id, project_id, folder_id, title, content, created_by, sort_order, "
                      "created_at, updated_at, version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 3)",
                      (did, project, folder_id, title, content, by, order, created, created + "9"))

        # P1: nested folders, folders given out of order
        folder("fA", "P1", None, "Alpha", 1)
        folder("fB", "P1", None, "Beta", 0)
        folder("fA1", "P1", "fA", "Alpha one", 0)
        folder("fA1x", "P1", "fA1", "Deep", 0)
        doc("dRoot", "P1", None, "Root doc", "<p>root</p>", 0)
        doc("dA2", "P1", "fA", "Second in Alpha", "<p>a2</p>", 1)
        doc("dA1", "P1", "fA", "First in Alpha", "<h1>a1</h1><p>text</p>", 0, by="u2")
        doc("dDeep", "P1", "fA1x", "Deep doc", "<p>deep</p>", 0)
        doc("dEmpty", "P1", "fB", "Empty", None, 0)
        doc("dBlank", "P1", "fB", "Blank", "  \n ", 1)
        doc("dOdd", "P1", None, ODD_TITLE, "<p>odd</p>", 1)
        doc("dLong", "P1", None, LONG_TITLE, "<p>long</p>", 2)
        doc("dNoTitle", "P1", None, "", "<p>x</p>", 3)
        doc("dTieB", "P1", None, "Tie B", "<p>b</p>", 7, created="2024-03-02T10:00:00")
        doc("dTieA", "P1", None, "Tie A", "<p>a</p>", 7, created="2024-03-01T09:00:00")
        # P2: same folder name as in P1, a cycle, a folder whose parent is in another project
        folder("fP2", "P2", None, "Alpha", 0)
        folder("fCycleX", "P2", "fCycleY", "Cycle X", 1)
        folder("fCycleY", "P2", "fCycleX", "Cycle Y", 2)
        folder("fForeign", "P2", "fA", "Foreign parent", 3)
        doc("dP2", "P2", "fP2", "In P2", "<p>p2</p>", 0, by=None)
        doc("dForeign", "P2", "fA", "Folder of another project", "<p>f</p>", 1)
        # P3 has no docs at all


def pages_by_id(query):
    return {r["id"]: r for r in query("SELECT * FROM pages")}


def children(query, project, parent):
    where = "parent_id IS NULL" if parent is None else "parent_id = ?"
    params = (project,) if parent is None else (project, parent)
    rows = query(f"SELECT id FROM pages WHERE project_id = ? AND {where} ORDER BY sort_order", params)
    return [r["id"] for r in rows]


# ---------- structure ----------

def test_counts_and_content_match(old_db):
    _, migrate_to_006, query = old_db
    folders = query("SELECT * FROM doc_folders")
    docs = query("SELECT * FROM documents")
    assert migrate_to_006() == ["006"]
    pages = pages_by_id(query)
    assert len(folders) == 8 and len(docs) == 13
    assert len(pages) == len(folders) + len(docs)

    for d in docs:
        p = pages[d["id"]]
        assert (p["kind"], p["space_type"], p["project_id"], p["owner_id"]) == ("page", "project", d["project_id"], None)
        assert p["title"] == (d["title"] or "Untitled")
        assert p["created_by"] == d["created_by"]
        assert (p["created_at"], p["updated_at"]) == (d["created_at"], d["updated_at"])
        assert p["legacy_html"] == (d["content"] if d["content"] and d["content"].strip() else None)
        assert p["ydoc"] is None and p["archived_at"] is None and p["task_id"] is None
    for f in folders:
        p = pages[f["id"]]
        assert (p["title"], p["project_id"], p["legacy_html"], p["kind"]) == (f["name"], f["project_id"], None, "page")
        assert (p["created_at"], p["updated_at"]) == (f["created_at"], f["updated_at"])
    # nothing was removed from the old tables
    assert len(query("SELECT * FROM documents")) == len(docs)
    assert len(query("SELECT * FROM doc_folders")) == len(folders)
    assert pages["dOdd"]["title"] == ODD_TITLE and pages["dLong"]["title"] == LONG_TITLE
    assert pages["dNoTitle"]["title"] == "Untitled"
    assert pages["dEmpty"]["legacy_html"] is None and pages["dBlank"]["legacy_html"] is None


def test_hierarchy_and_order_match(old_db):
    _, migrate_to_006, query = old_db
    migrate_to_006()
    pages = pages_by_id(query)
    assert pages["fA1"]["parent_id"] == "fA" and pages["fA1x"]["parent_id"] == "fA1"
    assert pages["dDeep"]["parent_id"] == "fA1x" and pages["dA1"]["parent_id"] == "fA"
    assert pages["dRoot"]["parent_id"] is None and pages["fA"]["parent_id"] is None
    # folders first, then documents, each in the old order (ties by creation time)
    assert children(query, "P1", None) == ["fB", "fA", "dRoot", "dOdd", "dLong", "dNoTitle", "dTieA", "dTieB"]
    assert children(query, "P1", "fA") == ["fA1", "dA1", "dA2"]
    assert children(query, "P1", "fB") == ["dEmpty", "dBlank"]
    # damaged data lands at the top of its own project instead of failing the migration
    assert pages["fForeign"]["parent_id"] is None and pages["dForeign"]["parent_id"] is None
    assert None in {pages["fCycleX"]["parent_id"], pages["fCycleY"]["parent_id"]}
    assert pages["fP2"]["parent_id"] is None and pages["dP2"]["parent_id"] == "fP2"
    # every parent is in the same project
    for p in pages.values():
        if p["parent_id"]:
            assert pages[p["parent_id"]]["project_id"] == p["project_id"]
    assert query("SELECT COUNT(*) AS n FROM pages WHERE project_id = 'P3'")[0]["n"] == 0


def test_second_run_changes_nothing(old_db):
    connect, migrate_to_006, query = old_db
    migrate_to_006()
    first = query("SELECT * FROM pages ORDER BY id")
    with connect() as conn:
        assert copy_docs_to_pages(conn) == {"folders": 0, "documents": 0}
    assert migrate_to_006() == []
    assert query("SELECT * FROM pages ORDER BY id") == first


def test_copy_adds_only_what_is_missing_and_keeps_later_edits(old_db):
    connect, migrate_to_006, query = old_db
    migrate_to_006()
    with connect() as c:
        c.execute("UPDATE pages SET title = 'Renamed', parent_id = NULL WHERE id = 'dDeep'")
        c.execute("DELETE FROM pages WHERE id = 'dRoot'")
        c.execute("INSERT INTO documents (id, project_id, folder_id, title, content, created_by, sort_order, "
                  "created_at, updated_at) VALUES ('dNew', 'P1', 'fB', 'New', '<p>n</p>', 'u1', 5, 'c', 'u')")
    with connect() as conn:
        assert copy_docs_to_pages(conn) == {"folders": 0, "documents": 2}
    pages = pages_by_id(query)
    assert pages["dDeep"]["title"] == "Renamed" and pages["dDeep"]["parent_id"] is None
    assert pages["dRoot"]["legacy_html"] == "<p>root</p>" and pages["dNew"]["parent_id"] == "fB"


def test_empty_old_docs(old_db):
    connect, migrate_to_006, query = old_db
    with connect() as c:
        c.execute("DELETE FROM documents")
        c.execute("DELETE FROM doc_folders")
    assert migrate_to_006() == ["006"]
    assert query("SELECT COUNT(*) AS n FROM pages")[0]["n"] == 0
    assert query("SELECT version FROM schema_migrations WHERE version = '006'")


def test_docs_moved_flag_is_reported_to_the_legacy_ui(client, admin):
    assert docs_moved() is True
    res = client.get("/api/auth/me", headers=auth(admin["token"]))
    assert res.json()["docsMoved"] is True


# ---------- permissions (the app's own database) ----------

def test_migrated_pages_are_readable_by_exactly_those_who_could_read_the_documents(
        client, admin, make_user, make_project, grant):
    project = make_project("Docs project")
    other = make_project("Other project")
    reader = make_user("viewer")      # reads the docs (now pages), edits nothing
    tasker = make_user()      # task access
    viewer = make_user("viewer")
    outsider = make_user()    # no access
    grant(project, reader["user"]["id"], can_review=True, can_tasks=True)
    grant(project, tasker["user"]["id"], can_review=False, can_tasks=True)
    grant(project, viewer["user"]["id"], can_review=True, can_tasks=True)

    h = auth(admin["token"])
    folder = client.post(f"/api/projects/{project}/folders", json={"name": "F"}, headers=h).json()["id"]
    doc = client.post(f"/api/projects/{project}/documents", json={"title": "D", "folderId": folder},
                      headers=h).json()["id"]
    client.patch(f"/api/documents/{doc}", json={"content": "<p>secret</p>"}, headers=h)
    elsewhere = client.post(f"/api/projects/{other}/documents", json={"title": "E"}, headers=h).json()["id"]

    users = {"admin": admin, "reader": reader, "tasker": tasker, "viewer": viewer, "outsider": outsider}
    old_read = {name: client.get(f"/api/documents/{doc}", headers=auth(u["token"])).status_code == 200
                for name, u in users.items()}
    old_other = {name: client.get(f"/api/documents/{elsewhere}", headers=auth(u["token"])).status_code == 200
                 for name, u in users.items()}
    assert old_read["reader"] and not old_read["outsider"] and not old_other["reader"]

    with get_db() as conn:
        counts = copy_docs_to_pages(conn)
    assert counts["documents"] >= 2 and counts["folders"] >= 1

    for name, u in users.items():
        for page_id, was_readable in ((doc, old_read[name]), (folder, old_read[name]), (elsewhere, old_other[name])):
            res = client.get(f"/api/pages/{page_id}", headers=auth(u["token"]))
            assert (res.status_code == 200) == was_readable, (name, page_id, res.status_code)

    body = client.get(f"/api/pages/{doc}", headers=auth(reader["token"])).json()
    assert body["parentId"] == folder and body["needsImport"] is True and body["legacyHtml"] == "<p>secret</p>"
    assert body["space"] == f"p:{project}" and body["canEdit"] is False
    assert client.get(f"/api/pages/{doc}", headers=auth(tasker["token"])).json()["canEdit"] is True
    assert client.get(f"/api/pages/{doc}", headers=auth(viewer["token"])).json()["canEdit"] is False
    listing = client.get(f"/api/spaces/p:{project}/pages", headers=auth(reader["token"])).json()
    assert {p["id"]: p["parentId"] for p in listing if not p.get("system")} == {folder: None, doc: folder}
    assert client.get(f"/api/spaces/p:{project}/pages", headers=auth(outsider["token"])).status_code == 403
