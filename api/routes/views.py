"""View routes (PLAN.md 5.6): a view is a saved layout + query config on one table.

Who may do what:
- a view that belongs to a page follows the page (``can_read_page`` / ``can_edit_page``);
- a view on ``tasks:<projectId>`` without a page: read with any access to the project,
  create / change / delete with ``can_edit_tasks``;
- a view on ``tasks:*`` without a page is private to its creator (admins may touch it too);
- a view on a custom table (``tbl_<id>``) without a page follows the table: read with the right to read
  its rows, change with the right to edit them (a personal table: the owner only). A view that belongs to a
  page follows the page, but cannot be created on a table the caller may not read.
Share-link guests get 403 everywhere (``require_auth``).
"""

import json

from typing import Optional

from fastapi import APIRouter, Depends, HTTPException

from api.auth import (
    can_edit_custom_rows,
    can_edit_page,
    can_edit_tasks,
    can_read_custom_table,
    can_read_page,
    require_auth,
)
from api.events import current_client_id, live
from api.state import projects
from api.tables.custom_source import load_table
from api.tables.source import resolve_source
from database import db_check_project_access
from database.custom_tables import db_get_custom_table
from database.pages import db_get_page
from database.views import db_create_view, db_delete_view, db_get_view, db_list_views, db_update_view

router = APIRouter()

LAYOUTS = ("table", "board", "list", "calendar", "gantt")
MAX_NAME = 200
MAX_CONFIG_BYTES = 64 * 1024


# ============ Helpers ============

def _project_of(table_ref: str):
    """'tasks:<projectId>' -> project id; 'tasks:*' (and anything else) -> None."""
    if table_ref.startswith("tasks:") and table_ref != "tasks:*":
        return table_ref.split(":", 1)[1]
    return None


def _custom_table(table_ref: str):
    """The custom table a ref names, or None (tasks refs, and tables that no longer exist)."""
    return db_get_custom_table(table_ref) if table_ref.startswith("tbl_") else None


def _may(user: dict, view: dict, write: bool) -> bool:
    page = db_get_page(view["ownerPageId"]) if view.get("ownerPageId") else None
    if page:
        return can_edit_page(user, page) if write else can_read_page(user, page)
    table = _custom_table(view["tableRef"])
    if table:
        return can_edit_custom_rows(user, table) if write else can_read_custom_table(user, table)
    project_id = _project_of(view["tableRef"])
    if project_id:
        return can_edit_tasks(user, project_id) if write else db_check_project_access(user["id"], project_id)
    return view["createdBy"] == user["id"] or bool(user.get("is_admin"))


def _load(view_id: str, user: dict, write: bool = False) -> dict:
    view = db_get_view(view_id)
    if not view:
        raise HTTPException(status_code=404, detail="View not found")
    if not _may(user, view, write):
        raise HTTPException(status_code=403, detail="Access denied")
    return view


def _body(view: dict, user: dict) -> dict:
    return {
        "id": view["id"],
        "tableRef": view["tableRef"],
        "name": view["name"],
        "layout": view["layout"],
        "config": view["config"],
        "ownerPageId": view["ownerPageId"],
        "canEdit": _may(user, view, True),
    }


def _clean_name(value) -> str:
    if not isinstance(value, str):
        raise HTTPException(status_code=400, detail="name must be a string")
    return value.strip()[:MAX_NAME] or "Untitled view"


def _clean_layout(value) -> str:
    if value not in LAYOUTS:
        raise HTTPException(status_code=400, detail=f"layout must be one of {', '.join(LAYOUTS)}")
    return value


def _clean_config(value) -> dict:
    if not isinstance(value, dict):
        raise HTTPException(status_code=400, detail="config must be an object")
    if "query" in value and not isinstance(value["query"], dict):
        raise HTTPException(status_code=400, detail="config.query must be an object")
    if len(json.dumps(value)) > MAX_CONFIG_BYTES:
        raise HTTPException(status_code=400, detail="config is too large")
    return value


async def _notify(view: dict) -> None:
    """Tell the other tabs that can see the view (never the tab that made the change)."""
    message = {"type": "view_changed", "viewId": view["id"]}
    page = db_get_page(view["ownerPageId"]) if view.get("ownerPageId") else None
    if page and page["spaceType"] == "project":
        await live.to_project(page["projectId"], message)
        return
    table = None if page else _custom_table(view["tableRef"])
    if table and table["spaceType"] == "project":
        await live.to_project(table["projectId"], message)
        return
    project_id = _project_of(view["tableRef"]) if not page else None
    if project_id:
        await live.to_project(project_id, message)
        return
    # Personal page, personal table or tasks:*: only the owner's other tabs
    owner = page["ownerId"] if page else table["ownerId"] if table else view["createdBy"]
    origin = current_client_id.get()
    for conn in list(live.connections.values()):
        if conn.principal["id"] == owner and not (origin and conn.client_id == origin):
            await live._send(conn, message)


# ============ Endpoints ============

@router.get("/api/views")
async def list_views(tableRef: Optional[str] = None, ownerPageId: Optional[str] = None,
                     user: dict = Depends(require_auth)):
    """Views the caller can open, newest change first: ``{"views": [{id, tableRef, name, layout, ownerPageId, canEdit}]}``.

    Optional filters: ``tableRef`` and ``ownerPageId``. A view is listed only when the caller may read it
    and may read the rows of its table (task access on the project), so the list never shows a view
    that would open to an error.
    """
    out = []
    for view in db_list_views(tableRef, ownerPageId):
        if not _may(user, view, False):
            continue
        project_id = _project_of(view["tableRef"])
        if project_id and not db_check_project_access(user["id"], project_id, require_tasks=True):
            continue
        table = _custom_table(view["tableRef"])
        if view["tableRef"].startswith("tbl_") and not (table and can_read_custom_table(user, table)):
            continue
        out.append({
            "id": view["id"], "tableRef": view["tableRef"], "name": view["name"], "layout": view["layout"],
            "ownerPageId": view["ownerPageId"], "canEdit": _may(user, view, True),
        })
    return {"views": out}


@router.get("/api/views/{view_id}")
async def get_view(view_id: str, user: dict = Depends(require_auth)):
    return _body(_load(view_id, user), user)


@router.post("/api/views")
async def create_view(data: dict, user: dict = Depends(require_auth)):
    """Body: {tableRef, name?, layout, config?, ownerPageId?}."""
    table_ref = data.get("tableRef")
    if not isinstance(table_ref, str):
        raise HTTPException(status_code=400, detail="tableRef is required")
    resolve_source(table_ref)  # unknown refs: 404
    if table_ref.startswith("tbl_"):
        load_table(user, table_ref)  # 404 / 403 unless the caller may read the table
    project_id = _project_of(table_ref)
    if project_id and project_id not in projects:
        raise HTTPException(status_code=404, detail="Project not found")
    name = _clean_name(data.get("name", "Untitled view"))
    layout = _clean_layout(data.get("layout", "table"))
    config = _clean_config(data.get("config", {"query": {}}))

    owner_page_id = data.get("ownerPageId")
    candidate = {"tableRef": table_ref, "ownerPageId": None, "createdBy": user["id"]}
    if owner_page_id is not None:
        if not isinstance(owner_page_id, str) or not db_get_page(owner_page_id):
            raise HTTPException(status_code=404, detail="Page not found")
        candidate["ownerPageId"] = owner_page_id
    if not _may(user, candidate, True):
        raise HTTPException(status_code=403, detail="Access denied")

    view = db_create_view(table_ref, name, layout, config, owner_page_id, user["id"])
    await _notify(view)
    return _body(view, user)


@router.patch("/api/views/{view_id}")
async def update_view(view_id: str, data: dict, user: dict = Depends(require_auth)):
    """Change name, layout and/or config. Each key of ``config`` given replaces that key of the stored config."""
    view = _load(view_id, user, write=True)
    name = _clean_name(data["name"]) if "name" in data else None
    layout = _clean_layout(data["layout"]) if "layout" in data else None
    config = None
    if "config" in data:
        config = _clean_config({**view["config"], **_clean_config(data["config"])})
    view = db_update_view(view_id, name=name, layout=layout, config=config)
    await _notify(view)
    return _body(view, user)


@router.delete("/api/views/{view_id}")
async def delete_view(view_id: str, user: dict = Depends(require_auth)):
    view = _load(view_id, user, write=True)
    db_delete_view(view_id)
    await _notify(view)
    return {"success": True}
