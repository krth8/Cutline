"""
Notification database operations
"""

import secrets
from datetime import datetime
from typing import List
from .engine import execute, fetchone, fetchall
from .utils import get_db


def db_create_notification(user_id: str, notification_type: str, title: str,
                          message: str = None, project_id: str = None) -> dict:
    """Create a new notification for a user."""
    notification_id = secrets.token_urlsafe(8)
    created_at = datetime.now().isoformat()

    with get_db() as conn:
        execute(conn, """
            INSERT INTO notifications (id, user_id, type, title, message, related_project_id, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        """, (notification_id, user_id, notification_type, title, message, project_id, created_at))

    return {
        "id": notification_id,
        "userId": user_id,
        "type": notification_type,
        "title": title,
        "message": message,
        "projectId": project_id,
        "isRead": False,
        "createdAt": created_at
    }


def db_list_notifications(user_id: str, limit: int = 50) -> List[dict]:
    """List notifications for a user, newest first."""
    with get_db() as conn:
        cursor = execute(conn,
            "SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT ?",
            (user_id, limit)
        )
        return [{
            "id": row["id"],
            "userId": row["user_id"],
            "type": row["type"],
            "title": row["title"],
            "message": row["message"],
            "projectId": row["related_project_id"],
            "isRead": bool(row["is_read"]),
            "createdAt": row["created_at"]
        } for row in fetchall(cursor)]


def db_get_unread_count(user_id: str) -> int:
    """Get count of unread notifications for a user."""
    with get_db() as conn:
        cursor = execute(conn,
            "SELECT COUNT(*) as count FROM notifications WHERE user_id = ? AND is_read = 0",
            (user_id,)
        )
        row = fetchone(cursor)
        return row["count"] if row else 0


def db_mark_notification_read(notification_id: str, user_id: str) -> bool:
    """Mark a single notification as read (only if it belongs to user_id)."""
    with get_db() as conn:
        cursor = execute(conn,
            "UPDATE notifications SET is_read = 1 WHERE id = ? AND user_id = ?",
            (notification_id, user_id)
        )
        return cursor.rowcount > 0


def db_mark_all_notifications_read(user_id: str) -> int:
    """Mark all notifications as read for a user."""
    with get_db() as conn:
        cursor = execute(conn,
            "UPDATE notifications SET is_read = 1 WHERE user_id = ? AND is_read = 0",
            (user_id,)
        )
        return cursor.rowcount


def db_delete_notification(notification_id: str, user_id: str) -> bool:
    """Delete a notification (only if it belongs to user_id)."""
    with get_db() as conn:
        cursor = execute(conn, "DELETE FROM notifications WHERE id = ? AND user_id = ?", (notification_id, user_id))
        return cursor.rowcount > 0
