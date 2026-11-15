"""page_refs (what pages mention) and the queries behind the @ menu and backlinks."""

from typing import List, Set, Tuple

from .engine import execute, fetchall
from .utils import get_db

Ref = Tuple[str, str]  # (ref_type, ref_id)


def db_replace_page_refs(page_id: str, refs: Set[Ref]) -> Set[Ref]:
    """Make `refs` the stored set of a page, in one transaction. Returns the set that was stored before."""
    with get_db() as conn:
        old = {(r["ref_type"], r["ref_id"]) for r in
               fetchall(execute(conn, "SELECT ref_type, ref_id FROM page_refs WHERE page_id = ?", (page_id,)))}
        for ref_type, ref_id in old - refs:
            execute(conn, "DELETE FROM page_refs WHERE page_id = ? AND ref_type = ? AND ref_id = ?",
                    (page_id, ref_type, ref_id))
        for ref_type, ref_id in refs - old:
            execute(conn, "INSERT INTO page_refs (page_id, ref_type, ref_id) VALUES (?, ?, ?)",
                    (page_id, ref_type, ref_id))
    return old


def db_get_page_refs(page_id: str) -> Set[Ref]:
    with get_db() as conn:
        rows = fetchall(execute(conn, "SELECT ref_type, ref_id FROM page_refs WHERE page_id = ?", (page_id,)))
    return {(r["ref_type"], r["ref_id"]) for r in rows}


def db_pages_mentioning(ref_type: str, ref_id: str) -> List[str]:
    """Ids of the unarchived pages that refer to the target (no permission check)."""
    with get_db() as conn:
        rows = fetchall(execute(conn, """
            SELECT p.id FROM page_refs r JOIN pages p ON p.id = r.page_id
            WHERE r.ref_type = ? AND r.ref_id = ? AND p.archived_at IS NULL
            ORDER BY p.updated_at DESC
        """, (ref_type, ref_id)))
    return [r["id"] for r in rows]


def _like(text: str) -> str:
    """A LIKE pattern that contains `text` literally (escape character: !)."""
    escaped = text.replace("!", "!!").replace("%", "!%").replace("_", "!_")
    return f"%{escaped}%"


def db_search_pages(query: str, project_ids: List[str], owner_id: str) -> List[dict]:
    """Unarchived pages (not task pages) whose title contains `query`, in the given projects or personal to
    `owner_id`. Newest first; the caller ranks and caps."""
    marks = ", ".join("?" for _ in project_ids) or "NULL"
    with get_db() as conn:
        rows = fetchall(execute(conn, f"""
            SELECT id, title, icon, space_type, project_id, owner_id, kind FROM pages
            WHERE archived_at IS NULL AND kind = 'page' AND title LIKE ? ESCAPE '!'
              AND ((space_type = 'project' AND project_id IN ({marks})) OR (space_type = 'personal' AND owner_id = ?))
            ORDER BY updated_at DESC LIMIT 200
        """, (_like(query), *project_ids, owner_id)))
    return rows


def db_users_sharing_projects(user_id: str) -> List[dict]:
    """The user themself plus everybody who has access to at least one project the user has access to."""
    with get_db() as conn:
        rows = fetchall(execute(conn, """
            SELECT DISTINCT u.id, u.username, u.profile_image FROM users u
            WHERE u.id = ? OR u.id IN (
                SELECT pa2.user_id FROM project_access pa1
                JOIN project_access pa2 ON pa1.project_id = pa2.project_id
                WHERE pa1.user_id = ?)
            ORDER BY u.username
        """, (user_id, user_id)))
    return rows


def db_project_people(project_id: str) -> List[dict]:
    """Everybody who can open the project: members, plus admins (who can open every project)."""
    with get_db() as conn:
        rows = fetchall(execute(conn, """
            SELECT DISTINCT u.id, u.username, u.profile_image FROM users u
            WHERE u.role = 'admin' OR u.id IN (SELECT user_id FROM project_access WHERE project_id = ?)
            ORDER BY u.username
        """, (project_id,)))
    return rows


def db_find_notification(user_id: str, notification_type: str, link: str) -> bool:
    with get_db() as conn:
        rows = fetchall(execute(conn, "SELECT id FROM notifications WHERE user_id = ? AND type = ? AND link = ? LIMIT 1",
                                (user_id, notification_type, link)))
    return bool(rows)
