"""Pages: one tree of documents per space (a project, or a person). See PLAN.md 5.4."""

from database.engine import execute, get_schema_type


def up(conn):
    blob = get_schema_type("BLOB")
    # sort_order is double precision on both databases: PostgreSQL's REAL has too few
    # digits for repeated "halve the gap" inserts between two siblings.
    # import_claimed_by is an addition to the 5.4 contract: it makes claim-import atomic.
    execute(conn, f"""
        CREATE TABLE IF NOT EXISTS pages (
            id TEXT PRIMARY KEY,
            kind TEXT NOT NULL DEFAULT 'page' CHECK (kind IN ('page', 'task')),
            space_type TEXT NOT NULL CHECK (space_type IN ('project', 'personal')),
            project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
            owner_id TEXT REFERENCES users(id) ON DELETE CASCADE,
            parent_id TEXT REFERENCES pages(id) ON DELETE CASCADE,
            task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE,
            title TEXT NOT NULL DEFAULT 'Untitled',
            icon TEXT,
            sort_order DOUBLE PRECISION NOT NULL DEFAULT 0,
            ydoc {blob},
            text TEXT,
            legacy_html TEXT,
            import_claimed_by TEXT,
            created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            archived_at TEXT
        )
    """)
    execute(conn, "CREATE INDEX IF NOT EXISTS idx_pages_project ON pages(space_type, project_id)")
    execute(conn, "CREATE INDEX IF NOT EXISTS idx_pages_owner ON pages(space_type, owner_id)")
    execute(conn, "CREATE INDEX IF NOT EXISTS idx_pages_parent ON pages(parent_id)")
    # Partial unique index: supported by both SQLite and PostgreSQL
    execute(conn, "CREATE UNIQUE INDEX IF NOT EXISTS idx_pages_task ON pages(task_id) WHERE kind = 'task'")
