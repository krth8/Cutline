"""
Project access control database operations
"""

import secrets
from datetime import datetime
from typing import List, Optional
from .engine import execute, fetchone, fetchall
from .utils import get_db
from .users import db_get_user_by_id
from .projects import db_list_projects


def db_grant_project_access(user_id: str, project_id: str, can_review: bool = True,
                            can_tasks: bool = False, is_owner: bool = False,
                            granted_by: str = None) -> dict:
    """Grant a user access to a project."""
    access_id = secrets.token_urlsafe(8)
    granted_at = datetime.now().isoformat()

    with get_db() as conn:
        cursor = execute(conn,
            "SELECT id FROM project_access WHERE user_id = ? AND project_id = ?",
            (user_id, project_id)
        )
        existing = fetchone(cursor)

        if existing:
            execute(conn, """
                UPDATE project_access
                SET can_review = ?, can_tasks = ?, is_owner = ?, granted_by = ?, granted_at = ?
                WHERE user_id = ? AND project_id = ?
            """, (1 if can_review else 0, 1 if can_tasks else 0, 1 if is_owner else 0,
                  granted_by, granted_at, user_id, project_id))
            access_id = existing["id"]
        else:
            execute(conn, """
                INSERT INTO project_access (id, user_id, project_id, can_review, can_tasks, is_owner, granted_by, granted_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """, (access_id, user_id, project_id, 1 if can_review else 0, 1 if can_tasks else 0,
                  1 if is_owner else 0, granted_by, granted_at))

    return {
        "id": access_id,
        "userId": user_id,
        "projectId": project_id,
        "canReview": can_review,
        "canTasks": can_tasks,
        "isOwner": is_owner,
        "grantedBy": granted_by,
        "grantedAt": granted_at
    }


def db_get_project_access(user_id: str, project_id: str) -> Optional[dict]:
    """Get a user's access to a specific project."""
    with get_db() as conn:
        cursor = execute(conn, """
            SELECT pa.*, u.username, u.role as user_role
            FROM project_access pa
            JOIN users u ON pa.user_id = u.id
            WHERE pa.user_id = ? AND pa.project_id = ?
        """, (user_id, project_id))
        row = fetchone(cursor)

        if not row:
            return None

        return {
            "id": row["id"],
            "userId": row["user_id"],
            "username": row["username"],
            "userRole": row["user_role"],
            "projectId": row["project_id"],
            "canReview": bool(row["can_review"]),
            "canTasks": bool(row["can_tasks"]),
            "isOwner": bool(row["is_owner"]),
            "grantedBy": row["granted_by"],
            "grantedAt": row["granted_at"]
        }


def db_list_project_access(project_id: str) -> List[dict]:
    """List all users with access to a project."""
    with get_db() as conn:
        cursor = execute(conn, """
            SELECT pa.*, u.username, u.role as user_role, u.profile_image,
                   g.username as grantor_name
            FROM project_access pa
            JOIN users u ON pa.user_id = u.id
            LEFT JOIN users g ON pa.granted_by = g.id
            WHERE pa.project_id = ?
            ORDER BY pa.is_owner DESC, pa.granted_at ASC
        """, (project_id,))

        return [{
            "id": row["id"],
            "userId": row["user_id"],
            "username": row["username"],
            "userRole": row["user_role"],
            "profileImage": row["profile_image"],
            "projectId": row["project_id"],
            "canReview": bool(row["can_review"]),
            "canTasks": bool(row["can_tasks"]),
            "isOwner": bool(row["is_owner"]),
            "grantedBy": row["granted_by"],
            "grantorName": row["grantor_name"],
            "grantedAt": row["granted_at"]
        } for row in fetchall(cursor)]


def db_list_user_project_access(user_id: str) -> List[dict]:
    """List all projects a user has access to."""
    with get_db() as conn:
        cursor = execute(conn, """
            SELECT pa.*, p.name as project_name, p.cover_image
            FROM project_access pa
            JOIN projects p ON pa.project_id = p.id
            WHERE pa.user_id = ?
            ORDER BY pa.granted_at DESC
        """, (user_id,))

        return [{
            "id": row["id"],
            "userId": row["user_id"],
            "projectId": row["project_id"],
            "projectName": row["project_name"],
            "coverImage": row["cover_image"],
            "canReview": bool(row["can_review"]),
            "canTasks": bool(row["can_tasks"]),
            "isOwner": bool(row["is_owner"]),
            "grantedAt": row["granted_at"]
        } for row in fetchall(cursor)]


def db_update_project_access(user_id: str, project_id: str,
                             can_review: bool = None, can_tasks: bool = None) -> bool:
    """Update a user's access permissions for a project."""
    updates = []
    params = []

    if can_review is not None:
        updates.append("can_review = ?")
        params.append(1 if can_review else 0)
    if can_tasks is not None:
        updates.append("can_tasks = ?")
        params.append(1 if can_tasks else 0)

    if not updates:
        return False

    params.extend([user_id, project_id])

    with get_db() as conn:
        query = f"UPDATE project_access SET {', '.join(updates)} WHERE user_id = ? AND project_id = ?"
        cursor = execute(conn, query, tuple(params))
        return cursor.rowcount > 0


def db_revoke_project_access(user_id: str, project_id: str) -> bool:
    """Revoke a user's access to a project."""
    with get_db() as conn:
        cursor = execute(conn,
            "DELETE FROM project_access WHERE user_id = ? AND project_id = ?",
            (user_id, project_id)
        )
        return cursor.rowcount > 0


def db_check_project_access(user_id: str, project_id: str,
                            require_review: bool = False, require_tasks: bool = False) -> bool:
    """Check if a user has access to a project."""
    user = db_get_user_by_id(user_id)
    if user and user.get("role") == "admin":
        return True

    access = db_get_project_access(user_id, project_id)
    if not access:
        return False

    if require_review and not access["canReview"]:
        return False
    if require_tasks and not access["canTasks"]:
        return False

    return True


def db_list_accessible_projects(user_id: str) -> List[dict]:
    """List all projects a user can access."""
    user = db_get_user_by_id(user_id)
    if not user:
        return []

    if user.get("role") == "admin":
        return db_list_projects()

    with get_db() as conn:
        cursor = execute(conn, """
            SELECT p.id, p.name, p.cover_image, p.created_at, p.created_by,
                   COUNT(DISTINCT c.id) as clip_count,
                   pa.can_review, pa.can_tasks, pa.is_owner
            FROM projects p
            JOIN project_access pa ON p.id = pa.project_id
            LEFT JOIN clips c ON c.project_id = p.id
            WHERE pa.user_id = ?
            GROUP BY p.id, p.name, p.cover_image, p.created_at, p.created_by,
                     pa.can_review, pa.can_tasks, pa.is_owner
            ORDER BY p.created_at DESC
        """, (user_id,))

        return [{
            "id": row["id"],
            "name": row["name"],
            "coverImage": row["cover_image"],
            "createdAt": row["created_at"],
            "createdBy": row["created_by"],
            "clipCount": row["clip_count"],
            "canReview": bool(row["can_review"]),
            "canTasks": bool(row["can_tasks"]),
            "isOwner": bool(row["is_owner"])
        } for row in fetchall(cursor)]
