"""
Task sections database operations
"""

import secrets
from datetime import datetime
from typing import List, Optional
from .engine import execute, insert_ignore, fetchone, fetchall, DB_TYPE, DatabaseType
from .utils import get_db


def db_create_section(project_id: str, name: str, color: str = '#6366f1') -> dict:
    """Create a new task section."""
    section_id = secrets.token_urlsafe(8)
    created_at = datetime.now().isoformat()

    with get_db() as conn:
        cursor = execute(conn, "SELECT COALESCE(MAX(sort_order), -1) + 1 as next_order FROM task_sections WHERE project_id = ?", (project_id,))
        sort_order = fetchone(cursor)["next_order"]

        execute(conn, """
            INSERT INTO task_sections (id, project_id, name, color, sort_order, is_collapsed, created_at)
            VALUES (?, ?, ?, ?, ?, 0, ?)
        """, (section_id, project_id, name, color, sort_order, created_at))

    return {
        "id": section_id,
        "projectId": project_id,
        "name": name,
        "color": color,
        "sortOrder": sort_order,
        "isCollapsed": False,
        "createdAt": created_at
    }


def db_list_sections(project_id: str) -> List[dict]:
    """List all sections for a project."""
    with get_db() as conn:
        cursor = execute(conn, """
            SELECT ts.*,
                   (SELECT COUNT(*) FROM tasks WHERE section_id = ts.id) as task_count
            FROM task_sections ts
            WHERE ts.project_id = ?
            ORDER BY ts.sort_order ASC
        """, (project_id,))
        rows = fetchall(cursor)

    return [{
        "id": row["id"],
        "projectId": row["project_id"],
        "name": row["name"],
        "color": row["color"],
        "sortOrder": row["sort_order"],
        "isCollapsed": bool(row["is_collapsed"]),
        "taskCount": row["task_count"],
        "createdAt": row["created_at"]
    } for row in rows]


def db_get_section(section_id: str) -> Optional[dict]:
    """Get a section by ID."""
    with get_db() as conn:
        cursor = execute(conn, """
            SELECT ts.*,
                   (SELECT COUNT(*) FROM tasks WHERE section_id = ts.id) as task_count
            FROM task_sections ts
            WHERE ts.id = ?
        """, (section_id,))
        row = fetchone(cursor)

    if not row:
        return None

    return {
        "id": row["id"],
        "projectId": row["project_id"],
        "name": row["name"],
        "color": row["color"],
        "sortOrder": row["sort_order"],
        "isCollapsed": bool(row["is_collapsed"]),
        "taskCount": row["task_count"],
        "createdAt": row["created_at"]
    }


def db_update_section(section_id: str, **kwargs) -> bool:
    """Update a section. Pass only the fields to update."""
    allowed_fields = {
        "name": "name",
        "color": "color",
        "sort_order": "sort_order",
        "is_collapsed": "is_collapsed"
    }

    updates = []
    params = []

    for key, value in kwargs.items():
        if key in allowed_fields:
            updates.append(f"{allowed_fields[key]} = ?")
            params.append(value)

    if not updates:
        return False

    params.append(section_id)

    with get_db() as conn:
        query = f"UPDATE task_sections SET {', '.join(updates)} WHERE id = ?"
        cursor = execute(conn, query, tuple(params))
        return cursor.rowcount > 0


def db_delete_section(section_id: str) -> bool:
    """Delete a section. Tasks in this section will have section_id set to NULL."""
    with get_db() as conn:
        execute(conn, "UPDATE tasks SET section_id = NULL WHERE section_id = ?", (section_id,))
        cursor = execute(conn, "DELETE FROM task_sections WHERE id = ?", (section_id,))
        return cursor.rowcount > 0


def db_reorder_sections(section_ids: List[str]) -> bool:
    """Reorder sections by setting sort_order based on position in list."""
    with get_db() as conn:
        for i, section_id in enumerate(section_ids):
            execute(conn, "UPDATE task_sections SET sort_order = ? WHERE id = ?", (i, section_id))
    return True


# ============ Section Statuses ============

def db_get_section_statuses(section_id: str) -> List[dict]:
    """Get all statuses available for a section."""
    with get_db() as conn:
        cursor = execute(conn, """
            SELECT cs.*, ss.is_custom, ss.sort_order as section_sort_order
            FROM section_statuses ss
            JOIN clip_statuses cs ON ss.status_id = cs.id
            WHERE ss.section_id = ?
            ORDER BY ss.sort_order ASC, cs.sort_order ASC
        """, (section_id,))
        rows = fetchall(cursor)

    return [{
        "id": row["id"],
        "name": row["name"],
        "color": row["color"],
        "isCustom": bool(row["is_custom"]),
        "sortOrder": row["section_sort_order"] if row["section_sort_order"] is not None else row["sort_order"]
    } for row in rows]


def db_add_section_status(section_id: str, status_id: str, is_custom: bool = False) -> bool:
    """Add an existing status to a section."""
    with get_db() as conn:
        cursor = execute(conn, "SELECT COALESCE(MAX(sort_order), -1) + 1 as next_order FROM section_statuses WHERE section_id = ?", (section_id,))
        sort_order = fetchone(cursor)["next_order"]

        try:
            insert_ignore(conn, "section_statuses", ("section_id", "status_id", "is_custom", "sort_order"),
                          (section_id, status_id, int(is_custom), sort_order), ("section_id", "status_id"))
            return True
        except Exception:
            return False


def db_remove_section_status(section_id: str, status_id: str) -> bool:
    """Remove a status from a section."""
    with get_db() as conn:
        cursor = execute(conn, """
            DELETE FROM section_statuses WHERE section_id = ? AND status_id = ?
        """, (section_id, status_id))
        return cursor.rowcount > 0


def db_create_section_status(section_id: str, name: str, color: str = '#6366f1') -> dict:
    """Create a new status specifically for a section."""
    from .clips import db_create_status

    status = db_create_status(name, color)
    db_add_section_status(section_id, status["id"], is_custom=True)

    return {
        **status,
        "isCustom": True
    }
