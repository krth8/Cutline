"""Migration runner.

Numbered Python files in database/migrations/ (001_name.py, 002_name.py, ...) each expose
``up(conn)``. They are applied in order at startup, each in its own transaction, and recorded
in the ``schema_migrations`` table so they never run twice. Works on SQLite and PostgreSQL.
See database/migrations/README.md for how to add one.
"""

import importlib.util
import re
from pathlib import Path
from typing import Callable, List, Optional, Tuple

from . import engine
from .engine import DB_TYPE, DatabaseType, execute, fetchall, get_connection, table_exists

MIGRATIONS_DIR = Path(__file__).parent / "migrations"
_FILE_RE = re.compile(r"^(\d{3,})_([A-Za-z0-9_]+)\.py$")
_PG_LOCK_ID = 727274  # advisory lock so parallel workers do not apply the same migration


class MigrationError(RuntimeError):
    """A migration failed (it was rolled back) or the migration files are invalid."""


def discover(migrations_dir: Path = MIGRATIONS_DIR) -> List[Tuple[str, str, Path]]:
    """Return (version, name, path) for every migration file, sorted by version."""
    found = {}
    for path in Path(migrations_dir).iterdir():
        m = _FILE_RE.match(path.name)
        if not m:
            continue
        version = m.group(1)
        if version in found:
            raise MigrationError(f"Duplicate migration number {version}: {found[version][2].name} and {path.name}")
        found[version] = (version, m.group(2), path)
    return [found[v] for v in sorted(found, key=int)]


def _load_up(path: Path) -> Callable:
    spec = importlib.util.spec_from_file_location(f"cutline_migration_{path.stem}", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    up = getattr(module, "up", None)
    if not callable(up):
        raise MigrationError(f"Migration {path.name} does not define up(conn)")
    return up


def _ensure_table(conn):
    if not table_exists(conn, "schema_migrations"):
        execute(conn, """
            CREATE TABLE IF NOT EXISTS schema_migrations (
                version TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                applied_at TEXT NOT NULL
            )
        """)


def _applied(conn) -> set:
    return {r["version"] for r in fetchall(execute(conn, "SELECT version FROM schema_migrations"))}


def run_migrations(connect: Optional[Callable] = None, migrations_dir: Optional[Path] = None) -> List[str]:
    """Apply all pending migrations. Returns the versions applied by this call.

    ``connect`` is a context-manager factory yielding a connection that commits on success and
    rolls back on error (default: database.engine.get_connection). ``migrations_dir`` defaults to
    database/migrations/. Raises MigrationError if a migration fails; that migration is rolled back.
    """
    connect = connect or get_connection
    migrations = discover(migrations_dir or MIGRATIONS_DIR)

    with connect() as conn:
        _ensure_table(conn)
        done = _applied(conn)

    applied_now = []
    for version, name, path in migrations:
        if version in done:
            continue
        try:
            with connect() as conn:
                if DB_TYPE == DatabaseType.POSTGRESQL:
                    execute(conn, "SELECT pg_advisory_xact_lock(?)", (_PG_LOCK_ID,))
                else:
                    # Python's sqlite3 does not open a transaction for DDL on its own
                    conn.execute("BEGIN IMMEDIATE")
                if version in _applied(conn):  # another worker got there first
                    continue
                _load_up(path)(conn)
                execute(conn, "INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)",
                        (version, name, engine.get_current_timestamp()))
        except MigrationError:
            raise
        except Exception as e:
            raise MigrationError(
                f"Migration {path.name} failed and was rolled back: {type(e).__name__}: {e}. "
                f"Startup stopped; fix the migration or the data and restart."
            ) from e
        applied_now.append(version)
        print(f"Applied migration {path.name}")
    return applied_now
