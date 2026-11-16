"""Access per tab: project_access.can_lounge and invite_links.can_lounge.

A person's access to a project is three switches, one per tab of the app: Main (pages and tasks, the
existing ``can_tasks``), Review (``can_review``) and Lounge (``can_lounge``, new). Everyone who had access
before keeps the Lounge.
"""

from database.engine import add_column_if_not_exists


def up(conn):
    add_column_if_not_exists(conn, "project_access", "can_lounge", "INTEGER DEFAULT 1")
    add_column_if_not_exists(conn, "invite_links", "can_lounge", "INTEGER DEFAULT 1")
