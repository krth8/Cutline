"""
Share links, guests, and invite links database operations
"""

import secrets
import hashlib
import bcrypt
from datetime import datetime, timedelta
from typing import List, Optional
from .engine import execute, fetchone, fetchall
from .utils import get_db


def _hash_password(password: str) -> str:
    """Hash a password using bcrypt."""
    password_bytes = password.encode('utf-8')
    hashed = bcrypt.hashpw(password_bytes, bcrypt.gensalt(rounds=12))
    return hashed.decode('utf-8')


def _verify_password(password: str, hashed: str) -> bool:
    """Verify a password against a bcrypt hash."""
    try:
        password_bytes = password.encode('utf-8')
        hashed_bytes = hashed.encode('utf-8')
        return bcrypt.checkpw(password_bytes, hashed_bytes)
    except Exception:
        return False


def _verify_password_legacy(password: str, password_hash: str, password_salt: str) -> bool:
    """Verify password using legacy SHA-256 method."""
    hash_obj = hashlib.sha256((password_salt + password).encode())
    return hash_obj.hexdigest() == password_hash


# ============ Share Link Operations ============

def db_create_share_link(project_id: str, password: str = None, created_by: str = None,
                         expires_at: str = None) -> dict:
    """Create a new share link for a project."""
    link_id = secrets.token_urlsafe(16)
    created_at = datetime.now().isoformat()

    password_hash = None
    if password:
        password_hash = _hash_password(password)

    with get_db() as conn:
        execute(conn, """
            INSERT INTO share_links (id, project_id, password_hash, password_salt,
                                     created_at, created_by, expires_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        """, (link_id, project_id, password_hash, None, created_at, created_by, expires_at))

    return {
        "id": link_id,
        "projectId": project_id,
        "hasPassword": password is not None,
        "createdAt": created_at,
        "createdBy": created_by,
        "expiresAt": expires_at,
        "isActive": True,
        "accessCount": 0
    }


def db_get_share_link(link_id: str) -> Optional[dict]:
    """Get a share link by ID."""
    with get_db() as conn:
        cursor = execute(conn, "SELECT * FROM share_links WHERE id = ?", (link_id,))
        row = fetchone(cursor)

        if not row:
            return None

        return {
            "id": row["id"],
            "projectId": row["project_id"],
            "hasPassword": row["password_hash"] is not None,
            "createdAt": row["created_at"],
            "createdBy": row["created_by"],
            "expiresAt": row["expires_at"],
            "isActive": bool(row["is_active"]),
            "accessCount": row["access_count"],
            "_passwordHash": row["password_hash"],
            "_passwordSalt": row["password_salt"]
        }


def db_validate_share_link_password(link_id: str, password: str) -> bool:
    """Validate a password for a share link."""
    with get_db() as conn:
        cursor = execute(conn,
            "SELECT password_hash, password_salt FROM share_links WHERE id = ? AND is_active = 1",
            (link_id,)
        )
        row = fetchone(cursor)

        if not row:
            return False

        if row["password_hash"] is None:
            return True

        if _verify_password(password, row["password_hash"]):
            return True

        if row["password_salt"] and _verify_password_legacy(password, row["password_hash"], row["password_salt"]):
            return True

        return False


def db_increment_share_link_access(link_id: str):
    """Increment the access count for a share link."""
    with get_db() as conn:
        execute(conn,
            "UPDATE share_links SET access_count = access_count + 1 WHERE id = ?",
            (link_id,)
        )


def db_list_share_links(project_id: str) -> List[dict]:
    """List all share links for a project."""
    with get_db() as conn:
        cursor = execute(conn,
            "SELECT * FROM share_links WHERE project_id = ? ORDER BY created_at DESC",
            (project_id,)
        )

        return [{
            "id": row["id"],
            "projectId": row["project_id"],
            "hasPassword": row["password_hash"] is not None,
            "createdAt": row["created_at"],
            "createdBy": row["created_by"],
            "expiresAt": row["expires_at"],
            "isActive": bool(row["is_active"]),
            "accessCount": row["access_count"]
        } for row in fetchall(cursor)]


def db_list_all_share_links() -> List[dict]:
    """List all share links across all projects."""
    with get_db() as conn:
        cursor = execute(conn,
            "SELECT * FROM share_links ORDER BY project_id, created_at DESC"
        )

        return [{
            "id": row["id"],
            "projectId": row["project_id"],
            "hasPassword": row["password_hash"] is not None,
            "createdAt": row["created_at"],
            "createdBy": row["created_by"],
            "expiresAt": row["expires_at"],
            "isActive": bool(row["is_active"]),
            "accessCount": row["access_count"]
        } for row in fetchall(cursor)]


def db_deactivate_share_link(link_id: str) -> bool:
    """Deactivate a share link."""
    with get_db() as conn:
        cursor = execute(conn,
            "UPDATE share_links SET is_active = 0 WHERE id = ?",
            (link_id,)
        )
        return cursor.rowcount > 0


def db_delete_share_link(link_id: str) -> bool:
    """Permanently delete a share link."""
    with get_db() as conn:
        cursor = execute(conn, "DELETE FROM share_links WHERE id = ?", (link_id,))
        return cursor.rowcount > 0


# ============ Guest Operations ============

def db_track_guest(name: str, project_id: str, share_link_id: str = None) -> dict:
    """Track a guest accessing via share link."""
    now = datetime.now().isoformat()
    guest_id = secrets.token_urlsafe(8)

    with get_db() as conn:
        cursor = execute(conn,
            "SELECT id, first_seen FROM guests WHERE name = ? AND project_id = ?",
            (name, project_id)
        )
        existing = fetchone(cursor)

        if existing:
            execute(conn,
                "UPDATE guests SET last_seen = ? WHERE id = ?",
                (now, existing["id"])
            )
            return {
                "id": existing["id"],
                "name": name,
                "projectId": project_id,
                "firstSeen": existing["first_seen"],
                "lastSeen": now
            }
        else:
            execute(conn, """
                INSERT INTO guests (id, name, project_id, share_link_id, first_seen, last_seen)
                VALUES (?, ?, ?, ?, ?, ?)
            """, (guest_id, name, project_id, share_link_id, now, now))

            return {
                "id": guest_id,
                "name": name,
                "projectId": project_id,
                "firstSeen": now,
                "lastSeen": now
            }


def db_list_guests() -> List[dict]:
    """List all guests."""
    with get_db() as conn:
        cursor = execute(conn,
            "SELECT * FROM guests ORDER BY last_seen DESC"
        )
        return [{
            "id": row["id"],
            "name": row["name"],
            "projectId": row["project_id"],
            "shareLinkId": row["share_link_id"],
            "firstSeen": row["first_seen"],
            "lastSeen": row["last_seen"]
        } for row in fetchall(cursor)]


def db_delete_guest(guest_id: str) -> bool:
    """Delete a guest."""
    with get_db() as conn:
        cursor = execute(conn, "DELETE FROM guests WHERE id = ?", (guest_id,))
        return cursor.rowcount > 0


# ============ Invite Link Operations ============

def db_create_invite_link(created_by: str, is_admin: bool = False, role: str = 'viewer',
                          project_id: str = None, can_review: bool = True, can_tasks: bool = False,
                          max_uses: int = 1, expires_in_days: int = None) -> dict:
    """Create a new invite link."""
    link_id = secrets.token_urlsafe(16)
    created_at = datetime.now().isoformat()
    expires_at = None
    if expires_in_days:
        expires_at = (datetime.now() + timedelta(days=expires_in_days)).isoformat()

    if role == 'admin':
        is_admin = True
    elif is_admin:
        role = 'admin'

    with get_db() as conn:
        execute(conn, """
            INSERT INTO invite_links (id, created_by, is_admin, role, project_id, can_review, can_tasks, max_uses, uses, expires_at, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
        """, (link_id, created_by, 1 if is_admin else 0, role, project_id,
              1 if can_review else 0, 1 if can_tasks else 0, max_uses, expires_at, created_at))

    return {
        "id": link_id,
        "createdBy": created_by,
        "isAdmin": is_admin,
        "role": role,
        "projectId": project_id,
        "canReview": can_review,
        "canTasks": can_tasks,
        "maxUses": max_uses,
        "uses": 0,
        "expiresAt": expires_at,
        "createdAt": created_at
    }


def db_get_invite_link(link_id: str) -> Optional[dict]:
    """Get an invite link by ID."""
    with get_db() as conn:
        cursor = execute(conn, "SELECT * FROM invite_links WHERE id = ?", (link_id,))
        row = fetchone(cursor)

        if not row:
            return None

        return {
            "id": row["id"],
            "createdBy": row["created_by"],
            "isAdmin": bool(row["is_admin"]),
            "role": row.get("role") or ('admin' if row["is_admin"] else 'viewer'),
            "projectId": row.get("project_id"),
            "canReview": bool(row.get("can_review", 1)),
            "canTasks": bool(row.get("can_tasks", 0)),
            "maxUses": row["max_uses"],
            "uses": row["uses"],
            "expiresAt": row["expires_at"],
            "createdAt": row["created_at"]
        }


def db_list_invite_links() -> List[dict]:
    """List all invite links."""
    with get_db() as conn:
        cursor = execute(conn, """
            SELECT il.*, u.username as creator_name, p.name as project_name
            FROM invite_links il
            LEFT JOIN users u ON il.created_by = u.id
            LEFT JOIN projects p ON il.project_id = p.id
            ORDER BY il.created_at DESC
        """)

        return [{
            "id": row["id"],
            "createdBy": row["created_by"],
            "creatorName": row["creator_name"],
            "isAdmin": bool(row["is_admin"]),
            "role": row.get("role") or ('admin' if row["is_admin"] else 'viewer'),
            "projectId": row.get("project_id"),
            "projectName": row.get("project_name"),
            "canReview": bool(row.get("can_review", 1)),
            "canTasks": bool(row.get("can_tasks", 0)),
            "maxUses": row["max_uses"],
            "uses": row["uses"],
            "expiresAt": row["expires_at"],
            "createdAt": row["created_at"]
        } for row in fetchall(cursor)]


def db_use_invite_link(link_id: str) -> bool:
    """Increment the uses count of an invite link."""
    link = db_get_invite_link(link_id)
    if not link:
        return False

    if link["expiresAt"]:
        expires = datetime.fromisoformat(link["expiresAt"])
        if datetime.now() > expires:
            return False

    if link["maxUses"] > 0 and link["uses"] >= link["maxUses"]:
        return False

    with get_db() as conn:
        execute(conn, "UPDATE invite_links SET uses = uses + 1 WHERE id = ?", (link_id,))

    return True


def db_delete_invite_link(link_id: str) -> bool:
    """Delete an invite link."""
    with get_db() as conn:
        cursor = execute(conn, "DELETE FROM invite_links WHERE id = ?", (link_id,))
        return cursor.rowcount > 0
