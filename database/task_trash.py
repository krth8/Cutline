"""Task trash (PLAN.md H3): moving tasks to the trash and back, listing it, deleting for good.

A deleted task keeps its row with deleted_at / deleted_by set, so everything attached to it (checklist,
comments, clip links, assignees, custom values, its page, the review-comment link) stays in place. Every
task deleted by one action gets the same deleted_at: that is how "the subtasks that went with their
parent" are told apart from subtasks that were deleted on their own earlier.
"""

from datetime import datetime
from typing import Iterable, List, Optional

from .engine import execute, fetchall, fetchone
from .utils import get_db


def _marks(values: Iterable) -> str:
    return ",".join("?" for _ in values)


def db_soft_delete_tasks(task_ids: List[str], user_id: Optional[str], deleted_at: Optional[str] = None) -> int:
    """Move live tasks to the trash, all with one deleted_at. Returns how many were moved."""
    if not task_ids:
        return 0
    stamp = deleted_at or datetime.now().isoformat()
    with get_db() as conn:
        cursor = execute(conn, f"UPDATE tasks SET deleted_at = ?, deleted_by = ? "
                               f"WHERE deleted_at IS NULL AND id IN ({_marks(task_ids)})",
                         (stamp, user_id, *task_ids))
        return cursor.rowcount


def db_get_trashed_task(task_id: str) -> Optional[dict]:
    """The bare row of a task that is in the trash, or None."""
    with get_db() as conn:
        row = fetchone(execute(conn, "SELECT id, project_id, parent_id, name, comment_id, deleted_at, deleted_by "
                                     "FROM tasks WHERE id = ? AND deleted_at IS NOT NULL", (task_id,)))
    return dict(row) if row else None


def db_trashed_descendants(task_id: str, deleted_at: str) -> List[str]:
    """Ids below a trashed task that were deleted in the same action (same deleted_at), at any depth."""
    found: List[str] = []
    frontier = [task_id]
    with get_db() as conn:
        while frontier:
            cursor = execute(conn, f"SELECT id FROM tasks WHERE deleted_at = ? AND parent_id IN ({_marks(frontier)})",
                             (deleted_at, *frontier))
            frontier = [r["id"] for r in fetchall(cursor)]
            found.extend(frontier)
    return found


def db_restore_tasks(task_id: str, deleted_at: str, subtask_ids: List[str]) -> dict:
    """Bring a trashed task and the subtasks deleted with it back. Returns what was fixed on the way:
    {"detached": True} when the task's parent is still in the trash (or gone), so it returns at the top level;
    {"commentTaken": True} when the review comment it came from got another task meanwhile (link dropped)."""
    result = {"detached": False, "commentTaken": False}
    ids = [task_id] + list(subtask_ids)
    with get_db() as conn:
        row = fetchone(execute(conn, "SELECT parent_id, comment_id FROM tasks WHERE id = ?", (task_id,)))
        if row and row["parent_id"]:
            parent = fetchone(execute(conn, "SELECT deleted_at FROM tasks WHERE id = ?", (row["parent_id"],)))
            if not parent or parent["deleted_at"] is not None:
                execute(conn, "UPDATE tasks SET parent_id = NULL WHERE id = ?", (task_id,))
                result["detached"] = True
        for tid in ids:
            own = fetchone(execute(conn, "SELECT comment_id FROM tasks WHERE id = ?", (tid,)))
            if own and own["comment_id"]:
                other = fetchone(execute(conn, "SELECT id FROM tasks WHERE comment_id = ? AND deleted_at IS NULL AND id <> ?",
                                         (own["comment_id"], tid)))
                if other:
                    execute(conn, "UPDATE tasks SET comment_id = NULL, clip_frame = NULL WHERE id = ?", (tid,))
                    if tid == task_id:
                        result["commentTaken"] = True
        execute(conn, f"UPDATE tasks SET deleted_at = NULL, deleted_by = NULL WHERE id IN ({_marks(ids)})", tuple(ids))
    return result


def db_list_trash(project_ids: List[str]) -> List[dict]:
    """The trash of the given projects, newest first. One entry per deleted action: a task deleted together
    with its parent is not listed on its own, it is counted in its parent's subtaskCount."""
    if not project_ids:
        return []
    with get_db() as conn:
        rows = fetchall(execute(conn, f"""
            SELECT t.id, t.project_id, t.parent_id, t.name, t.deleted_at, t.deleted_by,
                   p.name AS parent_name, p.deleted_at AS parent_deleted_at,
                   u.username AS deleted_by_name
            FROM tasks t
            LEFT JOIN tasks p ON t.parent_id = p.id
            LEFT JOIN users u ON t.deleted_by = u.id
            WHERE t.deleted_at IS NOT NULL AND t.project_id IN ({_marks(project_ids)})
            ORDER BY t.deleted_at DESC, t.sort_order ASC
        """, tuple(project_ids)))
    entries = []
    for r in rows:
        if r["parent_id"] and r["parent_deleted_at"] == r["deleted_at"]:
            continue  # went with its parent
        entries.append({
            "id": r["id"], "projectId": r["project_id"], "name": r["name"],
            "deletedAt": r["deleted_at"], "deletedBy": r["deleted_by"], "deletedByName": r["deleted_by_name"],
            "parentId": r["parent_id"], "parentName": r["parent_name"],
            "subtaskCount": len(db_trashed_descendants(r["id"], r["deleted_at"])),
        })
    return entries


def db_trash_ids(project_id: str) -> List[str]:
    """Ids of every task in the trash of a project."""
    with get_db() as conn:
        return [r["id"] for r in fetchall(execute(
            conn, "SELECT id FROM tasks WHERE project_id = ? AND deleted_at IS NOT NULL", (project_id,)))]


def db_trash_ids_older_than(cutoff: str) -> List[dict]:
    """Tasks (id, project_id) deleted before the cutoff (an ISO timestamp)."""
    with get_db() as conn:
        return [dict(r) for r in fetchall(execute(
            conn, "SELECT id, project_id FROM tasks WHERE deleted_at IS NOT NULL AND deleted_at < ?", (cutoff,)))]
