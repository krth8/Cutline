"""pages.import_claimed_at: when the legacy import was claimed, so a claim that was never used can expire."""

from database.engine import add_column_if_not_exists


def up(conn):
    add_column_if_not_exists(conn, "pages", "import_claimed_at", "TEXT")
