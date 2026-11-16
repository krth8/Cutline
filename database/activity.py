"""The activity log: what happened in the projects (see migration 023)."""

import json
import secrets
from datetime import datetime
from typing import Iterable, List, Optional

from .engine import execute, fetchall
from .utils import get_db

KEEP_PER_PROJECT = 2000  # older events are dropped when a project passes this many


def db_add_activity(project_id: str, actor_id: Optional[str], actor_name: Optional[str], kind: str, title: str,
                    detail: Optional[dict] = None, link: Optional[str] = None,
                    involves: Iterable[str] = ()) -> dict:
    people = [p for p in dict.fromkeys(involves) if p and p != actor_id]
    event = {
        "id": secrets.token_urlsafe(8), "projectId": project_id, "actorId": actor_id, "actorName": actor_name,
        "kind": kind, "title": title, "detail": detail or {}, "link": link, "involves": people,
        "createdAt": datetime.now().isoformat(),
    }
    with get_db() as conn:
        execute(conn, """
            INSERT INTO activity (id, project_id, actor_id, actor_name, kind, title, detail, link, involves, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (event["id"], project_id, actor_id, actor_name, kind, title[:300], json.dumps(event["detail"]), link,
              "," + ",".join(people) + ("," if people else ""), event["createdAt"]))
        execute(conn, """
            DELETE FROM activity WHERE project_id = ? AND id NOT IN (
                SELECT id FROM activity WHERE project_id = ? ORDER BY created_at DESC LIMIT ?)
        """, (project_id, project_id, KEEP_PER_PROJECT))
    return event


def db_list_activity(project_ids: List[str], involving: Optional[str] = None, kinds_hidden: Optional[dict] = None,
                     limit: int = 40) -> List[dict]:
    """Newest first, from the given projects. ``involving``: only events that concern that person and were
    done by someone else. ``kinds_hidden``: project id -> kind prefixes that project must not show."""
    if not project_ids:
        return []
    marks = ",".join("?" for _ in project_ids)
    sql = f"SELECT * FROM activity WHERE project_id IN ({marks})"
    args: list = list(project_ids)
    if involving:
        sql += " AND involves LIKE ? AND (actor_id IS NULL OR actor_id <> ?)"
        args += [f"%,{involving},%", involving]
    sql += " ORDER BY created_at DESC LIMIT ?"
    args.append(limit * 3 if kinds_hidden else limit)
    with get_db() as conn:
        rows = fetchall(execute(conn, sql, tuple(args)))
    events = []
    for r in rows:
        hidden = (kinds_hidden or {}).get(r["project_id"], ())
        if any(r["kind"].startswith(prefix) for prefix in hidden):
            continue
        events.append({
            "id": r["id"], "projectId": r["project_id"], "actorId": r["actor_id"], "actorName": r["actor_name"],
            "kind": r["kind"], "title": r["title"], "detail": json.loads(r["detail"] or "{}"), "link": r["link"],
            "createdAt": r["created_at"],
        })
        if len(events) >= limit:
            break
    return events
