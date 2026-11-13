"""
User database operations
"""

import secrets
import hashlib
import bcrypt
from datetime import datetime
from typing import List, Optional
from .engine import execute, fetchone, fetchall
from .utils import get_db


def _hash_password(password: str, existing_hash: bytes = None) -> tuple:
    """Hash a password using bcrypt."""
    if existing_hash is not None:
        return existing_hash, None

    password_bytes = password.encode('utf-8')
    hashed = bcrypt.hashpw(password_bytes, bcrypt.gensalt(rounds=12))
    return hashed.decode('utf-8'), None


def _verify_password(password: str, hashed: str) -> bool:
    """Verify a password against a bcrypt hash."""
    try:
        password_bytes = password.encode('utf-8')
        hashed_bytes = hashed.encode('utf-8')
        return bcrypt.checkpw(password_bytes, hashed_bytes)
    except Exception:
        return False


def _verify_password_legacy(password: str, password_hash: str, password_salt: str) -> bool:
    """Verify password using legacy SHA-256 method (for migration)."""
    hash_obj = hashlib.sha256((password_salt + password).encode())
    return hash_obj.hexdigest() == password_hash


def db_create_user(username: str, password: str, is_admin: bool = False, role: str = 'editor', email: str = None) -> dict:
    """Create a new user."""
    user_id = secrets.token_urlsafe(8)
    created_at = datetime.now().isoformat()
    password_hash, _ = _hash_password(password)

    if is_admin:
        role = 'admin'

    with get_db() as conn:
        execute(conn, """
            INSERT INTO users (id, username, password_hash, password_salt, is_admin, role, created_at, email)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        """, (user_id, username, password_hash, None, 1 if is_admin else 0, role, created_at, email))

    return {
        "id": user_id,
        "username": username,
        "email": email,
        "isAdmin": is_admin,
        "role": role,
        "createdAt": created_at
    }


def db_get_user(username: str) -> Optional[dict]:
    """Get a user by username."""
    with get_db() as conn:
        cursor = execute(conn, "SELECT * FROM users WHERE username = ?", (username,))
        row = fetchone(cursor)

        if not row:
            return None

        return {
            "id": row["id"],
            "username": row["username"],
            "isAdmin": bool(row["is_admin"]),
            "role": row.get("role") or ('admin' if row["is_admin"] else 'editor'),
            "profileImage": row["profile_image"],
            "email": row.get("email"),
            "createdAt": row["created_at"],
            "_passwordHash": row["password_hash"],
            "_passwordSalt": row["password_salt"]
        }


def db_get_user_by_id(user_id: str) -> Optional[dict]:
    """Get a user by ID."""
    with get_db() as conn:
        cursor = execute(conn, "SELECT * FROM users WHERE id = ?", (user_id,))
        row = fetchone(cursor)

        if not row:
            return None

        return {
            "id": row["id"],
            "username": row["username"],
            "isAdmin": bool(row["is_admin"]),
            "role": row.get("role") or ('admin' if row["is_admin"] else 'editor'),
            "profileImage": row["profile_image"],
            "email": row.get("email"),
            "createdAt": row["created_at"]
        }


def db_validate_user(username: str, password: str) -> Optional[dict]:
    """Validate user credentials and return user info if valid."""
    user = db_get_user(username)
    if not user:
        return None

    if _verify_password(password, user["_passwordHash"]):
        return {
            "id": user["id"],
            "username": user["username"],
            "isAdmin": user["isAdmin"],
            "role": user["role"],
            "profileImage": user["profileImage"],
            "email": user.get("email"),
            "createdAt": user["createdAt"]
        }

    if user.get("_passwordSalt") and _verify_password_legacy(password, user["_passwordHash"], user["_passwordSalt"]):
        new_hash, _ = _hash_password(password)
        with get_db() as conn:
            execute(conn,
                "UPDATE users SET password_hash = ?, password_salt = NULL WHERE id = ?",
                (new_hash, user["id"])
            )
        return {
            "id": user["id"],
            "username": user["username"],
            "isAdmin": user["isAdmin"],
            "role": user["role"],
            "profileImage": user["profileImage"],
            "email": user.get("email"),
            "createdAt": user["createdAt"]
        }

    return None


def db_has_users() -> bool:
    """Check if any users exist in the database."""
    with get_db() as conn:
        cursor = execute(conn, "SELECT COUNT(*) as count FROM users")
        row = fetchone(cursor)
        return row["count"] > 0


def db_init_admin_user():
    """Legacy function - no longer creates default admin."""
    if db_has_users():
        print("Users already exist, skipping setup")
    else:
        print("No users exist - setup wizard required")


def db_list_users() -> List[dict]:
    """List all users (without password info)."""
    with get_db() as conn:
        cursor = execute(conn, "SELECT id, username, email, is_admin, role, profile_image, created_at FROM users ORDER BY created_at DESC")

        return [{
            "id": row["id"],
            "username": row["username"],
            "email": row.get("email"),
            "isAdmin": bool(row["is_admin"]),
            "role": row.get("role") or ('admin' if row["is_admin"] else 'editor'),
            "profileImage": row["profile_image"],
            "createdAt": row["created_at"]
        } for row in fetchall(cursor)]


def db_delete_user(user_id: str) -> bool:
    """Delete a user by ID."""
    with get_db() as conn:
        cursor = execute(conn, "DELETE FROM users WHERE id = ?", (user_id,))
        return cursor.rowcount > 0


def db_update_user_role(user_id: str, role: str = None, is_admin: bool = None) -> bool:
    """Update a user's role and/or admin status."""
    updates = []
    params = []

    if role is not None:
        updates.append("role = ?")
        params.append(role)
        updates.append("is_admin = ?")
        params.append(1 if role == 'admin' else 0)
    elif is_admin is not None:
        updates.append("is_admin = ?")
        params.append(1 if is_admin else 0)
        updates.append("role = ?")
        params.append('admin' if is_admin else 'editor')

    if not updates:
        return False

    params.append(user_id)

    with get_db() as conn:
        query = f"UPDATE users SET {', '.join(updates)} WHERE id = ?"
        cursor = execute(conn, query, tuple(params))
        return cursor.rowcount > 0


def db_update_user_password(user_id: str, new_password: str) -> bool:
    """Update a user's password."""
    password_hash, _ = _hash_password(new_password)
    with get_db() as conn:
        cursor = execute(conn,
            "UPDATE users SET password_hash = ?, password_salt = NULL WHERE id = ?",
            (password_hash, user_id)
        )
        return cursor.rowcount > 0


def db_update_user_email(user_id: str, email: Optional[str]) -> bool:
    """Set or clear a user's email address."""
    with get_db() as conn:
        cursor = execute(conn, "UPDATE users SET email = ? WHERE id = ?", (email or None, user_id))
        return cursor.rowcount > 0


def db_update_user_profile_image(user_id: str, profile_image_url: str) -> bool:
    """Update a user's profile image."""
    with get_db() as conn:
        cursor = execute(conn,
            "UPDATE users SET profile_image = ? WHERE id = ?",
            (profile_image_url, user_id)
        )
        return cursor.rowcount > 0
