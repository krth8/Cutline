"""Notifications about tasks: who follows a task, which kinds of notification each person wants, and which due-date
reminders have gone out.

- ``notification_prefs``: one row per person and kind they changed from the default (api/notify.py has the kinds).
- ``task_followers``: an explicit follow (1) or unfollow (0). Assignees, the creator and commenters follow a task
  unless they unfollowed it.
- ``task_reminders``: a due-date reminder that was sent, so each one goes out once (per task, kind and due date).
"""

from database.engine import execute


def up(conn):
    execute(conn, """
        CREATE TABLE IF NOT EXISTS notification_prefs (
            user_id TEXT NOT NULL,
            kind TEXT NOT NULL,
            enabled INTEGER NOT NULL,
            PRIMARY KEY (user_id, kind)
        )
    """)
    execute(conn, """
        CREATE TABLE IF NOT EXISTS task_followers (
            task_id TEXT NOT NULL,
            user_id TEXT NOT NULL,
            following INTEGER NOT NULL,
            PRIMARY KEY (task_id, user_id)
        )
    """)
    execute(conn, """
        CREATE TABLE IF NOT EXISTS task_reminders (
            task_id TEXT NOT NULL,
            kind TEXT NOT NULL,
            due_date TEXT NOT NULL,
            sent_at TEXT NOT NULL,
            PRIMARY KEY (task_id, kind, due_date)
        )
    """)
