"""Duplicating pages, page templates and copying a project's setup (PLAN.md H4).

    POST   /api/pages/{id}/duplicate            deep copy of a page (and its sub-pages)
    GET    /api/templates                       built-in templates and the ones the caller may use
    POST   /api/templates                       save a page as a template (frozen copy)
    DELETE /api/templates/{id}
    POST   /api/templates/{id}/use              create pages from a template
    POST   /api/projects/{id}/copy-setup        copy pages, task columns, custom tables and Tasks views of another project

The copying itself lives in api/pageclone.py (rules for what is re-pointed) and api/builtin_templates.py.
"""

from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException

from api import builtin_templates
from api.auth import can_edit_custom_schema, require_auth
from api.pageclone import build_bundle, delete_template_files, freeze_bundle, instantiate, relation_target_for_copy, table_bundle
from api.routes.pages import MAX_TITLE, _body, _clean_parent, _clean_title, _load, _notify, _space
from api.state import projects
from database import db_check_project_access
from database.custom_tables import db_list_custom_tables
from database.pages import db_get_page, db_list_pages, sort_between, space_of
from database.table_columns import db_create_table_column, db_list_table_columns
from database.templates import (
    db_add_template,
    db_delete_template,
    db_get_template,
    db_list_templates_for,
    new_template_id,
)

router = APIRouter()

MAX_NAME = 100
MAX_DESCRIPTION = 500
EVENT_IDS = 500


def _clean_text(value, limit: int, what: str, required: bool = False) -> str:
    if value is None and not required:
        return ""
    if not isinstance(value, str):
        raise HTTPException(status_code=400, detail=f"{what} must be a string")
    text = value.strip()[:limit]
    if required and not text:
        raise HTTPException(status_code=400, detail=f"{what} is required")
    return text


def _is_admin(user: dict) -> bool:
    return bool(user.get("is_admin")) or user.get("role") == "admin"


async def _announce(root: dict, page_ids: List[str]) -> None:
    await _notify(root, "created", pageIds=page_ids[:EVENT_IDS])


def _created(root_id: str, page_ids: List[str], user: dict) -> dict:
    return {**_body(db_get_page(root_id), user), "pageIds": page_ids}


# ============ Duplicate ============

def _next_to(page: dict) -> float:
    """A sort order that puts a copy right after ``page`` among its siblings."""
    siblings = [r for r in db_list_pages(page["spaceType"], page["projectId"], page["ownerId"])
                if r["parentId"] == page["parentId"]]
    later = [r["sortOrder"] for r in siblings if r["sortOrder"] > page["sortOrder"]]
    return sort_between(page["sortOrder"], min(later) if later else None)


@router.post("/api/pages/{page_id}/duplicate")
async def duplicate_page(page_id: str, data: Optional[dict] = None, user: dict = Depends(require_auth)):
    """Copy a page and (by default) its sub-pages. Body: {space?, parentId?, withSubpages?: true, title?}.

    Without space and parentId the copy lands right after the original. The caller needs to read the source
    and to create pages in the destination space. Returns the copy's root page plus `pageIds` (every new page)."""
    data = data or {}
    source = _load(page_id, user)
    if source["kind"] == "task":
        raise HTTPException(status_code=400, detail="A task page cannot be duplicated")
    if source["archivedAt"]:
        raise HTTPException(status_code=400, detail="Restore the page before duplicating it")
    space = data.get("space") if data.get("space") is not None else space_of(source)
    space_type, project_id = _space(space, user, write=True)
    same_space = space == space_of(source)
    parent_id = _clean_parent(data.get("parentId")) if "parentId" in data else (source["parentId"] if same_space else None)
    with_subpages = data.get("withSubpages", True)
    if not isinstance(with_subpages, bool):
        raise HTTPException(status_code=400, detail="withSubpages must be true or false")
    title = _clean_title(data["title"]) if data.get("title") is not None \
        else f"{source['title'] or 'Untitled'} (copy)"[:MAX_TITLE]
    next_to_source = same_space and parent_id == source["parentId"]
    try:
        bundle = await build_bundle([page_id], with_subpages)
        made = instantiate(bundle, user, space_type, project_id, parent_id, title=title,
                           sort_order=_next_to(source) if next_to_source else None)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    root = db_get_page(made["rootIds"][0])
    await _announce(root, made["pageIds"])
    return _created(root["id"], made["pageIds"], user)


# ============ Templates ============

def _builtin_summary(t: dict) -> dict:
    return {"id": t["id"], "name": t["name"], "description": t["description"], "scope": "builtin", "icon": t["icon"],
            "pageCount": 1, "canDelete": False, "ownerId": None}


def _summary(t: dict, user: dict) -> dict:
    return {"id": t["id"], "name": t["name"], "description": t["description"], "scope": t["scope"], "icon": None,
            "pageCount": t["pageCount"], "ownerId": t["ownerId"], "createdAt": t["createdAt"],
            "canDelete": _may_delete(t, user)}


def _may_delete(template: dict, user: dict) -> bool:
    if template["scope"] == "workspace":
        return _is_admin(user)
    return template["ownerId"] == user["id"]


def _may_use(template: dict, user: dict) -> bool:
    return template["scope"] == "workspace" or template["ownerId"] == user["id"]


@router.get("/api/templates")
async def list_templates(user: dict = Depends(require_auth)):
    """The built-in templates, then the workspace templates and the caller's own, newest first:
    {"templates": [{id, name, description, scope: 'builtin'|'personal'|'workspace', icon, pageCount, canDelete}]}."""
    stored = [_summary(t, user) for t in db_list_templates_for(user["id"])]
    return {"templates": [_builtin_summary(t) for t in builtin_templates.BUILTIN] + stored}


@router.post("/api/templates")
async def create_template(data: dict, user: dict = Depends(require_auth)):
    """Save a page (with its sub-pages) as a frozen template. Body: {pageId, name, description?, scope: 'personal'|'workspace'}.
    Workspace templates are for admins only. Later edits of the page do not change the template."""
    page_id = data.get("pageId")
    if not isinstance(page_id, str) or not page_id:
        raise HTTPException(status_code=400, detail="pageId is required")
    name = _clean_text(data.get("name"), MAX_NAME, "name", required=True)
    description = _clean_text(data.get("description"), MAX_DESCRIPTION, "description")
    scope = data.get("scope", "personal")
    if scope not in ("personal", "workspace"):
        raise HTTPException(status_code=400, detail="scope must be 'personal' or 'workspace'")
    if scope == "workspace" and not _is_admin(user):
        raise HTTPException(status_code=403, detail="Only admins can create workspace templates")
    source = _load(page_id, user)
    if source["kind"] == "task" or source["archivedAt"]:
        raise HTTPException(status_code=400, detail="This page cannot be saved as a template")
    template_id = new_template_id()
    try:
        bundle = freeze_bundle(await build_bundle([page_id], True), template_id)
        for page in bundle["pages"]:
            page["system"] = None  # a template never carries a system key (the dashboard of a project)
        saved = db_add_template(template_id, name, description, scope, user["id"], len(bundle["pages"]), bundle)
    except ValueError as exc:
        delete_template_files(template_id)
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception:
        delete_template_files(template_id)
        raise
    return _summary(saved, user)


@router.delete("/api/templates/{template_id}")
async def delete_template(template_id: str, user: dict = Depends(require_auth)):
    """Delete a template: your own personal one, or (admins) a workspace one. Built-ins cannot be deleted."""
    if template_id in builtin_templates.BY_ID:
        raise HTTPException(status_code=400, detail="Built-in templates cannot be deleted")
    template = db_get_template(template_id)
    if not template or not _may_use(template, user):
        raise HTTPException(status_code=404, detail="Template not found")
    if not _may_delete(template, user):
        raise HTTPException(status_code=403, detail="Only admins can delete workspace templates")
    db_delete_template(template_id)
    delete_template_files(template_id)
    return {"success": True}


@router.post("/api/templates/{template_id}/use")
async def use_template(template_id: str, data: dict, user: dict = Depends(require_auth)):
    """Create pages from a template. Body: {space: 'me' | 'p:<projectId>', parentId?, title?}. Returns the new
    root page plus `pageIds`. The caller needs to create pages in the space."""
    space = data.get("space")
    if not isinstance(space, str):
        raise HTTPException(status_code=400, detail="space is required")
    space_type, project_id = _space(space, user, write=True)
    parent_id = _clean_parent(data.get("parentId"))
    title = _clean_title(data["title"]) if data.get("title") is not None else None
    builtin = builtin_templates.BY_ID.get(template_id)
    try:
        if builtin:
            target = builtin_templates.Target(user, space_type, project_id, parent_id)
            if parent_id:
                _check_parent_in_space(parent_id, space_type, project_id, user)
            root = await builtin["build"](target, title)
            page_ids = [root["id"]]
        else:
            template = db_get_template(template_id, with_bundle=True)
            if not template or not _may_use(template, user):
                raise HTTPException(status_code=404, detail="Template not found")
            made = instantiate(template["bundle"], user, space_type, project_id, parent_id, title=title)
            root = db_get_page(made["rootIds"][0])
            page_ids = made["pageIds"]
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    await _announce(root, page_ids)
    return _created(root["id"], page_ids, user)


def _check_parent_in_space(parent_id: str, space_type: str, project_id: Optional[str], user: dict) -> None:
    """Refuse a parent that is not a live page of the destination space (the database layer checks it for copies)."""
    parent = db_get_page(parent_id)
    if not parent or parent["kind"] != "page" or parent["archivedAt"]:
        raise ValueError("Parent page not found")
    if parent["spaceType"] != space_type or parent["projectId"] != project_id or \
            (space_type == "personal" and parent["ownerId"] != user["id"]):
        raise ValueError("Parent page is in another space")


# ============ Project templates ============

@router.post("/api/projects/{project_id}/copy-setup")
async def copy_project_setup(project_id: str, data: dict, user: dict = Depends(require_auth)):
    """Copy the setup of another project into this (new, still unused) one. Body: {from: '<projectId>'}.

    Copies: the page tree (sub-pages, icons, content, images, views, with the re-pointing rules of a duplicate),
    the custom task columns (definitions only), the custom tables (columns only) and the views on the Tasks page
    (they replace the new project's own Tasks view). Never copied: tasks, clips, comments, members, table rows.
    Needs: owner or admin of this project and any access to the source. 409 when this project already has pages,
    custom columns or custom tables of its own."""
    source_id = data.get("from")
    if not isinstance(source_id, str) or not source_id:
        raise HTTPException(status_code=400, detail="from is required")
    if project_id not in projects or source_id not in projects:
        raise HTTPException(status_code=404, detail="Project not found")
    if source_id == project_id:
        raise HTTPException(status_code=400, detail="Choose another project to copy from")
    probe = {"spaceType": "project", "projectId": project_id}
    if not can_edit_custom_schema(user, probe):
        raise HTTPException(status_code=403, detail="Only the project owner or an admin can copy a setup into it")
    if not db_check_project_access(user["id"], source_id):
        raise HTTPException(status_code=403, detail="Access denied")
    _space(f"p:{project_id}", user, write=True)

    own_pages = [p for p in db_list_pages("project", project_id) if p["kind"] == "page" and not p["system"]]
    if own_pages or db_list_table_columns(f"tasks:{project_id}") or db_list_custom_tables("project", project_id):
        raise HTTPException(status_code=409, detail="This project already has its own pages, columns or tables")

    # custom task columns: definitions with their keys, so copied views keep working
    columns = db_list_table_columns(f"tasks:{source_id}")
    for column in columns:
        if column["type"] != "relation":  # relation columns follow once the copied tables exist
            db_create_table_column(f"tasks:{project_id}", column["key"], column["name"], column["type"],
                                   column["config"], user["id"])
    table_map = {}

    listing = [p for p in db_list_pages("project", source_id) if p["kind"] == "page"]
    roots = [p["id"] for p in listing if p["parentId"] is None]
    tables = tuple(t["id"] for t in db_list_custom_tables("project", source_id))
    copied = 0
    # The source's dashboard lands on the dashboard this project already has
    tasks_page = next((p["id"] for p in db_list_pages("project", project_id) if p["system"] == "dashboard"), None)
    if roots:
        bundle = await build_bundle(roots, True, extra_tables=tables)
        made = instantiate(bundle, user, "project", project_id, None,
                           system_pages={"dashboard": tasks_page} if tasks_page else None)
        table_map = made["tableMap"]
        copied = len([k for k in made["pageIds"] if k != tasks_page])
        first = db_get_page(made["rootIds"][0]) if made["rootIds"] else None
        if first:
            await _notify(first, "created", pageIds=made["pageIds"][:EVENT_IDS])
    elif tables:  # no pages to carry them: copy the table schemas alone
        bundle = {"v": 1, "sourceSpace": f"p:{source_id}", "sourceProject": source_id, "pages": [], "views": [],
                  "tables": [b for b in (table_bundle(t) for t in tables) if b]}
        table_map = instantiate(bundle, user, "project", project_id, None)["tableMap"]
    # relation columns of the tasks: valid only when their target exists in the new project, else dropped
    mapping = {**table_map, f"tasks:{source_id}": f"tasks:{project_id}"}
    for column in columns:
        if column["type"] != "relation":
            continue
        target = relation_target_for_copy(column["config"].get("target"), "project", project_id, user, mapping)
        if target:
            db_create_table_column(f"tasks:{project_id}", column["key"], column["name"], column["type"],
                                   {**column["config"], "target": target}, user["id"])
    return {"success": True, "pages": copied, "columns": len(columns), "tables": len(tables)}

