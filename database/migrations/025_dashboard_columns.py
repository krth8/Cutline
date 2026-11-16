"""The dashboards get their new layout (blocks side by side): every project's dashboard is made again.

There is no data to keep yet, so the old dashboard pages and their views are simply replaced.
"""

from database.dashboard_page import ensure_dashboard_page
from database.engine import execute, fetchall


def up(conn):
    execute(conn, "DELETE FROM views WHERE owner_page_id IN (SELECT id FROM pages WHERE system_key = 'dashboard')")
    execute(conn, "DELETE FROM pages WHERE system_key = 'dashboard'")
    for row in fetchall(execute(conn, "SELECT id, created_by FROM projects")):
        ensure_dashboard_page(conn, row["id"], row["created_by"])
