"""page_versions: named and automatic versions of a page (H2). `state` is the full encoded Yjs document."""

from database.engine import execute, get_schema_type


def up(conn):
    blob = get_schema_type("BLOB")
    execute(conn, f"""
        CREATE TABLE IF NOT EXISTS page_versions (
            id TEXT PRIMARY KEY,
            page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
            created_at TEXT NOT NULL,
            created_by TEXT,
            name TEXT,
            kind TEXT NOT NULL,
            state {blob} NOT NULL,
            text_length INTEGER NOT NULL DEFAULT 0,
            excerpt TEXT,
            editors TEXT NOT NULL DEFAULT '[]'
        )
    """)
    execute(conn, "CREATE INDEX IF NOT EXISTS idx_page_versions_page ON page_versions(page_id, created_at)")
