"""Push subscriptions: which browsers get a user's notifications as push messages."""

import secrets
from datetime import datetime
from typing import List

from .engine import execute, fetchall
from .utils import get_db


def db_save_push_subscription(user_id: str, endpoint: str, p256dh: str, auth: str, user_agent: str = None) -> None:
    """Store the subscription of a browser. A browser has one row: enabling it again (also as another user) replaces it."""
    with get_db() as conn:
        execute(conn, "DELETE FROM push_subscriptions WHERE endpoint = ?", (endpoint,))
        execute(conn, """
            INSERT INTO push_subscriptions (id, user_id, endpoint, p256dh, auth, user_agent, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        """, (secrets.token_urlsafe(8), user_id, endpoint, p256dh, auth, (user_agent or "")[:300], datetime.now().isoformat()))


def db_delete_push_subscription(endpoint: str, user_id: str = None) -> None:
    """Forget a browser (only when it belongs to ``user_id``, if given)."""
    with get_db() as conn:
        if user_id:
            execute(conn, "DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id = ?", (endpoint, user_id))
        else:
            execute(conn, "DELETE FROM push_subscriptions WHERE endpoint = ?", (endpoint,))


def db_list_push_subscriptions(user_id: str) -> List[dict]:
    with get_db() as conn:
        rows = fetchall(execute(conn, "SELECT endpoint, p256dh, auth, user_agent, created_at FROM push_subscriptions "
                                      "WHERE user_id = ? ORDER BY created_at", (user_id,)))
    return [dict(r) for r in rows]
