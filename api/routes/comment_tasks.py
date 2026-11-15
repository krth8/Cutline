"""A task made from a review comment (PLAN.md S6).

POST /api/projects/{project_id}/comments/{comment_id}/task creates one task per comment: named from the first
line of the comment, linked to the comment's clip, with the comment's frame and id stored on the task and the
comment text as its description. Asking again returns the task that exists. Only people who may edit tasks in
the project can do it (share-link guests and reviewers without task rights cannot).
"""

from typing import Iterable, Optional

from fastapi import APIRouter, Depends, HTTPException

from api.auth import can_edit_tasks, require_auth
from api.events import live
from api.routes.tasks import create_task_record, reload_task
from api.state import projects
from database.tasks import db_get_clip_row_id, db_get_task_by_comment, db_link_task_clip

router = APIRouter()

MAX_TASK_NAME = 80


def task_name_from_comment(comment: dict) -> str:
    """The first non-empty line of the comment, cut at a word boundary when it is long."""
    text = comment.get("text") or ""
    first = next((line.strip() for line in text.splitlines() if line.strip()), "")
    if not first:
        frame = comment.get("frame")
        return f"Review comment at frame {frame}" if frame is not None else "Review comment"
    if len(first) <= MAX_TASK_NAME:
        return first
    cut = first[:MAX_TASK_NAME - 1]
    if " " in cut[MAX_TASK_NAME // 2:]:
        cut = cut.rsplit(" ", 1)[0]
    return cut.rstrip(" ,;:.-") + "…"


async def _tell_comment_changed(project_id: str, comment: dict) -> None:
    """Other viewers of the review learn the comment's task link (the event also carries `resolved`)."""
    await live.to_project(project_id, {
        "type": "comment_updated",
        "commentId": comment["id"],
        "resolved": bool(comment.get("resolved")),
        "taskId": comment.get("taskId"),
    })


@router.post("/api/projects/{project_id}/comments/{comment_id}/task")
async def create_task_from_comment(project_id: str, comment_id: str, user: dict = Depends(require_auth)):
    """Create (or return) the task of a review comment. Returns {task, created}."""
    if not can_edit_tasks(user, project_id):
        raise HTTPException(status_code=403, detail="Access denied")
    project = projects.get(project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    comment = next((c for c in project.get("comments", []) if c.get("id") == comment_id), None)
    if not comment:
        raise HTTPException(status_code=404, detail="Comment not found")

    # No await between this check and the insert below, so two requests cannot both create a task
    # (the unique index on tasks.comment_id is the backstop)
    existing_id = db_get_task_by_comment(project_id, comment_id)
    if existing_id:
        task = reload_task(existing_id)
        if task:
            if comment.get("taskId") != existing_id:
                comment["taskId"] = existing_id
            return {"task": task, "created": False}

    base_name = comment.get("clipBaseName")
    clip_id = db_get_clip_row_id(project_id, base_name) if base_name else None
    frame = comment.get("frame")
    task = await create_task_record(
        user,
        project_id,
        {"name": task_name_from_comment(comment), "description": comment.get("text") or None, "clipId": clip_id},
        link={"commentId": comment_id, "clipFrame": frame if isinstance(frame, int) else None},
    )
    if clip_id:
        db_link_task_clip(task["id"], clip_id)  # the legacy task detail lists clips from this link table

    comment["taskId"] = task["id"]
    await _tell_comment_changed(project_id, comment)
    return {"task": task, "created": True}


async def forget_deleted_tasks(project_id: str, task_ids: Iterable[str]) -> None:
    """Comments whose task was deleted lose their "Task" chip (so a new task can be made from them)."""
    gone = set(task_ids)
    for comment in (projects.get(project_id) or {}).get("comments", []):
        if comment.get("taskId") in gone:
            comment.pop("taskId", None)
            await _tell_comment_changed(project_id, comment)


async def relink_restored_tasks(project_id: str, restored: Iterable[dict]) -> None:
    """Restored tasks made from a review comment show the "Task" chip on it again. When the comment has another
    task by now, the database dropped the link (db_restore_tasks) and the comment is left alone."""
    comments = {c["id"]: c for c in (projects.get(project_id) or {}).get("comments", [])}
    for task in restored:
        comment = comments.get(task.get("commentId"))
        if comment and not comment.get("taskId"):
            comment["taskId"] = task["id"]
            await _tell_comment_changed(project_id, comment)
