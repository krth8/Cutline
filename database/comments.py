"""
Comments and annotations database operations
"""

import json
from datetime import datetime
from .engine import execute, fetchone
from .utils import get_db


def db_add_comment(project_id: str, comment: dict) -> dict:
    """Add a comment to the database."""
    comment_id = comment.get("id")
    created_at = comment.get("createdAt") or datetime.now().isoformat()
    drawing_json = json.dumps(comment["drawing"]) if comment.get("drawing") else None

    with get_db() as conn:
        execute(conn, """
            INSERT INTO comments (id, project_id, frame, user_id, user_name, text, drawing_json, color, created_at, user_profile_image, client_hash, clip_base_name, clip_version)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (
            comment_id,
            project_id,
            comment.get("frame"),
            comment.get("user"),
            comment.get("userName"),
            comment.get("text"),
            drawing_json,
            comment.get("color"),
            created_at,
            comment.get("userProfileImage"),
            comment.get("_clientHash"),
            comment.get("clipBaseName"),
            comment.get("clipVersion")
        ))

    return comment


def db_delete_comment(project_id: str, comment_id: str) -> bool:
    """Delete a comment from the database."""
    with get_db() as conn:
        cursor = execute(conn,
            "DELETE FROM comments WHERE id = ? AND project_id = ?",
            (comment_id, project_id)
        )
        return cursor.rowcount > 0


def db_add_annotation(project_id: str, annotation: dict) -> dict:
    """Add an annotation to the database."""
    annotation_id = annotation.get("id")
    created_at = annotation.get("createdAt") or datetime.now().isoformat()
    strokes_json = json.dumps(annotation["strokes"]) if annotation.get("strokes") else None

    with get_db() as conn:
        execute(conn, """
            INSERT INTO annotations (id, project_id, frame, user_id, strokes_json, color, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        """, (
            annotation_id,
            project_id,
            annotation.get("frame"),
            annotation.get("user"),
            strokes_json,
            annotation.get("color"),
            created_at
        ))

    return annotation
