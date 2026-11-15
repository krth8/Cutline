"""Mentions: refs derived from a page's document, who may see a target, and the notification for a person.

`record_page_refs` is the one function the snapshot job calls (api/pagesync.py). Everything else here is
shared with the routes in api/routes/mentions.py.
"""

import asyncio
from typing import Dict, Iterable, List, Optional, Set, Tuple

from pycrdt import Doc, XmlElement, XmlFragment

from api.auth import can_read_page
from api.events import live
from api.state import projects, tasks
from database import db_check_project_access, db_create_notification, db_get_user_by_id
from database.access import db_list_accessible_projects
from database.mentions import (
    db_find_notification,
    db_get_page_refs,
    db_replace_page_refs,
    db_users_sharing_projects,
)
from database.pages import db_get_page, space_of

MENTION = "mention"
FRAGMENT = "default"
# kind in the document -> ref_type in page_refs
KIND_TO_REF = {"person": "user", "task": "task", "page": "page", "clip": "clip"}
REF_TO_KIND = {v: k for k, v in KIND_TO_REF.items()}
NOTIFICATION_TYPE = "mention"

Ref = Tuple[str, str]


# ============ Refs in a document ============

def extract_refs(doc: Doc) -> Set[Ref]:
    """The (ref_type, ref_id) of every mention node in the document."""
    refs: Set[Ref] = set()

    def walk(node) -> None:
        if not isinstance(node, XmlElement):
            return
        if node.tag == MENTION:
            attrs = dict(node.attributes)
            ref_type = KIND_TO_REF.get(str(attrs.get("kind") or ""))
            ref_id = str(attrs.get("id") or "")
            if ref_type and ref_id:
                refs.add((ref_type, ref_id))
            return
        for child in node.children:
            walk(child)

    for block in doc.get(FRAGMENT, type=XmlFragment).children:
        walk(block)
    return refs


# ============ Who may see what ============

def project_rights(user: dict) -> Dict[str, Tuple[bool, bool]]:
    """{project_id: (can_review, can_tasks)} for the projects the user has any access to."""
    if user.get("role") == "admin":
        return {pid: (True, True) for pid in projects}
    return {p["id"]: (p["canReview"], p["canTasks"]) for p in db_list_accessible_projects(user["id"])}


def split_clip_id(clip_id: str) -> Optional[Tuple[str, str]]:
    project_id, sep, base_name = clip_id.partition(":")
    return (project_id, base_name) if sep and project_id and base_name else None


def resolve_target(user: dict, kind: str, target_id: str) -> Optional[dict]:
    """What the reader may know about a mention target, or None when it is missing or not readable by them.

    Missing and forbidden are not told apart, so the answer never confirms that something exists."""
    if kind == "task":
        task = tasks.get(target_id)
        if not task or not db_check_project_access(user["id"], task["projectId"], require_tasks=True):
            return None
        return {"title": task["name"], "projectId": task["projectId"]}
    if kind == "page":
        page = db_get_page(target_id)
        if not page or page["archivedAt"] or not can_read_page(user, page):
            return None
        return {"title": page["title"], "icon": page["icon"], "space": space_of(page), "projectId": page["projectId"]}
    if kind == "clip":
        parts = split_clip_id(target_id)
        if not parts or parts[1] not in projects.get(parts[0], {}).get("clips", {}):
            return None
        if not db_check_project_access(user["id"], parts[0], require_review=True):
            return None
        return {"title": parts[1], "projectId": parts[0]}
    if kind == "person":
        if user["id"] != target_id and user.get("role") != "admin" \
                and target_id not in {p["id"] for p in db_users_sharing_projects(user["id"])}:
            return None
        person = db_get_user_by_id(target_id)
        return {"title": person["username"]} if person else None
    return None


def route_for(kind: str, target_id: str, info: dict) -> Optional[str]:
    """The app route a chip links to (None for people)."""
    from urllib.parse import quote
    if kind == "task":
        return f"?task={quote(target_id, safe='')}"
    if kind == "page":
        space = info["space"]
        base = "/me" if space == "me" else f"/p/{quote(space[2:], safe='')}"
        return f"{base}/page/{quote(target_id, safe='')}"
    if kind == "clip":
        parts = split_clip_id(target_id)
        return f"/p/{quote(parts[0], safe='')}/review?clip={quote(parts[1], safe='')}" if parts else None
    return None


def page_route(page: dict) -> str:
    base = "/me" if page["spaceType"] == "personal" else f"/p/{page['projectId']}"
    return f"{base}/page/{page['id']}"


# ============ Snapshot hook ============

async def record_page_refs(page_id: str, doc: Doc, authors: Iterable[str] = ()) -> None:
    """Called after a page was snapshotted: store the document's refs and notify newly mentioned people.

    `authors` are the users who made the edits that added mentions since the last snapshot; they are never
    notified about their own mention. Failures are logged, never raised: a snapshot must not fail over this."""
    try:
        refs = extract_refs(doc)  # on the event-loop thread, like all pycrdt access
        old = await asyncio.to_thread(db_replace_page_refs, page_id, refs)
        added = {ref_id for ref_type, ref_id in refs - old if ref_type == "user"}
        if added:
            await _notify_people(page_id, added, set(authors))
    except Exception as exc:
        print(f"Could not record the mentions of page {page_id}: {exc}")


def _create_notifications(page_id: str, user_ids: Set[str], authors: Set[str]) -> List[dict]:
    page = db_get_page(page_id)
    if not page or page["archivedAt"]:
        return []
    link = page_route(page)
    title = page["title"] or "Untitled"
    made = []
    for user_id in sorted(user_ids - authors):
        person = db_get_user_by_id(user_id)
        if not person or not can_read_page(person, page):
            continue
        if db_find_notification(user_id, NOTIFICATION_TYPE, link):
            continue  # once per (page, person)
        made.append(db_create_notification(user_id, NOTIFICATION_TYPE, f"You were mentioned in {title}",
                                           project_id=page["projectId"], link=link))
    return made


async def _notify_people(page_id: str, user_ids: Set[str], authors: Set[str]) -> None:
    for notification in await asyncio.to_thread(_create_notifications, page_id, user_ids, authors):
        await live.to_user(notification["userId"], {"type": "notification", "notification": notification})
