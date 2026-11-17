"""Notifications about tasks, and what each person wants to be told.

Kinds (also the ``type`` of a notification row; database/notifications.py drops the ones a person turned off):

- ``task_assigned``  someone gave you a task
- ``task_comment``   a comment on a task you follow
- ``task_status``    the status of a task you follow changed
- ``task_due``       a task of yours is due today, or its due date passed yesterday
- ``mention``        you were tagged (pages, review comments, task comments) or someone answered your review comment
- ``session_joined`` someone joined a review session of a project you made (off unless turned on)

Who follows a task: its assignees and its creator, everyone who commented on it, and everyone who pressed Follow;
minus everyone who pressed Unfollow. Nobody is told about their own action, and only people with the Home tab of
the project hear about its tasks. Every function here is safe to call from a request: failures are printed.
"""

import asyncio
from datetime import date, datetime, timedelta
from typing import Iterable, List, Optional, Set

from api.activity import task_link
from api.comment_notify import tagged_usernames
from api.events import live
from database import db_check_project_access
from database.clips import db_list_statuses
from database.notifications import db_create_notification
from database.task_notify import db_claim_reminder, db_follow_if_undecided, db_task_follow_choices
from database.users import db_list_users

KINDS = [
    {"kind": "task_assigned", "label": "A task is assigned to me", "default": True},
    {"kind": "task_comment", "label": "Comments on tasks I follow", "default": True},
    {"kind": "task_status", "label": "Status changes on tasks I follow", "default": True},
    {"kind": "task_due", "label": "My tasks are due today or overdue", "default": True},
    {"kind": "mention", "label": "Mentions and replies to my comments", "default": True},
    {"kind": "session_joined", "label": "Someone joins my review session", "default": False},
]
KIND_NAMES = {k["kind"] for k in KINDS}
PREVIEW = 140
REMINDER_HOUR = 8          # due-date reminders go out from this hour (server time) on
REMINDER_INTERVAL = 600    # seconds between checks


def _name(user: Optional[dict]) -> str:
    return (user or {}).get("username") or (user or {}).get("name") or "Someone"


def _preview(text: str) -> Optional[str]:
    text = (text or "").strip()
    return (text if len(text) <= PREVIEW else text[:PREVIEW - 1] + "…") or None


def _may_see(user_id: str, task: dict) -> bool:
    return bool(user_id) and db_check_project_access(user_id, task["projectId"], require_tasks=True)


def followers(task: dict) -> Set[str]:
    """Everyone who follows the task (see the module docstring)."""
    choices = db_task_follow_choices(task["id"])
    people = {a.get("id") for a in task.get("assignees") or [] if a.get("id")}
    if task.get("createdBy"):
        people.add(task["createdBy"])
    people |= {uid for uid, on in choices.items() if on}
    return {uid for uid in people if choices.get(uid, True)}


def is_following(task: dict, user_id: str) -> bool:
    return user_id in followers(task)


async def _send(user_ids: Iterable[str], kind: str, title: str, task: dict, message: Optional[str] = None) -> None:
    for user_id in user_ids:
        try:
            if not _may_see(user_id, task):
                continue
            notification = await asyncio.to_thread(db_create_notification, user_id, kind, title, message,
                                                   task["projectId"], task_link(task))
            if notification:  # None: the person turned this kind off
                await live.to_user(user_id, {"type": "notification", "notification": notification})
        except Exception as exc:
            print(f"Could not notify {user_id} about task {task.get('id')}: {exc}")


def _actor_id(actor: Optional[dict]) -> Optional[str]:
    return None if not actor or actor.get("is_guest") else actor.get("id")


async def task_created(actor: Optional[dict], task: dict) -> None:
    """A new task with assignees: tell them (not the one who made it)."""
    me = _actor_id(actor)
    assigned = [a.get("id") for a in task.get("assignees") or [] if a.get("id") and a.get("id") != me]
    await _send(assigned, "task_assigned", f"{_name(actor)} assigned you to {task.get('name') or 'a task'}", task)


async def task_changed(actor: Optional[dict], before: dict, after: dict) -> None:
    """New assignees are told; the followers hear about a new status."""
    me = _actor_id(actor)
    title = after.get("name") or "a task"
    old = {a.get("id") for a in before.get("assignees") or []}
    added = [a.get("id") for a in after.get("assignees") or [] if a.get("id") and a.get("id") not in old and a.get("id") != me]
    await _send(added, "task_assigned", f"{_name(actor)} assigned you to {title}", after)
    if before.get("statusId") != after.get("statusId") and after.get("statusId"):
        status = next((s["name"] for s in db_list_statuses() if s["id"] == after["statusId"]), "a new status")
        told = set(added) | ({me} if me else set())
        await _send(sorted(followers(after) - told), "task_status", f"{_name(actor)} moved {title} to {status}", after)


async def comment_added(actor: dict, task: dict, comment: dict) -> None:
    """People tagged with @username hear it as a mention, the other followers as a comment. The writer follows."""
    me = _actor_id(actor)
    title = task.get("name") or "a task"
    text = comment.get("text") or ""
    if me:
        await asyncio.to_thread(db_follow_if_undecided, task["id"], me)
    names = tagged_usernames(text)
    tagged: List[str] = []
    if names:
        by_name = {u["username"].lower(): u["id"] for u in db_list_users()}
        tagged = [by_name[n] for n in names if n in by_name and by_name[n] != me]
    await _send(tagged, "mention", f"{_name(actor)} mentioned you on {title}", task, _preview(text))
    rest = sorted(followers(task) - set(tagged) - ({me} if me else set()))
    await _send(rest, "task_comment", f"{_name(actor)} commented on {title}", task, _preview(text))


# ---------------------------------------------------------------- due-date reminders

def due_reminders(all_tasks: Iterable[dict], now: datetime) -> List[tuple]:
    """The reminders to send now: (task, kind, title) for open tasks due today (from REMINDER_HOUR on) and for
    tasks whose due date was yesterday. Older overdue tasks get nothing (no flood after a pause or a deploy)."""
    if now.hour < REMINDER_HOUR:
        return []
    today = now.date()
    yesterday = today - timedelta(days=1)
    done = {s["id"] for s in db_list_statuses() if s.get("isDone")}
    out = []
    for task in all_tasks:
        due = task.get("dueDate")
        if not due or task.get("statusId") in done or not task.get("assignees"):
            continue
        try:
            day = date.fromisoformat(str(due)[:10])
        except ValueError:
            continue
        if day == today:
            out.append((task, "today", f"Due today: {task.get('name') or 'a task'}"))
        elif day == yesterday:
            out.append((task, "overdue", f"Overdue: {task.get('name') or 'a task'} was due yesterday"))
    return out


async def send_due_reminders(now: Optional[datetime] = None) -> int:
    """Send the reminders that are due and not sent before (each once per task, kind and due date)."""
    from api.state import tasks  # the live task state
    sent = 0
    for task, kind, title in due_reminders(list(tasks.values()), now or datetime.now()):
        if not await asyncio.to_thread(db_claim_reminder, task["id"], kind, str(task["dueDate"])[:10]):
            continue
        people = [a.get("id") for a in task.get("assignees") or [] if a.get("id")]
        await _send(people, "task_due", title, task)
        sent += 1
    return sent


async def reminder_loop() -> None:
    """Started with the server: checks for due-date reminders every REMINDER_INTERVAL seconds."""
    while True:
        try:
            await send_due_reminders()
        except Exception as exc:
            print(f"Due-date reminders failed: {exc}")
        await asyncio.sleep(REMINDER_INTERVAL)

