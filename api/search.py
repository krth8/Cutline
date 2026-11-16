"""Global search: pages, tasks, review comments and clips that the caller may see.

Pages are matched on title (in Python, accent-insensitive) and body text (`pages.text`, SQL LIKE). Tasks,
comments and clips live in memory (api/state.py) and are scanned there. Permissions are the same as on the
other surfaces: pages by the `can_read_page` rules (project access, own personal pages), tasks need task
access and comments and clips need review access on the project.
"""

import time
import unicodedata
from typing import Dict, Iterable, List, Optional, Set
from urllib.parse import quote

from api.mentions import project_rights
from api.state import projects, tasks
from database.search import (
    db_page_ids_with_text,
    db_page_texts,
    db_search_visible_pages,
    db_task_ids_with_page_text,
    db_task_page_texts,
)

TYPES = ("page", "task", "comment", "clip")
MAX_QUERY_CHARS = 200
MAX_WORDS = 6
SNIPPET_BEFORE = 50
SNIPPET_LENGTH = 140
TITLE_LENGTH = 100


# ============ Text helpers ============

def fold(text: str) -> str:
    """Lower-case and drop accents, keeping the length (so indexes in the folded text fit the original)."""
    out = []
    for ch in text:
        base = unicodedata.normalize("NFD", ch)[0]
        low = base.lower()
        out.append(low if len(low) == 1 else ch)
    return "".join(out)


def query_words(q: str) -> List[str]:
    """The distinct folded words of a query, at most MAX_WORDS."""
    words: List[str] = []
    for word in fold((q or "").strip()[:MAX_QUERY_CHARS]).split():
        if word not in words:
            words.append(word)
    return words[:MAX_WORDS]


def has_all(folded: str, words: List[str]) -> bool:
    return all(w in folded for w in words)


def snippet_around(text: str, words: List[str], length: int = SNIPPET_LENGTH) -> Optional[str]:
    """A short stretch of `text` around the first matching word, whitespace collapsed; None when none matches."""
    folded = fold(text)
    hits = [i for i in (folded.find(w) for w in words) if i >= 0]
    if not hits:
        return None
    start = max(0, min(hits) - SNIPPET_BEFORE)
    chunk = " ".join(text[start:start + length].split())
    return ("..." if start > 0 else "") + chunk + ("..." if start + length < len(text) else "")


def rank_of(title_folded: str, query_folded: str, words: List[str]) -> int:
    """0: title starts with the query. 1: title contains it (or every word). 2: the match is elsewhere."""
    if title_folded.startswith(query_folded):
        return 0
    if query_folded in title_folded or has_all(title_folded, words):
        return 1
    return 2


def order(items: List[dict]) -> List[dict]:
    """Best rank first, newest first within a rank (items carry `_rank` and `_recent`)."""
    items.sort(key=lambda i: i["_recent"] or "", reverse=True)
    items.sort(key=lambda i: i["_rank"])
    return items


def _p(value: str) -> str:
    return quote(value, safe="")


# ============ The four searches ============

def search_pages(user: dict, rights: Dict[str, tuple], words: List[str], query_folded: str, limit: int,
                 only_project: Optional[str]) -> List[dict]:
    project_ids = [pid for pid, (_review, can_tasks) in rights.items() if can_tasks]  # pages are part of the Main tab
    metas = db_search_visible_pages(project_ids, user["id"], only_project)
    body_hits: List[Set[str]] = [db_page_ids_with_text(w, project_ids, user["id"], only_project) for w in words]
    found = []
    for meta in metas:
        title = fold(meta["title"] or "")
        if not all(w in title or meta["id"] in hits for w, hits in zip(words, body_hits)):
            continue
        found.append({"meta": meta, "_rank": rank_of(title, query_folded, words), "_recent": str(meta["updated_at"] or "")})
    top = order(found)[:limit]
    texts = db_page_texts(i["meta"]["id"] for i in top)
    items = []
    for hit in top:
        meta = hit["meta"]
        personal = meta["space_type"] == "personal"
        base = "/me" if personal else f"/p/{_p(meta['project_id'])}"
        pid = None if personal else meta["project_id"]
        items.append({"type": "page", "id": meta["id"], "title": meta["title"] or "Untitled", "icon": meta["icon"],
                      "snippet": snippet_around(texts.get(meta["id"], ""), words),
                      "projectId": pid, "projectName": None if personal else projects.get(pid, {}).get("name"),
                      "route": f"{base}/page/{_p(meta['id'])}"})
    return items


def search_tasks(rights: Dict[str, tuple], words: List[str], query_folded: str, limit: int,
                 only_project: Optional[str]) -> List[dict]:
    task_projects = [pid for pid, (_review, can_tasks) in rights.items() if can_tasks and pid in projects
                     and (only_project is None or pid == only_project)]
    if not task_projects:
        return []
    allowed = set(task_projects)
    body_hits = [db_task_ids_with_page_text(w, task_projects) for w in words]
    found = []
    for task in tasks.values():
        if task.get("projectId") not in allowed or task.get("deletedAt"):
            continue
        name = fold(task.get("name") or "")
        description = fold(task.get("description") or "")
        if not all(w in name or w in description or task["id"] in hits for w, hits in zip(words, body_hits)):
            continue
        found.append({"task": task, "_rank": rank_of(name, query_folded, words), "_recent": str(task.get("createdAt") or "")})
    top = order(found)[:limit]
    bodies = db_task_page_texts(i["task"]["id"] for i in top)
    items = []
    for hit in top:
        task = hit["task"]
        snippet = (snippet_around(task.get("description") or "", words)
                   or snippet_around(bodies.get(task["id"], ""), words))
        items.append({"type": "task", "id": task["id"], "title": task.get("name") or "Untitled task", "snippet": snippet,
                      "projectId": task["projectId"], "projectName": projects.get(task["projectId"], {}).get("name"),
                      "route": f"/p/{_p(task['projectId'])}/tasks?task={_p(task['id'])}"})
    return items


def search_comments(rights: Dict[str, tuple], words: List[str], query_folded: str, limit: int,
                    only_project: Optional[str]) -> List[dict]:
    found = []
    for pid, (can_review, _can_tasks) in rights.items():
        if not can_review or pid not in projects or (only_project is not None and pid != only_project):
            continue
        for comment in projects[pid].get("comments", []):
            text = comment.get("text") or ""
            folded = fold(text)
            if not text or not has_all(folded, words):
                continue
            found.append({"pid": pid, "comment": comment, "_rank": rank_of(folded.lstrip(), query_folded, words),
                          "_recent": str(comment.get("createdAt") or "")})
    items = []
    for hit in order(found)[:limit]:
        comment, pid = hit["comment"], hit["pid"]
        clip, version, frame = comment.get("clipBaseName"), comment.get("clipVersion"), comment.get("frame")
        query = []
        if clip:
            query.append(f"clip={_p(clip)}")
            if isinstance(version, int):
                query.append(f"v={version}")
            if isinstance(frame, int) and frame >= 0:
                query.append(f"frame={frame}")
        where = " ".join(part for part in (clip, f"v{version}" if isinstance(version, int) else None) if part)
        items.append({"type": "comment", "id": comment["id"],
                      "title": snippet_around(comment["text"], words, TITLE_LENGTH) or comment["text"][:TITLE_LENGTH],
                      "snippet": " - ".join(part for part in (where, comment.get("userName")) if part) or None,
                      "projectId": pid, "projectName": projects[pid].get("name"), "clip": clip, "version": version,
                      "frame": frame, "route": f"/p/{_p(pid)}/review" + ("?" + "&".join(query) if query else "")})
    return items


def search_clips(rights: Dict[str, tuple], words: List[str], query_folded: str, limit: int,
                 only_project: Optional[str]) -> List[dict]:
    found = []
    for pid, (can_review, _can_tasks) in rights.items():
        if not can_review or pid not in projects or (only_project is not None and pid != only_project):
            continue
        for base_name, clip in projects[pid].get("clips", {}).items():
            folded = fold(base_name)
            if has_all(folded, words):
                versions = clip.get("versions") or []
                recent = max((str(v.get("uploadedAt") or v.get("createdAt") or "") for v in versions), default="")
                found.append({"pid": pid, "name": base_name, "_rank": rank_of(folded, query_folded, words), "_recent": recent})
    return [{"type": "clip", "id": f"{h['pid']}:{h['name']}", "title": h["name"], "projectId": h["pid"],
             "projectName": projects[h["pid"]].get("name"), "route": f"/p/{_p(h['pid'])}/review?clip={_p(h['name'])}"}
            for h in order(found)[:limit]]


def run_search(user: dict, q: str, types: Optional[Iterable[str]], project: Optional[str], limit: int) -> dict:
    """{groups: [{type, items}], took} for the caller; groups without results are left out."""
    started = time.perf_counter()
    words = query_words(q)
    wanted = [t for t in TYPES if types is None or t in types]
    groups = []
    if words:
        query_folded = " ".join(words)
        rights = project_rights(user)
        if project is not None and project not in rights:
            wanted = []  # a project the caller cannot open: nothing, and no hint that it exists
        for kind in wanted:
            if kind == "page":
                items = search_pages(user, rights, words, query_folded, limit, project)
            elif kind == "task":
                items = search_tasks(rights, words, query_folded, limit, project)
            elif kind == "comment":
                items = search_comments(rights, words, query_folded, limit, project)
            else:
                items = search_clips(rights, words, query_folded, limit, project)
            if items:
                groups.append({"type": kind, "items": items})
    return {"groups": groups, "took": int((time.perf_counter() - started) * 1000)}
