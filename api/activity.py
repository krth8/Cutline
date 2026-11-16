"""Recording activity (database/activity.py) from the places where things change.

Every function here is safe to call from a request: a failure is printed, never raised, and people watching
the project are told that there is something new (``activity`` over the live connection; they fetch the list).

Kinds: ``task.created``, ``task.status``, ``task.assigned``, ``task.due``, ``task.renamed``, ``page.created``,
``comment.added``. The prefix decides who may see it: task.* and page.* need the Home tab of the project,
comment.* the Review tab.
"""

from typing import Iterable, List, Optional
from urllib.parse import quote

from api.events import live
from database.activity import db_add_activity
from database.clips import db_list_statuses


def _name(user: Optional[dict]) -> Optional[str]:
    return (user or {}).get("username") or (user or {}).get("name")


async def record(project_id: str, actor: Optional[dict], kind: str, title: str, detail: Optional[dict] = None,
                 link: Optional[str] = None, involves: Iterable[str] = ()) -> None:
    try:
        actor_id = None if not actor or actor.get("is_guest") else actor.get("id")
        db_add_activity(project_id, actor_id, _name(actor), kind, title, detail, link, involves)
        await live.to_project(project_id, {"type": "activity", "kind": kind}, echo=True)
    except Exception as exc:
        print(f"Could not record activity {kind} in {project_id}: {exc}")


def task_link(task: dict) -> str:
    return f"/p/{task['projectId']}/pages?task={quote(task['id'], safe='')}"


def _people(task: dict) -> List[str]:
    return [a.get("id") for a in task.get("assignees") or []] + [task.get("createdBy")]


def _status_name(status_id: Optional[str]) -> Optional[str]:
    if not status_id:
        return None
    return next((s["name"] for s in db_list_statuses() if s["id"] == status_id), None)


async def task_created(actor: Optional[dict], task: dict) -> None:
    await record(task["projectId"], actor, "task.created", task.get("name") or "Untitled", link=task_link(task),
                 involves=_people(task))


async def task_changed(actor: Optional[dict], before: dict, after: dict) -> None:
    """One event per thing that changed among status, assignees, due date and name."""
    project_id, title, link = after["projectId"], after.get("name") or "Untitled", task_link(after)
    people = _people(after)
    if before.get("statusId") != after.get("statusId"):
        await record(project_id, actor, "task.status", title, link=link, involves=people,
                     detail={"from": _status_name(before.get("statusId")), "to": _status_name(after.get("statusId"))})
    old = {a.get("id") for a in before.get("assignees") or []}
    added = [a for a in after.get("assignees") or [] if a.get("id") not in old]
    if added:
        await record(project_id, actor, "task.assigned", title, link=link, involves=[a.get("id") for a in added],
                     detail={"to": [a.get("username") or a.get("name") for a in added]})
    if (before.get("dueDate") or None) != (after.get("dueDate") or None):
        await record(project_id, actor, "task.due", title, link=link, involves=people,
                     detail={"from": before.get("dueDate") or None, "to": after.get("dueDate") or None})
    if before.get("name") != after.get("name"):
        await record(project_id, actor, "task.renamed", title, link=link, involves=people,
                     detail={"from": before.get("name")})


async def page_created(actor: Optional[dict], page: dict) -> None:
    if page.get("spaceType") != "project" or not page.get("projectId") or page.get("kind") != "page":
        return
    await record(page["projectId"], actor, "page.created", page.get("title") or "Untitled",
                 link=f"/p/{page['projectId']}/page/{page['id']}")


async def comment_added(actor: Optional[dict], project_id: str, comment: dict, link: str, involves: Iterable[str]) -> None:
    text = comment.get("text") or ""
    await record(project_id, {**(actor or {}), "username": comment.get("userName")}, "comment.added",
                 comment.get("clipBaseName") or "a clip", link=link, involves=involves,
                 detail={"text": text[:140], "reply": bool(comment.get("parentId")), "drawing": bool(comment.get("drawing"))})
