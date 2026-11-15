"""A "Tasks" page for every project (PLAN.md T13).

Adds ``pages.system_key`` (NULL for ordinary pages, 'tasks' for the Tasks page of a project; one per
project) and creates the page, with its table view, for every project that has none. Running it again
adds nothing. The page itself is built by database/tasks_page.py.
"""

from database.engine import add_column_if_not_exists, execute, fetchall
from database.tasks_page import ensure_tasks_page


def up(conn):
    add_column_if_not_exists(conn, "pages", "system_key", "TEXT")
    execute(conn, "CREATE UNIQUE INDEX IF NOT EXISTS idx_pages_system ON pages(project_id, system_key) "
                  "WHERE system_key IS NOT NULL")
    for row in fetchall(execute(conn, "SELECT id, created_by FROM projects")):
        ensure_tasks_page(conn, row["id"], row["created_by"])
