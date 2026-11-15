"""page_files: images and attachments uploaded into pages. The bytes live on disk, one folder per page."""

from database.engine import execute


def up(conn):
    execute(conn, """
        CREATE TABLE IF NOT EXISTS page_files (
            id TEXT PRIMARY KEY,
            page_id TEXT NOT NULL,
            name TEXT NOT NULL,
            mime TEXT NOT NULL,
            size INTEGER NOT NULL,
            is_image INTEGER NOT NULL DEFAULT 0,
            width INTEGER,
            height INTEGER,
            created_by TEXT,
            created_at TEXT NOT NULL
        )
    """)
    execute(conn, "CREATE INDEX IF NOT EXISTS idx_page_files_page ON page_files(page_id)")
