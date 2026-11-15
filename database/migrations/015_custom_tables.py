"""custom_tables and custom_rows: user-created tables (WP C1). PLAN.md 5.4.

A table belongs to a space like a page does: a project, or one person. Its columns are rows of
``table_columns`` with ``table_ref = 'tbl_<id>'``. A row keeps its values as a JSON object keyed
by column key (``data``; ``values`` is a reserved word in PostgreSQL). Custom tables have no
hierarchy, so rows have no parent.
"""

from database.engine import execute


def up(conn):
    execute(conn, """
        CREATE TABLE IF NOT EXISTS custom_tables (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            space_type TEXT NOT NULL CHECK (space_type IN ('project', 'personal')),
            project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
            owner_id TEXT REFERENCES users(id) ON DELETE CASCADE,
            created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        )
    """)
    execute(conn, "CREATE INDEX IF NOT EXISTS idx_custom_tables_project ON custom_tables(space_type, project_id)")
    execute(conn, "CREATE INDEX IF NOT EXISTS idx_custom_tables_owner ON custom_tables(space_type, owner_id)")
    execute(conn, """
        CREATE TABLE IF NOT EXISTS custom_rows (
            id TEXT PRIMARY KEY,
            table_id TEXT NOT NULL REFERENCES custom_tables(id) ON DELETE CASCADE,
            data TEXT NOT NULL DEFAULT '{}',
            sort_order DOUBLE PRECISION NOT NULL DEFAULT 0,
            created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        )
    """)
    execute(conn, "CREATE INDEX IF NOT EXISTS idx_custom_rows_table ON custom_rows(table_id, sort_order)")
