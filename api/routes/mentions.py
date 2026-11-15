"""Mentions: the @ menu search, resolving chips, and backlinks ("Mentioned in")."""

from typing import List

from fastapi import APIRouter, Depends, HTTPException, Query

from api.auth import can_access_space, can_read_page, require_auth
from api.mentions import (
    KIND_TO_REF,
    page_route,
    project_rights,
    resolve_target,
    route_for,
)
from api.state import projects, tasks
from database.mentions import (
    db_pages_mentioning,
    db_project_people,
    db_search_pages,
    db_users_sharing_projects,
)
from database.pages import db_get_page, parse_space, space_of

router = APIRouter()

PER_KIND = 8
MAX_RESOLVE = 200
MAX_QUERY = 100


def _match(text: str, query: str) -> bool:
    return query in (text or "").lower()


def _first_then_rest(items: List[dict], is_first) -> List[dict]:
    """Stable: items for which is_first(item) is true come first."""
    return [i for i in items if is_first(i)] + [i for i in items if not is_first(i)]


@router.get("/api/mentions/search")
async def search_mentions(q: str = Query("", max_length=MAX_QUERY), space: str = "me", user: dict = Depends(require_auth)):
    """People, tasks, pages and clips matching `q` that the caller may see, at most 8 of each.

    `space` is the space of the page being edited ('me' or 'p:<projectId>'): its project's tasks and clips
    come first, and people are those with access to it (for a personal page: everyone the caller shares a
    project with)."""
    try:
        _space_type, space_project = parse_space(space)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    if not can_access_space(user, space):
        raise HTTPException(status_code=403, detail="Access denied")
    query = q.strip().lower()
    rights = project_rights(user)

    candidates = db_project_people(space_project) if space_project else db_users_sharing_projects(user["id"])
    people = [{"kind": "person", "id": p["id"], "label": p["username"], "profileImage": p["profile_image"]}
              for p in candidates if _match(p["username"], query)][:PER_KIND]

    visible_tasks = sorted((t for t in tasks.values() if rights.get(t["projectId"], (False, False))[1]
                            and _match(t["name"], query)),
                           key=lambda t: (t["projectId"] != space_project, t.get("createdAt") or ""))
    task_items = [{"kind": "task", "id": t["id"], "label": t["name"], "projectId": t["projectId"],
                   "projectName": projects.get(t["projectId"], {}).get("name")} for t in visible_tasks[:PER_KIND]]

    clip_items = []
    for pid, (can_review, _can_tasks) in rights.items():
        if not can_review or pid not in projects:
            continue
        for base_name in projects[pid].get("clips", {}):
            if _match(base_name, query):
                clip_items.append({"kind": "clip", "id": f"{pid}:{base_name}", "label": base_name, "projectId": pid,
                                   "projectName": projects[pid].get("name")})
    clip_items.sort(key=lambda c: (c["projectId"] != space_project, c["label"].lower()))

    pages = db_search_pages(query, list(rights), user["id"])
    page_items = _first_then_rest(
        [{"kind": "page", "id": p["id"], "label": p["title"], "icon": p["icon"],
          "space": "me" if p["space_type"] == "personal" else f"p:{p['project_id']}"} for p in pages],
        lambda p: p["space"] == space)

    return {"people": people, "tasks": task_items, "pages": page_items[:PER_KIND], "clips": clip_items[:PER_KIND]}


@router.post("/api/mentions/resolve")
async def resolve_mentions(data: dict, user: dict = Depends(require_auth)):
    """Current names for chips: {items: [{kind, id}]} -> {items: [{kind, id, ok, title?, icon?, route?}]}.

    A target that is missing or that the caller may not see gives only {ok: false}: no title."""
    items = data.get("items")
    if not isinstance(items, list) or len(items) > MAX_RESOLVE:
        raise HTTPException(status_code=400, detail="items must be a list of at most 200")
    out = []
    for item in items:
        kind, target_id = (item.get("kind"), item.get("id")) if isinstance(item, dict) else (None, None)
        if kind not in KIND_TO_REF or not isinstance(target_id, str) or not target_id:
            raise HTTPException(status_code=400, detail="Each item needs a kind and an id")
        info = resolve_target(user, kind, target_id)
        if info is None:
            out.append({"kind": kind, "id": target_id, "ok": False})
            continue
        entry = {"kind": kind, "id": target_id, "ok": True, "title": info["title"], "route": route_for(kind, target_id, info)}
        if info.get("icon"):
            entry["icon"] = info["icon"]
        if info.get("projectId"):
            entry["projectId"] = info["projectId"]
        out.append(entry)
    return {"items": out}


@router.get("/api/backlinks")
async def backlinks(kind: str, id: str = Query(..., min_length=1), user: dict = Depends(require_auth)):
    """The pages that mention a person, task, page or clip, limited to pages the caller may read."""
    ref_type = KIND_TO_REF.get(kind) or (kind if kind in KIND_TO_REF.values() else None)
    if ref_type is None:
        raise HTTPException(status_code=400, detail="kind must be person, task, page or clip")
    kind = {v: k for k, v in KIND_TO_REF.items()}[ref_type]
    if resolve_target(user, kind, id) is None:
        return {"pages": []}  # nothing is said about a target the caller cannot see
    pages = []
    for page_id in db_pages_mentioning(ref_type, id):
        page = db_get_page(page_id)
        if not page or page["archivedAt"] or not can_read_page(user, page) or (kind == "page" and page_id == id):
            continue
        pages.append({"id": page["id"], "title": page["title"], "icon": page["icon"], "space": space_of(page),
                      "projectId": page["projectId"], "route": page_route(page), "updatedAt": page["updatedAt"]})
    return {"pages": pages}
