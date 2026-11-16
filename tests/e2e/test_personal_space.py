"""The personal space: moving a page with a sub-page into a project and back, as two real users.

Needs the bundle: `cd web && npm run build`. Tests run in order and share the server and browsers.
"""

from pathlib import Path

import pytest
from playwright.sync_api import expect

from e2e.e2e_support import PASSWORD, REPO, login, wait_js

pytestmark = pytest.mark.e2e

if not Path(REPO, "static", "dist", "pages.js").exists():
    pytest.skip("web bundle not built (cd web && npm run build)", allow_module_level=True)


def tree_row(page, title):
    return page.locator(".cl-sidebar").get_by_role("treeitem", name=title, exact=True)


def watching(page):
    wait_js(page, "window.Live && Live.isConnected()", 10000)
    page.wait_for_timeout(2500)  # the watch list is sent to the server within 2 s


@pytest.fixture(scope="module")
def scene(server, new_page):
    users = {name: server.create_user(name) for name in ("ana", "ben")}
    project = server.create_project("Spot")
    for uid in users.values():
        server.grant_access(project, uid)
    token = server.api("/api/auth/login", {"username": "ana", "password": PASSWORD}, token="")["token"]
    notes = server.api("/api/spaces/me/pages", {"title": "Notes"}, token=token)
    server.api("/api/spaces/me/pages", {"title": "Details", "parentId": notes["id"]}, token=token)
    ana, ben = new_page(name="ana"), new_page(name="ben")
    login(ana, server.base_url, "ana", goto="/me")
    expect(ana.locator("[data-testid=space-overview]")).to_be_visible()
    login(ben, server.base_url, "ben", goto=f"/p/{project}/pages")
    expect(ben.locator("[data-testid=page-view]")).to_be_visible(timeout=15000)  # the project's dashboard
    watching(ana)
    watching(ben)
    return {"ana": ana, "ben": ben, "project": project, "token": token, "notes": notes["id"]}


def page_space(server, page_id, token=None):
    return server.api(f"/api/pages/{page_id}", token=token)["space"]


def test_the_personal_section_is_ana_only(scene):
    ana, ben = scene["ana"], scene["ben"]
    expect(ana.locator(".cl-sidebar").get_by_role("link", name="Personal", exact=True)).to_be_visible()
    expect(tree_row(ana, "Notes")).to_be_visible()
    assert ben.locator(".cl-sidebar").get_by_role("treeitem", name="Notes").count() == 0


def test_moving_a_personal_page_into_a_project_after_the_warning(scene, server):
    ana, ben, project = scene["ana"], scene["ben"], scene["project"]
    tree_row(ana, "Notes").hover()
    ana.get_by_role("button", name="Actions for Notes").click()
    ana.get_by_role("menuitem", name="Move to...").click()

    dialog = ana.get_by_role("dialog")
    expect(dialog).to_be_visible()
    dialog.get_by_label("Spot").check()
    warning = dialog.locator("[data-testid=move-warning]")
    expect(warning).to_contain_text("Everyone in Spot will be able to see this page and its 1 sub-page.")
    expect(warning).to_contain_text("will gain access")
    # nothing happened yet
    assert page_space(server, scene["notes"], scene["token"]) == "me"
    dialog.get_by_role("button", name="Move page").click()
    expect(dialog).to_have_count(0)

    assert page_space(server, scene["notes"], scene["token"]) == f"p:{project}"
    assert tree_row(ana, "Notes").count() == 0  # gone from the personal tree
    ana.locator(".cl-sidebar").get_by_role("link", name="Spot", exact=True).click()  # open the project in the sidebar
    expect(tree_row(ana, "Notes")).to_have_count(1)

    # ben sees it appear without a reload, with its sub-page, and can open it
    expect(tree_row(ben, "Notes")).to_be_visible()
    tree_row(ben, "Notes").get_by_role("button", name="Expand Notes").click()
    expect(tree_row(ben, "Details")).to_be_visible()
    tree_row(ben, "Notes").click()
    expect(ben.locator("[data-testid=page-view]").get_by_role("textbox", name="Page title")).to_have_value("Notes")
    expect(ben.locator(".cl-sync-status")).to_be_visible()


def test_moving_it_back_removes_it_for_ben_and_closes_his_editor(scene, server):
    ana, ben = scene["ana"], scene["ben"]
    tree_row(ana, "Notes").click()
    expect(ana.locator("[data-testid=page-view]")).to_be_visible()
    ana.get_by_role("button", name="Page menu").click()
    ana.get_by_role("menuitem", name="Move to...").click()

    dialog = ana.get_by_role("dialog")
    dialog.get_by_label("Personal space").check()
    warning = dialog.locator("[data-testid=move-warning]")
    expect(warning).to_contain_text("Only you will be able to see this page and its 1 sub-page.")
    expect(warning).to_contain_text("will lose access")
    expect(warning).to_contain_text("ben")
    dialog.get_by_role("button", name="Move page").click()

    # ana follows the page to the personal space
    expect(ana).to_have_url(f"{server.base_url}/me/page/{scene['notes']}")
    assert page_space(server, scene["notes"], scene["token"]) == "me"

    # ben: gone from the tree, and the open page is not available any more
    expect(tree_row(ben, "Notes")).to_have_count(0)
    expect(ben.get_by_text("This page is not available")).to_be_visible()
    assert ben.locator(".cl-editor__prose").count() == 0
