"""Clip statuses, settings and preset routes."""

from fastapi import (
    APIRouter,
    Depends,
    HTTPException,
)
from database import (
    db_apply_status_preset_to_project,
    db_create_priority_preset,
    db_create_stage_preset,
    db_create_status,
    db_create_status_preset,
    db_delete_priority_preset,
    db_delete_setting,
    db_delete_stage_preset,
    db_delete_status,
    db_delete_status_preset,
    db_get_effective_setting,
    db_get_priority_preset,
    db_get_setting,
    db_get_stage_preset,
    db_get_status_preset,
    db_list_priority_presets,
    db_list_settings,
    db_list_stage_presets,
    db_list_status_presets,
    db_list_statuses,
    db_set_setting,
    db_update_priority_preset,
    db_update_stage_preset,
    db_update_status,
    db_update_status_preset,
)
from api.auth import require_auth


router = APIRouter()


# ============ Clip Statuses API ============

@router.get("/api/statuses")
async def list_statuses():
    """List all clip statuses."""
    statuses = db_list_statuses()
    return {"statuses": statuses}


@router.post("/api/statuses")
async def create_status(data: dict, user: dict = Depends(require_auth)):
    """Create a new clip status (requires authentication)."""
    name = data.get("name")
    color = data.get("color", "#6366f1")

    if not name:
        raise HTTPException(status_code=400, detail="Status name is required")

    status = db_create_status(name, color)
    return {"status": status}


@router.patch("/api/statuses/{status_id}")
async def update_status(status_id: str, data: dict, user: dict = Depends(require_auth)):
    """Update a clip status (requires authentication)."""
    name = data.get("name")
    color = data.get("color")

    success = db_update_status(status_id, name=name, color=color)
    if not success:
        raise HTTPException(status_code=404, detail="Status not found")

    return {"success": True}


@router.delete("/api/statuses/{status_id}")
async def delete_status(status_id: str, user: dict = Depends(require_auth)):
    """Delete a clip status (requires authentication)."""
    success = db_delete_status(status_id)
    if not success:
        raise HTTPException(status_code=404, detail="Status not found")

    return {"success": True}


# ============ Settings API ============

@router.get("/api/settings")
async def get_settings(scope: str = "global", scope_id: str = None, user: dict = Depends(require_auth)):
    """Get all settings for a scope."""
    return db_list_settings(scope, scope_id)


@router.get("/api/settings/{key}")
async def get_setting(key: str, scope: str = "global", scope_id: str = None, user: dict = Depends(require_auth)):
    """Get a specific setting value."""
    value = db_get_setting(key, scope, scope_id)
    return {"key": key, "value": value, "scope": scope, "scopeId": scope_id}


@router.get("/api/settings/effective/{key}")
async def get_effective_setting(key: str, project_id: str = None, user: dict = Depends(require_auth)):
    """Get effective setting with project -> global fallback."""
    value = db_get_effective_setting(key, project_id)
    return {"key": key, "value": value, "projectId": project_id}


@router.put("/api/settings/{key}")
async def set_setting(key: str, data: dict, user: dict = Depends(require_auth)):
    """Set a setting value."""
    scope = data.get("scope", "global")
    scope_id = data.get("scopeId")
    value = data.get("value")

    result = db_set_setting(key, value, scope, scope_id)
    return result


@router.delete("/api/settings/{key}")
async def delete_setting(key: str, scope: str = "global", scope_id: str = None, user: dict = Depends(require_auth)):
    """Delete a setting."""
    success = db_delete_setting(key, scope, scope_id)
    return {"success": success}


# ============ Priority Presets API ============

@router.get("/api/priority-presets")
async def list_priority_presets(user: dict = Depends(require_auth)):
    """List all priority presets."""
    return db_list_priority_presets()


@router.get("/api/priority-presets/{preset_id}")
async def get_priority_preset(preset_id: str, user: dict = Depends(require_auth)):
    """Get a priority preset by ID."""
    preset = db_get_priority_preset(preset_id)
    if not preset:
        raise HTTPException(status_code=404, detail="Preset not found")
    return preset


@router.post("/api/priority-presets")
async def create_priority_preset(data: dict, user: dict = Depends(require_auth)):
    """Create a custom priority preset."""
    name = data.get("name")
    options = data.get("options", [])

    if not name:
        raise HTTPException(status_code=400, detail="Name is required")
    if not options:
        raise HTTPException(status_code=400, detail="At least one option is required")

    preset = db_create_priority_preset(name, options, user.get("id"))
    return preset


@router.patch("/api/priority-presets/{preset_id}")
async def update_priority_preset(preset_id: str, data: dict, user: dict = Depends(require_auth)):
    """Update a priority preset."""
    name = data.get("name")
    options = data.get("options")

    try:
        preset = db_update_priority_preset(preset_id, name, options)
        if not preset:
            raise HTTPException(status_code=404, detail="Preset not found")
        return preset
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.delete("/api/priority-presets/{preset_id}")
async def delete_priority_preset(preset_id: str, user: dict = Depends(require_auth)):
    """Delete a priority preset."""
    try:
        success = db_delete_priority_preset(preset_id)
        if not success:
            raise HTTPException(status_code=404, detail="Preset not found")
        return {"success": True}
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


# ============ Status Presets API ============

@router.get("/api/status-presets")
async def list_status_presets(user: dict = Depends(require_auth)):
    """List all status presets."""
    return db_list_status_presets()


@router.get("/api/status-presets/{preset_id}")
async def get_status_preset(preset_id: str, user: dict = Depends(require_auth)):
    """Get a status preset by ID."""
    preset = db_get_status_preset(preset_id)
    if not preset:
        raise HTTPException(status_code=404, detail="Preset not found")
    return preset


@router.post("/api/status-presets")
async def create_status_preset(data: dict, user: dict = Depends(require_auth)):
    """Create a custom status preset."""
    name = data.get("name")
    statuses = data.get("statuses", [])

    if not name:
        raise HTTPException(status_code=400, detail="Name is required")
    if not statuses:
        raise HTTPException(status_code=400, detail="At least one status is required")

    preset = db_create_status_preset(name, statuses, user.get("id"))
    return preset


@router.patch("/api/status-presets/{preset_id}")
async def update_status_preset(preset_id: str, data: dict, user: dict = Depends(require_auth)):
    """Update a status preset."""
    name = data.get("name")
    statuses = data.get("statuses")

    try:
        preset = db_update_status_preset(preset_id, name, statuses)
        if not preset:
            raise HTTPException(status_code=404, detail="Preset not found")
        return preset
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.delete("/api/status-presets/{preset_id}")
async def delete_status_preset(preset_id: str, user: dict = Depends(require_auth)):
    """Delete a status preset."""
    try:
        success = db_delete_status_preset(preset_id)
        if not success:
            raise HTTPException(status_code=404, detail="Preset not found")
        return {"success": True}
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.post("/api/status-presets/{preset_id}/apply")
async def apply_status_preset(preset_id: str, data: dict = None, user: dict = Depends(require_auth)):
    """Apply a status preset - creates actual statuses from the preset template."""
    project_id = data.get("projectId") if data else None

    try:
        statuses = db_apply_status_preset_to_project(preset_id, project_id)
        return {"success": True, "statuses": statuses}
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


# ============ Stage Presets API ============

@router.get("/api/stage-presets")
async def list_stage_presets(user: dict = Depends(require_auth)):
    """List all stage presets."""
    return db_list_stage_presets()


@router.get("/api/stage-presets/{preset_id}")
async def get_stage_preset(preset_id: str, user: dict = Depends(require_auth)):
    """Get a stage preset by ID."""
    preset = db_get_stage_preset(preset_id)
    if not preset:
        raise HTTPException(status_code=404, detail="Preset not found")
    return preset


@router.post("/api/stage-presets")
async def create_stage_preset(data: dict, user: dict = Depends(require_auth)):
    """Create a custom stage preset."""
    name = data.get("name")
    stages = data.get("stages", [])

    if not name:
        raise HTTPException(status_code=400, detail="Name is required")
    if not stages:
        raise HTTPException(status_code=400, detail="At least one stage is required")

    preset = db_create_stage_preset(name, stages, user.get("id"))
    return preset


@router.patch("/api/stage-presets/{preset_id}")
async def update_stage_preset(preset_id: str, data: dict, user: dict = Depends(require_auth)):
    """Update a stage preset."""
    name = data.get("name")
    stages = data.get("stages")

    try:
        preset = db_update_stage_preset(preset_id, name, stages)
        if not preset:
            raise HTTPException(status_code=404, detail="Preset not found")
        return preset
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.delete("/api/stage-presets/{preset_id}")
async def delete_stage_preset(preset_id: str, user: dict = Depends(require_auth)):
    """Delete a stage preset."""
    try:
        success = db_delete_stage_preset(preset_id)
        if not success:
            raise HTTPException(status_code=404, detail="Preset not found")
        return {"success": True}
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
