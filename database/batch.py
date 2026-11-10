"""
Batch database operations for efficient persistence.

Uses database-native upsert syntax:
- SQLite: INSERT OR REPLACE
- PostgreSQL: ON CONFLICT DO UPDATE
"""

import json
from typing import List, Tuple
from .engine import get_connection, execute, insert_ignore, fetchone, DB_TYPE, DatabaseType


def db_batch_upsert_comments(project_id: str, comments: List[dict]) -> int:
    """
    Batch upsert comments using database-specific syntax.
    Returns number of comments persisted.
    """
    if not comments:
        return 0

    with get_connection() as conn:
        for comment in comments:
            drawing_json = json.dumps(comment.get("drawing")) if comment.get("drawing") else None
            anchor_json = json.dumps(comment.get("anchor")) if comment.get("anchor") else None

            resolved = 1 if comment.get("resolved") else 0
            parent_id = comment.get("parentId")

            if DB_TYPE == DatabaseType.POSTGRESQL:
                execute(conn, """
                    INSERT INTO comments (id, project_id, frame, user_id, user_name, text,
                                         drawing_json, color, created_at, user_profile_image, client_hash,
                                         clip_base_name, clip_version, resolved, parent_id, anchor_json)
                    VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                    ON CONFLICT (id) DO UPDATE SET
                        text = EXCLUDED.text,
                        drawing_json = EXCLUDED.drawing_json,
                        clip_base_name = EXCLUDED.clip_base_name,
                        clip_version = EXCLUDED.clip_version,
                        resolved = EXCLUDED.resolved,
                        parent_id = EXCLUDED.parent_id,
                        anchor_json = EXCLUDED.anchor_json
                """, (
                    comment["id"], project_id, comment.get("frame"),
                    comment.get("user"), comment.get("userName"), comment.get("text"),
                    drawing_json, comment.get("color"), comment.get("createdAt"),
                    comment.get("userProfileImage"), comment.get("_clientHash"),
                    comment.get("clipBaseName"), comment.get("clipVersion"),
                    resolved, parent_id, anchor_json
                ))
            else:
                execute(conn, """
                    INSERT OR REPLACE INTO comments
                    (id, project_id, frame, user_id, user_name, text, drawing_json, color,
                     created_at, user_profile_image, client_hash, clip_base_name, clip_version,
                     resolved, parent_id, anchor_json)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """, (
                    comment["id"], project_id, comment.get("frame"),
                    comment.get("user"), comment.get("userName"), comment.get("text"),
                    drawing_json, comment.get("color"), comment.get("createdAt"),
                    comment.get("userProfileImage"), comment.get("_clientHash"),
                    comment.get("clipBaseName"), comment.get("clipVersion"),
                    resolved, parent_id, anchor_json
                ))

    return len(comments)


def db_batch_delete_comments(project_id: str, comment_ids: List[str]) -> int:
    """Batch delete comments by IDs."""
    if not comment_ids:
        return 0

    with get_connection() as conn:
        if DB_TYPE == DatabaseType.POSTGRESQL:
            placeholders = ",".join(["%s" for _ in comment_ids])
        else:
            placeholders = ",".join(["?" for _ in comment_ids])

        execute(conn, f"""
            DELETE FROM comments
            WHERE project_id = ? AND id IN ({placeholders})
        """, (project_id, *comment_ids))

    return len(comment_ids)


def db_batch_upsert_annotations(project_id: str, annotations: List[dict]) -> int:
    """Batch upsert annotations."""
    if not annotations:
        return 0

    with get_connection() as conn:
        for annotation in annotations:
            strokes_json = json.dumps(annotation.get("strokes")) if annotation.get("strokes") else None

            if DB_TYPE == DatabaseType.POSTGRESQL:
                execute(conn, """
                    INSERT INTO annotations (id, project_id, frame, user_id, strokes_json, color, created_at)
                    VALUES (%s, %s, %s, %s, %s, %s, %s)
                    ON CONFLICT (id) DO UPDATE SET
                        strokes_json = EXCLUDED.strokes_json
                """, (
                    annotation["id"], project_id, annotation.get("frame"),
                    annotation.get("user"), strokes_json, annotation.get("color"),
                    annotation.get("createdAt")
                ))
            else:
                execute(conn, """
                    INSERT OR REPLACE INTO annotations
                    (id, project_id, frame, user_id, strokes_json, color, created_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?)
                """, (
                    annotation["id"], project_id, annotation.get("frame"),
                    annotation.get("user"), strokes_json, annotation.get("color"),
                    annotation.get("createdAt")
                ))

    return len(annotations)


def db_batch_delete_annotations(project_id: str, annotation_ids: List[str]) -> int:
    """Batch delete annotations by IDs."""
    if not annotation_ids:
        return 0

    with get_connection() as conn:
        if DB_TYPE == DatabaseType.POSTGRESQL:
            placeholders = ",".join(["%s" for _ in annotation_ids])
        else:
            placeholders = ",".join(["?" for _ in annotation_ids])

        execute(conn, f"""
            DELETE FROM annotations
            WHERE project_id = ? AND id IN ({placeholders})
        """, (project_id, *annotation_ids))

    return len(annotation_ids)


def db_batch_upsert_clips(project_id: str, clips: List[Tuple[str, dict]]) -> int:
    """
    Batch upsert clips and their versions.
    clips: List of (base_name, clip_data) tuples
    """
    if not clips:
        return 0

    with get_connection() as conn:
        for base_name, clip_data in clips:
            # Check both statusId (direct) and status.id (nested) for compatibility
            status_id = clip_data.get("statusId") or (clip_data.get("status", {}).get("id") if clip_data.get("status") else None)

            # Upsert clip record
            if DB_TYPE == DatabaseType.POSTGRESQL:
                execute(conn, """
                    INSERT INTO clips (project_id, base_name, active_version, status_id)
                    VALUES (%s, %s, %s, %s)
                    ON CONFLICT (project_id, base_name) DO UPDATE SET
                        active_version = EXCLUDED.active_version,
                        status_id = EXCLUDED.status_id
                """, (project_id, base_name, clip_data.get("activeVersion", 1), status_id))
            else:
                execute(conn, """
                    INSERT OR REPLACE INTO clips (project_id, base_name, active_version, status_id)
                    VALUES (?, ?, ?, ?)
                """, (project_id, base_name, clip_data.get("activeVersion", 1), status_id))

            # Get clip ID
            cursor = execute(conn,
                "SELECT id FROM clips WHERE project_id = ? AND base_name = ?",
                (project_id, base_name))
            clip_row = fetchone(cursor)
            if not clip_row:
                continue
            clip_id = clip_row["id"]

            # Upsert versions
            for version_data in clip_data.get("versions", []):
                proxies_json = json.dumps(version_data.get("proxies")) if version_data.get("proxies") else None

                if DB_TYPE == DatabaseType.POSTGRESQL:
                    execute(conn, """
                        INSERT INTO clip_versions
                        (clip_id, version, version_str, filename, thumbnail, proxies_json,
                         default_quality, uploaded_at, media_type)
                        VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
                        ON CONFLICT (clip_id, version) DO UPDATE SET
                            filename = EXCLUDED.filename,
                            thumbnail = EXCLUDED.thumbnail,
                            proxies_json = EXCLUDED.proxies_json,
                            default_quality = EXCLUDED.default_quality,
                            media_type = EXCLUDED.media_type
                    """, (clip_id, version_data["version"], version_data.get("versionStr"),
                          version_data["filename"], version_data.get("thumbnail"),
                          proxies_json, version_data.get("defaultQuality"),
                          version_data.get("uploadedAt"), version_data.get("mediaType", "video")))
                else:
                    execute(conn, """
                        INSERT OR REPLACE INTO clip_versions
                        (clip_id, version, version_str, filename, thumbnail, proxies_json,
                         default_quality, uploaded_at, media_type)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """, (clip_id, version_data["version"], version_data.get("versionStr"),
                          version_data["filename"], version_data.get("thumbnail"),
                          proxies_json, version_data.get("defaultQuality"),
                          version_data.get("uploadedAt"), version_data.get("mediaType", "video")))

    return len(clips)


def db_batch_upsert_tasks(tasks: List[dict]) -> int:
    """Batch upsert tasks."""
    if not tasks:
        return 0

    with get_connection() as conn:
        for task in tasks:
            custom_fields_json = json.dumps(task.get("customFields")) if task.get("customFields") else None

            # Get first assignee for legacy column
            assignees = task.get("assignees", [])
            first_assignee = assignees[0]["id"] if assignees else task.get("assigneeId")

            if DB_TYPE == DatabaseType.POSTGRESQL:
                execute(conn, """
                    INSERT INTO tasks (id, project_id, parent_id, clip_id, stage_tag, name,
                                      description, status_id, assignee_id, due_date,
                                      custom_fields, sort_order, created_at, created_by)
                    VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                    ON CONFLICT (id) DO UPDATE SET
                        name = EXCLUDED.name,
                        description = EXCLUDED.description,
                        status_id = EXCLUDED.status_id,
                        assignee_id = EXCLUDED.assignee_id,
                        due_date = EXCLUDED.due_date,
                        custom_fields = EXCLUDED.custom_fields,
                        sort_order = EXCLUDED.sort_order,
                        stage_tag = EXCLUDED.stage_tag
                """, (task["id"], task["projectId"], task.get("parentId"), task.get("clipId"),
                      task.get("stageTag"), task["name"], task.get("description"),
                      task.get("statusId"), first_assignee, task.get("dueDate"),
                      custom_fields_json, task.get("sortOrder", 0),
                      task.get("createdAt"), task.get("createdBy")))
            else:
                execute(conn, """
                    INSERT OR REPLACE INTO tasks
                    (id, project_id, parent_id, clip_id, stage_tag, name, description,
                     status_id, assignee_id, due_date, custom_fields, sort_order,
                     created_at, created_by)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """, (task["id"], task["projectId"], task.get("parentId"), task.get("clipId"),
                      task.get("stageTag"), task["name"], task.get("description"),
                      task.get("statusId"), first_assignee, task.get("dueDate"),
                      custom_fields_json, task.get("sortOrder", 0),
                      task.get("createdAt"), task.get("createdBy")))

            # Handle task assignees junction table
            if "assignees" in task or "assigneeIds" in task:
                # Clear existing assignees
                execute(conn, "DELETE FROM task_assignees WHERE task_id = ?", (task["id"],))

                # Insert new assignees
                assignee_ids = task.get("assigneeIds", [])
                if not assignee_ids and task.get("assignees"):
                    assignee_ids = [a["id"] for a in task["assignees"]]

                from datetime import datetime
                assigned_at = datetime.now().isoformat()

                for user_id in assignee_ids:
                    if user_id:
                        insert_ignore(conn, "task_assignees", ("task_id", "user_id", "assigned_at"),
                                      (task["id"], user_id, assigned_at), ("task_id", "user_id"))

    return len(tasks)


def db_batch_upsert_statuses(statuses: List[dict]) -> int:
    """Batch upsert clip statuses."""
    if not statuses:
        return 0

    with get_connection() as conn:
        for status in statuses:
            if DB_TYPE == DatabaseType.POSTGRESQL:
                execute(conn, """
                    INSERT INTO clip_statuses (id, name, color, sort_order, created_at)
                    VALUES (%s, %s, %s, %s, %s)
                    ON CONFLICT (id) DO UPDATE SET
                        name = EXCLUDED.name,
                        color = EXCLUDED.color,
                        sort_order = EXCLUDED.sort_order
                """, (status["id"], status["name"], status["color"],
                      status.get("sortOrder", 0), status.get("createdAt")))
            else:
                execute(conn, """
                    INSERT OR REPLACE INTO clip_statuses (id, name, color, sort_order, created_at)
                    VALUES (?, ?, ?, ?, ?)
                """, (status["id"], status["name"], status["color"],
                      status.get("sortOrder", 0), status.get("createdAt")))

    return len(statuses)
