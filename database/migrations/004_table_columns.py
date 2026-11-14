"""table_columns: user-defined columns of a table (for tasks, table_ref is 'tasks:<projectId>'). PLAN.md 5.4."""

from database.engine import execute


def up(conn):
    execute(conn, """
        CREATE TABLE IF NOT EXISTS table_columns (
            id TEXT PRIMARY KEY,
            table_ref TEXT NOT NULL,
            key TEXT NOT NULL,
            name TEXT NOT NULL,
            type TEXT NOT NULL,
            config TEXT,
            sort_order DOUBLE PRECISION NOT NULL DEFAULT 0,
            created_by TEXT,
            created_at TEXT NOT NULL,
            UNIQUE (table_ref, key)
        )
    """)
    execute(conn, "CREATE INDEX IF NOT EXISTS idx_table_columns_ref ON table_columns(table_ref)")
