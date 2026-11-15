"""Clip summaries for the clip block in pages (PLAN.md S6): what a card needs, without the whole project.

Both endpoints need review access to the project (the same right that opens a clip in review). Anyone else
gets a plain 403 that names nothing: not the clip, not the project.
"""

from typing import Optional

from fastapi import APIRouter, Depends, HTTPException

from api.auth import require_auth, require_project_access
from api.state import projects

router = APIRouter()


def clip_summary(project_id: str, base_name: str, clip: dict, comments: list, version: Optional[int] = None) -> dict:
    """The card data of one clip. `version` picks a version; a missing or unknown one falls back to the active version."""
    versions = clip.get("versions") or []
    wanted = version if version is not None else clip.get("activeVersion")
    shown = next((v for v in versions if v.get("version") == wanted), None) or (versions[0] if versions else {})
    status = clip.get("status")
    return {
        "projectId": project_id,
        "baseName": base_name,
        "version": shown.get("version"),
        "versionStr": shown.get("versionStr"),
        "activeVersion": clip.get("activeVersion"),
        "versionCount": len(versions),
        "thumbnail": shown.get("thumbnail"),
        "mediaType": shown.get("mediaType") or "video",
        "status": {"id": status.get("id"), "name": status.get("name"), "color": status.get("color")} if status else None,
        "commentCount": sum(1 for c in comments if c.get("clipBaseName") == base_name),
    }


def _project(user: dict, project_id: str) -> dict:
    """The project's in-memory data, after checking the caller may review it (403 before 404: nothing leaks)."""
    require_project_access(user, project_id, require_review=True)
    project = projects.get(project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Not found")
    return project


@router.get("/api/projects/{project_id}/clip-summaries")
async def list_clip_summaries(project_id: str, user: dict = Depends(require_auth)):
    """Every clip of a project as card data, in the order the project keeps them. Used by the clip picker."""
    project = _project(user, project_id)
    comments = project.get("comments", [])
    clips = [clip_summary(project_id, name, clip, comments) for name, clip in (project.get("clips") or {}).items()]
    return {"clips": clips}


@router.get("/api/projects/{project_id}/clips/{base_name}/summary")
async def get_clip_summary(project_id: str, base_name: str, version: Optional[int] = None,
                           user: dict = Depends(require_auth)):
    """One clip as card data (404 when the clip no longer exists)."""
    project = _project(user, project_id)
    clip = (project.get("clips") or {}).get(base_name)
    if not clip:
        raise HTTPException(status_code=404, detail="Clip not found")
    return clip_summary(project_id, base_name, clip, project.get("comments", []), version)
