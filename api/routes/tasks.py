"""Task, task comment, checklist, clip-link and section routes."""

from fastapi import (
    APIRouter,
    Depends,
    HTTPException,
    Request,
)
from typing import List, Optional
from cache import cache_manager
from database import (
    db_check_project_access,
    db_list_statuses,
    db_create_task,
    db_delete_task,
    db_get_task,
    db_get_untagged_clips,
)
from api.auth import Permission, has_permission, require_auth
from api.events import live
from api.state import projects, tasks


router = APIRouter()


async def task_changed(task: dict, what: str) -> None:
    """Tell open task views that a task's comments, checklist or linked clips changed."""
    await live.to_project(task["projectId"], {"type": f"task_{what}_changed", "taskId": task["id"]}, tasks_only=True)


def can_edit_tasks(user: dict, project_id: str) -> bool:
    """Task access on the project and a role that may change things (viewers are read-only)."""
    return has_permission(user.get("role", "guest"), Permission.PROJECT_UPDATE) and \
        db_check_project_access(user["id"], project_id, require_tasks=True)


# ============ Untagged Clips API ============

@router.get("/api/projects/{project_id}/untagged-clips")
async def get_untagged_clips(project_id: str, user: dict = Depends(require_auth)):
    """Get all clips in a project that are not linked to any task."""
    # Check project existence
    if project_id not in projects:
        raise HTTPException(status_code=404, detail="Project not found")

    # Check project access
    if not db_check_project_access(user["id"], project_id, require_review=True):
        raise HTTPException(status_code=403, detail="Access denied for this project")

    clips = db_get_untagged_clips(project_id)
    return {"clips": clips}


# ============ Tasks API ============

@router.get("/api/projects/{project_id}/tasks")
async def list_tasks(
    project_id: str,
    parent_id: Optional[str] = None,
    section_id: Optional[str] = None,
    stage_tag: Optional[str] = None,
    status_id: Optional[str] = None,
    assignee_id: Optional[str] = None,
    priority: Optional[str] = None,
    view: str = "list",
    user: dict = Depends(require_auth)
):
    """List tasks for a project with optional filters.

    view: 'list' for flat list (default), 'hierarchy' for nested shot/task structure
    """
    # Check project existence in memory
    if project_id not in projects:
        raise HTTPException(status_code=404, detail="Project not found")

    # Check task access permission
    if not db_check_project_access(user["id"], project_id, require_tasks=True):
        raise HTTPException(status_code=403, detail="Task access denied for this project")

    # Filter tasks from in-memory cache
    project_tasks = [t for t in tasks.values() if t.get("projectId") == project_id]

    if view == "hierarchy":
        # Build hierarchy from flat list
        task_map = {t["id"]: {**t, "children": []} for t in project_tasks}
        root_tasks = []
        for task in project_tasks:
            if task.get("parentId") and task["parentId"] in task_map:
                task_map[task["parentId"]]["children"].append(task_map[task["id"]])
            else:
                root_tasks.append(task_map[task["id"]])
        return {"tasks": root_tasks}

    # Apply filters for flat list
    filtered_tasks = project_tasks
    if parent_id is not None:
        filtered_tasks = [t for t in filtered_tasks if t.get("parentId") == parent_id]
    else:
        # Only root tasks (no parent)
        filtered_tasks = [t for t in filtered_tasks if not t.get("parentId")]

    if section_id:
        filtered_tasks = [t for t in filtered_tasks if t.get("sectionId") == section_id]
    if stage_tag:
        filtered_tasks = [t for t in filtered_tasks if t.get("stageTag") == stage_tag]
    if status_id:
        filtered_tasks = [t for t in filtered_tasks if t.get("statusId") == status_id]
    if assignee_id:
        filtered_tasks = [t for t in filtered_tasks if any(a.get("id") == assignee_id for a in t.get("assignees", []))]
    if priority:
        filtered_tasks = [t for t in filtered_tasks if t.get("priority") == priority]

    # Sort by sortOrder, then createdAt
    filtered_tasks.sort(key=lambda t: (t.get("sortOrder", 0), t.get("createdAt", "")))

    return {"tasks": filtered_tasks}


@router.post("/api/projects/{project_id}/tasks")
async def create_task(project_id: str, data: dict, user: dict = Depends(require_auth)):
    """Create a new task in a project."""
    # Check project existence in memory
    if project_id not in projects:
        raise HTTPException(status_code=404, detail="Project not found")

    # Check task access permission
    if not can_edit_tasks(user, project_id):
        raise HTTPException(status_code=403, detail="Task access denied for this project")

    name = data.get("name")
    if not name:
        raise HTTPException(status_code=400, detail="Task name is required")

    # Create task in DB (needed to get ID and setup assignees)
    task = db_create_task(
        project_id=project_id,
        name=name,
        created_by=user.get("id"),
        parent_id=data.get("parentId"),
        clip_id=data.get("clipId"),
        section_id=data.get("sectionId"),
        stage_tag=data.get("stageTag"),
        description=data.get("description"),
        status_id=data.get("statusId"),
        assignee_id=data.get("assigneeId"),  # Single assignee (legacy)
        assignee_ids=data.get("assigneeIds"),  # Multiple assignees (new)
        priority=data.get("priority", "medium"),
        due_date=data.get("dueDate"),
        custom_fields=data.get("customFields")
    )

    # Add to in-memory cache (fetch full task with assignees)
    full_task = db_get_task(task["id"])
    if full_task:
        tasks[task["id"]] = full_task

    # Update parent's childCount in cache if this is a subtask
    parent_id = data.get("parentId")
    if parent_id and parent_id in tasks:
        tasks[parent_id]["childCount"] = tasks[parent_id].get("childCount", 0) + 1

    await live.to_project(project_id, {"type": "task_created", "task": full_task or task}, tasks_only=True)
    return {"task": full_task or task}


@router.get("/api/tasks/{task_id}")
async def get_task(task_id: str, user: dict = Depends(require_auth)):
    """Get a single task by ID."""
    # Read from in-memory cache
    task = tasks.get(task_id)
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")

    # Check task access permission
    if not db_check_project_access(user["id"], task["projectId"], require_tasks=True):
        raise HTTPException(status_code=403, detail="Task access denied for this project")

    return {"task": task}


@router.patch("/api/tasks/{task_id}")
async def update_task(task_id: str, data: dict, user: dict = Depends(require_auth)):
    """Update a task. Only pass the fields you want to update."""
    # Read from in-memory cache
    task = tasks.get(task_id)
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")

    # Check task access permission
    if not can_edit_tasks(user, task["projectId"]):
        raise HTTPException(status_code=403, detail="Task access denied for this project")

    # Update in-memory task (direct field mapping)
    field_mapping = {
        "name": "name",
        "description": "description",
        "parentId": "parentId",
        "sectionId": "sectionId",
        "stageTag": "stageTag",
        "statusId": "statusId",
        "priority": "priority",
        "dueDate": "dueDate",
        "customFields": "customFields",
        "sortOrder": "sortOrder"
    }

    for api_field, task_field in field_mapping.items():
        if api_field in data:
            task[task_field] = data[api_field]

    # Keep the embedded status object in sync with statusId (the list view reads it)
    if "statusId" in data:
        status_id = data["statusId"]
        match = next((st for st in db_list_statuses() if st["id"] == status_id), None) if status_id else None
        task["status"] = {"id": match["id"], "name": match["name"], "color": match["color"]} if match else None

    # Handle assignees specially (need to update junction table and fetch user info)
    if "assigneeIds" in data or "assigneeId" in data:
        from database.tasks import db_set_task_assignees, db_get_task_assignees
        assignee_ids = data.get("assigneeIds") or ([data.get("assigneeId")] if data.get("assigneeId") else [])
        db_set_task_assignees(task_id, assignee_ids)
        task["assignees"] = db_get_task_assignees(task_id)
        if task["assignees"]:
            task["assignee"] = task["assignees"][0]
        else:
            task.pop("assignee", None)

    # Mark for write-back persistence
    cache_manager.mark_task_dirty(task_id)

    await live.to_project(task["projectId"], {"type": "task_updated", "task": task}, tasks_only=True)
    return {"task": task}


@router.delete("/api/tasks/{task_id}")
async def delete_task(task_id: str, user: dict = Depends(require_auth)):
    """Delete a task and its children."""
    # Read from in-memory cache
    task = tasks.get(task_id)
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")

    # Check task access permission
    if not can_edit_tasks(user, task["projectId"]):
        raise HTTPException(status_code=403, detail="Task access denied for this project")

    # Find and remove all children recursively from memory
    def find_children(parent_id: str) -> List[str]:
        child_ids = [t["id"] for t in tasks.values() if t.get("parentId") == parent_id]
        all_ids = list(child_ids)
        for cid in child_ids:
            all_ids.extend(find_children(cid))
        return all_ids

    ids_to_remove = [task_id] + find_children(task_id)

    # Update parent's childCount if this is a subtask
    parent_id = task.get("parentId")

    # Delete from database (cascade delete handles children)
    success = db_delete_task(task_id)
    if not success:
        raise HTTPException(status_code=500, detail="Failed to delete task")

    # Remove from in-memory cache
    for tid in ids_to_remove:
        tasks.pop(tid, None)

    # Decrement parent's childCount after successful deletion
    if parent_id and parent_id in tasks:
        tasks[parent_id]["childCount"] = max(0, tasks[parent_id].get("childCount", 1) - 1)

    await live.to_project(task["projectId"], {"type": "task_deleted", "taskId": task_id, "parentId": parent_id}, tasks_only=True)
    return {"success": True}


@router.post("/api/projects/{project_id}/tasks/reorder")
async def reorder_tasks_endpoint(project_id: str, data: dict, user: dict = Depends(require_auth)):
    """Reorder tasks by providing an array of task IDs in desired order."""
    # Check project existence in memory
    if project_id not in projects:
        raise HTTPException(status_code=404, detail="Project not found")

    # Check task access permission
    if not can_edit_tasks(user, project_id):
        raise HTTPException(status_code=403, detail="Task access denied for this project")

    task_ids = data.get("taskIds", [])
    if not task_ids:
        raise HTTPException(status_code=400, detail="taskIds array is required")

    # Update sortOrder in memory
    for i, task_id in enumerate(task_ids):
        if task_id in tasks:
            tasks[task_id]["sortOrder"] = i
            cache_manager.mark_task_dirty(task_id)

    await live.to_project(project_id, {"type": "tasks_reordered"}, tasks_only=True)
    return {"success": True}


@router.get("/api/projects/{project_id}/tasks/stages")
async def list_stage_tags(project_id: str, user: dict = Depends(require_auth)):
    """Get all unique stage tags used in a project."""
    # Check project existence in memory
    if project_id not in projects:
        raise HTTPException(status_code=404, detail="Project not found")

    # Check task access permission
    if not db_check_project_access(user["id"], project_id, require_tasks=True):
        raise HTTPException(status_code=403, detail="Task access denied for this project")

    # Get stage tags from in-memory tasks
    project_tasks = [t for t in tasks.values() if t.get("projectId") == project_id]
    stages = set()
    for task in project_tasks:
        if task.get("stageTag"):
            stages.add(task["stageTag"])

    # Common VFX/animation stages for suggestions
    common_stages = ["Previz", "Layout", "Animation", "Lighting", "FX", "Compositing", "Review"]

    return {
        "usedStages": sorted(list(stages)),
        "suggestedStages": common_stages
    }


# ============ Task Comments API ============

@router.get("/api/tasks/{task_id}/comments")
async def get_task_comments(task_id: str, user: dict = Depends(require_auth)):
    """Get all comments for a task."""
    from database.task_comments import db_get_task_comments

    # Check task exists
    task = tasks.get(task_id)
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")

    # Check task access permission
    if not db_check_project_access(user["id"], task["projectId"], require_tasks=True):
        raise HTTPException(status_code=403, detail="Task access denied")

    comments = db_get_task_comments(task_id)
    return {"comments": comments}


@router.post("/api/tasks/{task_id}/comments")
async def create_task_comment(task_id: str, data: dict, user: dict = Depends(require_auth)):
    """Add a comment to a task."""
    from database.task_comments import db_create_task_comment

    # Check task exists
    task = tasks.get(task_id)
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")

    # Check task access permission
    if not db_check_project_access(user["id"], task["projectId"], require_tasks=True):
        raise HTTPException(status_code=403, detail="Task access denied")

    text = data.get("text", "").strip()
    if not text:
        raise HTTPException(status_code=400, detail="Comment text is required")

    comment = db_create_task_comment(
        task_id=task_id,
        user_id=user["id"],
        user_name=user.get("username", "Unknown"),
        text=text,
        user_profile_image=user.get("profileImage")
    )

    await task_changed(task, "comments")
    return {"comment": comment}


@router.delete("/api/tasks/{task_id}/comments/{comment_id}")
async def delete_task_comment(task_id: str, comment_id: str, user: dict = Depends(require_auth)):
    """Delete a task comment."""
    from database.task_comments import db_get_task_comment, db_delete_task_comment

    # Check task exists
    task = tasks.get(task_id)
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")

    # Check task access permission
    if not db_check_project_access(user["id"], task["projectId"], require_tasks=True):
        raise HTTPException(status_code=403, detail="Task access denied")

    # Get comment to check ownership
    comment = db_get_task_comment(comment_id)
    if not comment:
        raise HTTPException(status_code=404, detail="Comment not found")

    # Only comment author or admin can delete
    if comment["userId"] != user["id"] and not user.get("is_admin"):
        raise HTTPException(status_code=403, detail="Cannot delete other user's comment")

    success = db_delete_task_comment(comment_id)
    if not success:
        raise HTTPException(status_code=500, detail="Failed to delete comment")

    await task_changed(task, "comments")
    return {"success": True}


# ============ Task-Clip Linking API ============

@router.get("/api/tasks/{task_id}/clips")
async def get_task_clips(task_id: str, user: dict = Depends(require_auth)):
    """Get all clips linked to a task."""
    from database.tasks import db_get_task_clips

    # Check task exists
    task = tasks.get(task_id)
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")

    # Check task access permission
    if not db_check_project_access(user["id"], task["projectId"], require_tasks=True):
        raise HTTPException(status_code=403, detail="Task access denied")

    clips = db_get_task_clips(task_id)
    return {"clips": clips}


@router.post("/api/tasks/{task_id}/clips")
async def link_task_clip(task_id: str, data: dict, user: dict = Depends(require_auth)):
    """Link a clip to a task."""
    from database.tasks import db_link_task_clip

    # Check task exists
    task = tasks.get(task_id)
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")

    # Check task access permission
    if not can_edit_tasks(user, task["projectId"]):
        raise HTTPException(status_code=403, detail="Task access denied")

    clip_id = data.get("clipId")
    if not clip_id:
        raise HTTPException(status_code=400, detail="clipId is required")

    success = db_link_task_clip(task_id, clip_id)
    if not success:
        raise HTTPException(status_code=500, detail="Failed to link clip")

    await task_changed(task, "clips")
    return {"success": True}


@router.delete("/api/tasks/{task_id}/clips/{clip_id}")
async def unlink_task_clip(task_id: str, clip_id: int, user: dict = Depends(require_auth)):
    """Unlink a clip from a task."""
    from database.tasks import db_unlink_task_clip

    # Check task exists
    task = tasks.get(task_id)
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")

    # Check task access permission
    if not can_edit_tasks(user, task["projectId"]):
        raise HTTPException(status_code=403, detail="Task access denied")

    success = db_unlink_task_clip(task_id, clip_id)
    if not success:
        raise HTTPException(status_code=404, detail="Clip link not found")

    await task_changed(task, "clips")
    return {"success": True}


@router.get("/api/clips/{clip_id}/tasks")
async def get_clip_tasks(clip_id: int, user: dict = Depends(require_auth)):
    """Get all tasks linked to a clip."""
    from database.tasks import db_get_clip_tasks

    from database import get_db, execute, fetchone

    # Look up the clip's project
    with get_db() as conn:
        clip = fetchone(execute(conn, "SELECT project_id FROM clips WHERE id = ?", (clip_id,)))

    if not clip:
        raise HTTPException(status_code=404, detail="Clip not found")

    # Check project access
    project_id = clip["project_id"]
    if not db_check_project_access(user["id"], project_id, require_tasks=True):
        raise HTTPException(status_code=403, detail="Task access denied")

    tasks_list = db_get_clip_tasks(clip_id)
    return {"tasks": tasks_list}


# ============ Task Checklist Items ============

@router.get("/api/tasks/{task_id}/checklist")
async def get_task_checklist(task_id: str, user: dict = Depends(require_auth)):
    """Get all checklist items for a task."""
    from database.tasks import db_list_checklist_items

    task = tasks.get(task_id)
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")

    if not db_check_project_access(user["id"], task["projectId"], require_tasks=True):
        raise HTTPException(status_code=403, detail="Task access denied")

    items = db_list_checklist_items(task_id)
    return {"items": items}


@router.post("/api/tasks/{task_id}/checklist")
async def create_checklist_item(task_id: str, request: Request, user: dict = Depends(require_auth)):
    """Create a new checklist item."""
    from database.tasks import db_create_checklist_item

    task = tasks.get(task_id)
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")

    if not can_edit_tasks(user, task["projectId"]):
        raise HTTPException(status_code=403, detail="Task access denied")

    data = await request.json()
    text = data.get("text", "").strip()
    if not text:
        raise HTTPException(status_code=400, detail="Text is required")

    item = db_create_checklist_item(task_id, text)
    await task_changed(task, "checklist")
    return {"item": item}


@router.patch("/api/tasks/{task_id}/checklist/{item_id}")
async def update_checklist_item(task_id: str, item_id: str, request: Request, user: dict = Depends(require_auth)):
    """Update a checklist item (text or checked state)."""
    from database.tasks import db_update_checklist_item

    task = tasks.get(task_id)
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")

    if not can_edit_tasks(user, task["projectId"]):
        raise HTTPException(status_code=403, detail="Task access denied")

    data = await request.json()
    text = data.get("text")
    is_checked = data.get("isChecked")

    item = db_update_checklist_item(item_id, text=text, is_checked=is_checked)
    if not item:
        raise HTTPException(status_code=404, detail="Checklist item not found")

    await task_changed(task, "checklist")
    return {"item": item}


@router.delete("/api/tasks/{task_id}/checklist/{item_id}")
async def delete_checklist_item(task_id: str, item_id: str, user: dict = Depends(require_auth)):
    """Delete a checklist item."""
    from database.tasks import db_delete_checklist_item

    task = tasks.get(task_id)
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")

    if not can_edit_tasks(user, task["projectId"]):
        raise HTTPException(status_code=403, detail="Task access denied")

    success = db_delete_checklist_item(item_id)
    if not success:
        raise HTTPException(status_code=404, detail="Checklist item not found")

    await task_changed(task, "checklist")
    return {"success": True}


# ============ Task Sections API ============

@router.get("/api/projects/{project_id}/sections")
async def list_sections(project_id: str, user: dict = Depends(require_auth)):
    """List all task sections for a project."""
    from database.sections import db_list_sections

    if project_id not in projects:
        raise HTTPException(status_code=404, detail="Project not found")

    if not db_check_project_access(user["id"], project_id, require_tasks=True):
        raise HTTPException(status_code=403, detail="Task access denied")

    sections_list = db_list_sections(project_id)
    return {"sections": sections_list}


@router.post("/api/projects/{project_id}/sections")
async def create_section(project_id: str, data: dict, user: dict = Depends(require_auth)):
    """Create a new task section."""
    from database.sections import db_create_section

    if project_id not in projects:
        raise HTTPException(status_code=404, detail="Project not found")

    if not can_edit_tasks(user, project_id):
        raise HTTPException(status_code=403, detail="Task access denied")

    name = data.get("name")
    if not name:
        raise HTTPException(status_code=400, detail="Section name is required")

    color = data.get("color", "#6366f1")
    section = db_create_section(project_id, name, color)
    return section


@router.get("/api/sections/{section_id}")
async def get_section(section_id: str, user: dict = Depends(require_auth)):
    """Get a section by ID."""
    from database.sections import db_get_section

    section = db_get_section(section_id)
    if not section:
        raise HTTPException(status_code=404, detail="Section not found")

    if not db_check_project_access(user["id"], section["projectId"], require_tasks=True):
        raise HTTPException(status_code=403, detail="Task access denied")

    return section


@router.patch("/api/sections/{section_id}")
async def update_section(section_id: str, data: dict, user: dict = Depends(require_auth)):
    """Update a section."""
    from database.sections import db_get_section, db_update_section

    section = db_get_section(section_id)
    if not section:
        raise HTTPException(status_code=404, detail="Section not found")

    if not can_edit_tasks(user, section["projectId"]):
        raise HTTPException(status_code=403, detail="Task access denied")

    updates = {}
    if "name" in data:
        updates["name"] = data["name"]
    if "color" in data:
        updates["color"] = data["color"]
    if "is_collapsed" in data:
        updates["is_collapsed"] = int(data["is_collapsed"])
    if "sort_order" in data:
        updates["sort_order"] = data["sort_order"]

    if updates:
        db_update_section(section_id, **updates)

    return db_get_section(section_id)


@router.delete("/api/sections/{section_id}")
async def delete_section(section_id: str, user: dict = Depends(require_auth)):
    """Delete a section."""
    from database.sections import db_get_section, db_delete_section

    section = db_get_section(section_id)
    if not section:
        raise HTTPException(status_code=404, detail="Section not found")

    if not can_edit_tasks(user, section["projectId"]):
        raise HTTPException(status_code=403, detail="Task access denied")

    db_delete_section(section_id)
    return {"success": True}


@router.post("/api/projects/{project_id}/sections/reorder")
async def reorder_sections(project_id: str, data: dict, user: dict = Depends(require_auth)):
    """Reorder sections."""
    from database.sections import db_reorder_sections

    if project_id not in projects:
        raise HTTPException(status_code=404, detail="Project not found")

    if not can_edit_tasks(user, project_id):
        raise HTTPException(status_code=403, detail="Task access denied")

    section_ids = data.get("sectionIds", [])
    if not section_ids:
        raise HTTPException(status_code=400, detail="Section IDs required")

    db_reorder_sections(section_ids)
    return {"success": True}


@router.get("/api/sections/{section_id}/statuses")
async def get_section_statuses(section_id: str, user: dict = Depends(require_auth)):
    """Get all statuses available for a section."""
    from database.sections import db_get_section, db_get_section_statuses

    section = db_get_section(section_id)
    if not section:
        raise HTTPException(status_code=404, detail="Section not found")

    if not db_check_project_access(user["id"], section["projectId"], require_tasks=True):
        raise HTTPException(status_code=403, detail="Task access denied")

    statuses = db_get_section_statuses(section_id)
    return {"statuses": statuses}


@router.post("/api/sections/{section_id}/statuses")
async def add_section_status(section_id: str, data: dict, user: dict = Depends(require_auth)):
    """Add an existing status to a section, or create a new custom status."""
    from database.sections import db_get_section, db_add_section_status, db_create_section_status

    section = db_get_section(section_id)
    if not section:
        raise HTTPException(status_code=404, detail="Section not found")

    if not can_edit_tasks(user, section["projectId"]):
        raise HTTPException(status_code=403, detail="Task access denied")

    status_id = data.get("statusId")
    if status_id:
        # Add existing status to section
        db_add_section_status(section_id, status_id)
        return {"success": True}
    else:
        # Create new custom status
        name = data.get("name")
        if not name:
            raise HTTPException(status_code=400, detail="Status name or statusId required")
        color = data.get("color", "#6366f1")
        status = db_create_section_status(section_id, name, color)
        return status


@router.delete("/api/sections/{section_id}/statuses/{status_id}")
async def remove_section_status(section_id: str, status_id: str, user: dict = Depends(require_auth)):
    """Remove a status from a section."""
    from database.sections import db_get_section, db_remove_section_status

    section = db_get_section(section_id)
    if not section:
        raise HTTPException(status_code=404, detail="Section not found")

    if not can_edit_tasks(user, section["projectId"]):
        raise HTTPException(status_code=403, detail="Task access denied")

    db_remove_section_status(section_id, status_id)
    return {"success": True}
