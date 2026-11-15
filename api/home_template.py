"""The "My dashboard" page every user gets the first time they open Home (S4).

The page is an ordinary personal page: its stored Yjs document is built here with pycrdt, with the
node names and attributes the editor's nodes expect (web/src/pages/editor/blocks/*). The views its
blocks show are owned by the page, so they follow its privacy and go with it. Nothing here runs
again for a user who already has the page: the user edits it like any other page.
"""

from typing import Optional

from pycrdt import Doc, XmlElement, XmlFragment, XmlText

from api.pagesync import FRAGMENT, extract_text
from database.pages import db_create_page, db_write_page_snapshot
from database.views import db_create_view

DASHBOARD_TITLE = "My dashboard"
DASHBOARD_ICON = "\U0001F3E0"

ME_FILTER = {"column": "assignees", "op": "in", "value": ["@me"]}
OPEN_FILTER = {"column": "status", "op": "notDone"}
# Rolling windows of the query engine's `relative` operator: this week = today and the next six days
THIS_WEEK = {"column": "dueDate", "op": "relative", "value": {"unit": "day", "from": 0, "to": 6}}
BEFORE_TODAY = {"column": "dueDate", "op": "relative", "value": {"unit": "day", "from": -3650, "to": -1}}
BY_DUE_DATE = [{"column": "dueDate", "dir": "asc"}]


def _query(*conditions: dict, sort: Optional[list] = None) -> dict:
    query = {"filter": {"and": [ME_FILTER, OPEN_FILTER, *conditions]}}
    if sort:
        query["sort"] = sort
    return {"query": query}


def _element(parent, tag: str, **attributes) -> XmlElement:
    """Append an element to `parent` (the element must be in the document before its attributes are set)."""
    element = XmlElement(tag)
    parent.children.append(element)
    for key, value in attributes.items():
        if value is not None:
            element.attributes[key] = value
    return element


def _text(parent, text: str) -> None:
    parent.children.append(XmlText(text))


def build_document(open_view: str, week_view: str, overdue_view: str) -> Doc:
    """The dashboard's content: a row of three live numbers, the two task lists, the recent pages."""
    doc = Doc()
    fragment = doc.get(FRAGMENT, type=XmlFragment)

    heading = _element(fragment, "heading", level=2)
    _text(heading, "At a glance")

    row = _element(fragment, "paragraph")
    for label, view, last in (("Open tasks assigned to me: ", open_view, False),
                              ("Due this week: ", week_view, False),
                              ("Overdue: ", overdue_view, True)):
        _text(row, label)
        _element(row, "summaryInline", viewId=view, fn="count")
        if not last:
            _text(row, "   ·   ")

    _element(fragment, "viewBlock", viewId=open_view)
    _element(fragment, "viewBlock", viewId=week_view)

    heading = _element(fragment, "heading", level=2)
    _text(heading, "Recently changed pages")
    _element(fragment, "pageList", scope="all", limit=8)

    _element(fragment, "paragraph")  # a free line at the end to keep typing
    return doc


def create_dashboard(user: dict) -> dict:
    """Create the user's dashboard page with its views and stored document. Returns the page."""
    page = db_create_page("personal", None, user["id"], user["id"], title=DASHBOARD_TITLE, icon=DASHBOARD_ICON)
    page_id = page["id"]

    def view(name: str, layout: str, config: dict) -> str:
        return db_create_view("tasks:*", name, layout, config, page_id, user["id"])["id"]

    open_view = view("My open tasks", "list", _query(sort=BY_DUE_DATE))
    week_view = view("Due this week", "list", _query(THIS_WEEK, sort=BY_DUE_DATE))
    overdue_view = view("Overdue", "list", _query(BEFORE_TODAY, sort=BY_DUE_DATE))

    doc = build_document(open_view, week_view, overdue_view)
    db_write_page_snapshot(page_id, doc.get_update(), extract_text(doc), 0)
    return page
