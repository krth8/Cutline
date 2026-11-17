"""The dashboard of a project: its front page (the Home tab with the project open).

Every project has one page marked ``pages.system_key = 'dashboard'``. It is an ordinary page built from the
editor's blocks, so people can move, remove and add to it; it only cannot be deleted or moved out of the
project. Its blocks read the project's tasks through views that the page owns. Tasks themselves live in the
database, not on a page: there is no fixed Tasks page (migration 024 unlocks the old ones).

``ensure_dashboard_page`` is the one function that creates it: migration 024 calls it for every existing
project and ``db_create_project`` for new ones. It does nothing when the project has the page.
"""

import json
import secrets
import uuid
from datetime import datetime
from typing import Optional

from pycrdt import Doc, XmlElement, XmlFragment, XmlText

from database.engine import execute, fetchone

SYSTEM_DASHBOARD = "dashboard"
DASHBOARD_TITLE = "Dashboard"
ALL_TASKS = "All tasks"  # the view the Tasks route (/p/<id>/tasks) opens full page
FRAGMENT = "default"  # the Y.XmlFragment that Tiptap's Collaboration extension uses

VISIBLE_COLUMNS = ["name", "status", "priority", "assignees", "dueDate"]
HIDDEN_COLUMNS = ["startDate", "section", "clip", "description", "createdAt", "createdBy"]

OPEN = {"column": "status", "op": "notDone"}
MINE = {"column": "assignees", "op": "in", "value": ["@me"]}
OVERDUE = {"column": "dueDate", "op": "relative", "value": {"unit": "day", "from": -3650, "to": -1}}
BY_DUE_DATE = [{"column": "dueDate", "dir": "asc"}]


def _columns() -> list:
    return [{"key": k} for k in VISIBLE_COLUMNS] + [{"key": k, "hidden": True} for k in HIDDEN_COLUMNS]


def _views() -> list:
    """(key, name, layout, config) of the views the dashboard owns."""
    return [
        ("all", ALL_TASKS, "table", {"query": {"parentId": None}, "columns": _columns()}),
        ("open", "Open tasks", "list", {"query": {"filter": {"and": [OPEN]}, "sort": BY_DUE_DATE}}),
        ("mine", "My tasks", "list", {"query": {"filter": {"and": [MINE, OPEN]}, "sort": BY_DUE_DATE}}),
        ("overdue", "Overdue", "list", {"query": {"filter": {"and": [OPEN, OVERDUE]}, "sort": BY_DUE_DATE}}),
        ("schedule", "Schedule", "gantt", {"query": {"parentId": None}}),
    ]


def _element(parent, tag: str, **attributes) -> XmlElement:
    """Append an element (it must be in the document before its attributes are set)."""
    element = XmlElement(tag)
    parent.children.append(element)
    for key, value in attributes.items():
        if value is not None:
            element.attributes[key] = value
    return element


def _heading(fragment, text: str) -> None:
    _element(fragment, "heading", level=2).children.append(XmlText(text))


def build_document(views: dict, project_id: str) -> bytes:
    """The stored Yjs document, with the node names and attributes of the editor's blocks
    (web/src/pages/editor/blocks/*, extensions/layout.ts): progress and the key numbers beside my tasks and the
    overdue ones, then the schedule and the pages."""
    doc = Doc()
    fragment = doc.get(FRAGMENT, type=XmlFragment)

    # Top row, side by side: progress with the key numbers under it, and my tasks
    top = _element(fragment, "columns", width="wide")
    left, right = _element(top, "column"), _element(top, "column")
    _element(left, "chart", viewId=views["all"], type="donut", groupBy="status", fn="count", title="Progress")

    numbers = _element(left, "paragraph")
    for label, view, fn, last in (("Done: ", "all", "percentDone", False), ("Open tasks: ", "open", "count", False),
                                  ("Mine: ", "mine", "count", False), ("Overdue: ", "overdue", "count", True)):
        numbers.children.append(XmlText(label))
        _element(numbers, "summaryInline", viewId=views[view], fn=fn)
        if not last:
            numbers.children.append(XmlText("   ·   "))

    # a view block shows the name of its view, so these need no heading
    _element(right, "viewBlock", viewId=views["mine"])
    _element(right, "viewBlock", viewId=views["overdue"])
    _element(fragment, "viewBlock", viewId=views["schedule"], width="wide")
    _heading(fragment, "Pages")
    _element(fragment, "pageList", scope=f"p:{project_id}", limit=8)
    _element(fragment, "paragraph")  # a free line at the end to keep typing
    return doc.get_update()


def dashboard_page_id(conn, project_id: str) -> Optional[str]:
    row = fetchone(execute(conn, "SELECT id FROM pages WHERE project_id = ? AND system_key = ?",
                           (project_id, SYSTEM_DASHBOARD)))
    return row["id"] if row else None


def ensure_dashboard_page(conn, project_id: str, created_by: Optional[str] = None) -> Optional[str]:
    """Create the dashboard page and its views when the project has none. Returns the new page id, or None
    when it already existed. ``created_by`` is dropped when that user no longer exists."""
    if dashboard_page_id(conn, project_id):
        return None
    if created_by and not fetchone(execute(conn, "SELECT 1 AS x FROM users WHERE id = ?", (created_by,))):
        created_by = None
    top = fetchone(execute(conn, "SELECT MIN(sort_order) AS m FROM pages WHERE project_id = ? "
                                 "AND space_type = 'project' AND parent_id IS NULL", (project_id,)))
    sort_order = (top["m"] - 1.0) if top and top["m"] is not None else 0.0
    page_id = str(uuid.uuid4())
    now = datetime.now().isoformat()
    views = {key: secrets.token_urlsafe(9) for key, _name, _layout, _config in _views()}
    execute(conn, """INSERT INTO pages (id, kind, space_type, project_id, title, sort_order, ydoc, text,
                                        system_key, created_by, created_at, updated_at)
                     VALUES (?, 'page', 'project', ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (page_id, project_id, DASHBOARD_TITLE, sort_order, build_document(views, project_id),
             "Progress Pages", SYSTEM_DASHBOARD, created_by, now, now))
    for key, name, layout, config in _views():
        execute(conn, """INSERT INTO views (id, table_ref, name, owner_page_id, layout, config, created_by,
                                            created_at, updated_at)
                         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (views[key], f"tasks:{project_id}", name, page_id, layout, json.dumps(config), created_by, now, now))
    return page_id
