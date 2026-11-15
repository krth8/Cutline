"""tasks.start_date: optional start of a task (date-only text, YYYY-MM-DD). PLAN.md 5.4, T9."""

from database.engine import add_column_if_not_exists


def up(conn):
    add_column_if_not_exists(conn, "tasks", "start_date", "TEXT")
