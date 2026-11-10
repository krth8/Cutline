"""Setup, login, admin, invite and user profile routes."""

import os
from fastapi import (
    APIRouter,
    Depends,
    File,
    HTTPException,
    Request,
    UploadFile,
)
from cache import cache_manager
from database import (
    db_create_invite_link,
    db_create_user,
    db_delete_guest,
    db_delete_invite_link,
    db_delete_user,
    db_get_invite_link,
    db_get_user,
    db_get_user_by_id,
    db_grant_project_access,
    db_has_users,
    db_list_guests,
    db_list_invite_links,
    db_list_users,
    db_update_user_password,
    db_update_user_profile_image,
    db_update_user_role,
    db_use_invite_link,
    db_validate_user,
)
from api.auth import (
    JWT_EXPIRATION_HOURS,
    ROLES,
    check_rate_limit,
    clear_login_attempts,
    create_jwt_token,
    get_role_permissions,
    record_login_attempt,
    require_admin,
    require_auth,
)
from api.config import PROFILES_DIR, UPLOAD_DIR
from api.media import process_image, safe_upload_name
from api.state import projects, tasks


router = APIRouter()


# ============ Setup API ============

@router.get("/api/setup/status")
async def setup_status():
    """Check if initial setup is required (no users exist)."""
    needs_setup = not db_has_users()
    return {"needsSetup": needs_setup}


@router.post("/api/setup/complete")
async def setup_complete(data: dict):
    """Complete initial setup by creating the first admin user."""
    # Only allow if no users exist
    if db_has_users():
        raise HTTPException(status_code=400, detail="Setup already completed")

    username = data.get("username", "").strip()
    password = data.get("password", "")

    if not username or not password:
        raise HTTPException(status_code=400, detail="Username and password required")

    if len(username) < 3:
        raise HTTPException(status_code=400, detail="Username must be at least 3 characters")

    if len(password) < 12:
        raise HTTPException(status_code=400, detail="Password must be at least 12 characters")

    # Create the first admin user
    new_user = db_create_user(username, password, is_admin=True)

    # Create JWT token for auto-login
    token = create_jwt_token(
        user_id=new_user["id"],
        username=new_user["username"],
        is_admin=True
    )

    return {
        "success": True,
        "user": new_user,
        "token": token,
        "expiresIn": JWT_EXPIRATION_HOURS * 3600
    }


# ============ Auth API ============

@router.post("/api/auth/login")
async def auth_login(data: dict, request: Request):
    """Validate user credentials and return JWT token."""
    username = data.get("username", "")
    password = data.get("password", "")

    # Get client IP for rate limiting
    client_ip = request.client.host if request.client else "unknown"
    rate_limit_key = f"{client_ip}:{username}"

    # Check rate limit
    if not check_rate_limit(rate_limit_key):
        raise HTTPException(
            status_code=429,
            detail="Too many login attempts. Please try again later."
        )

    if not username or not password:
        return {"valid": False, "error": "Username and password required"}

    user = db_validate_user(username, password)
    if user:
        # Clear rate limit on successful login
        clear_login_attempts(rate_limit_key)

        # Create JWT token with role
        token = create_jwt_token(
            user_id=user["id"],
            username=user["username"],
            is_admin=user["isAdmin"],
            role=user.get("role", "admin" if user["isAdmin"] else "editor")
        )

        return {
            "valid": True,
            "user": user,
            "token": token,
            "expiresIn": JWT_EXPIRATION_HOURS * 3600  # seconds
        }
    else:
        # Record failed attempt
        record_login_attempt(rate_limit_key)
        return {"valid": False, "error": "Invalid credentials"}


@router.post("/api/auth/refresh")
async def auth_refresh(user: dict = Depends(require_auth)):
    """Refresh JWT token for authenticated user."""
    token = create_jwt_token(
        user_id=user["id"],
        username=user["username"],
        is_admin=user["is_admin"],
        role=user.get("role", "admin" if user["is_admin"] else "editor")
    )

    return {
        "token": token,
        "expiresIn": JWT_EXPIRATION_HOURS * 3600
    }


@router.get("/api/auth/me")
async def auth_me(user: dict = Depends(require_auth)):
    """Get current authenticated user info."""
    # Fetch full user info from database to include profileImage
    full_user = db_get_user_by_id(user["id"])
    if full_user:
        user["profileImage"] = full_user.get("profileImage")
    return {
        "user": user,
        "permissions": get_role_permissions(user["role"])
    }


# ============ Admin API ============

@router.get("/api/admin/users")
async def admin_list_users(user: dict = Depends(require_admin)):
    """List all users (admin only)."""
    users = db_list_users()
    return {"users": users}


@router.post("/api/admin/users")
async def admin_create_user(data: dict, user: dict = Depends(require_admin)):
    """Create a new user (admin only)."""
    username = data.get("username")
    password = data.get("password")
    is_admin = data.get("isAdmin", False)

    if not username or not password:
        raise HTTPException(status_code=400, detail="Username and password required")

    # Check if username exists
    existing = db_get_user(username)
    if existing:
        raise HTTPException(status_code=409, detail="Username already exists")

    new_user = db_create_user(username, password, is_admin)
    return {"user": new_user}


@router.delete("/api/admin/users/{user_id}")
async def admin_delete_user(user_id: str, user: dict = Depends(require_admin)):
    """Delete a user (admin only)."""
    # Prevent self-deletion
    if user_id == user["id"]:
        raise HTTPException(status_code=400, detail="Cannot delete your own account")

    success = db_delete_user(user_id)
    if not success:
        raise HTTPException(status_code=404, detail="User not found")

    return {"success": True}


@router.patch("/api/admin/users/{user_id}")
async def admin_update_user(user_id: str, data: dict, user: dict = Depends(require_admin)):
    """Update a user's role or password (admin only).

    Body: {
        "role": "admin" | "editor" | "viewer",  // User role
        "isAdmin": true/false,                   // Legacy, synced with role
        "password": "new_password"
    }
    """
    # Handle role update
    if "role" in data:
        new_role = data["role"]
        # Prevent removing own admin status
        if user_id == user["id"] and new_role != "admin":
            raise HTTPException(status_code=400, detail="Cannot remove your own admin status")

        success = db_update_user_role(user_id, role=new_role)
        if not success:
            raise HTTPException(status_code=404, detail="User not found")

    # Handle legacy isAdmin field
    elif "isAdmin" in data:
        # Prevent removing own admin status
        if user_id == user["id"] and not data["isAdmin"]:
            raise HTTPException(status_code=400, detail="Cannot remove your own admin status")

        success = db_update_user_role(user_id, is_admin=data["isAdmin"])
        if not success:
            raise HTTPException(status_code=404, detail="User not found")

    if "password" in data:
        success = db_update_user_password(user_id, data["password"])
        if not success:
            raise HTTPException(status_code=404, detail="User not found")

    return {"success": True}


@router.get("/api/admin/roles")
async def admin_list_roles(user: dict = Depends(require_admin)):
    """List all available roles and their permissions (admin only)."""
    return {"roles": ROLES}


# ============ Invite Links API ============

@router.post("/api/admin/invites")
async def admin_create_invite(data: dict, user: dict = Depends(require_admin)):
    """Create a new invite link (admin only).

    Body: {
        "role": "admin" | "editor" | "viewer",  // User role
        "projectId": "optional_project_id",      // Link user to specific project
        "canReview": true/false,                 // For viewers: review access
        "canTasks": true/false,                  // For viewers: tasks access
        "maxUses": 1,
        "expiresInDays": 7
    }
    """
    role = data.get("role", "viewer")
    is_admin = role == "admin" or data.get("isAdmin", False)
    project_id = data.get("projectId")
    can_review = data.get("canReview", True)
    can_tasks = data.get("canTasks", False)
    max_uses = data.get("maxUses", 1)
    expires_in_days = data.get("expiresInDays")

    # Validate project exists if specified
    if project_id and project_id not in projects:
        raise HTTPException(status_code=404, detail="Project not found")

    invite = db_create_invite_link(
        created_by=user["id"],
        is_admin=is_admin,
        role=role,
        project_id=project_id,
        can_review=can_review,
        can_tasks=can_tasks,
        max_uses=max_uses,
        expires_in_days=expires_in_days
    )

    return {"invite": invite}


@router.get("/api/admin/invites")
async def admin_list_invites(user: dict = Depends(require_admin)):
    """List all invite links (admin only)."""
    invites = db_list_invite_links()
    return {"invites": invites}


@router.delete("/api/admin/invites/{invite_id}")
async def admin_delete_invite(invite_id: str, user: dict = Depends(require_admin)):
    """Delete an invite link (admin only)."""
    success = db_delete_invite_link(invite_id)
    if not success:
        raise HTTPException(status_code=404, detail="Invite link not found")
    return {"success": True}


@router.get("/api/admin/guests")
async def admin_list_guests(user: dict = Depends(require_admin)):
    """List all guests (admin only)."""
    guests = db_list_guests()
    return {"guests": guests}


@router.delete("/api/admin/guests/{guest_id}")
async def admin_delete_guest(guest_id: str, user: dict = Depends(require_admin)):
    """Delete a guest (admin only)."""
    success = db_delete_guest(guest_id)
    if not success:
        raise HTTPException(status_code=404, detail="Guest not found")
    return {"success": True}


@router.get("/api/admin/cache")
async def admin_cache_stats(user: dict = Depends(require_admin)):
    """Get cache statistics (admin only)."""
    stats = cache_manager.get_stats()
    stats["projectsInMemory"] = len(projects)
    stats["tasksInMemory"] = len(tasks)
    return stats


@router.post("/api/admin/cache/flush")
async def admin_cache_flush(user: dict = Depends(require_admin)):
    """Force flush all dirty cache data to database (admin only)."""
    await cache_manager._flush_all_dirty()
    return {"success": True, "message": "Cache flushed to database"}


@router.get("/api/invite/{invite_id}")
async def get_invite_info(invite_id: str):
    """Get invite link info (public endpoint for registration page)."""
    invite = db_get_invite_link(invite_id)
    if not invite:
        raise HTTPException(status_code=404, detail="Invite link not found")

    # Check if expired
    if invite["expiresAt"]:
        from datetime import datetime
        expires = datetime.fromisoformat(invite["expiresAt"])
        if datetime.now() > expires:
            raise HTTPException(status_code=410, detail="Invite link has expired")

    # Check if max uses reached
    if invite["maxUses"] > 0 and invite["uses"] >= invite["maxUses"]:
        raise HTTPException(status_code=410, detail="Invite link has reached maximum uses")

    # Return limited info (don't expose who created it or admin status)
    return {
        "valid": True,
        "expiresAt": invite["expiresAt"]
    }


@router.post("/api/auth/register/{invite_id}")
async def register_with_invite(invite_id: str, data: dict):
    """Register a new user with an invite link.

    The invite determines:
    - User role (admin, editor, viewer)
    - Project access (if linked to a project)
    - Access permissions (canReview, canTasks for viewers)
    """
    username = data.get("username", "").strip()
    password = data.get("password", "")

    if not username or not password:
        raise HTTPException(status_code=400, detail="Username and password required")

    if len(username) < 3:
        raise HTTPException(status_code=400, detail="Username must be at least 3 characters")

    if len(password) < 12:
        raise HTTPException(status_code=400, detail="Password must be at least 12 characters")

    # Get and validate invite link
    invite = db_get_invite_link(invite_id)
    if not invite:
        raise HTTPException(status_code=404, detail="Invite link not found")

    # Check if expired
    if invite["expiresAt"]:
        from datetime import datetime
        expires = datetime.fromisoformat(invite["expiresAt"])
        if datetime.now() > expires:
            raise HTTPException(status_code=410, detail="Invite link has expired")

    # Check if max uses reached
    if invite["maxUses"] > 0 and invite["uses"] >= invite["maxUses"]:
        raise HTTPException(status_code=410, detail="Invite link has reached maximum uses")

    # Check if username exists
    existing = db_get_user(username)
    if existing:
        raise HTTPException(status_code=409, detail="Username already exists")

    # Create the user with the role from the invite
    role = invite.get("role", "viewer")
    new_user = db_create_user(
        username=username,
        password=password,
        is_admin=invite["isAdmin"],
        role=role
    )

    # If invite is linked to a project, grant access
    if invite.get("projectId"):
        db_grant_project_access(
            user_id=new_user["id"],
            project_id=invite["projectId"],
            can_review=invite.get("canReview", True),
            can_tasks=invite.get("canTasks", False),
            is_owner=False,
            granted_by=invite.get("createdBy")
        )

    # Mark invite as used
    db_use_invite_link(invite_id)

    # Create JWT token for auto-login
    token = create_jwt_token(
        user_id=new_user["id"],
        username=new_user["username"],
        is_admin=new_user["isAdmin"],
        role=new_user.get("role", role)
    )

    return {
        "success": True,
        "user": new_user,
        "token": token,
        "expiresIn": JWT_EXPIRATION_HOURS * 3600
    }


# ============ User Profile API ============

@router.post("/api/users/me/profile-image")
async def upload_profile_image(file: UploadFile = File(...), user: dict = Depends(require_auth)):
    """Upload profile image for current user. Automatically resizes to max 256px."""
    user_id = user["id"]

    # Save original file temporarily
    temp_filename = f"temp_profile_{user_id}_{safe_upload_name(file.filename)}"
    temp_path = os.path.join(UPLOAD_DIR, temp_filename)

    with open(temp_path, "wb") as f:
        content = await file.read()
        f.write(content)

    # Process and save profile image (max 256px)
    profile_filename = f"{user_id}.jpg"
    profile_path = os.path.join(PROFILES_DIR, profile_filename)

    success = await process_image(temp_path, profile_path, max_size=256, quality=90)

    # Clean up temp file
    try:
        os.remove(temp_path)
    except OSError as e:
        print(f"Warning: Could not remove temp file {temp_path}: {e}")

    if not success:
        raise HTTPException(status_code=500, detail="Failed to process image")

    # Update user in database
    profile_url = f"/profiles/{profile_filename}"
    db_update_user_profile_image(user_id, profile_url)

    return {"profileImage": profile_url}


@router.delete("/api/users/me/profile-image")
async def delete_profile_image(user: dict = Depends(require_auth)):
    """Delete profile image for current user."""
    user_id = user["id"]

    # Delete file if exists
    profile_path = os.path.join(PROFILES_DIR, f"{user_id}.jpg")
    if os.path.exists(profile_path):
        try:
            os.remove(profile_path)
        except OSError as e:
            print(f"Warning: Could not remove profile image {profile_path}: {e}")

    # Update database
    db_update_user_profile_image(user_id, None)

    return {"success": True}


@router.get("/api/users/me")
async def get_current_user_info(user: dict = Depends(require_auth)):
    """Get current user info including profile image."""
    user_data = db_get_user_by_id(user["id"])
    if not user_data:
        raise HTTPException(status_code=404, detail="User not found")

    return {
        "user": user_data,
        "permissions": get_role_permissions(user.get("role", "guest"))
    }
