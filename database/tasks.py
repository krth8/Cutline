"""
Task database operations
"""

import json
import secrets
from datetime import datetime
from typing import List, Optional
from .engine import execute, insert_ignore, fetchone, fetchall, DB_TYPE, DatabaseType
from .utils import get_db


def db_set_task_assignees(task_id: str, user_ids: List[str]) -> None:
    """Set the assignees for a task (replaces existing)."""
    assigned_at = datetime.now().isoformat()
    with get_db() as conn:
        # Remove existing assignees
        execute(conn, "DELETE FROM task_assignees WHERE task_id = ?", (task_id,))
        # Add new assignees
        for user_id in user_ids:
            if user_id:  # Skip empty/null values
                insert_ignore(conn, "task_assignees", ("task_id", "user_id", "assigned_at"),
                              (task_id, user_id, assigned_at), ("task_id", "user_id"))


def db_get_task_assignees(task_id: str) -> List[dict]:
    """Get all assignees for a task."""
    with get_db() as conn:
        cursor = execute(conn, """
            SELECT u.id, u.username as name, u.profile_image as profileImage
            FROM task_assignees ta
            JOIN users u ON ta.user_id = u.id
            WHERE ta.task_id = ?
            ORDER BY ta.assigned_at ASC
        """, (task_id,))
        return [dict(row) for row in fetchall(cursor)]


def db_create_task(project_id: str, name: str, created_by: str = None,
                   parent_id: str = None, clip_id: int = None, stage_tag: str = None,
                   section_id: str = None, description: str = None, status_id: str = None,
                   assignee_id: str = None, assignee_ids: List[str] = None,
                   priority: str = None, due_date: str = None, custom_fields: dict = None) -> dict:
    """Create a new task."""
    task_id = secrets.token_urlsafe(12)
    created_at = datetime.now().isoformat()
    custom_fields_json = json.dumps(custom_fields) if custom_fields else None

    # Support both single assignee_id (legacy) and assignee_ids (multi-select)
    final_assignee_ids = assignee_ids or ([assignee_id] if assignee_id else [])

    with get_db() as conn:
        cursor = execute(conn, """
            SELECT COALESCE(MAX(sort_order), -1) + 1 as next_order
            FROM tasks WHERE project_id = ? AND (parent_id = ? OR (parent_id IS NULL AND ? IS NULL))
        """, (project_id, parent_id, parent_id))
        sort_order = fetchone(cursor)["next_order"]

        # Still store first assignee in assignee_id for backwards compatibility
        first_assignee = final_assignee_ids[0] if final_assignee_ids else None

        execute(conn, """
            INSERT INTO tasks (id, project_id, parent_id, clip_id, section_id, stage_tag, name, description,
                               status_id, assignee_id, priority, due_date, custom_fields, sort_order,
                               created_at, created_by)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (task_id, project_id, parent_id, clip_id, section_id, stage_tag, name, description,
              status_id, first_assignee, priority, due_date, custom_fields_json, sort_order,
              created_at, created_by))

    # Set all assignees in junction table
    if final_assignee_ids:
        db_set_task_assignees(task_id, final_assignee_ids)

    return {
        "id": task_id,
        "projectId": project_id,
        "parentId": parent_id,
        "clipId": clip_id,
        "sectionId": section_id,
        "stageTag": stage_tag,
        "name": name,
        "description": description,
        "statusId": status_id,
        "assigneeIds": final_assignee_ids,
        "priority": priority,
        "dueDate": due_date,
        "customFields": custom_fields,
        "sortOrder": sort_order,
        "createdAt": created_at,
        "createdBy": created_by,
        "childCount": 0
    }


def db_get_task(task_id: str) -> Optional[dict]:
    """Get a task by ID with related info."""
    with get_db() as conn:
        cursor = execute(conn, """
            SELECT t.*,
                   cs.name as status_name, cs.color as status_color,
                   c.base_name as clip_name,
                   ts.name as section_name, ts.color as section_color,
                   (SELECT COUNT(*) FROM tasks WHERE parent_id = t.id) as child_count
            FROM tasks t
            LEFT JOIN clip_statuses cs ON t.status_id = cs.id
            LEFT JOIN clips c ON t.clip_id = c.id
            LEFT JOIN task_sections ts ON t.section_id = ts.id
            WHERE t.id = ?
        """, (task_id,))
        row = fetchone(cursor)

        if not row:
            return None

        task = {
            "id": row["id"],
            "projectId": row["project_id"],
            "parentId": row["parent_id"],
            "clipId": row["clip_id"],
            "clipName": row["clip_name"],
            "sectionId": row["section_id"],
            "stageTag": row["stage_tag"],
            "name": row["name"],
            "description": row["description"],
            "statusId": row["status_id"],
            "priority": row["priority"],
            "dueDate": row["due_date"],
            "sortOrder": row["sort_order"],
            "createdAt": row["created_at"],
            "createdBy": row["created_by"],
            "childCount": row["child_count"]
        }

        if row["section_id"]:
            task["section"] = {
                "id": row["section_id"],
                "name": row["section_name"],
                "color": row["section_color"]
            }

        if row["custom_fields"]:
            task["customFields"] = json.loads(row["custom_fields"])

        if row["status_id"]:
            task["status"] = {
                "id": row["status_id"],
                "name": row["status_name"],
                "color": row["status_color"]
            }

        # Get all assignees from junction table
        task["assignees"] = db_get_task_assignees(task_id)
        # Also provide first assignee as 'assignee' for backwards compatibility
        if task["assignees"]:
            task["assignee"] = task["assignees"][0]

        return task


def db_get_tasks_assignees_batch(task_ids: List[str]) -> dict:
    """Get assignees for multiple tasks in one query."""
    if not task_ids:
        return {}

    with get_db() as conn:
        placeholders = ",".join(["?" for _ in task_ids])
        cursor = execute(conn, f"""
            SELECT ta.task_id, u.id, u.username as name, u.profile_image as profileImage
            FROM task_assignees ta
            JOIN users u ON ta.user_id = u.id
            WHERE ta.task_id IN ({placeholders})
            ORDER BY ta.assigned_at ASC
        """, tuple(task_ids))

        # Group by task_id
        result = {task_id: [] for task_id in task_ids}
        for row in fetchall(cursor):
            result[row["task_id"]].append({
                "id": row["id"],
                "name": row["name"],
                "profileImage": row["profileImage"]
            })
        return result


def db_list_tasks(project_id: str, parent_id: str = None, include_children: bool = False,
                  stage_tag: str = None, status_id: str = None, assignee_id: str = None,
                  section_id: str = None, priority: str = None) -> List[dict]:
    """List tasks for a project with optional filters."""
    with get_db() as conn:
        query = """
            SELECT t.*,
                   cs.name as status_name, cs.color as status_color,
                   c.base_name as clip_name,
                   ts.name as section_name, ts.color as section_color,
                   (SELECT COUNT(*) FROM tasks WHERE parent_id = t.id) as child_count
            FROM tasks t
            LEFT JOIN clip_statuses cs ON t.status_id = cs.id
            LEFT JOIN clips c ON t.clip_id = c.id
            LEFT JOIN task_sections ts ON t.section_id = ts.id
            WHERE t.project_id = ?
        """
        params = [project_id]

        if parent_id is not None:
            query += " AND t.parent_id = ?"
            params.append(parent_id)
        elif not include_children:
            query += " AND t.parent_id IS NULL"

        if stage_tag:
            query += " AND t.stage_tag = ?"
            params.append(stage_tag)

        if status_id:
            query += " AND t.status_id = ?"
            params.append(status_id)

        if assignee_id:
            # Filter by assignee using junction table
            query += " AND t.id IN (SELECT task_id FROM task_assignees WHERE user_id = ?)"
            params.append(assignee_id)

        if section_id:
            query += " AND t.section_id = ?"
            params.append(section_id)

        if priority:
            query += " AND t.priority = ?"
            params.append(priority)

        query += " ORDER BY t.sort_order ASC, t.created_at DESC"

        cursor = execute(conn, query, tuple(params))
        rows = fetchall(cursor)

        # Get task IDs for batch assignee lookup
        task_ids = [row["id"] for row in rows]

    # Batch fetch all assignees (outside the 'with' block to avoid nested connections)
    assignees_by_task = db_get_tasks_assignees_batch(task_ids)

    tasks = []
    for row in rows:
        task = {
            "id": row["id"],
            "projectId": row["project_id"],
            "parentId": row["parent_id"],
            "clipId": row["clip_id"],
            "clipName": row["clip_name"],
            "sectionId": row["section_id"],
            "stageTag": row["stage_tag"],
            "name": row["name"],
            "description": row["description"],
            "statusId": row["status_id"],
            "priority": row["priority"],
            "dueDate": row["due_date"],
            "sortOrder": row["sort_order"],
            "createdAt": row["created_at"],
            "createdBy": row["created_by"],
            "childCount": row["child_count"]
        }

        if row["custom_fields"]:
            task["customFields"] = json.loads(row["custom_fields"])

        if row["status_id"]:
            task["status"] = {
                "id": row["status_id"],
                "name": row["status_name"],
                "color": row["status_color"]
            }

        if row["section_id"]:
            task["section"] = {
                "id": row["section_id"],
                "name": row["section_name"],
                "color": row["section_color"]
            }

        # Get assignees from batch result
        task["assignees"] = assignees_by_task.get(row["id"], [])
        # Also provide first assignee as 'assignee' for backwards compatibility
        if task["assignees"]:
            task["assignee"] = task["assignees"][0]

        tasks.append(task)

    return tasks


def db_get_task_by_clip(clip_id: int) -> Optional[dict]:
    """Get the task associated with a clip."""
    with get_db() as conn:
        cursor = execute(conn, "SELECT id FROM tasks WHERE clip_id = ?", (clip_id,))
        row = fetchone(cursor)
        if row:
            return db_get_task(row["id"])
        return None


def db_update_task(task_id: str, **kwargs) -> bool:
    """Update a task. Pass only the fields to update."""
    allowed_fields = {
        "name": "name",
        "description": "description",
        "parent_id": "parent_id",
        "section_id": "section_id",
        "stage_tag": "stage_tag",
        "status_id": "status_id",
        "assignee_id": "assignee_id",
        "priority": "priority",
        "due_date": "due_date",
        "custom_fields": "custom_fields",
        "sort_order": "sort_order"
    }

    updates = []
    params = []

    # Handle assignee_ids separately (multi-select)
    assignee_ids = kwargs.pop("assignee_ids", None)

    for key, value in kwargs.items():
        if key in allowed_fields:
            if key == "custom_fields" and value is not None:
                value = json.dumps(value)
            # If assignee_id is set, also update assignee_ids
            if key == "assignee_id":
                if assignee_ids is None:
                    assignee_ids = [value] if value else []
            updates.append(f"{allowed_fields[key]} = ?")
            params.append(value)

    # Update junction table if assignee_ids was provided
    if assignee_ids is not None:
        db_set_task_assignees(task_id, assignee_ids)
        # Also update the legacy assignee_id column
        first_assignee = assignee_ids[0] if assignee_ids else None
        if "assignee_id = ?" not in updates:
            updates.append("assignee_id = ?")
            params.append(first_assignee)

    if not updates:
        return assignee_ids is not None  # Return True if we only updated assignees

    params.append(task_id)

    with get_db() as conn:
        query = f"UPDATE tasks SET {', '.join(updates)} WHERE id = ?"
        cursor = execute(conn, query, tuple(params))
        return cursor.rowcount > 0


def db_delete_task(task_id: str) -> bool:
    """Delete a task (children will be cascaded)."""
    with get_db() as conn:
        cursor = execute(conn, "DELETE FROM tasks WHERE id = ?", (task_id,))
        return cursor.rowcount > 0


def db_reorder_tasks(task_ids: List[str]) -> bool:
    """Reorder tasks by setting sort_order based on position in list."""
    with get_db() as conn:
        for i, task_id in enumerate(task_ids):
            execute(conn, "UPDATE tasks SET sort_order = ? WHERE id = ?", (i, task_id))
    return True


def db_get_task_hierarchy(project_id: str) -> List[dict]:
    """Get all tasks in a project with full hierarchy."""
    all_tasks = db_list_tasks(project_id, include_children=True)

    task_map = {t["id"]: {**t, "children": []} for t in all_tasks}
    root_tasks = []

    for task in all_tasks:
        if task["parentId"] and task["parentId"] in task_map:
            task_map[task["parentId"]]["children"].append(task_map[task["id"]])
        else:
            root_tasks.append(task_map[task["id"]])

    return root_tasks


# ============ Task-Clip Junction Operations ============

def db_link_task_clip(task_id: str, clip_id: int) -> bool:
    """Link a clip to a task."""
    linked_at = datetime.now().isoformat()

    with get_db() as conn:
        try:
            insert_ignore(conn, "task_clips", ("task_id", "clip_id", "linked_at"),
                          (task_id, clip_id, linked_at), ("task_id", "clip_id"))
            return True
        except Exception:
            return False


def db_unlink_task_clip(task_id: str, clip_id: int) -> bool:
    """Unlink a clip from a task."""
    with get_db() as conn:
        cursor = execute(conn, """
            DELETE FROM task_clips WHERE task_id = ? AND clip_id = ?
        """, (task_id, clip_id))
        return cursor.rowcount > 0


def db_get_task_clips(task_id: str) -> List[dict]:
    """Get all clips linked to a task."""
    with get_db() as conn:
        cursor = execute(conn, """
            SELECT c.id, c.base_name, c.active_version, c.status_id,
                   cv.thumbnail, cv.media_type,
                   cs.name as status_name, cs.color as status_color,
                   tc.linked_at
            FROM task_clips tc
            JOIN clips c ON tc.clip_id = c.id
            LEFT JOIN clip_versions cv ON c.id = cv.clip_id AND c.active_version = cv.version
            LEFT JOIN clip_statuses cs ON c.status_id = cs.id
            WHERE tc.task_id = ?
            ORDER BY tc.linked_at ASC
        """, (task_id,))
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
        } if row["status_id"] else None,
        "linkedAt": row["linked_at"]
    } for row in rows]


def db_get_clip_tasks(clip_id: int) -> List[dict]:
    """Get all tasks linked to a clip."""
    with get_db() as conn:
        cursor = execute(conn, """
            SELECT t.id, t.name, t.status_id, t.due_date,
                   cs.name as status_name, cs.color as status_color,
                   tc.linked_at
            FROM task_clips tc
            JOIN tasks t ON tc.task_id = t.id
            LEFT JOIN clip_statuses cs ON t.status_id = cs.id
            WHERE tc.clip_id = ?
            ORDER BY tc.linked_at ASC
        """, (clip_id,))
        rows = fetchall(cursor)

    return [{
        "id": row["id"],
        "name": row["name"],
        "dueDate": row["due_date"],
        "status": {
            "id": row["status_id"],
            "name": row["status_name"],
            "color": row["status_color"]
        } if row["status_id"] else None,
        "linkedAt": row["linked_at"]
    } for row in rows]


def db_set_task_clips(task_id: str, clip_ids: List[int]) -> None:
    """Set the clips for a task (replaces existing)."""
    linked_at = datetime.now().isoformat()

    with get_db() as conn:
        # Remove existing clips
        execute(conn, "DELETE FROM task_clips WHERE task_id = ?", (task_id,))
        # Add new clips
        for clip_id in clip_ids:
            if clip_id:
                insert_ignore(conn, "task_clips", ("task_id", "clip_id", "linked_at"),
                              (task_id, clip_id, linked_at), ("task_id", "clip_id"))


# ============ Checklist Items ============

def db_list_checklist_items(task_id: str) -> List[dict]:
    """Get all checklist items for a task."""
    with get_db() as conn:
        cursor = execute(conn, """
            SELECT id, task_id, text, is_checked, sort_order, created_at
            FROM task_checklist_items
            WHERE task_id = ?
            ORDER BY sort_order ASC, created_at ASC
        """, (task_id,))
        return [{
            "id": row["id"],
            "taskId": row["task_id"],
            "text": row["text"],
            "isChecked": bool(row["is_checked"]),
            "sortOrder": row["sort_order"],
            "createdAt": row["created_at"]
        } for row in fetchall(cursor)]


def db_create_checklist_item(task_id: str, text: str) -> dict:
    """Create a new checklist item."""
    item_id = secrets.token_urlsafe(8)
    created_at = datetime.now().isoformat()

    with get_db() as conn:
        # Get max sort_order for this task
        cursor = execute(conn, """
            SELECT COALESCE(MAX(sort_order), 0) + 1 as next_order
            FROM task_checklist_items WHERE task_id = ?
        """, (task_id,))
        row = fetchone(cursor)
        sort_order = row["next_order"] if row else 1

        execute(conn, """
            INSERT INTO task_checklist_items (id, task_id, text, is_checked, sort_order, created_at)
            VALUES (?, ?, ?, 0, ?, ?)
        """, (item_id, task_id, text, sort_order, created_at))

    return {
        "id": item_id,
        "taskId": task_id,
        "text": text,
        "isChecked": False,
        "sortOrder": sort_order,
        "createdAt": created_at
    }


def db_update_checklist_item(item_id: str, text: str = None, is_checked: bool = None) -> Optional[dict]:
    """Update a checklist item."""
    with get_db() as conn:
        # Build update query dynamically
        updates = []
        params = []

        if text is not None:
            updates.append("text = ?")
            params.append(text)
        if is_checked is not None:
            updates.append("is_checked = ?")
            params.append(1 if is_checked else 0)

        if not updates:
            return None

        params.append(item_id)
        execute(conn, f"""
            UPDATE task_checklist_items
            SET {', '.join(updates)}
            WHERE id = ?
        """, tuple(params))

        # Return updated item
        cursor = execute(conn, """
            SELECT id, task_id, text, is_checked, sort_order, created_at
            FROM task_checklist_items WHERE id = ?
        """, (item_id,))
        row = fetchone(cursor)

        if not row:
            return None

        return {
            "id": row["id"],
            "taskId": row["task_id"],
            "text": row["text"],
            "isChecked": bool(row["is_checked"]),
            "sortOrder": row["sort_order"],
            "createdAt": row["created_at"]
        }


def db_delete_checklist_item(item_id: str) -> bool:
    """Delete a checklist item."""
    with get_db() as conn:
        cursor = execute(conn, "DELETE FROM task_checklist_items WHERE id = ?", (item_id,))
        return cursor.rowcount > 0
