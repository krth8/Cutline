"""Project access (members/owners) routes."""

from fastapi import APIRouter, Depends, HTTPException
from database import (
    db_get_project,
    db_get_project_access,
    db_get_user_by_id,
    db_grant_project_access,
    db_list_project_access,
    db_list_user_project_access,
    db_list_users,
    db_revoke_project_access,
    db_update_project_access,
)
from api.auth import require_auth, require_project_access
from api.state import projects


router = APIRouter()


# ============ Project Access API ============

@router.get("/api/projects/{project_id}/access")
async def list_project_access(project_id: str, user: dict = Depends(require_auth)):
    """List all users with access to a project.

    Only admins and project owners can see the full access list.
    """
    if project_id not in projects:
        raise HTTPException(status_code=404, detail="Project not found")

    # Check if user is admin or has access to this project
    if user["role"] != "admin":
        access = db_get_project_access(user["id"], project_id)
        if not access or not access["isOwner"]:
            raise HTTPException(status_code=403, detail="Only admins and project owners can view access list")

    access_list = db_list_project_access(project_id)
    return {"access": access_list}


@router.post("/api/projects/{project_id}/access")
async def grant_project_access(project_id: str, data: dict, user: dict = Depends(require_auth)):
    """Grant a user access to a project.

    Only admins and project owners can grant access.

    Body: {
        "userId": "user_id",
        "canReview": true/false,
        "canTasks": true/false
    }
    """
    if project_id not in projects:
        raise HTTPException(status_code=404, detail="Project not found")

    # Check if user is admin or project owner
    if user["role"] != "admin":
        access = db_get_project_access(user["id"], project_id)
        if not access or not access["isOwner"]:
            raise HTTPException(status_code=403, detail="Only admins and project owners can grant access")

    target_user_id = data.get("userId")
    if not target_user_id:
        raise HTTPException(status_code=400, detail="userId is required")

    # Check if target user exists
    target_user = db_get_user_by_id(target_user_id)
    if not target_user:
        raise HTTPException(status_code=404, detail="User not found")

    can_review = data.get("canReview", True)
    can_tasks = data.get("canTasks", False)

    access = db_grant_project_access(
        user_id=target_user_id,
        project_id=project_id,
        can_review=can_review,
        can_tasks=can_tasks,
        is_owner=False,
        granted_by=user["id"]
    )

    return {"access": access}


@router.patch("/api/projects/{project_id}/access/{target_user_id}")
async def update_project_access(project_id: str, target_user_id: str, data: dict, user: dict = Depends(require_auth)):
    """Update a user's access permissions for a project.

    Only admins and project owners can update access.

    Body: {
        "canReview": true/false,
        "canTasks": true/false
    }
    """
    if project_id not in projects:
        raise HTTPException(status_code=404, detail="Project not found")

    # Check if user is admin or project owner
    if user["role"] != "admin":
        access = db_get_project_access(user["id"], project_id)
        if not access or not access["isOwner"]:
            raise HTTPException(status_code=403, detail="Only admins and project owners can update access")

    can_review = data.get("canReview")
    can_tasks = data.get("canTasks")

    success = db_update_project_access(target_user_id, project_id, can_review=can_review, can_tasks=can_tasks)
    if not success:
        raise HTTPException(status_code=404, detail="Access record not found")

    return {"success": True}


@router.delete("/api/projects/{project_id}/access/{target_user_id}")
async def revoke_project_access(project_id: str, target_user_id: str, user: dict = Depends(require_auth)):
    """Revoke a user's access to a project.

    Only admins and project owners can revoke access.
    Cannot revoke owner's access.
    """
    if project_id not in projects:
        raise HTTPException(status_code=404, detail="Project not found")

    # Check if user is admin or project owner
    if user["role"] != "admin":
        access = db_get_project_access(user["id"], project_id)
        if not access or not access["isOwner"]:
            raise HTTPException(status_code=403, detail="Only admins and project owners can revoke access")

    # Check if target is owner - cannot revoke owner access
    target_access = db_get_project_access(target_user_id, project_id)
    if target_access and target_access["isOwner"]:
        raise HTTPException(status_code=400, detail="Cannot revoke project owner's access")

    success = db_revoke_project_access(target_user_id, project_id)
    if not success:
        raise HTTPException(status_code=404, detail="Access record not found")

    return {"success": True}


@router.get("/api/projects/{project_id}/members")
async def list_project_members(project_id: str, user: dict = Depends(require_auth)):
    """List all users who can be assigned to tasks in this project.

    Returns all users in the system - any user can be assigned to a task.
    """
    # Check database for project existence (not in-memory dict)
    project = db_get_project(project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    require_project_access(user, project_id)

    # Return all users - anyone can be assigned to a task
    all_users = db_list_users()

    members = [{
        "id": u["id"],
        "username": u["username"],
        "profileImage": u.get("profileImage"),
        "role": u["role"],
        "canTasks": True
    } for u in all_users]

    return {"members": members}


@router.get("/api/users/{user_id}/access")
async def list_user_access(user_id: str, user: dict = Depends(require_auth)):
    """List all projects a user has access to.

    Users can see their own access. Admins can see anyone's access.
    """
    # Check if user can view this info
    if user["role"] != "admin" and user["id"] != user_id:
        raise HTTPException(status_code=403, detail="Can only view your own access unless admin")

    access_list = db_list_user_project_access(user_id)
    return {"access": access_list}
