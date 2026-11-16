"""Access per tab: a person sees only the tabs they were given. Review and Lounge: those two and no Main.
The Lounge only: no tab bar at all, no Home or personal pages, and they land in the project's Lounge.

Needs the bundle: `cd web && npm run build`.
"""

from pathlib import Path

import pytest
from playwright.sync_api import expect

from e2e.e2e_support import REPO, login, wait_js

pytestmark = pytest.mark.e2e

if not Path(REPO, "static", "dist", "pages.js").exists():
    pytest.skip("web bundle not built (cd web && npm run build)", allow_module_level=True)

SIDEBAR = "[data-testid=cl-sidebar]"
TABS = "[data-testid=project-tabs]"


def give(server, project, user_id, **flags):
    server.api(f"/api/projects/{project}/access", {"userId": user_id, "canReview": False, "canTasks": False, "canLounge": False, **flags})


@pytest.fixture(scope="module")
def scene(server):
    project = server.create_project("Spot")
    server.create_page(project, "Brief")
    rita = server.create_user("rita")
    lars = server.create_user("lars")
    give(server, project, rita, canReview=True, canLounge=True)
    give(server, project, lars, canLounge=True)
    return {"project": project}


def tabs(page):
    return page.locator(f"{TABS} .cl-ptabs__tab").all_inner_texts()


def test_review_and_lounge_are_the_only_tabs_and_there_is_no_main(scene, server, new_page):
    page, project = new_page(name="rita"), scene["project"]
    login(page, server.base_url, "rita")
    page.wait_for_url("**/projects")  # the Review tab with no project open
    page.wait_for_selector(TABS, timeout=15000)
    assert tabs(page) == ["Review", "Lounge"]
    side = page.locator(SIDEBAR)
    assert side.locator("[data-testid=nav-home]").count() == 0
    assert side.locator("[data-testid=nav-personal]").count() == 0
    # the project has nothing to unfold: Tasks and the pages are the Main tab
    row = side.locator(f"[data-project-id='{project}']")
    assert row.locator("button.cl-nav__chevron").count() == 0
    row.locator("[data-testid=nav-project]").click()
    page.wait_for_url(f"**/p/{project}/review")
    wait_js(page, "AppState.activeTab === 'review'", 15000)
    assert tabs(page) == ["Review", "Lounge"]
    # a link into Main leads to the first tab she has
    page.goto(f"{server.base_url}/p/{project}/pages")
    page.wait_for_url(f"**/p/{project}/review", timeout=15000)


def test_the_lounge_only_has_no_tab_bar_and_lands_in_the_lounge(scene, server, new_page):
    page, project = new_page(name="lars"), scene["project"]
    login(page, server.base_url, "lars")
    page.wait_for_url("**/lounge", timeout=15000)
    page.wait_for_selector(SIDEBAR, timeout=15000)
    assert page.locator(TABS).count() == 0
    side = page.locator(SIDEBAR)
    assert side.locator("[data-testid=nav-home]").count() == 0
    side.locator(f"[data-project-id='{project}'] [data-testid=nav-project]").click()
    page.wait_for_url(f"**/p/{project}/lounge")
    wait_js(page, f"LoungeModule.activeChannelType === 'project' && LoungeModule.projectId === '{project}'", 15000)
    expect(page.locator(".lounge-main")).to_be_visible()
    assert page.locator(TABS).count() == 0
    # Review and Main are closed to him, also by address
    page.goto(f"{server.base_url}/p/{project}/review")
    page.wait_for_url(f"**/p/{project}/lounge", timeout=15000)
