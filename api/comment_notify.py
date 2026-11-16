"""Notifications from review comments: people tagged with @username, and the author of a comment that got a reply.

A tag is ``@`` followed by a username, written anywhere in the text. Only people who have the Review tab of the
project are told, never the writer, and each person once per comment.
"""

import re
from typing import List, Optional
from urllib.parse import quote

from api.auth import can_use_review
from database.notifications import db_create_notification
from database.users import db_get_user_by_id, db_list_users

TAG = re.compile(r"(?<![\w@])@([\w.\-]{1,80})")
PREVIEW = 140


def tagged_usernames(text: str) -> List[str]:
    """The usernames written as @name in the text, lower-cased, in order, without repeats."""
    seen: List[str] = []
    for name in TAG.findall(text or ""):
        name = name.rstrip(".").lower()
        if name and name not in seen:
            seen.append(name)
    return seen


def comment_link(project_id: str, comment: dict) -> str:
    link = f"/p/{project_id}/review"
    if comment.get("clipBaseName"):
        link += f"?clip={quote(comment['clipBaseName'], safe='')}"
    return link


def notify_about_comment(project_id: str, comment: dict, parent: Optional[dict], writer_id: Optional[str]) -> List[dict]:
    """Create the notifications of a new comment and return them (the caller sends them out live)."""
    text = comment.get("text") or ""
    preview = text if len(text) <= PREVIEW else text[:PREVIEW - 1] + "\u2026"
    writer = comment.get("userName") or "Someone"
    where = comment.get("clipBaseName") or "a clip"
    link = comment_link(project_id, comment)
    told = {writer_id} if writer_id else set()
    made: List[dict] = []

    def tell(user: Optional[dict], title: str) -> None:
        if not user or user["id"] in told or not can_use_review(user, project_id):
            return
        told.add(user["id"])
        made.append(db_create_notification(user["id"], "mention", title, message=preview or None,
                                           project_id=project_id, link=link))

    names = tagged_usernames(text)
    if names:
        by_name = {u["username"].lower(): u for u in db_list_users()}
        for name in names:
            tell(by_name.get(name), f"{writer} tagged you on {where}")
    if parent and parent.get("user"):
        tell(db_get_user_by_id(parent["user"]), f"{writer} replied to your comment on {where}")
    return made
