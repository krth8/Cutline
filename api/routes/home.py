"""Home (S4): which personal page a user opens as Home, the "My dashboard" template, and the recent-pages list.

GET  /api/home           -> {pageId: string | null}   the Home page (null when none is set); never creates anything
POST /api/home/open      -> {pageId, created}         the Home page; makes "My dashboard" the first time
PUT  /api/home {pageId}  -> {pageId}                  one of the caller's own live personal pages becomes Home
GET  /api/pages/recent   -> {pages: [...]}            pages the caller can read, most recently changed first

Share-link guests are refused everywhere (require_auth).
"""

from fastapi import APIRouter, Depends, HTTPException

from api.auth import can_access_space, require_auth
from api.events import live
from api.home_template import create_dashboard
from api.state import projects
from database.access import db_list_accessible_projects
from database.pages import (
    db_get_home_page_id,
    db_get_page,
    db_recent_pages,
    db_set_home_page_id,
    parse_space,
    space_of,
)

router = APIRouter()

MAX_RECENT = 50
DEFAULT_RECENT = 8


@router.get("/api/home")
async def get_home(user: dict = Depends(require_auth)):
    return {"pageId": db_get_home_page_id(user["id"])}


@router.post("/api/home/open")
async def open_home(user: dict = Depends(require_auth)):
    """The Home page. A user without one (new, or the old one was archived or deleted) gets a fresh
    "My dashboard", which becomes their Home."""
    page_id = db_get_home_page_id(user["id"])
    if page_id:
        return {"pageId": page_id, "created": False}
    page = create_dashboard(user)
    db_set_home_page_id(user["id"], page["id"])
    # The page tree of the sidebar may already be on screen (the landing page is the Projects grid)
    await live.to_user(user["id"], {"type": "page_changed", "pageId": page["id"], "change": "created"})
    return {"pageId": page["id"], "created": True}


@router.put("/api/home")
async def set_home(data: dict, user: dict = Depends(require_auth)):
    page_id = data.get("pageId")
    if not isinstance(page_id, str) or not page_id:
        raise HTTPException(status_code=400, detail="pageId is required")
    page = db_get_page(page_id)
    if not page or page["spaceType"] != "personal" or page["ownerId"] != user["id"]:
        # Someone else's page looks the same as a missing one
        raise HTTPException(status_code=404, detail="Page not found")
    if page["archivedAt"] is not None or page["kind"] != "page":
        raise HTTPException(status_code=400, detail="Only a live personal page can be Home")
    db_set_home_page_id(user["id"], page_id)
    return {"pageId": page_id}


@router.get("/api/pages/recent")
async def recent_pages(scope: str = "all", limit: int = DEFAULT_RECENT, user: dict = Depends(require_auth)):
    """Pages the caller can read, most recently changed first. scope: 'me' (own personal pages),
    'p:<projectId>' (one project) or 'all' (both). Archived pages, task pages and other people's
    personal pages never appear."""
    limit = max(1, min(MAX_RECENT, limit))
    if scope == "all":
        project_ids = [p["id"] for p in db_list_accessible_projects(user["id"])
                       if p["id"] in projects and p.get("canTasks", True)]  # pages are part of the Main tab
        rows = db_recent_pages("all", project_ids, user["id"], limit)
    else:
        try:
            space_type, project_id = parse_space(scope)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc))
        if project_id is not None and project_id not in projects:
            raise HTTPException(status_code=404, detail="Project not found")
        if not can_access_space(user, scope):
            raise HTTPException(status_code=403, detail="Access denied")
        rows = db_recent_pages(space_type, [project_id] if project_id else [], user["id"], limit)
    return {"pages": [{
        "id": r["id"], "title": r["title"], "icon": r["icon"], "space": space_of(r), "updatedAt": r["updatedAt"],
        "projectName": projects.get(r["projectId"], {}).get("name") if r["projectId"] else None,
    } for r in rows]}
