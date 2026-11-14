"""page_updates: the log of Yjs updates not yet folded into pages.ydoc. See PLAN.md 5.4 / 5.7."""

from database.engine import execute, get_schema_type


def up(conn):
    auto_id = get_schema_type("AUTO_ID")
    blob = get_schema_type("BLOB")
    # "update" is a reserved word on both databases, so the column is always quoted.
    execute(conn, f"""
        CREATE TABLE IF NOT EXISTS page_updates (
            id {auto_id},
            page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
            "update" {blob} NOT NULL,
            created_at TEXT NOT NULL
        )
    """)
    execute(conn, "CREATE INDEX IF NOT EXISTS idx_page_updates_page ON page_updates(page_id, id)")
