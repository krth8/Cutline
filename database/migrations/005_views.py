"""views: saved configurations (layout, filter, sort, group, columns) of a table. PLAN.md 5.4."""

from database.engine import execute


def up(conn):
    execute(conn, """
        CREATE TABLE IF NOT EXISTS views (
            id TEXT PRIMARY KEY,
            table_ref TEXT NOT NULL,
            name TEXT NOT NULL,
            owner_page_id TEXT,
            layout TEXT NOT NULL,
            config TEXT NOT NULL,
            created_by TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        )
    """)
    execute(conn, "CREATE INDEX IF NOT EXISTS idx_views_owner_page ON views(owner_page_id)")
    execute(conn, "CREATE INDEX IF NOT EXISTS idx_views_table_ref ON views(table_ref)")
