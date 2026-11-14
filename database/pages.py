"""Pages: database operations (PLAN.md 5.4).

A page belongs to a space: a project ('p:<projectId>') or a person ('me').
Pages form a tree per space; siblings are ordered by a fractional sort_order so
that inserting between two siblings never renumbers the others.
"""

import uuid
from datetime import datetime
from typing import List, Optional, Tuple

from .engine import execute, fetchall, fetchone
from .utils import get_db

# ydoc content this short is an empty Yjs document (the encoding of "no updates")
EMPTY_YDOC_BYTES = 2

_SUBTREE = """WITH RECURSIVE sub(id) AS (
    SELECT id FROM pages WHERE id = ?
    UNION ALL
    SELECT p.id FROM pages p JOIN sub ON p.parent_id = sub.id
)"""

_META_COLUMNS = ("id, kind, space_type, project_id, owner_id, parent_id, task_id, title, icon, "
                 "sort_order, legacy_html, import_claimed_by, created_by, created_at, updated_at, archived_at, "
                 "LENGTH(ydoc) AS ydoc_length")


def parse_space(space: str) -> Tuple[str, Optional[str]]:
    """'me' -> ('personal', None); 'p:<id>' -> ('project', id). Raises ValueError otherwise."""
    if space == "me":
        return "personal", None
    if isinstance(space, str) and space.startswith("p:") and len(space) > 2:
        return "project", space[2:]
    raise ValueError("Space must be 'me' or 'p:<projectId>'")


def space_of(page: dict) -> str:
    return "me" if page["spaceType"] == "personal" else f"p:{page['projectId']}"


def sort_between(before: Optional[float], after: Optional[float]) -> float:
    """A sort_order that lands between two siblings (either may be None for the ends)."""
    if before is None and after is None:
        return 0.0
    if before is None:
        return after - 1.0
    if after is None:
        return before + 1.0
    return (before + after) / 2.0


def _page(row: dict) -> dict:
    length = row.get("ydoc_length")
    return {
        "id": row["id"],
        "kind": row["kind"],
        "spaceType": row["space_type"],
        "projectId": row["project_id"],
        "ownerId": row["owner_id"],
        "parentId": row["parent_id"],
        "taskId": row["task_id"],
        "title": row["title"],
        "icon": row["icon"],
        "sortOrder": row["sort_order"],
        "legacyHtml": row["legacy_html"],
        "importClaimedBy": row["import_claimed_by"],
        "hasContent": bool(length and length > EMPTY_YDOC_BYTES),
        "createdBy": row["created_by"],
        "createdAt": row["created_at"],
        "updatedAt": row["updated_at"],
        "archivedAt": row["archived_at"],
    }


def db_get_page(page_id: str) -> Optional[dict]:
    """The page without its payloads (ydoc, text); hasContent tells whether the document has content."""
    with get_db() as conn:
        row = fetchone(execute(conn, f"SELECT {_META_COLUMNS} FROM pages WHERE id = ?", (page_id,)))
    return _page(row) if row else None


def db_list_pages(space_type: str, project_id: Optional[str] = None, owner_id: Optional[str] = None,
                  archived: bool = False) -> List[dict]:
    """Every page of a space, flat and ordered by sort_order; the client builds the tree.
    Archived or live pages, never the ydoc/text/legacy_html payloads."""
    where, params = "space_type = ?", [space_type]
    if space_type == "project":
        where += " AND project_id = ?"
        params.append(project_id)
    else:
        where += " AND owner_id = ?"
        params.append(owner_id)
    where += " AND archived_at IS NOT NULL" if archived else " AND archived_at IS NULL"
    with get_db() as conn:
        rows = fetchall(execute(
            conn,
            f"SELECT id, kind, parent_id, task_id, title, icon, sort_order, archived_at FROM pages "
            f"WHERE {where} ORDER BY sort_order, created_at, id", tuple(params)))
    return [{"id": r["id"], "kind": r["kind"], "parentId": r["parent_id"], "taskId": r["task_id"],
             "title": r["title"], "icon": r["icon"], "sortOrder": r["sort_order"],
             "archivedAt": r["archived_at"]} for r in rows]


def _next_sort_order(conn, space_type: str, project_id, owner_id, parent_id) -> float:
    where, params = ["space_type = ?"], [space_type]
    where.append("project_id = ?" if space_type == "project" else "owner_id = ?")
    params.append(project_id if space_type == "project" else owner_id)
    if parent_id:
        where.append("parent_id = ?")
        params.append(parent_id)
    else:
        where.append("parent_id IS NULL")
    row = fetchone(execute(conn, f"SELECT MAX(sort_order) AS m FROM pages WHERE {' AND '.join(where)}", tuple(params)))
    return (row["m"] + 1.0) if row and row["m"] is not None else 0.0


def _check_parent(conn, page_id: Optional[str], parent_id: str, space_type: str, project_id, owner_id) -> None:
    """Raise ValueError unless parent_id is a usable parent in the same space."""
    parent = fetchone(execute(conn, "SELECT id, kind, space_type, project_id, owner_id, archived_at FROM pages WHERE id = ?",
                              (parent_id,)))
    if not parent:
        raise ValueError("Parent page not found")
    if parent["space_type"] != space_type or parent["project_id"] != project_id or parent["owner_id"] != owner_id:
        raise ValueError("Parent page is in another space")
    if parent["kind"] != "page":
        raise ValueError("A task page cannot have sub-pages")
    if parent["archived_at"]:
        raise ValueError("Parent page is archived")
    if page_id:
        inside = fetchall(execute(conn, _SUBTREE + " SELECT id FROM sub", (page_id,)))
        if parent_id in {r["id"] for r in inside}:
            raise ValueError("A page cannot be moved under itself or one of its sub-pages")


def db_create_page(space_type: str, project_id: Optional[str], owner_id: Optional[str], created_by: Optional[str],
                   title: str = "Untitled", parent_id: Optional[str] = None, icon: Optional[str] = None,
                   sort_order: Optional[float] = None, kind: str = "page", task_id: Optional[str] = None,
                   legacy_html: Optional[str] = None) -> dict:
    """Create a page (at the end of its siblings unless sort_order is given). Raises ValueError for a bad parent."""
    page_id = str(uuid.uuid4())
    now = datetime.now().isoformat()
    project_id = project_id if space_type == "project" else None
    owner_id = owner_id if space_type == "personal" else None
    with get_db() as conn:
        if parent_id:
            _check_parent(conn, None, parent_id, space_type, project_id, owner_id)
        if sort_order is None:
            sort_order = _next_sort_order(conn, space_type, project_id, owner_id, parent_id)
        execute(conn, """INSERT INTO pages (id, kind, space_type, project_id, owner_id, parent_id, task_id, title, icon,
                                            sort_order, legacy_html, created_by, created_at, updated_at)
                         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (page_id, kind, space_type, project_id, owner_id, parent_id, task_id, title, icon,
                 sort_order, legacy_html, created_by, now, now))
    return db_get_page(page_id)


_UNSET = object()


def db_update_page(page_id: str, title=_UNSET, icon=_UNSET, parent_id=_UNSET, sort_order=_UNSET) -> Optional[dict]:
    """Change title, icon, parent and/or sort_order. Moving to a new parent without a sort_order appends.
    Raises ValueError for a parent in another space, an archived or task parent, or the page's own subtree."""
    with get_db() as conn:
        row = fetchone(execute(conn, f"SELECT {_META_COLUMNS} FROM pages WHERE id = ?", (page_id,)))
        if not row:
            return None
        sets, params = [], []
        if title is not _UNSET:
            sets.append("title = ?")
            params.append(title)
        if icon is not _UNSET:
            sets.append("icon = ?")
            params.append(icon)
        if parent_id is not _UNSET and parent_id != row["parent_id"]:
            if row["kind"] == "task":
                raise ValueError("A task page cannot be moved")
            if parent_id:
                _check_parent(conn, page_id, parent_id, row["space_type"], row["project_id"], row["owner_id"])
            sets.append("parent_id = ?")
            params.append(parent_id)
            if sort_order is _UNSET:
                sort_order = _next_sort_order(conn, row["space_type"], row["project_id"], row["owner_id"], parent_id)
        if sort_order is not _UNSET:
            sets.append("sort_order = ?")
            params.append(float(sort_order))
        if sets:
            sets.append("updated_at = ?")
            params.append(datetime.now().isoformat())
            execute(conn, f"UPDATE pages SET {', '.join(sets)} WHERE id = ?", tuple(params) + (page_id,))
    return db_get_page(page_id)


def db_set_archived(page_id: str, archived: bool) -> Optional[dict]:
    """Archive or restore a page together with all its sub-pages.
    A restored page whose parent is still archived moves to the top level."""
    now = datetime.now().isoformat()
    with get_db() as conn:
        row = fetchone(execute(conn, "SELECT id, kind, parent_id FROM pages WHERE id = ?", (page_id,)))
        if not row:
            return None
        if archived and row["kind"] == "task":
            raise ValueError("A task page cannot be archived")
        execute(conn, _SUBTREE + " UPDATE pages SET archived_at = ?, updated_at = ? WHERE id IN (SELECT id FROM sub)",
                (page_id, now if archived else None, now))
        if not archived and row["parent_id"]:
            parent = fetchone(execute(conn, "SELECT archived_at FROM pages WHERE id = ?", (row["parent_id"],)))
            if parent and parent["archived_at"]:
                execute(conn, "UPDATE pages SET parent_id = NULL WHERE id = ?", (page_id,))
    return db_get_page(page_id)


def db_delete_page(page_id: str) -> bool:
    """Delete a page and its sub-pages for good (callers only allow this for archived pages)."""
    with get_db() as conn:
        cursor = execute(conn, _SUBTREE + " DELETE FROM pages WHERE id IN (SELECT id FROM sub)", (page_id,))
        return cursor.rowcount > 0


def db_get_task_page(task_id: str) -> Optional[dict]:
    with get_db() as conn:
        row = fetchone(execute(conn, f"SELECT {_META_COLUMNS} FROM pages WHERE kind = 'task' AND task_id = ?", (task_id,)))
    return _page(row) if row else None


def db_get_or_create_task_page(task_id: str, project_id: str, title: str, created_by: Optional[str]) -> dict:
    """The page of a task, created in the task's project on first use. Safe against two callers at once."""
    page = db_get_task_page(task_id)
    if page:
        return page
    try:
        return db_create_page("project", project_id, None, created_by, title=title or "Untitled",
                              kind="task", task_id=task_id)
    except Exception:
        # Lost the race against the unique index on task_id: the winner's page is there now
        page = db_get_task_page(task_id)
        if page:
            return page
        raise


def db_claim_page_import(page_id: str, user_id: str) -> bool:
    """Atomically claim the legacy-HTML import of a page. True for exactly one caller, once."""
    with get_db() as conn:
        cursor = execute(
            conn,
            """UPDATE pages SET import_claimed_by = ?
               WHERE id = ? AND import_claimed_by IS NULL AND legacy_html IS NOT NULL
                 AND (ydoc IS NULL OR LENGTH(ydoc) <= ?)""",
            (user_id, page_id, EMPTY_YDOC_BYTES))
        return cursor.rowcount == 1
