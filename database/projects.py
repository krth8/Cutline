"""
Project database operations
"""

import json
from datetime import datetime
from typing import Dict, List, Optional
from .engine import execute, fetchone, fetchall
from .utils import get_db


def db_create_project(project_id: str, name: str, created_by: str = None) -> dict:
    """Create a new project in the database."""
    from .access import db_grant_project_access

    created_at = datetime.now().isoformat()
    with get_db() as conn:
        execute(conn,
            "INSERT INTO projects (id, name, created_at, created_by) VALUES (?, ?, ?, ?)",
            (project_id, name, created_at, created_by)
        )

    if created_by:
        db_grant_project_access(
            user_id=created_by,
            project_id=project_id,
            can_review=True,
            can_tasks=True,
            is_owner=True,
            granted_by=created_by
        )

    return {
        "id": project_id,
        "name": name,
        "clips": {},
        "comments": [],
        "annotations": [],
        "createdAt": created_at,
        "createdBy": created_by
    }


def db_get_project(project_id: str) -> Optional[dict]:
    """Get a project with all its data."""
    with get_db() as conn:
        cursor = execute(conn, "SELECT * FROM projects WHERE id = ?", (project_id,))
        row = fetchone(cursor)
        if not row:
            return None

        project = {
            "id": row["id"],
            "name": row["name"],
            "coverImage": row["cover_image"],
            "createdAt": row["created_at"],
            "createdBy": row["created_by"],
            "clips": {},
            "comments": [],
            "annotations": []
        }

        # Get clips with status info
        cursor = execute(conn, """
            SELECT c.*, cs.id as status_id, cs.name as status_name, cs.color as status_color
            FROM clips c
            LEFT JOIN clip_statuses cs ON c.status_id = cs.id
            WHERE c.project_id = ?
        """, (project_id,))
        clips_rows = fetchall(cursor)

        for clip_row in clips_rows:
            base_name = clip_row["base_name"]

            cursor = execute(conn,
                "SELECT * FROM clip_versions WHERE clip_id = ? ORDER BY version DESC",
                (clip_row["id"],)
            )
            versions = []
            for v_row in fetchall(cursor):
                version_data = {
                    "version": v_row["version"],
                    "versionStr": v_row["version_str"] or f"v{v_row['version']}",
                    "filename": v_row["filename"],
                    "thumbnail": v_row["thumbnail"],
                    "uploadedAt": v_row["uploaded_at"],
                    "mediaType": v_row.get("media_type", "video") or "video"
                }
                if v_row["proxies_json"]:
                    version_data["proxies"] = json.loads(v_row["proxies_json"])
                if v_row["default_quality"]:
                    version_data["defaultQuality"] = v_row["default_quality"]
                versions.append(version_data)

            clip_data = {
                "versions": versions,
                "activeVersion": clip_row["active_version"]
            }

            if clip_row["status_id"]:
                clip_data["status"] = {
                    "id": clip_row["status_id"],
                    "name": clip_row["status_name"],
                    "color": clip_row["status_color"]
                }

            project["clips"][base_name] = clip_data

        # Get comments
        cursor = execute(conn,
            "SELECT * FROM comments WHERE project_id = ? ORDER BY created_at",
            (project_id,)
        )
        for c_row in fetchall(cursor):
            comment = {
                "id": c_row["id"],
                "frame": c_row["frame"],
                "user": c_row["user_id"],
                "userName": c_row["user_name"],
                "text": c_row["text"],
                "color": c_row["color"],
                "createdAt": c_row["created_at"],
                "userProfileImage": c_row["user_profile_image"],
                "_clientHash": c_row["client_hash"],
                "clipBaseName": c_row["clip_base_name"],
                "clipVersion": c_row["clip_version"],
                "resolved": bool(c_row.get("resolved", 0)),
                "parentId": c_row.get("parent_id")
            }
            if c_row["drawing_json"]:
                comment["drawing"] = json.loads(c_row["drawing_json"])
            if c_row.get("anchor_json"):
                comment["anchor"] = json.loads(c_row["anchor_json"])
            project["comments"].append(comment)

        # Get annotations
        cursor = execute(conn,
            "SELECT * FROM annotations WHERE project_id = ? ORDER BY created_at",
            (project_id,)
        )
        for a_row in fetchall(cursor):
            annotation = {
                "id": a_row["id"],
                "frame": a_row["frame"],
                "user": a_row["user_id"],
                "color": a_row["color"],
                "createdAt": a_row["created_at"]
            }
            if a_row["strokes_json"]:
                annotation["strokes"] = json.loads(a_row["strokes_json"])
            project["annotations"].append(annotation)

        return project


def db_list_projects() -> List[dict]:
    """List all projects with basic info."""
    with get_db() as conn:
        cursor = execute(conn, """
            SELECT p.id, p.name, p.cover_image, p.created_at, p.created_by,
                   COUNT(DISTINCT c.id) as clip_count
            FROM projects p
            LEFT JOIN clips c ON c.project_id = p.id
            GROUP BY p.id, p.name, p.cover_image, p.created_at, p.created_by
            ORDER BY p.created_at DESC
        """)

        return [{
            "id": row["id"],
            "name": row["name"],
            "coverImage": row["cover_image"],
            "createdAt": row["created_at"],
            "createdBy": row["created_by"],
            "clipCount": row["clip_count"]
        } for row in fetchall(cursor)]


def db_update_project_cover(project_id: str, cover_url: str):
    """Update project cover image."""
    with get_db() as conn:
        execute(conn,
            "UPDATE projects SET cover_image = ? WHERE id = ?",
            (cover_url, project_id)
        )


def db_delete_project(project_id: str) -> dict:
    """Delete a project and all related data."""
    deleted_info = {
        "clips": [],
        "thumbnails": [],
        "cover": None
    }

    with get_db() as conn:
        cursor = execute(conn, "SELECT cover_image FROM projects WHERE id = ?", (project_id,))
        row = fetchone(cursor)
        if row and row["cover_image"]:
            deleted_info["cover"] = row["cover_image"]

        cursor = execute(conn, """
            SELECT cv.filename, cv.thumbnail, cv.proxies_json
            FROM clip_versions cv
            JOIN clips c ON cv.clip_id = c.id
            WHERE c.project_id = ?
        """, (project_id,))

        for row in fetchall(cursor):
            if row["filename"]:
                deleted_info["clips"].append(row["filename"])
            if row["thumbnail"]:
                deleted_info["thumbnails"].append(row["thumbnail"])
            if row["proxies_json"]:
                proxies = json.loads(row["proxies_json"])
                for quality, proxy_file in proxies.items():
                    if proxy_file and proxy_file not in deleted_info["clips"]:
                        deleted_info["clips"].append(proxy_file)

        cursor = execute(conn, "DELETE FROM projects WHERE id = ?", (project_id,))
        deleted_info["deleted"] = cursor.rowcount > 0

    return deleted_info
