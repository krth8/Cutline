"""Migration runner tests, each on its own temporary SQLite file."""

import sqlite3
from contextlib import contextmanager

import pytest

import conftest  # noqa: F401  (sets up the test environment before database is imported)
from database import migrate
from database.engine import DB_TYPE, DatabaseType

pytestmark = pytest.mark.skipif(DB_TYPE != DatabaseType.SQLITE, reason="runner tests use a temporary SQLite file")


@pytest.fixture
def env(tmp_path):
    db = tmp_path / "m.db"
    mdir = tmp_path / "migrations"
    mdir.mkdir()

    @contextmanager
    def connect():
        conn = sqlite3.connect(db)
        conn.row_factory = sqlite3.Row
        try:
            yield conn
            conn.commit()
        except Exception:
            conn.rollback()
            raise
        finally:
            conn.close()

    def add(name, body):
        (mdir / name).write_text(body)

    def query(sql):
        with connect() as c:
            return [tuple(r) for r in c.execute(sql).fetchall()]

    return connect, mdir, add, query


def test_applies_in_order_and_records(env):
    connect, mdir, add, query = env
    add("001_a.py", "def up(conn):\n    conn.execute('CREATE TABLE a (x INTEGER)')\n")
    add("002_b.py", "def up(conn):\n    conn.execute('INSERT INTO a VALUES (1)')\n")
    assert migrate.run_migrations(connect, mdir) == ["001", "002"]
    assert query("SELECT version, name FROM schema_migrations ORDER BY version") == [("001", "a"), ("002", "b")]
    assert query("SELECT x FROM a") == [(1,)]


def test_applied_migrations_do_not_run_twice(env):
    connect, mdir, add, query = env
    add("001_a.py", "def up(conn):\n    conn.execute('CREATE TABLE a (x INTEGER)')\n    conn.execute('INSERT INTO a VALUES (1)')\n")
    migrate.run_migrations(connect, mdir)
    assert migrate.run_migrations(connect, mdir) == []
    add("002_b.py", "def up(conn):\n    conn.execute('INSERT INTO a VALUES (2)')\n")
    assert migrate.run_migrations(connect, mdir) == ["002"]
    assert query("SELECT x FROM a ORDER BY x") == [(1,), (2,)]


def test_failing_migration_rolls_back_and_stops(env):
    connect, mdir, add, query = env
    add("001_a.py", "def up(conn):\n    conn.execute('CREATE TABLE a (x INTEGER)')\n")
    add("002_bad.py", "def up(conn):\n    conn.execute('CREATE TABLE b (x INTEGER)')\n    raise ValueError('boom')\n")
    add("003_c.py", "def up(conn):\n    conn.execute('CREATE TABLE c (x INTEGER)')\n")
    with pytest.raises(migrate.MigrationError, match="002_bad.py.*rolled back.*boom"):
        migrate.run_migrations(connect, mdir)
    assert query("SELECT version FROM schema_migrations") == [("001",)]
    tables = {r[0] for r in query("SELECT name FROM sqlite_master WHERE type='table'")}
    assert "b" not in tables and "c" not in tables
    # fixing the migration lets the next start continue
    add("002_bad.py", "def up(conn):\n    conn.execute('CREATE TABLE b (x INTEGER)')\n")
    assert migrate.run_migrations(connect, mdir) == ["002", "003"]


def test_duplicate_numbers_rejected(env):
    connect, mdir, add, _ = env
    add("001_a.py", "def up(conn): pass\n")
    add("001_b.py", "def up(conn): pass\n")
    with pytest.raises(migrate.MigrationError, match="Duplicate"):
        migrate.run_migrations(connect, mdir)


def test_baseline_recorded_in_app_database():
    versions = [v for v, _, _ in migrate.discover()]
    assert versions[0] == "001"
    from database.engine import execute, fetchall, get_connection
    with get_connection() as conn:
        rows = fetchall(execute(conn, "SELECT version FROM schema_migrations"))
    assert "001" in {r["version"] for r in rows}
