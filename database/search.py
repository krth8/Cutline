"""Queries behind global search (api/search.py): which pages the caller may see, and the page text matches.

Text matching is a plain LIKE on lower-cased text (works the same on SQLite and PostgreSQL). It is
case-insensitive for ASCII only; the accent-insensitive part is done in Python by api/search.py on titles.
"""

from typing import Dict, Iterable, List, Optional, Set

from .engine import execute, fetchall
from .mentions import _like
from .utils import get_db


def _scope(project_ids: List[str], owner_id: str, only_project: Optional[str]):
    """SQL (and params) limiting pages to the given projects, plus the owner's personal pages unless the
    search is limited to one project."""
    if only_project is not None:
        return "(space_type = 'project' AND project_id = ?)", [only_project]
    marks = ", ".join("?" for _ in project_ids) or "NULL"
    return (f"((space_type = 'project' AND project_id IN ({marks})) OR (space_type = 'personal' AND owner_id = ?))",
            [*project_ids, owner_id])


def db_search_visible_pages(project_ids: List[str], owner_id: str, only_project: Optional[str] = None) -> List[dict]:
    """Metadata of the unarchived pages (not task pages) in the given projects or personal to `owner_id`.
    With `only_project`, only that project's pages (the caller has checked access to it)."""
    scope, params = _scope(project_ids, owner_id, only_project)
    with get_db() as conn:
        return fetchall(execute(conn, f"""
            SELECT id, title, icon, space_type, project_id, updated_at FROM pages
            WHERE archived_at IS NULL AND kind = 'page' AND {scope}
        """, tuple(params)))


def db_page_ids_with_text(word: str, project_ids: List[str], owner_id: str, only_project: Optional[str] = None) -> Set[str]:
    """Ids of the visible pages whose body text contains `word` (case-insensitive for ASCII)."""
    scope, params = _scope(project_ids, owner_id, only_project)
    with get_db() as conn:
        rows = fetchall(execute(conn, f"""
            SELECT id FROM pages
            WHERE archived_at IS NULL AND kind = 'page' AND {scope} AND LOWER(text) LIKE ? ESCAPE '!'
        """, (*params, _like(word.lower()))))
    return {r["id"] for r in rows}


def db_task_ids_with_page_text(word: str, project_ids: List[str]) -> Set[str]:
    """Ids of the tasks (in the given projects) whose task page, the body of the task, contains `word`."""
    if not project_ids:
        return set()
    marks = ", ".join("?" for _ in project_ids)
    with get_db() as conn:
        rows = fetchall(execute(conn, f"""
            SELECT task_id FROM pages
            WHERE archived_at IS NULL AND kind = 'task' AND task_id IS NOT NULL
              AND project_id IN ({marks}) AND LOWER(text) LIKE ? ESCAPE '!'
        """, (*project_ids, _like(word.lower()))))
    return {r["task_id"] for r in rows}


def db_page_texts(page_ids: Iterable[str]) -> Dict[str, str]:
    """The body text of the given pages, {page_id: text}."""
    ids = list(page_ids)
    if not ids:
        return {}
    marks = ", ".join("?" for _ in ids)
    with get_db() as conn:
        rows = fetchall(execute(conn, f"SELECT id, text FROM pages WHERE id IN ({marks})", tuple(ids)))
    return {r["id"]: r["text"] or "" for r in rows}


def db_task_page_texts(task_ids: Iterable[str]) -> Dict[str, str]:
    """The body text of the task pages of the given tasks, {task_id: text}."""
    ids = list(task_ids)
    if not ids:
        return {}
    marks = ", ".join("?" for _ in ids)
    with get_db() as conn:
        rows = fetchall(execute(conn, f"SELECT task_id, text FROM pages WHERE kind = 'task' AND task_id IN ({marks})",
                                tuple(ids)))
    return {r["task_id"]: r["text"] or "" for r in rows}
