"""Notification preferences, task followers and sent due-date reminders (tables of migration 026)."""

from datetime import datetime
from typing import Dict

from .engine import execute, fetchall, insert_ignore
from .utils import get_db


def db_get_notification_prefs(user_id: str) -> Dict[str, bool]:
    """The kinds this person changed from the default: kind -> enabled."""
    with get_db() as conn:
        rows = fetchall(execute(conn, "SELECT kind, enabled FROM notification_prefs WHERE user_id = ?", (user_id,)))
    return {r["kind"]: bool(r["enabled"]) for r in rows}


def db_set_notification_pref(user_id: str, kind: str, enabled: bool) -> None:
    with get_db() as conn:
        execute(conn, "DELETE FROM notification_prefs WHERE user_id = ? AND kind = ?", (user_id, kind))
        execute(conn, "INSERT INTO notification_prefs (user_id, kind, enabled) VALUES (?, ?, ?)",
                (user_id, kind, 1 if enabled else 0))


def db_task_follow_choices(task_id: str) -> Dict[str, bool]:
    """Explicit follows (True) and unfollows (False) of a task: user id -> following."""
    with get_db() as conn:
        rows = fetchall(execute(conn, "SELECT user_id, following FROM task_followers WHERE task_id = ?", (task_id,)))
    return {r["user_id"]: bool(r["following"]) for r in rows}


def db_set_task_follow(task_id: str, user_id: str, following: bool) -> None:
    with get_db() as conn:
        execute(conn, "DELETE FROM task_followers WHERE task_id = ? AND user_id = ?", (task_id, user_id))
        execute(conn, "INSERT INTO task_followers (task_id, user_id, following) VALUES (?, ?, ?)",
                (task_id, user_id, 1 if following else 0))


def db_follow_if_undecided(task_id: str, user_id: str) -> None:
    """Follow a task unless the person already chose (so commenting never undoes an unfollow)."""
    with get_db() as conn:
        insert_ignore(conn, "task_followers", ("task_id", "user_id", "following"), (task_id, user_id, 1),
                      ("task_id", "user_id"))


def db_claim_reminder(task_id: str, kind: str, due_date: str) -> bool:
    """Record a reminder as sent. True when this call recorded it, False when it had gone out before."""
    with get_db() as conn:
        cursor = insert_ignore(conn, "task_reminders", ("task_id", "kind", "due_date", "sent_at"),
                               (task_id, kind, due_date, datetime.now().isoformat()), ("task_id", "kind", "due_date"))
        return bool(cursor and cursor.rowcount > 0)
