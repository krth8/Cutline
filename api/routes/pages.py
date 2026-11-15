"""Page routes (PLAN.md 5.7, REST part): the page tree of a space, one page, import claim, task pages."""

import math

from fastapi import APIRouter, Depends, HTTPException

from api.auth import can_access_space, can_edit_page, can_read_page, require_auth
from api.events import live
from api.pagesync import close_rooms_without_access, close_unavailable_rooms
from api.routes.page_files import delete_files_of_page_tree
from api.state import projects, tasks
from database import db_check_project_access, db_list_users
from database.access import db_list_project_access
from database.pages import (
    db_claim_page_import,
    db_create_page,
    db_delete_page,
    db_get_or_create_task_page,
    db_get_page,
    db_list_pages,
    db_move_page,
    db_page_has_content,
    db_set_archived,
    db_subtree_ids,
    db_subtree_summary,
    db_update_page,
    parse_space,
    space_of,
)

router = APIRouter()

MAX_TITLE = 300
MAX_ICON = 64


# ============ Helpers ============

def _space(space: str, user: dict, write: bool = False):
    """Validate a space string and the caller's rights on it. Returns (space_type, project_id)."""
    try:
        space_type, project_id = parse_space(space)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    if project_id is not None and project_id not in projects:
        raise HTTPException(status_code=404, detail="Project not found")
    if not can_access_space(user, space, write=write):
        raise HTTPException(status_code=403, detail="Access denied")
    return space_type, project_id


def _load(page_id: str, user: dict, write: bool = False) -> dict:
    page = db_get_page(page_id)
    if not page:
        raise HTTPException(status_code=404, detail="Page not found")
    if not can_read_page(user, page) or (write and not can_edit_page(user, page)):
        raise HTTPException(status_code=403, detail="Access denied")
    return page


def _needs_import(page: dict) -> bool:
    """Legacy HTML waiting and no content yet (neither a snapshot nor pending sync updates)."""
    return bool(page["legacyHtml"]) and not page["hasContent"] and not db_page_has_content(page["id"])


def _body(page: dict, user: dict) -> dict:
    needs_import = _needs_import(page)
    body = {
        "id": page["id"],
        "title": page["title"],
        "icon": page["icon"],
        "kind": page["kind"],
        "system": page["system"],
        "space": space_of(page),
        "parentId": page["parentId"],
        "sortOrder": page["sortOrder"],
        "canEdit": can_edit_page(user, page),
        "needsImport": needs_import,
        "archived": page["archivedAt"] is not None,
    }
    if page["kind"] == "task":
        body["taskId"] = page["taskId"]
    if needs_import:
        body["legacyHtml"] = page["legacyHtml"]
    return body


async def _notify(page: dict, change: str, **extra) -> None:
    """Tell the people who can see the page: project pages go to the project's tabs,
    personal pages to the owner's tabs. Task pages send no events."""
    if page["kind"] == "task":
        return
    message = {"type": "page_changed", "pageId": page["id"], "change": change, **extra}
    if page["spaceType"] == "project":
        await live.to_project(page["projectId"], message)
    else:
        await live.to_user(page["ownerId"], message)


def _clean_title(value) -> str:
    if not isinstance(value, str):
        raise HTTPException(status_code=400, detail="title must be a string")
    return value.strip()[:MAX_TITLE] or "Untitled"


def _clean_icon(value):
    if value is None:
        return None
    if not isinstance(value, str):
        raise HTTPException(status_code=400, detail="icon must be a string or null")
    return value.strip()[:MAX_ICON] or None


def _clean_parent(value):
    if value is None or value == "":
        return None
    if not isinstance(value, str):
        raise HTTPException(status_code=400, detail="parentId must be a string or null")
    return value


# ============ Space tree ============

@router.get("/api/spaces/{space}/pages")
async def list_pages(space: str, archived: int = 0, user: dict = Depends(require_auth)):
    """The pages of a space as a flat list ordered by sortOrder (the client builds the tree).
    ?archived=1 lists the archived pages instead. Task pages are never listed."""
    space_type, project_id = _space(space, user)
    rows = db_list_pages(space_type, project_id=project_id, owner_id=user["id"] if space_type == "personal" else None,
                         archived=bool(archived))
    rows = [r for r in rows if r["kind"] != "task"]  # task pages are reached through their task only
    return [{"id": r["id"], "parentId": r["parentId"], "title": r["title"], "icon": r["icon"],
             "sortOrder": r["sortOrder"], "kind": r["kind"], "system": r["system"]} for r in rows]


@router.post("/api/spaces/{space}/pages")
async def create_page(space: str, data: dict, user: dict = Depends(require_auth)):
    """Create a page at the end of its siblings. Body: {title?, parentId?, template?}."""
    space_type, project_id = _space(space, user, write=True)
    title = _clean_title(data["title"]) if data.get("title") is not None else "Untitled"
    parent_id = _clean_parent(data.get("parentId"))
    try:
        page = db_create_page(space_type, project_id, user["id"] if space_type == "personal" else None,
                              user["id"], title=title, parent_id=parent_id)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    await _notify(page, "created")
    return _body(page, user)


# ============ One page ============

@router.get("/api/pages/{page_id}")
async def get_page(page_id: str, user: dict = Depends(require_auth)):
    return _body(_load(page_id, user), user)


@router.patch("/api/pages/{page_id}")
async def update_page(page_id: str, data: dict, user: dict = Depends(require_auth)):
    """Change title, icon, parentId, sortOrder and/or archived (archiving covers the sub-pages)."""
    page = _load(page_id, user, write=True)

    fields = {}
    if "title" in data:
        fields["title"] = _clean_title(data["title"])
    if "icon" in data:
        fields["icon"] = _clean_icon(data["icon"])
    if "parentId" in data:
        fields["parent_id"] = _clean_parent(data["parentId"])
    if "sortOrder" in data:
        order = data["sortOrder"]
        if isinstance(order, bool) or not isinstance(order, (int, float)) or not math.isfinite(order):
            raise HTTPException(status_code=400, detail="sortOrder must be a number")
        fields["sort_order"] = float(order)
    archived = data.get("archived") if "archived" in data else None
    if "archived" in data and not isinstance(archived, bool):
        raise HTTPException(status_code=400, detail="archived must be true or false")

    changes = []
    try:
        if fields:
            page = db_update_page(page_id, **fields)
            if "title" in fields or "icon" in fields:
                changes.append("renamed")
            if "parent_id" in fields or "sort_order" in fields:
                changes.append("moved")
        if archived is not None and archived != (page["archivedAt"] is not None):
            page = db_set_archived(page_id, archived)
            changes.append("archived" if archived else "restored")
            if archived:
                await close_unavailable_rooms()
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))

    for change in changes:
        await _notify(page, change)
    return _body(page, user)


# ============ Moving between spaces ============

def _readers(space_type: str, project_id, owner_id) -> dict:
    """{user id: username} of the people who can read pages of a space: the owner of a personal space,
    or everyone with access to the project (members and admins)."""
    if space_type == "personal":
        users = {u["id"]: u["username"] for u in db_list_users()}
        return {owner_id: users.get(owner_id, "")}
    readers = {a["userId"]: a["username"] for a in db_list_project_access(project_id)}
    readers.update({u["id"]: u["username"] for u in db_list_users() if u["role"] == "admin"})
    return readers


def _destination(data: dict, user: dict):
    """Validate {space, parentId?} of a move: the caller may create pages there. Returns (space_type, project_id, parent_id)."""
    space = data.get("space")
    if not isinstance(space, str):
        raise HTTPException(status_code=400, detail="space is required")
    space_type, project_id = _space(space, user, write=True)
    return space_type, project_id, _clean_parent(data.get("parentId"))


def _owner_for(space_type: str, user: dict):
    return user["id"] if space_type == "personal" else None


@router.get("/api/pages/{page_id}/move-preview")
async def move_preview(page_id: str, space: str, user: dict = Depends(require_auth)):
    """What moving the page to `space` ('me' or 'p:<id>') changes: how many sub-pages move, who gains and who
    loses access (the caller never counts), and views whose rows some readers of the new space cannot see."""
    page = _load(page_id, user, write=True)
    if page["kind"] == "task":
        raise HTTPException(status_code=400, detail="A task page cannot be moved")
    if page["system"]:
        raise HTTPException(status_code=400, detail="The Tasks page cannot be moved to another space")
    space_type, project_id, _parent = _destination({"space": space}, user)
    before = _readers(page["spaceType"], page["projectId"], page["ownerId"])
    after = _readers(space_type, project_id, user["id"])
    summary = db_subtree_summary(page_id)

    def people(ids):
        names = sorted(after.get(i) or before.get(i) or "" for i in ids)
        return {"count": len(names), "names": names[:10]}

    gain = [i for i in after if i not in before and i != user["id"]]
    lose = [i for i in before if i not in after and i != user["id"]]
    limited = []
    for table_ref, count in summary["views"].items():
        if not table_ref.startswith("tasks:") or table_ref == "tasks:*":
            continue
        table_project = table_ref.split(":", 1)[1]
        without = [i for i in after if i != user["id"] and not db_check_project_access(i, table_project, require_tasks=True)]
        if without and table_project in projects:
            limited.append({"projectId": table_project, "projectName": projects[table_project].get("name", ""),
                            "viewCount": count, "readersWithoutAccess": len(without)})
    return {
        "from": space_of(page),
        "to": space,
        "subPages": summary["subPages"],
        "gain": people(gain),
        "lose": people(lose),
        "limitedViews": limited,
    }


@router.post("/api/pages/{page_id}/move")
async def move_page(page_id: str, data: dict, user: dict = Depends(require_auth)):
    """Move a page and its sub-pages to another space. Body: {space: 'me' | 'p:<projectId>', parentId?}.
    The caller must be able to edit the page where it is and to create pages in the new space; the page lands
    at the end of the top level (or of parentId's children). A project page moved to 'me' becomes the caller's.
    Connected editors who lose access are disconnected; both spaces get a page_changed event."""
    page = _load(page_id, user, write=True)
    space_type, project_id, parent_id = _destination(data, user)
    subtree = db_subtree_ids(page_id)
    try:
        moved = db_move_page(page_id, space_type, project_id, _owner_for(space_type, user), parent_id)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    if moved is None:
        raise HTTPException(status_code=404, detail="Page not found")
    await close_rooms_without_access(subtree)
    event_ids = subtree[:500]
    for where in (page, moved):
        await _notify(where, "moved", pageIds=event_ids)
    return _body(moved, user)


@router.delete("/api/pages/{page_id}")
async def delete_page(page_id: str, user: dict = Depends(require_auth)):
    """Delete an archived page and its sub-pages for good."""
    page = _load(page_id, user, write=True)
    if page["archivedAt"] is None:
        raise HTTPException(status_code=409, detail="Archive the page before deleting it")
    if page["system"]:
        raise HTTPException(status_code=400, detail="The Tasks page cannot be deleted")
    delete_files_of_page_tree(page_id)
    db_delete_page(page_id)
    await close_unavailable_rooms()
    await _notify(page, "deleted")
    return {"success": True}


@router.post("/api/pages/{page_id}/claim-import")
async def claim_import(page_id: str, user: dict = Depends(require_auth)):
    """Ask to do the one-time import of the page's legacy HTML. Exactly one caller ever gets granted: true."""
    _load(page_id, user, write=True)
    return {"granted": db_claim_page_import(page_id, user["id"])}


# ============ Task pages ============

@router.get("/api/tasks/{task_id}/page")
async def get_task_page(task_id: str, user: dict = Depends(require_auth)):
    """The page of a task (created on the first call), in the task's project."""
    task = tasks.get(task_id)
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")
    if not db_check_project_access(user["id"], task["projectId"], require_tasks=True):
        raise HTTPException(status_code=403, detail="Task access denied for this project")
    existing = db_get_or_create_task_page(task_id, task["projectId"], task.get("name"), user["id"])
    return _body(existing, user)
