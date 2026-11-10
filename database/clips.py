"""
Clip and status database operations
"""

import json
import secrets
from datetime import datetime
from typing import Dict, List, Optional
from .engine import execute, insert_ignore, fetchone, fetchall, DB_TYPE, DatabaseType
from .utils import get_db


# ============ Clip Operations ============

def db_add_clip_version(project_id: str, base_name: str, version: int, filename: str,
                        thumbnail: str = None, proxies: dict = None, default_quality: str = None,
                        version_str: str = None, media_type: str = 'video') -> dict:
    """Add a clip version to the database."""
    uploaded_at = datetime.now().isoformat()
    is_new_clip = False

    if version_str is None:
        version_str = f"v{version}"

    with get_db() as conn:
        insert_ignore(conn, "clips", ("project_id", "base_name", "active_version"),
                      (project_id, base_name, version), ("project_id", "base_name"))

        cursor = execute(conn,
            "SELECT id FROM clips WHERE project_id = ? AND base_name = ?",
            (project_id, base_name)
        )
        row = fetchone(cursor)
        clip_id = row["id"]

        proxies_json = json.dumps(proxies) if proxies else None

        if DB_TYPE == DatabaseType.POSTGRESQL:
            execute(conn, """
                INSERT INTO clip_versions
                (clip_id, version, version_str, filename, thumbnail, proxies_json, default_quality, uploaded_at, media_type)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT (clip_id, version) DO UPDATE SET
                    version_str = EXCLUDED.version_str,
                    filename = EXCLUDED.filename,
                    thumbnail = EXCLUDED.thumbnail,
                    proxies_json = EXCLUDED.proxies_json,
                    default_quality = EXCLUDED.default_quality,
                    uploaded_at = EXCLUDED.uploaded_at,
                    media_type = EXCLUDED.media_type
            """, (clip_id, version, version_str, filename, thumbnail, proxies_json, default_quality, uploaded_at, media_type))
        else:
            execute(conn, """
                INSERT OR REPLACE INTO clip_versions
                (clip_id, version, version_str, filename, thumbnail, proxies_json, default_quality, uploaded_at, media_type)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """, (clip_id, version, version_str, filename, thumbnail, proxies_json, default_quality, uploaded_at, media_type))

        if DB_TYPE == DatabaseType.POSTGRESQL:
            execute(conn,
                "UPDATE clips SET active_version = GREATEST(active_version, ?) WHERE id = ?",
                (version, clip_id)
            )
        else:
            execute(conn,
                "UPDATE clips SET active_version = MAX(active_version, ?) WHERE id = ?",
                (version, clip_id)
            )

    return {
        "clipId": clip_id,
        "baseName": base_name,
        "isNewClip": is_new_clip,
        "version": version,
        "mediaType": media_type
    }


def db_update_clip_active_version(project_id: str, base_name: str, version: int):
    """Update the active version for a clip."""
    with get_db() as conn:
        execute(conn, """
            UPDATE clips SET active_version = ?
            WHERE project_id = ? AND base_name = ?
        """, (version, project_id, base_name))


def db_delete_clip(project_id: str, base_name: str) -> dict:
    """Delete a clip and all its versions."""
    deleted_info = {
        "success": False,
        "files": [],
        "thumbnails": [],
        "proxies": []
    }

    with get_db() as conn:
        cursor = execute(conn, """
            SELECT id FROM clips WHERE project_id = ? AND base_name = ?
        """, (project_id, base_name))
        row = fetchone(cursor)

        if not row:
            return deleted_info

        clip_id = row["id"]

        cursor = execute(conn, """
            SELECT filename, thumbnail, proxies_json FROM clip_versions WHERE clip_id = ?
        """, (clip_id,))

        for v_row in fetchall(cursor):
            if v_row["filename"]:
                deleted_info["files"].append(v_row["filename"])
            if v_row["thumbnail"]:
                deleted_info["thumbnails"].append(v_row["thumbnail"])
            if v_row["proxies_json"]:
                proxies = json.loads(v_row["proxies_json"])
                for quality, proxy_file in proxies.items():
                    if proxy_file and proxy_file not in deleted_info["proxies"]:
                        deleted_info["proxies"].append(proxy_file)

        execute(conn, "DELETE FROM clip_versions WHERE clip_id = ?", (clip_id,))
        cursor = execute(conn, "DELETE FROM clips WHERE id = ?", (clip_id,))
        deleted_info["success"] = cursor.rowcount > 0

    return deleted_info


# ============ Status Operations ============

def db_create_status(name: str, color: str = '#6366f1') -> dict:
    """Create a new clip status."""
    status_id = secrets.token_urlsafe(8)
    created_at = datetime.now().isoformat()

    with get_db() as conn:
        cursor = execute(conn, "SELECT COALESCE(MAX(sort_order), -1) + 1 as next_order FROM clip_statuses")
        sort_order = fetchone(cursor)["next_order"]

        execute(conn, """
            INSERT INTO clip_statuses (id, name, color, sort_order, created_at)
            VALUES (?, ?, ?, ?, ?)
        """, (status_id, name, color, sort_order, created_at))

    return {
        "id": status_id,
        "name": name,
        "color": color,
        "sortOrder": sort_order,
        "createdAt": created_at
    }


def db_list_statuses() -> List[dict]:
    """List all clip statuses."""
    with get_db() as conn:
        cursor = execute(conn, "SELECT * FROM clip_statuses ORDER BY sort_order ASC")

        return [{
            "id": row["id"],
            "name": row["name"],
            "color": row["color"],
            "sortOrder": row["sort_order"],
            "createdAt": row["created_at"]
        } for row in fetchall(cursor)]


def db_update_status(status_id: str, name: str = None, color: str = None) -> bool:
    """Update a clip status."""
    updates = []
    params = []

    if name is not None:
        updates.append("name = ?")
        params.append(name)
    if color is not None:
        updates.append("color = ?")
        params.append(color)

    if not updates:
        return False

    params.append(status_id)

    with get_db() as conn:
        query = f"UPDATE clip_statuses SET {', '.join(updates)} WHERE id = ?"
        cursor = execute(conn, query, tuple(params))
        return cursor.rowcount > 0


def db_delete_status(status_id: str) -> bool:
    """Delete a clip status."""
    with get_db() as conn:
        execute(conn, "UPDATE clips SET status_id = NULL WHERE status_id = ?", (status_id,))
        cursor = execute(conn, "DELETE FROM clip_statuses WHERE id = ?", (status_id,))
        return cursor.rowcount > 0


def db_update_clip_status(project_id: str, base_name: str, status_id: str = None) -> bool:
    """Update the status of a clip."""
    with get_db() as conn:
        cursor = execute(conn, """
            UPDATE clips SET status_id = ?
            WHERE project_id = ? AND base_name = ?
        """, (status_id, project_id, base_name))
        return cursor.rowcount > 0


def db_get_clip_status(project_id: str, base_name: str) -> Optional[dict]:
    """Get the status of a clip."""
    with get_db() as conn:
        cursor = execute(conn, """
            SELECT cs.* FROM clip_statuses cs
            JOIN clips c ON c.status_id = cs.id
            WHERE c.project_id = ? AND c.base_name = ?
        """, (project_id, base_name))
        row = fetchone(cursor)

        if not row:
            return None

        return {
            "id": row["id"],
            "name": row["name"],
            "color": row["color"],
            "sortOrder": row["sort_order"],
            "createdAt": row["created_at"]
        }


def db_get_untagged_clips(project_id: str) -> List[dict]:
    """Get all clips in a project that are not linked to any task."""
    with get_db() as conn:
        cursor = execute(conn, """
            SELECT c.id, c.base_name, c.active_version, c.status_id,
                   cv.thumbnail, cv.media_type,
                   cs.name as status_name, cs.color as status_color
            FROM clips c
            LEFT JOIN clip_versions cv ON c.id = cv.clip_id AND c.active_version = cv.version
            LEFT JOIN clip_statuses cs ON c.status_id = cs.id
            WHERE c.project_id = ?
            AND c.id NOT IN (SELECT clip_id FROM task_clips)
            ORDER BY c.base_name ASC
        """, (project_id,))
        rows = fetchall(cursor)

    return [{
        "id": row["id"],
        "baseName": row["base_name"],
        "activeVersion": row["active_version"],
        "thumbnail": row["thumbnail"],
        "mediaType": row["media_type"],
        "status": {
            "id": row["status_id"],
            "name": row["status_name"],
            "color": row["status_color"]
        } if row["status_id"] else None
    } for row in rows]
