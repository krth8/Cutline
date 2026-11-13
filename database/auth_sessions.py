"""
Login session storage (see api/sessions.py for the rules).
"""

from typing import List
from .engine import execute, fetchall
from .utils import get_db


def db_create_auth_session(session_id: str, user_id: str, created_at: int, expires_at: int) -> None:
    with get_db() as conn:
        execute(conn, """
            INSERT INTO auth_sessions (id, user_id, created_at, last_activity, expires_at)
            VALUES (?, ?, ?, ?, ?)
        """, (session_id, user_id, created_at, created_at, expires_at))


def db_list_auth_sessions() -> List[dict]:
    with get_db() as conn:
        cursor = execute(conn, "SELECT id, user_id, last_activity, expires_at FROM auth_sessions")
        return [{
            "id": row["id"],
            "user_id": row["user_id"],
            "last_activity": int(row["last_activity"]),
            "expires_at": int(row["expires_at"]),
        } for row in fetchall(cursor)]


def db_touch_auth_session(session_id: str, last_activity: int) -> None:
    with get_db() as conn:
        execute(conn, "UPDATE auth_sessions SET last_activity = ? WHERE id = ?", (last_activity, session_id))


def db_delete_auth_sessions(session_ids: List[str]) -> None:
    if not session_ids:
        return
    with get_db() as conn:
        for session_id in session_ids:
            execute(conn, "DELETE FROM auth_sessions WHERE id = ?", (session_id,))
