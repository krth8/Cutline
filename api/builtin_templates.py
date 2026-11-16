"""Built-in page templates (H4): defined in code, always listed, never stored and never deleted.

Each template is built with the same server-side pieces as the "My dashboard" page (api/home_template.py):
a pycrdt document with the editor's node names, and views owned by the new page. A task list in a project
page reads that project's tasks (`tasks:<projectId>`); in the personal space it reads `tasks:*` for me.
"""

from typing import Callable, Dict, List, Optional

from pycrdt import Doc, XmlFragment

from api.home_template import BEFORE_TODAY, BY_DUE_DATE, ME_FILTER, OPEN_FILTER, THIS_WEEK, _element, _text
from api.pagesync import FRAGMENT, extract_text
from api.tables import custom_source
from database.mentions import db_replace_page_refs
from database.pages import db_create_page, db_write_page_snapshot
from database.table_columns import db_list_table_columns
from database.views import db_create_view


class Target:
    """Where a built-in template lands and who creates it."""

    def __init__(self, user: dict, space_type: str, project_id: Optional[str], parent_id: Optional[str],
                 sort_order: Optional[float] = None):
        self.user = user
        self.space_type = space_type
        self.project_id = project_id
        self.parent_id = parent_id
        self.sort_order = sort_order

    @property
    def space(self) -> str:
        return "me" if self.space_type == "personal" else f"p:{self.project_id}"

    @property
    def tasks_ref(self) -> str:
        return "tasks:*" if self.space_type == "personal" else f"tasks:{self.project_id}"

    def conditions(self, *extra: dict, mine: bool = False) -> list:
        """Open tasks; only mine in the personal space or when ``mine`` is set, else everybody's."""
        base = [ME_FILTER, OPEN_FILTER] if (mine or not self.project_id) else [OPEN_FILTER]
        return [*base, *extra]

    def page(self, title: str, icon: Optional[str] = None) -> dict:
        return db_create_page(self.space_type, self.project_id, self.user["id"] if self.space_type == "personal" else None,
                              self.user["id"], title=title, parent_id=self.parent_id, icon=icon,
                              sort_order=self.sort_order)

    def view(self, page_id: str, ref: str, name: str, layout: str, config: dict) -> str:
        return db_create_view(ref, name, layout, config, page_id, self.user["id"])["id"]


def _heading(fragment, text: str, level: int = 2) -> None:
    _text(_element(fragment, "heading", level=level), text)


def _bullets(fragment) -> None:
    item = _element(_element(fragment, "bulletList"), "listItem")
    _element(item, "paragraph")


def _store(page: dict, doc: Doc) -> None:
    db_write_page_snapshot(page["id"], doc.get_update(), extract_text(doc), 0)
    db_replace_page_refs(page["id"], set())


def _new_doc():
    doc = Doc()
    return doc, doc.get(FRAGMENT, type=XmlFragment)


def _task_list(target: Target, page_id: str, name: str, *conditions: dict, layout: str = "list",
               extra: Optional[dict] = None, mine: bool = False) -> str:
    config = {"query": {"filter": {"and": target.conditions(*conditions, mine=mine)}, "sort": BY_DUE_DATE},
              **(extra or {})}
    return target.view(page_id, target.tasks_ref, name, layout, config)


# ---------------------------------------------------------------- the templates

async def blank(target: Target, title: Optional[str]) -> dict:
    return target.page(title or "Untitled")


async def meeting_notes(target: Target, title: Optional[str]) -> dict:
    page = target.page(title or "Meeting notes", "\U0001F4DD")
    doc, fragment = _new_doc()
    _heading(fragment, "Attendees")
    _bullets(fragment)
    _heading(fragment, "Agenda")
    _bullets(fragment)
    _heading(fragment, "Notes")
    _element(fragment, "paragraph")
    _heading(fragment, "Action items")
    view = _task_list(target, page["id"], "Open tasks")
    _element(fragment, "viewBlock", viewId=view)
    _element(fragment, "paragraph")
    _store(page, doc)
    return page


async def project_brief(target: Target, title: Optional[str]) -> dict:
    page = target.page(title or "Project brief", "\U0001F3AF")
    doc, fragment = _new_doc()
    _heading(fragment, "Goal")
    _element(fragment, "paragraph")
    _heading(fragment, "Scope")
    _bullets(fragment)
    _heading(fragment, "Timeline")
    view = _task_list(target, page["id"], "Timeline", layout="gantt",
                      extra={"gantt": {"startColumn": "startDate", "endColumn": "dueDate", "scale": "week"}})
    _element(fragment, "viewBlock", viewId=view)
    _heading(fragment, "Team")
    _bullets(fragment)
    _store(page, doc)
    return page


async def shot_list(target: Target, title: Optional[str]) -> dict:
    page = target.page(title or "Shot list", "\U0001F3AC")
    table = await custom_source.create_table(target.user, {
        "name": page["title"], "space": target.space,
        "columns": [
            {"name": "Description", "type": "text"},
            {"name": "Status", "type": "select",
             "options": [{"label": "Planned", "color": "#9ca3af"}, {"label": "Shot", "color": "#3b82f6"},
                         {"label": "Approved", "color": "#22c55e"}]},
            {"name": "Assignee", "type": "person"},
            {"name": "Due date", "type": "date"},
        ]})
    keys = {c["name"]: c["key"] for c in db_list_table_columns(table["ref"])}
    # The shot is the row's own name: the title every layout, link and search shows. A separate "Shot" column
    # beside a hidden name made a row look empty as soon as the layout changed.
    columns = ([{"key": "name"}] + [{"key": keys[n]} for n in ("Description", "Status", "Assignee", "Due date")]
               + [{"key": "createdAt", "hidden": True}, {"key": "createdBy", "hidden": True}])
    view = target.view(page["id"], table["ref"], "Shots", "table", {"query": {}, "columns": columns})
    doc, fragment = _new_doc()
    _element(fragment, "viewBlock", viewId=view)
    _element(fragment, "paragraph")
    _store(page, doc)
    return page


async def weekly_plan(target: Target, title: Optional[str]) -> dict:
    page = target.page(title or "Weekly plan", "\U0001F4C5")
    doc, fragment = _new_doc()
    _heading(fragment, "My tasks due this week")
    week = _task_list(target, page["id"], "Due this week", THIS_WEEK, mine=True)
    _element(fragment, "viewBlock", viewId=week)
    _heading(fragment, "Overdue")
    overdue = _task_list(target, page["id"], "Overdue", BEFORE_TODAY, mine=True)
    _element(fragment, "viewBlock", viewId=overdue)
    _heading(fragment, "Notes")
    _element(fragment, "paragraph")
    _store(page, doc)
    return page


Builder = Callable[[Target, Optional[str]], object]

BUILTIN: List[dict] = [
    {"id": "builtin:blank", "name": "Blank page", "description": "An empty page.", "icon": "\U0001F4C4", "build": blank},
    {"id": "builtin:meeting-notes", "name": "Meeting notes",
     "description": "Attendees, agenda, notes and a list of open tasks for action items.",
     "icon": "\U0001F4DD", "build": meeting_notes},
    {"id": "builtin:project-brief", "name": "Project brief",
     "description": "Goal, scope, a timeline of the tasks and the team.", "icon": "\U0001F3AF", "build": project_brief},
    {"id": "builtin:shot-list", "name": "Shot list",
     "description": "A table with shot, description, status, assignee and due date.",
     "icon": "\U0001F3AC", "build": shot_list},
    {"id": "builtin:weekly-plan", "name": "Weekly plan",
     "description": "Your tasks due this week and overdue, and a notes section.", "icon": "\U0001F4C5",
     "build": weekly_plan},
]
BY_ID: Dict[str, dict] = {t["id"]: t for t in BUILTIN}
