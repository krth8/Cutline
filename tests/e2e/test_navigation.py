"""Navigation: the header always has three tabs, Main (pages and tasks), Review and Lounge. The sidebar always
lists Home, the personal pages and every project the user has access to, each with Tasks and its pages.
Choosing a project in the sidebar decides what the tabs show; with no project open Main is Home, Review is the
grid of projects and Lounge is the general Lounge. Back/forward work across legacy and bundle screens; a guest
on a share link has neither sidebar nor tabs; phone width has a drawer.

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
    """The text of the highlighted tab of the header."""
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


def project(page, project_id):
    return page.locator(f"{SIDEBAR} [data-project-id='{project_id}']")


def test_login_lands_on_the_projects_grid_with_the_three_tabs(scene, server):
    page = scene["page"]
    page.wait_for_url("**/projects")
    expect(page.locator(SIDEBAR)).to_be_visible()
    expect(page.locator("[data-testid=project-card]")).to_have_count(2)
    assert page.locator(f"{TABS} .cl-ptabs__tab").all_inner_texts() == ["Home", "Review", "Lounge"]
    assert current_tab(page) == "Review"
    assert page.locator(".main-tab").count() == 0
    # every project of the user is in the sidebar
    expect(page.locator(f"{SIDEBAR} [data-testid=nav-project]")).to_have_count(2)


def test_choosing_a_project_opens_it_in_the_tab_that_is_showing(scene, server):
    page, spot = scene["page"], scene["spot"]
    # from the grid (the Review tab): the project's review
    page.click(f"[data-testid=project-card][data-project-id='{spot}']")
    page.wait_for_url(f"**/p/{spot}/review")
    wait_js(page, "AppState.activeTab === 'review' && Object.keys(AppState.clips).length === 2", 15000)
    assert current_tab(page) == "Review"
    # the other project from the sidebar stays in Review
    project(page, scene["other"]).locator("[data-testid=nav-project]").click()
    page.wait_for_url(f"**/p/{scene['other']}/review")
    wait_js(page, f"AppState.projectId === '{scene['other']}'", 15000)
    project(page, spot).locator("[data-testid=nav-project]").click()
    page.wait_for_url(f"**/p/{spot}/review")


def test_the_tabs_show_the_open_project(scene, server):
    page, spot = scene["page"], scene["spot"]
    tab(page, "main")
    page.wait_for_url(f"**/p/{spot}/pages")
    assert current_tab(page) == "Home"

    # the project's front page is its dashboard: an ordinary page with live blocks
    expect(page.locator("[data-testid=page-view] .cl-page__title")).to_have_value("Dashboard", timeout=20000)
    page.wait_for_selector("[data-testid=view-block]", timeout=20000)
    assert current(page) == ["Spot"]

    project(page, spot).get_by_role("treeitem", name="Brief").click()
    page.wait_for_url(f"**/p/{spot}/page/{scene['brief']}")
    assert page.locator(f"{SIDEBAR} [role=treeitem][aria-selected=true]").get_attribute("aria-label") == "Brief"
    assert current_tab(page) == "Home"

    tab(page, "lounge")
    page.wait_for_url(f"**/p/{spot}/lounge")
    wait_js(page, "AppState.activeTab === 'lounge'")
    wait_js(page, f"LoungeModule.activeChannelType === 'project' && LoungeModule.projectId === '{spot}'", 15000)
    expect(page.locator(".lounge-sidebar")).to_be_hidden()  # only this project's room
    assert current_tab(page) == "Lounge"

    tab(page, "review")
    page.wait_for_url(f"**/p/{spot}/review")
    assert current_tab(page) == "Review"


def test_a_project_has_no_fixed_tasks_entry_and_its_dashboard_is_not_a_row_of_the_tree(scene, server):
    page = scene["page"]
    tab(page, "main")  # the page trees are part of the Home tab
    for project_id in (scene["spot"], scene["other"]):
        row = project(page, project_id)
        if row.locator(".cl-nav__chevron").get_attribute("aria-expanded") != "true":
            row.locator(".cl-nav__chevron").click()
        expect(row.locator(".cl-nav__children")).to_be_visible()
        assert row.get_by_role("link", name="Tasks", exact=True).count() == 0
        assert row.get_by_role("treeitem", name="Tasks", exact=True).count() == 0
        assert row.get_by_role("treeitem", name="Dashboard", exact=True).count() == 0
    assert project(page, scene["spot"]).get_by_role("treeitem").count() == 1  # Brief


def test_with_no_project_open_the_tabs_are_the_general_screens(scene, server):
    page = scene["page"]
    page.click("[data-testid=nav-projects]")  # leaves the open project
    page.wait_for_url("**/projects")
    tab(page, "main")
    page.wait_for_url("**/home")
    assert current_tab(page) == "Home"
    tab(page, "review")
    page.wait_for_url("**/projects")
    assert current_tab(page) == "Review"
    tab(page, "lounge")
    page.wait_for_url("**/lounge")
    wait_js(page, "AppState.activeTab === 'lounge'")
    # the rooms are in the app's sidebar: the channels above the projects; the view has no list of its own
    expect(page.locator("[data-testid=nav-channels]")).to_be_visible()
    expect(page.locator(".lounge-sidebar")).to_be_hidden()
    assert current_tab(page) == "Lounge"
    tab(page, "main")
    page.wait_for_url("**/home")


def test_review_shows_only_that_projects_clips_and_still_works(scene, server):
    page, spot, other = scene["page"], scene["spot"], scene["other"]
    page.click("[data-testid=nav-projects]")
    page.click(f"[data-testid=project-card][data-project-id='{spot}']")
    wait_js(page, f"AppState.projectId === '{spot}' && Object.keys(AppState.clips).length === 2", 15000)
    # the review's own panel lists the open project only: no other projects, no "New project" tile
    # the old left panel of clips is gone: the strip at the bottom chooses the clip
    expect(page.locator(".sidebar-left")).to_be_hidden()
    expect(page.locator(".clip-bin")).to_be_visible()
    # in Review the sidebar only chooses the project: no page trees
    assert page.locator(f"{SIDEBAR} .cl-nav__children").count() == 0
    # comments still work
    page.fill("#commentInput", "From the new navigation")
    page.click("#submitCommentBtn")
    wait_js(page, "AppState.comments.some(c => c.text === 'From the new navigation')", 10000)
    # the other project's review loads its own clips
    project(page, other).locator("[data-testid=nav-project]").click()
    page.wait_for_url(f"**/p/{other}/review")
    wait_js(page, f"AppState.projectId === '{other}' && Object.keys(AppState.clips).length === 0", 15000)
    assert current_tab(page) == "Review"


def test_back_and_forward_work_across_legacy_and_bundle_screens(scene, server):
    page, spot = scene["page"], scene["spot"]
    page.goto(server.base_url + "/home")
    page.wait_for_selector(".cl-page__title", timeout=20000)
    tab(page, "review")
    page.wait_for_url("**/projects")
    page.click(f"[data-testid=project-card][data-project-id='{spot}']")
    page.wait_for_url(f"**/p/{spot}/review")
    wait_js(page, "AppState.activeTab === 'review'")
    tab(page, "main")
    page.wait_for_url(f"**/p/{spot}/pages")
    tab(page, "lounge")
    page.wait_for_url(f"**/p/{spot}/lounge")

    page.go_back()
    page.wait_for_url(f"**/p/{spot}/pages")
    assert current_tab(page) == "Home"
    page.go_back()
    page.wait_for_url(f"**/p/{spot}/review")
    wait_js(page, "AppState.activeTab === 'review'")
    assert current_tab(page) == "Review"
    page.go_back()
    page.wait_for_url("**/projects")
    page.go_back()
    page.wait_for_url("**/home")
    assert current_tab(page) == "Home"
    page.go_forward()
    page.go_forward()
    page.wait_for_url(f"**/p/{spot}/review")
    wait_js(page, "AppState.activeTab === 'review'")
    assert current_tab(page) == "Review"


def test_the_project_menu_offers_the_legacy_actions(scene, server):
    page, spot = scene["page"], scene["spot"]
    row = project(page, spot).locator(".cl-nav__projectrow")
    row.hover()
    row.locator(".cl-nav__more").click()
    page.get_by_role("menuitem", name="Share link...").click()
    expect(page.locator("#shareModal")).to_be_visible()
    page.evaluate("hideShareModal()")
    # "New project" opens the legacy create dialog (ana is not an admin: the entry may be absent)
    if page.locator("[data-testid=new-project]").count():
        page.click("[data-testid=new-project]")
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
        page.click("[data-testid=nav-personal]")
        page.wait_for_url("**/me")
        expect(page.locator("#clNavHost")).to_be_hidden()  # choosing an item closes it
    finally:
        context.close()
