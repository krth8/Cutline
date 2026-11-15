"""One navigation: the sidebar is the only navigation on every screen (Home, Review, Tasks, a page, Lounge);
there are no top tabs; the current item is highlighted; Tasks is listed once per project; back/forward work
across legacy and bundle screens; a guest on a share link has no sidebar; phone width has a drawer.

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


def current(page):
    """The text of every highlighted item (aria-current) in the sidebar."""
    return page.evaluate(
        "(sel) => [...document.querySelectorAll(sel + ' [aria-current=page]')].map(e => e.innerText.trim().split('\\n')[0])",
        SIDEBAR,
    )


def open_project(page, project):
    row = page.locator(f"[data-project-id='{project}']")
    if row.locator(".cl-nav__chevron").get_attribute("aria-expanded") != "true":
        row.locator(".cl-nav__chevron").click()


def test_login_lands_on_home_with_the_sidebar_and_no_top_tabs(scene, server):
    page = scene["page"]
    page.wait_for_url("**/home")
    expect(page.locator(SIDEBAR)).to_be_visible()
    assert current(page) == ["Home"]
    assert page.locator(".main-tab").count() == 0
    assert page.locator(".main-tabs").count() == 0


def test_the_sidebar_stays_and_highlights_the_item_on_every_screen(scene, server):
    page, spot = scene["page"], scene["spot"]
    open_project(page, spot)

    page.click(f"[data-project-id='{spot}'] [data-testid=nav-review]")
    page.wait_for_url(f"**/p/{spot}/review")
    wait_js(page, "AppState.activeTab === 'review' && Object.keys(AppState.clips).length === 2", 15000)
    expect(page.locator(SIDEBAR)).to_be_visible()
    assert current(page) == ["Review"]

    page.click(f"[data-project-id='{spot}'] [data-testid=nav-tasks]")
    page.wait_for_url(f"**/p/{spot}/tasks")
    page.wait_for_selector("[data-testid=table-layout]", timeout=20000)
    expect(page.locator(SIDEBAR)).to_be_visible()
    assert current(page) == ["Tasks"]

    page.locator(f"[data-project-id='{spot}']").get_by_role("treeitem", name="Brief").click()
    page.wait_for_url(f"**/p/{spot}/page/{scene['brief']}")
    expect(page.locator(SIDEBAR)).to_be_visible()
    # page rows are tree items: the open one is aria-selected; no link entry is highlighted
    assert page.locator(f"{SIDEBAR} [role=treeitem][aria-selected=true]").get_attribute("aria-label") == "Brief"
    assert current(page) == []

    page.click("[data-testid=nav-lounge]")
    page.wait_for_url("**/lounge")
    wait_js(page, "AppState.activeTab === 'lounge'")
    expect(page.locator(SIDEBAR)).to_be_visible()
    assert current(page) == ["Lounge"]

    page.click("[data-testid=nav-home]")
    page.wait_for_url("**/home")
    assert current(page) == ["Home"]


def test_tasks_is_listed_once_per_project_and_not_among_the_pages(scene, server):
    page = scene["page"]
    for project in (scene["spot"], scene["other"]):
        open_project(page, project)
        row = page.locator(f"[data-project-id='{project}']")
        expect(row.get_by_role("link", name="Tasks", exact=True)).to_have_count(1)
        assert row.get_by_role("treeitem", name="Tasks", exact=True).count() == 0
    # no "Pages" label row either
    assert page.locator(f"{SIDEBAR} .cl-nav__item:text-is('Pages')").count() == 0


def test_review_from_the_sidebar_shows_only_that_projects_clips_and_still_works(scene, server):
    page, spot, other = scene["page"], scene["spot"], scene["other"]
    open_project(page, spot)
    page.click(f"[data-project-id='{spot}'] [data-testid=nav-review]")
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
    open_project(page, other)
    page.click(f"[data-project-id='{other}'] [data-testid=nav-review]")
    page.wait_for_url(f"**/p/{other}/review")
    wait_js(page, f"AppState.projectId === '{other}' && Object.keys(AppState.clips).length === 0", 15000)
    assert current(page) == ["Review"]


def test_back_and_forward_work_across_legacy_and_bundle_screens(scene, server):
    page, spot = scene["page"], scene["spot"]
    page.click("[data-testid=nav-home]")
    page.wait_for_url("**/home")
    open_project(page, spot)
    page.click(f"[data-project-id='{spot}'] [data-testid=nav-review]")
    page.wait_for_url(f"**/p/{spot}/review")
    wait_js(page, "AppState.activeTab === 'review'")
    page.click(f"[data-project-id='{spot}'] [data-testid=nav-tasks]")
    page.wait_for_url(f"**/p/{spot}/tasks")
    page.click("[data-testid=nav-lounge]")
    page.wait_for_url("**/lounge")

    page.go_back()
    page.wait_for_url(f"**/p/{spot}/tasks")
    page.wait_for_selector("[data-testid=table-layout]", timeout=20000)
    assert current(page) == ["Tasks"]
    page.go_back()
    page.wait_for_url(f"**/p/{spot}/review")
    wait_js(page, "AppState.activeTab === 'review'")
    assert current(page) == ["Review"]
    page.go_back()
    page.wait_for_url("**/home")
    assert current(page) == ["Home"]
    page.go_forward()
    page.wait_for_url(f"**/p/{spot}/review")
    wait_js(page, "AppState.activeTab === 'review'")
    assert current(page) == ["Review"]


def test_the_project_menu_offers_the_legacy_actions(scene, server):
    page, spot = scene["page"], scene["spot"]
    row = page.locator(f"[data-project-id='{spot}'] .cl-nav__projectrow")
    row.hover()
    row.locator(".cl-nav__more").click()
    page.get_by_role("menuitem", name="Share link...").click()
    expect(page.locator("#shareModal")).to_be_visible()
    page.evaluate("hideShareModal()")
    # the "+ New project" entry opens the legacy create dialog (ana is not an admin: the entry may be absent)
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


def test_a_guest_on_a_share_link_sees_no_sidebar(server, new_page, scene):
    guest = new_page(name="guest")
    open_guest(guest, server, scene["link"])
    wait_js(guest, "AppState.isShareLinkGuest === true && AppState.activeTab === 'review'", 15000)
    assert guest.locator(SIDEBAR).count() == 0
    expect(guest.locator("#clNavHost")).to_be_hidden()
    assert guest.locator(".main-tab").count() == 0


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
