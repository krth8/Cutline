"""
Task comments database operations
"""

import secrets
from datetime import datetime
from typing import List, Optional
from .engine import execute, fetchone, fetchall
from .utils import get_db


def db_create_task_comment(task_id: str, user_id: str, user_name: str, text: str,
                           user_profile_image: str = None) -> dict:
    """Create a new comment on a task."""
    comment_id = secrets.token_urlsafe(12)
    created_at = datetime.now().isoformat()

    with get_db() as conn:
        execute(conn, """
            INSERT INTO task_comments (id, task_id, user_id, user_name, user_profile_image, text, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        """, (comment_id, task_id, user_id, user_name, user_profile_image, text, created_at))

    return {
        "id": comment_id,
        "taskId": task_id,
        "userId": user_id,
        "userName": user_name,
        "userProfileImage": user_profile_image,
        "text": text,
        "createdAt": created_at
    }


def db_get_task_comments(task_id: str) -> List[dict]:
    """Get all comments for a task, ordered by creation time."""
    with get_db() as conn:
        cursor = execute(conn, """
            SELECT id, task_id, user_id, user_name, user_profile_image, text, created_at, updated_at
            FROM task_comments
            WHERE task_id = ?
            ORDER BY created_at ASC
        """, (task_id,))
        rows = fetchall(cursor)

    return [{
        "id": row["id"],
        "taskId": row["task_id"],
        "userId": row["user_id"],
        "userName": row["user_name"],
        "userProfileImage": row["user_profile_image"],
        "text": row["text"],
        "createdAt": row["created_at"],
        "updatedAt": row["updated_at"]
    } for row in rows]


def db_get_task_comment(comment_id: str) -> Optional[dict]:
    """Get a single comment by ID."""
    with get_db() as conn:
        cursor = execute(conn, """
            SELECT id, task_id, user_id, user_name, user_profile_image, text, created_at, updated_at
            FROM task_comments
            WHERE id = ?
        """, (comment_id,))
        row = fetchone(cursor)

    if not row:
        return None

    return {
        "id": row["id"],
        "taskId": row["task_id"],
        "userId": row["user_id"],
        "userName": row["user_name"],
        "userProfileImage": row["user_profile_image"],
        "text": row["text"],
        "createdAt": row["created_at"],
        "updatedAt": row["updated_at"]
    }


def db_update_task_comment(comment_id: str, text: str) -> bool:
    """Update a comment's text."""
    updated_at = datetime.now().isoformat()

    with get_db() as conn:
        cursor = execute(conn, """
            UPDATE task_comments
            SET text = ?, updated_at = ?
            WHERE id = ?
        """, (text, updated_at, comment_id))
        return cursor.rowcount > 0


def db_delete_task_comment(comment_id: str) -> bool:
    """Delete a comment."""
    with get_db() as conn:
        cursor = execute(conn, "DELETE FROM task_comments WHERE id = ?", (comment_id,))
        return cursor.rowcount > 0


def db_get_task_comment_count(task_id: str) -> int:
    """Get the number of comments on a task."""
    with get_db() as conn:
        cursor = execute(conn, """
            SELECT COUNT(*) as count FROM task_comments WHERE task_id = ?
        """, (task_id,))
        row = fetchone(cursor)
        return row["count"] if row else 0
