"""Mentions and backlinks (PLAN.md 5.4): page_refs, and a link on notifications."""

from database.engine import add_column_if_not_exists, execute


def up(conn):
    # What a page's document refers to, derived at snapshot time. ref_type: 'user' | 'task' | 'page' | 'clip'.
    # A clip's ref_id is "<projectId>:<baseName>".
    execute(conn, """
        CREATE TABLE IF NOT EXISTS page_refs (
            page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
            ref_type TEXT NOT NULL,
            ref_id TEXT NOT NULL,
            PRIMARY KEY (page_id, ref_type, ref_id)
        )
    """)
    execute(conn, "CREATE INDEX IF NOT EXISTS idx_page_refs_target ON page_refs(ref_type, ref_id)")
    # Where a notification leads when it is clicked (an app route such as /p/<id>/page/<id>)
    add_column_if_not_exists(conn, "notifications", "link", "TEXT")
