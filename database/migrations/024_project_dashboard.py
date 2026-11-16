"""Every project gets a dashboard page as its front page, and the fixed Tasks page is unlocked.

Tasks live in the database and are shown by blocks on any page, so a project no longer has a page that must
exist for them. The old Tasks pages are kept with everything on them: only their ``system_key`` is cleared,
which makes them ordinary pages (they can be renamed, moved, archived or deleted like any other).
The dashboard itself is built by database/dashboard_page.py.
"""

from database.dashboard_page import ensure_dashboard_page
from database.engine import execute, fetchall


def up(conn):
    execute(conn, "UPDATE pages SET system_key = NULL WHERE system_key = 'tasks'")
    for row in fetchall(execute(conn, "SELECT id, created_by FROM projects")):
        ensure_dashboard_page(conn, row["id"], row["created_by"])
