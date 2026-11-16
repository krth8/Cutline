"""The page tree in the sidebar and the page view: create, rename, move, archive, permissions.

Two real users in one project (plus a viewer-role member) drive the React bundle against the real
server. Tests run in order and build on one another (shared server and browser contexts).
Needs the bundle: `cd web && npm run build`.
"""

import json
from pathlib import Path

import pytest
from playwright.sync_api import expect

from e2e.e2e_support import ADMIN, REPO, login, wait_js

pytestmark = pytest.mark.e2e

if not Path(REPO, "static", "dist", "pages.js").exists():
    pytest.skip("web bundle not built (cd web && npm run build)", allow_module_level=True)


# ---------- helpers ----------

def space_pages(server, project, archived=False):
    return server.api(f"/api/spaces/p:{project}/pages" + ("?archived=1" if archived else ""))


def titles(server, project, parent=None, archived=False):
    """Titles of the children of `parent` (None = top level) in order, from the API."""
    ids = {p["id"] for p in space_pages(server, project, archived)}
    pages = [p for p in space_pages(server, project, archived)
             if p["parentId"] == parent or (parent is None and p["parentId"] not in ids)]
    return [p["title"] for p in sorted(pages, key=lambda p: p["sortOrder"])]


def page_id(server, project, title, archived=False):
    return next(p["id"] for p in space_pages(server, project, archived) if p["title"] == title)


def tree_row(page, title):
    return page.locator(".cl-sidebar").get_by_role("treeitem", name=title, exact=True)


def project_tree(page, project):
    return page.locator(f'.cl-tree[data-space="p:{project}"]')


def title_field(page):
    return page.locator("[data-testid=page-view]").get_by_role("textbox", name="Page title")


def open_project_pages(page, server, project, user=None, password=None):
    if user:
        login(page, server.base_url, user, goto=f"/p/{project}/pages")
    expect(page.locator("[data-testid=space-overview]")).to_be_visible()
    wait_js(page, "window.Live && Live.isConnected()", 10000)
    page.wait_for_timeout(2500)  # the watch list is sent to the server within 2 s


def wait_top_level(page, expected):
    """Wait until the top-level rows of the sidebar tree read `expected` (in order)."""
    page.wait_for_function(
        "expected => [...document.querySelectorAll('.cl-sidebar [role=treeitem][aria-level=\"1\"]')]"
        ".map(e => e.getAttribute('aria-label')).join() === expected.join()", arg=expected)


def drop_on(page, source_title, target_title, where):
    """Drag a tree row onto another: where is 'before', 'inside' or 'after' (rows are about 28 px high)."""
    y = {"before": 3, "inside": 14, "after": 25}[where]
    tree_row(page, source_title).drag_to(tree_row(page, target_title), target_position={"x": 60, "y": y})


@pytest.fixture(scope="module")
def scene(server, new_page):
    users = {name: server.create_user(name) for name in ("ana", "ben", "vera")}
    server.api(f"/api/admin/users/{users['vera']}", {"role": "viewer"}, method="PATCH")
    project = server.create_project("Spot")
    for uid in users.values():
        server.grant_access(project, uid)
    # These tests are about ordinary pages and start from an empty tree: take the Tasks page every project
    # gets (T13) out of the database. Its own behaviour is tested in test_tasks_tab.py and tests/test_tasks_page.py.
    server.sql("DELETE FROM views WHERE owner_page_id IN (SELECT id FROM pages WHERE project_id = ? AND system_key = 'tasks')", (project,))
    server.sql("DELETE FROM pages WHERE project_id = ? AND system_key = 'tasks'", (project,))
    ana = new_page(name="ana")
    ben = new_page(name="ben")
    login(ana, server.base_url, "ana", goto=f"/p/{project}/pages")
    open_project_pages(ana, server, project)
    login(ben, server.base_url, "ben", goto=f"/p/{project}/pages")
    open_project_pages(ben, server, project)
    return {"ana": ana, "ben": ben, "project": project, "users": users}


# ---------- tests ----------

def test_create_nested_pages_through_the_ui(scene, server):
    ana, project = scene["ana"], scene["project"]
    expect(ana.locator("[data-testid=space-overview]").get_by_text("No pages yet.")).to_be_visible()

    ana.locator("[data-testid=space-overview]").get_by_role("button", name="Create the first page").click()
    expect(title_field(ana)).to_be_focused()  # a new page asks for its title straight away
    ana.keyboard.type("Plan")
    ana.keyboard.press("Enter")
    expect(tree_row(ana, "Plan")).to_be_visible()
    expect(tree_row(ana, "Plan")).to_have_attribute("aria-selected", "true")

    tree_row(ana, "Plan").hover()
    ana.get_by_role("button", name="Add subpage to Plan").click()
    expect(title_field(ana)).to_be_focused()
    ana.keyboard.type("Budget")
    ana.keyboard.press("Enter")
    expect(tree_row(ana, "Budget")).to_be_visible()

    # a third level through the page menu
    ana.get_by_role("button", name="Page menu").click()
    ana.get_by_role("menuitem", name="Add subpage").click()
    expect(title_field(ana)).to_be_focused()
    ana.keyboard.type("Q1")
    ana.keyboard.press("Tab")
    expect(tree_row(ana, "Q1")).to_be_visible()

    assert titles(server, project) == ["Plan"]
    assert titles(server, project, page_id(server, project, "Plan")) == ["Budget"]
    assert titles(server, project, page_id(server, project, "Budget")) == ["Q1"]
    # the breadcrumbs of the open page: space > Plan > Budget > Q1
    crumbs = ana.get_by_role("navigation", name="Breadcrumb")
    expect(crumbs).to_contain_text("Spot")
    expect(crumbs.get_by_role("link", name="Plan")).to_be_visible()
    expect(crumbs.get_by_role("link", name="Budget")).to_be_visible()
    expect(ana).to_have_title("Q1 - Cutline")


def test_second_user_sees_the_tree_and_a_rename_without_reload(scene, server):
    ana, ben, project = scene["ana"], scene["ben"], scene["project"]
    expect(tree_row(ben, "Plan")).to_be_visible()  # the creation arrived live
    tree_row(ben, "Plan").get_by_role("button", name="Expand Plan").click()
    expect(tree_row(ben, "Budget")).to_be_visible()

    ana.get_by_role("link", name="Budget").click()  # breadcrumb: back to Budget
    expect(title_field(ana)).to_have_value("Budget")
    title_field(ana).fill("Budget 2025")
    ana.keyboard.press("Enter")
    expect(tree_row(ben, "Budget 2025")).to_be_visible()
    assert "Budget 2025" in titles(server, project, page_id(server, project, "Plan"))

    # an icon change reaches the other user as well
    ana.get_by_role("button", name="Add icon").click()
    ana.get_by_role("button", name="Icon \U0001F680").click()
    expect(tree_row(ben, "Budget 2025")).to_contain_text("\U0001F680")


def test_inline_rename_in_the_sidebar(scene, server):
    ana, ben, project = scene["ana"], scene["ben"], scene["project"]
    tree_row(ana, "Budget 2025").focus()
    ana.keyboard.press("F2")
    ana.keyboard.press("Control+a")
    ana.keyboard.type("Budget")
    ana.keyboard.press("Enter")
    expect(tree_row(ben, "Budget")).to_be_visible()
    # Escape leaves the title alone
    tree_row(ana, "Budget").dblclick()
    ana.keyboard.type("Other")
    ana.keyboard.press("Escape")
    expect(tree_row(ana, "Budget")).to_be_visible()
    assert "Budget" in titles(server, project, page_id(server, project, "Plan"))


def test_drag_to_reorder_and_to_nest_survives_a_reload(scene, server):
    ana, ben, project = scene["ana"], scene["ben"], scene["project"]
    for name in ("Alpha", "Beta", "Gamma"):
        server.api(f"/api/spaces/p:{project}/pages", {"title": name})
    expect(tree_row(ana, "Gamma")).to_be_visible()
    assert titles(server, project) == ["Plan", "Alpha", "Beta", "Gamma"]

    drop_on(ana, "Gamma", "Alpha", "before")
    wait_top_level(ana, ["Plan", "Gamma", "Alpha", "Beta"])
    wait_top_level(ben, ["Plan", "Gamma", "Alpha", "Beta"])  # and the other user sees the new order
    assert titles(server, project) == ["Plan", "Gamma", "Alpha", "Beta"]

    drop_on(ana, "Beta", "Alpha", "inside")
    expect(tree_row(ana, "Beta")).to_have_attribute("aria-level", "2")
    assert titles(server, project, page_id(server, project, "Alpha")) == ["Beta"]
    assert titles(server, project) == ["Plan", "Gamma", "Alpha"]

    # dropping a page into its own subtree is refused: nothing changes
    drop_on(ana, "Alpha", "Beta", "inside")
    ana.wait_for_timeout(500)
    assert titles(server, project) == ["Plan", "Gamma", "Alpha"]

    ana.reload()
    expect(tree_row(ana, "Beta")).to_be_visible()  # remembered as expanded
    labels = ana.locator(".cl-sidebar [role=treeitem]").evaluate_all(
        "els => els.map(e => e.getAttribute('aria-label') + ':' + e.getAttribute('aria-level'))")
    assert labels.index("Gamma:1") < labels.index("Alpha:1") < labels.index("Beta:2")


def test_archive_hides_the_subtree_for_both_and_restore_brings_it_back(scene, server):
    ana, ben, project = scene["ana"], scene["ben"], scene["project"]
    expect(tree_row(ben, "Alpha")).to_be_visible()
    tree_row(ana, "Alpha").hover()
    ana.get_by_role("button", name="Actions for Alpha").click()
    ana.get_by_role("menuitem", name="Archive").click()
    expect(tree_row(ana, "Alpha")).to_have_count(0)
    expect(tree_row(ben, "Alpha")).to_have_count(0)
    expect(tree_row(ben, "Beta")).to_have_count(0)
    assert {p["title"] for p in space_pages(server, project, archived=True)} == {"Alpha", "Beta"}

    # ben restores it from the Archived list
    project_tree(ben, project).get_by_role("button", name="More page options").click()
    ben.get_by_role("menuitem", name="Archived pages").click()
    dialog = ben.get_by_role("dialog")
    expect(dialog.get_by_text("Alpha")).to_be_visible()
    dialog.get_by_role("button", name="Restore Alpha").click()
    expect(dialog.get_by_text("No archived pages.")).to_be_visible()
    dialog.get_by_role("button", name="Close", exact=True).last.click()
    expect(tree_row(ben, "Alpha")).to_be_visible()
    expect(tree_row(ana, "Alpha")).to_be_visible()
    expect(tree_row(ana, "Beta")).to_be_visible()  # the sub-page came back with it


def test_delete_forever_removes_the_page_for_everyone(scene, server):
    ana, ben, project = scene["ana"], scene["ben"], scene["project"]
    server.api(f"/api/pages/{page_id(server, project, 'Gamma')}", {"archived": True}, method="PATCH")
    expect(tree_row(ana, "Gamma")).to_have_count(0)

    project_tree(ana, project).get_by_role("button", name="More page options").click()
    ana.get_by_role("menuitem", name="Archived pages").click()
    dialog = ana.get_by_role("dialog")
    dialog.get_by_role("button", name="Delete Gamma forever").click()
    ana.locator(".confirm-submit").click()  # the legacy confirm dialog behind platform.confirm
    expect(dialog.get_by_text("No archived pages.")).to_be_visible()
    dialog.get_by_role("button", name="Close", exact=True).last.click()
    assert titles(server, project, archived=True) == []
    assert "Gamma" not in titles(server, project)
    expect(tree_row(ben, "Gamma")).to_have_count(0)


def test_archiving_the_open_page_shows_the_banner_and_restore_works(scene, server):
    ana, project = scene["ana"], scene["project"]
    tree_row(ana, "Alpha").click()
    expect(title_field(ana)).to_have_value("Alpha")
    ana.get_by_role("button", name="Page menu").click()
    ana.get_by_role("menuitem", name="Archive").click()
    expect(ana.get_by_text("This page is archived.")).to_be_visible()
    expect(title_field(ana)).to_have_count(0)
    ana.get_by_role("button", name="Restore", exact=True).click()
    expect(ana.get_by_text("This page is archived.")).to_have_count(0)
    expect(title_field(ana)).to_have_value("Alpha")
    expect(tree_row(ana, "Alpha")).to_be_visible()
    assert "Alpha" in titles(server, project)


def test_viewer_sees_the_tree_without_edit_affordances(scene, server, new_page):
    project = scene["project"]
    vera = new_page(name="vera")
    login(vera, server.base_url, "vera", goto=f"/p/{project}/pages")
    expect(vera.locator("[data-testid=space-overview]")).to_be_visible()
    expect(tree_row(vera, "Plan")).to_be_visible()
    assert vera.locator("[data-testid=space-overview]").get_by_role("button", name="New page").count() == 0
    assert project_tree(vera, project).get_by_role("button", name="New page").count() == 0
    tree_row(vera, "Plan").hover()
    assert vera.get_by_role("button", name="Add subpage to Plan").count() == 0
    assert vera.get_by_role("button", name="Actions for Plan").count() == 0
    assert tree_row(vera, "Plan").get_attribute("draggable") == "false"

    tree_row(vera, "Plan").click()
    expect(vera.locator("[data-testid=page-view]").get_by_role("heading", name="Plan")).to_be_visible()
    assert title_field(vera).count() == 0
    vera.get_by_role("button", name="Page menu").click()
    assert vera.get_by_role("menuitem").count() == 5  # History, the three export entries and Copy link
    # the server agrees
    status = vera.evaluate(
        "fetch('/api/spaces/p:" + project + "/pages', {method: 'POST', headers: {'Content-Type': 'application/json'},"
        " body: '{}'}).then(r => r.status)")
    assert status == 403


def test_personal_pages_are_private(scene, server, new_page):
    ana, ben = scene["ana"], scene["ben"]
    # ana creates a personal page through the UI
    # inside a project the sidebar shows that project only: the personal space is reached from outside it
    ana.locator(".cl-sidebar").get_by_role("link", name="All projects", exact=True).click()
    ana.locator(".cl-sidebar").get_by_role("link", name="Personal", exact=True).click()
    expect(ana.locator("[data-testid=space-overview]")).to_contain_text("Personal space")
    ana.locator("[data-testid=space-overview]").get_by_role("button", name="Create the first page").click()
    expect(title_field(ana)).to_be_focused()
    ana.keyboard.type("Diary")
    ana.keyboard.press("Enter")
    expect(tree_row(ana, "Diary")).to_be_visible()
    diary = ana.evaluate("location.pathname.split('/').pop()")

    # ben has no such page, and neither can he open it
    ben.locator(".cl-sidebar").get_by_role("link", name="All projects", exact=True).click()
    ben.locator(".cl-sidebar").get_by_role("link", name="Personal", exact=True).click()
    expect(ben.locator("[data-testid=space-overview]")).to_contain_text("No pages yet.")
    assert ben.locator(".cl-sidebar").get_by_role("treeitem", name="Diary").count() == 0
    ben.goto(f"{server.base_url}/me/page/{diary}")
    expect(ben.get_by_text("This page is not available")).to_be_visible()
    expect(ben.get_by_role("link", name="Back to Personal space")).to_be_visible()

    # an admin is no exception
    admin = new_page(name="admin")
    login(admin, server.base_url, ADMIN["username"], ADMIN["password"], goto=f"/me/page/{diary}")
    expect(admin.get_by_text("This page is not available")).to_be_visible()
    admin.goto(f"{server.base_url}/me")
    expect(admin.locator("[data-testid=space-overview]")).to_contain_text("No pages yet.")


def test_deep_link_opens_the_page_with_ancestors_expanded(scene, server, new_page, browser):
    project = scene["project"]
    q1 = page_id(server, project, "Q1")
    ctx = browser.new_context()  # fresh storage: nothing is remembered as expanded
    page = new_page(ctx, name="deeplink")
    login(page, server.base_url, "ben", goto=f"/p/{project}/page/{q1}")
    expect(title_field(page)).to_have_value("Q1")
    expect(tree_row(page, "Q1")).to_have_attribute("aria-selected", "true")
    expect(tree_row(page, "Plan")).to_have_attribute("aria-expanded", "true")
    expect(tree_row(page, "Budget")).to_have_attribute("aria-expanded", "true")
    assert json.loads(page.evaluate(f"localStorage.getItem('cl-pages-expanded:p:{project}')"))


def test_a_page_deleted_while_open_is_not_available(scene, server):
    ben, project = scene["ben"], scene["project"]
    ben.goto(f"{server.base_url}/p/{project}/pages")
    open_project_pages(ben, server, project)
    doomed = server.api(f"/api/spaces/p:{project}/pages", {"title": "Doomed"})["id"]
    ben.locator(".cl-sidebar").get_by_role("treeitem", name="Doomed", exact=True).click()
    expect(title_field(ben)).to_have_value("Doomed")
    server.api(f"/api/pages/{doomed}", {"archived": True}, method="PATCH")
    expect(ben.get_by_text("This page is archived.")).to_be_visible()
    server.api(f"/api/pages/{doomed}", method="DELETE")
    expect(ben.get_by_text("This page is not available")).to_be_visible()
    ben.get_by_role("link", name="Back to Spot").click()
    expect(ben.locator("[data-testid=space-overview]")).to_be_visible()
