"""Navigation: logging in lands on the Projects grid; choosing a project opens it, and the header then
shows its tabs (Review, Tasks, Pages, Lounge) on every screen of that project while the sidebar shows that
project's pages only. Outside a project the sidebar lists Home, the personal pages and the projects.
Back/forward work across legacy and bundle screens; a guest on a share link has neither sidebar nor tabs;
phone width has a drawer.

Needs the bundle: `cd web && npm run build`. Tests run in order and share the server and the browsers.
"""

from pathlib import Path

import pytest
from playwright.sync_api import expect

from e2e.e2e_support import REPO, login, open_guest, wait_js

pytestmark = pytest.mark.e2e

if not Path(REPO, "static", "dist", "pages.js").exists():
    pytest.skip("web bundle not built (cd web && npm run build)", allow_module_level=True)

SIDEBAR = "[data-testid=cl-sidebar]"


@pytest.fixture(scope="module")
def scene(server, new_page):
    ana = server.create_user("ana")
    spot = server.create_project("Spot")
    other = server.create_project("Other")
    for project in (spot, other):
        server.grant_access(project, ana)
    server.upload_png_clip(spot, "shot_010_v1.png")
    server.upload_png_clip(spot, "shot_020_v1.png")
    server.add_comment(spot, "Logo is too small")
    page_id = server.create_page(spot, "Brief")
    page = new_page(name="ana")
    login(page, server.base_url, "ana")
    page.wait_for_selector(SIDEBAR, timeout=15000)
    return {"page": page, "spot": spot, "other": other, "brief": page_id, "link": server.create_share_link(spot)}


TABS = "[data-testid=project-tabs]"


def current_tab(page):
    """The text of the highlighted tab of the header, or None outside a project."""
    return page.evaluate(
        "(sel) => { const e = document.querySelector(sel + ' .cl-ptabs__tab[aria-current=page]'); return e ? e.innerText.trim() : null; }",
        TABS,
    )


def current(page):
    """The text of every highlighted link (aria-current) in the sidebar."""
    return page.evaluate(
        "(sel) => [...document.querySelectorAll(sel + ' [aria-current=page]')].map(e => e.innerText.trim().split('\\n')[0])",
        SIDEBAR,
    )


def tab(page, name):
    page.click(f"{TABS} [data-testid=tab-{name}]")


def test_login_lands_on_the_projects_grid(scene, server):
    page = scene["page"]
    page.wait_for_url("**/projects")
    expect(page.locator(SIDEBAR)).to_be_visible()
    expect(page.locator("[data-testid=project-card]")).to_have_count(2)
    assert page.locator(TABS).count() == 0  # no tabs before a project is chosen
    assert page.locator(".main-tab").count() == 0


def test_choosing_a_project_opens_its_review_with_the_tabs(scene, server):
    page, spot = scene["page"], scene["spot"]
    page.click(f"[data-testid=project-card][data-project-id='{spot}']")
    page.wait_for_url(f"**/p/{spot}/review")
    wait_js(page, "AppState.activeTab === 'review' && Object.keys(AppState.clips).length === 2", 15000)
    expect(page.locator(TABS)).to_be_visible()
    assert page.inner_text("[data-testid=tabs-project-name]") == "Spot"
    assert current_tab(page) == "Review"
    assert page.locator(f"{TABS} .cl-ptabs__tab").all_inner_texts() == ["Review", "Tasks", "Pages", "Lounge"]


def test_the_tabs_stay_and_follow_every_screen_of_the_project(scene, server):
    page, spot = scene["page"], scene["spot"]
    tab(page, "tasks")
    page.wait_for_url(f"**/p/{spot}/tasks")
    page.wait_for_selector("[data-testid=table-layout]", timeout=20000)
    assert current_tab(page) == "Tasks"

    tab(page, "pages")
    page.wait_for_url(f"**/p/{spot}/pages")
    assert current_tab(page) == "Pages"

    page.locator(SIDEBAR).get_by_role("treeitem", name="Brief").click()
    page.wait_for_url(f"**/p/{spot}/page/{scene['brief']}")
    assert page.locator(f"{SIDEBAR} [role=treeitem][aria-selected=true]").get_attribute("aria-label") == "Brief"
    assert current_tab(page) == "Pages"

    tab(page, "lounge")
    page.wait_for_url(f"**/p/{spot}/lounge")
    wait_js(page, "AppState.activeTab === 'lounge'")
    wait_js(page, f"LoungeModule.activeChannelType === 'project' && LoungeModule.projectId === '{spot}'", 15000)
    expect(page.locator(".lounge-sidebar")).to_be_hidden()  # only this project's room
    assert current_tab(page) == "Lounge"
    expect(page.locator(SIDEBAR)).to_be_visible()


def test_inside_a_project_the_sidebar_shows_that_project_only(scene, server):
    page, spot, other = scene["page"], scene["spot"], scene["other"]
    side = page.locator(SIDEBAR)
    assert side.locator("[data-testid=nav-project-heading]").inner_text().strip().lower() == "spot"
    assert side.locator(f"[data-project-id='{other}']").count() == 0
    assert side.locator("[data-testid=nav-personal]").count() == 0
    # Tasks is a tab, not a page of the tree
    assert side.get_by_role("treeitem", name="Tasks", exact=True).count() == 0
    side.locator("[data-testid=nav-projects]").click()
    page.wait_for_url("**/projects")
    assert page.locator(TABS).count() == 0
    # outside a project: the personal pages and every project
    expect(side.locator("[data-testid=nav-personal]")).to_be_visible()
    expect(side.locator("[data-testid=nav-project]")).to_have_count(2)


def test_review_shows_only_that_projects_clips_and_still_works(scene, server):
    page, spot, other = scene["page"], scene["spot"], scene["other"]
    page.click(f"{SIDEBAR} [data-project-id='{spot}'] [data-testid=nav-project]")
    wait_js(page, f"AppState.projectId === '{spot}' && Object.keys(AppState.clips).length === 2", 15000)
    # the review's own panel lists the open project only: no other projects, no "New project" tile
    assert page.locator(".sidebar-left .project-item").count() == 1
    assert page.locator(".sidebar-left .project-add").count() == 0
    assert page.locator(".sidebar-left .project-name").inner_text() == "Spot"
    # comments still work
    page.fill("#commentInput", "From the new navigation")
    page.click("#submitCommentBtn")
    wait_js(page, "AppState.comments.some(c => c.text === 'From the new navigation')", 10000)
    # the other project's review loads its own clips
    page.click("[data-testid=tabs-projects]")
    page.wait_for_url("**/projects")
    page.click(f"[data-testid=project-card][data-project-id='{other}']")
    page.wait_for_url(f"**/p/{other}/review")
    wait_js(page, f"AppState.projectId === '{other}' && Object.keys(AppState.clips).length === 0", 15000)
    assert current_tab(page) == "Review"
    assert page.inner_text("[data-testid=tabs-project-name]") == "Other"


def test_back_and_forward_work_across_legacy_and_bundle_screens(scene, server):
    page, spot = scene["page"], scene["spot"]
    page.goto(server.base_url + "/home")
    page.wait_for_selector(".cl-page__title", timeout=20000)
    assert current(page) == ["Home"]
    page.click(f"{SIDEBAR} [data-project-id='{spot}'] [data-testid=nav-project]")
    page.wait_for_url(f"**/p/{spot}/review")
    wait_js(page, "AppState.activeTab === 'review'")
    tab(page, "tasks")
    page.wait_for_url(f"**/p/{spot}/tasks")
    tab(page, "lounge")
    page.wait_for_url(f"**/p/{spot}/lounge")

    page.go_back()
    page.wait_for_url(f"**/p/{spot}/tasks")
    page.wait_for_selector("[data-testid=table-layout]", timeout=20000)
    assert current_tab(page) == "Tasks"
    page.go_back()
    page.wait_for_url(f"**/p/{spot}/review")
    wait_js(page, "AppState.activeTab === 'review'")
    assert current_tab(page) == "Review"
    page.go_back()
    page.wait_for_url("**/home")
    assert current(page) == ["Home"] and current_tab(page) is None
    page.go_forward()
    page.wait_for_url(f"**/p/{spot}/review")
    wait_js(page, "AppState.activeTab === 'review'")
    assert current_tab(page) == "Review"


def test_the_general_lounge_is_outside_the_projects(scene, server):
    page = scene["page"]
    page.goto(server.base_url + "/home")
    page.wait_for_selector(".cl-page__title", timeout=20000)
    page.click("[data-testid=nav-lounge]")
    page.wait_for_url("**/lounge")
    wait_js(page, "AppState.activeTab === 'lounge'")
    expect(page.locator(".lounge-sidebar")).to_be_visible()
    assert current(page) == ["Lounge"] and current_tab(page) is None


def test_the_project_menu_offers_the_legacy_actions(scene, server):
    page, spot = scene["page"], scene["spot"]
    page.goto(server.base_url + f"/p/{spot}/pages")
    page.wait_for_selector(TABS, timeout=20000)
    page.click(f"{TABS} .cl-ptabs__more")
    page.get_by_role("menuitem", name="Share link...").click()
    expect(page.locator("#shareModal")).to_be_visible()
    page.evaluate("hideShareModal()")
    # "New project" opens the legacy create dialog (ana is not an admin: the entry may be absent)
    page.click("[data-testid=tabs-projects]")
    page.wait_for_url("**/projects")
    if page.locator("[data-testid=projects-new]").count():
        page.click("[data-testid=projects-new]")
        expect(page.locator("#projectNameInput")).to_be_visible()
        page.evaluate("hideCreateProject()")


def test_the_sidebar_collapses_and_remembers_it(scene, server):
    page = scene["page"]
    page.get_by_role("button", name="Hide sidebar").click()
    expect(page.locator(f"{SIDEBAR}.is-collapsed")).to_be_visible()
    page.reload()
    expect(page.locator(f"{SIDEBAR}.is-collapsed")).to_be_visible(timeout=15000)
    page.get_by_role("button", name="Show sidebar").click()
    expect(page.locator(f"{SIDEBAR}:not(.is-collapsed)")).to_be_visible()


def test_the_header_keeps_search_notifications_and_the_user_menu(scene, server):
    page = scene["page"]
    for selector in ("#searchBtn", "#notificationsBtn", "#userMenuBtn"):
        expect(page.locator(selector)).to_be_visible()
    page.click("#userMenuBtn")
    expect(page.locator("#settingsModal")).to_be_visible()
    page.evaluate("hideSettingsPanel()")


def test_a_guest_on_a_share_link_sees_no_sidebar_and_no_tabs(server, new_page, scene):
    guest = new_page(name="guest")
    open_guest(guest, server, scene["link"])
    wait_js(guest, "AppState.isShareLinkGuest === true && AppState.activeTab === 'review'", 15000)
    assert guest.locator(SIDEBAR).count() == 0
    expect(guest.locator("#clNavHost")).to_be_hidden()
    assert guest.locator(".main-tab").count() == 0
    assert guest.locator(TABS).count() == 0


def test_phone_width_has_a_drawer_and_home_is_not_blank(scene, server, browser):
    context = browser.new_context(viewport={"width": 420, "height": 860})
    page = context.new_page()
    try:
        login(page, server.base_url, "ana", goto="/home")
        page.wait_for_selector(".cl-page__title", timeout=20000)
        box = page.locator("#viewPages").bounding_box()
        assert box and box["width"] > 380  # Home fills the screen
        # the sidebar is a drawer, closed at first
        expect(page.locator("#clNavHost")).to_be_hidden()
        page.click("#navMenuBtn")
        expect(page.locator(SIDEBAR)).to_be_visible()
        page.click("[data-testid=nav-lounge]")
        page.wait_for_url("**/lounge")
        expect(page.locator("#clNavHost")).to_be_hidden()  # choosing an item closes it
    finally:
        context.close()
