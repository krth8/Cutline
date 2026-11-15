"""clip_statuses.is_done: whether a status counts as "done" (the checkbox of the list layout, T11).

Existing statuses whose name matches the old name guess (done, complete, completed, finished,
closed) get the flag, so nothing changes for existing data.
"""

from database.engine import add_column_if_not_exists, execute

DONE_NAMES = ("done", "complete", "completed", "finished", "closed")


def up(conn):
    add_column_if_not_exists(conn, "clip_statuses", "is_done", "INTEGER DEFAULT 0")
    marks = ", ".join("?" for _ in DONE_NAMES)
    execute(conn, f"UPDATE clip_statuses SET is_done = 1 WHERE LOWER(TRIM(name)) IN ({marks})", DONE_NAMES)
