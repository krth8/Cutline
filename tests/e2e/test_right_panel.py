"""The right panel: activity in Home, comments in Review, people in Lounge. One header button turns it on and
off, remembered per tab; the activity list fills in live.

Needs the bundle: `cd web && npm run build`. Tests run in order and share the server and the browsers.
"""

from pathlib import Path

import pytest
from playwright.sync_api import expect

from e2e.e2e_support import ADMIN, PASSWORD, REPO, login, wait_js

pytestmark = pytest.mark.e2e

if not Path(REPO, "static", "dist", "pages.js").exists():
    pytest.skip("web bundle not built (cd web && npm run build)", allow_module_level=True)

ACTIVITY = "[data-testid=activity-panel]"
BUTTON = "#panelToggleBtn"


@pytest.fixture(scope="module")
def scene(server, new_page):
    rita = server.create_user("rita")
    spot = server.create_project("Spot")
    server.api(f"/api/projects/{spot}/access", {"userId": rita, "canReview": True, "canTasks": True, "canLounge": True})
    server.upload_png_clip(spot, "shot_010_v1.png")
    task = server.api(f"/api/projects/{spot}/tasks", {"name": "Grade pass"})["task"]
    page = new_page(name="admin")
    login(page, server.base_url, ADMIN["username"], ADMIN["password"], goto=f"/p/{spot}/pages")
    page.wait_for_selector(ACTIVITY, timeout=20000)
    token = server.api("/api/auth/login", {"username": "rita", "password": PASSWORD}, token="")["token"]
    return {"page": page, "spot": spot, "task": task, "rita": token}


def test_home_shows_what_others_did_that_concerns_me_live(scene, server):
    page = scene["page"]
    expect(page.locator(ACTIVITY)).to_contain_text("Nothing for you yet")
    # rita moves the due date of a task the admin made
    server.api(f"/api/tasks/{scene['task']['id']}", {"dueDate": "2026-12-01"}, token=scene["rita"], method="PATCH")
    row = page.locator(f"{ACTIVITY} [data-testid=activity-event]")
    expect(row).to_have_count(1, timeout=10000)
    expect(row).to_contain_text("rita moved the due date of Grade pass")
    # the project's own tab has everything, also what I did myself
    page.get_by_role("tab", name="This project").click()
    expect(page.locator(f"{ACTIVITY} [data-testid=activity-event]")).to_have_count(2)


def test_the_button_hides_the_panel_and_the_choice_is_kept_per_tab(scene, server):
    page, spot = scene["page"], scene["spot"]
    expect(page.locator(BUTTON)).to_have_attribute("aria-pressed", "true")
    page.click(BUTTON)
    expect(page.locator(ACTIVITY)).to_be_hidden()
    expect(page.locator(BUTTON)).to_have_attribute("aria-pressed", "false")
    page.reload()
    page.wait_for_selector("[data-testid=cl-sidebar]", timeout=20000)
    expect(page.locator(ACTIVITY)).to_be_hidden()

    # Review has its own choice: the comments are still there
    page.click("[data-testid=tab-review]")
    wait_js(page, f"AppState.projectId === '{spot}' && !!AppState.currentClip", 20000)
    expect(page.locator(".sidebar-right")).to_be_visible()
    expect(page.locator(BUTTON)).to_have_attribute("aria-pressed", "true")
    page.click(BUTTON)
    wait_js(page, "document.querySelector('.app').classList.contains('comments-hidden')")
    page.click(BUTTON)
    wait_js(page, "!document.querySelector('.app').classList.contains('comments-hidden')")

    # Lounge: the people of the room
    page.click("[data-testid=tab-lounge]")
    expect(page.locator(".lounge-sidebar-right")).to_be_visible(timeout=15000)
    expect(page.locator(".lounge-sidebar-right")).to_contain_text("People")
    page.click(BUTTON)
    expect(page.locator(".lounge-sidebar-right")).to_be_hidden()
    page.click(BUTTON)
    expect(page.locator(".lounge-sidebar-right")).to_be_visible()

    # back in Home it is still off, and comes back with the button
    page.click("[data-testid=tab-main]")
    page.wait_for_url(f"**/p/{spot}/pages")
    expect(page.locator(ACTIVITY)).to_be_hidden()
    page.click(BUTTON)
    expect(page.locator(ACTIVITY)).to_be_visible()


def test_the_grid_of_projects_has_no_panel_and_no_button(scene, server):
    page = scene["page"]
    page.click("[data-testid=nav-projects]")
    page.wait_for_url("**/projects")
    expect(page.locator(ACTIVITY)).to_have_count(0)
    expect(page.locator(BUTTON)).to_be_hidden()
