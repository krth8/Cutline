"""The "Tasks" page of a project (PLAN.md T13).

Every project has one page, marked by ``pages.system_key = 'tasks'``, that holds a single view block: a
table view of the project's tasks. The page is pinned first in the project's tree and cannot be deleted
or moved to another space; otherwise it is an ordinary page (people can add text and more views).

``ensure_tasks_page`` is the one function that creates it. Migration 013 calls it for every existing
project and ``db_create_project`` calls it for new ones. It does nothing when the project has the page.
"""

import json
import secrets
import uuid
from datetime import datetime
from typing import Optional

from pycrdt import Doc, XmlElement, XmlFragment

from database.engine import execute, fetchone

SYSTEM_TASKS = "tasks"
TASKS_TITLE = "Tasks"
FRAGMENT = "default"  # the Y.XmlFragment that Tiptap's Collaboration extension uses

# What the old task list showed by default (PropertyRegistry.getDefaultColumns), in that order. The other
# builtin columns are kept in the view but hidden. The old list had no grouping by default, so there is none.
VISIBLE_COLUMNS = ["name", "status", "priority", "assignees", "dueDate", "stage"]
HIDDEN_COLUMNS = ["startDate", "section", "clip", "description", "createdAt", "createdBy"]


def default_view_config() -> dict:
    """Subtasks nested under their parent (parentId null = top-level rows, children load on expand)."""
    columns = [{"key": k} for k in VISIBLE_COLUMNS] + [{"key": k, "hidden": True} for k in HIDDEN_COLUMNS]
    return {"query": {"parentId": None}, "columns": columns}


def build_page_document(view_id: str) -> bytes:
    """A stored Yjs document: one ``viewBlock`` node (attribute viewId) and an empty paragraph after it,
    in the XmlFragment the editor uses. The same shape the browser editor writes."""
    doc = Doc()
    frag = doc.get(FRAGMENT, type=XmlFragment)
    frag.children.append(XmlElement("viewBlock", {"viewId": view_id}))
    frag.children.append(XmlElement("paragraph"))
    return doc.get_update()


def tasks_page_id(conn, project_id: str) -> Optional[str]:
    row = fetchone(execute(conn, "SELECT id FROM pages WHERE project_id = ? AND system_key = ?",
                           (project_id, SYSTEM_TASKS)))
    return row["id"] if row else None


def ensure_tasks_page(conn, project_id: str, created_by: Optional[str] = None) -> Optional[str]:
    """Create the Tasks page and its view when the project has none. Returns the new page id, or None
    when it already existed. ``created_by`` is dropped when that user no longer exists."""
    if tasks_page_id(conn, project_id):
        return None
    if created_by and not fetchone(execute(conn, "SELECT 1 AS x FROM users WHERE id = ?", (created_by,))):
        created_by = None
    top = fetchone(execute(conn, "SELECT MIN(sort_order) AS m FROM pages WHERE project_id = ? "
                                 "AND space_type = 'project' AND parent_id IS NULL", (project_id,)))
    sort_order = (top["m"] - 1.0) if top and top["m"] is not None else 0.0
    page_id, view_id = str(uuid.uuid4()), secrets.token_urlsafe(9)
    now = datetime.now().isoformat()
    execute(conn, """INSERT INTO pages (id, kind, space_type, project_id, title, sort_order, ydoc, text,
                                        system_key, created_by, created_at, updated_at)
                     VALUES (?, 'page', 'project', ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (page_id, project_id, TASKS_TITLE, sort_order, build_page_document(view_id), "",
             SYSTEM_TASKS, created_by, now, now))
    execute(conn, """INSERT INTO views (id, table_ref, name, owner_page_id, layout, config, created_by,
                                        created_at, updated_at)
                     VALUES (?, ?, ?, ?, 'table', ?, ?, ?, ?)""",
            (view_id, f"tasks:{project_id}", TASKS_TITLE, page_id, json.dumps(default_view_config()),
             created_by, now, now))
    return page_id
