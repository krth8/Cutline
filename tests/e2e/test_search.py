"""The search palette (Ctrl+K) in real browsers: from the Pages tab and from a legacy tab, results, commands, privacy.

Tests run in order and build on one another (shared server, one browser context per person).
"""

import time

import pytest

from e2e.e2e_support import PASSWORD, login, wait_js

pytestmark = pytest.mark.e2e

PALETTE = "[data-testid=search-palette]"
INPUT = "[data-testid=search-input]"
RESULT = "[data-testid=search-result]"


def wait_for(fn, timeout=15.0):
    end = time.time() + timeout
    last = None
    while time.time() < end:
        last = fn()
        if last:
            return last
        time.sleep(0.2)
    raise AssertionError(f"condition not met, last value: {last!r}")


def palette(page, text):
    """Open the palette with Ctrl+K, type, and wait for the answer."""
    page.keyboard.press("Control+k")
    page.wait_for_selector(INPUT, timeout=10000)
    page.fill(INPUT, text)
    return page


def result(page, text):
    return page.locator(f"{RESULT}:has-text('{text}')").first


@pytest.fixture(scope="module")
def scene(server, new_page):
    ids = {name: server.create_user(name) for name in ("alice", "bob")}
    project = server.create_project("Search Spot")
    server.grant_access(project, ids["alice"])  # alice: review and tasks
    # bob may not see the project at all
    page_id = server.create_page(project, "Quarterly roadmap")
    server.sql("UPDATE pages SET text = ? WHERE id = ?", ("The pelican migration is scheduled for March.", page_id))
    alice_token = server.api("/api/auth/login", {"username": "alice", "password": PASSWORD}, token="")["token"]
    private = server.api("/api/spaces/me/pages", {"title": "Secret diary"}, token=alice_token)["id"]
    server.sql("UPDATE pages SET text = ? WHERE id = ?", ("my private walrus thoughts", private))
    task = server.create_task(project, "Storyboard the aquarium scene")["task"]["id"]
    server.upload_png_clip(project, "shot_010_v1.png")
    wait_for(lambda: "shot_010" in server.api(f"/api/projects/{project}")["clips"])
    comment = server.api(f"/api/projects/{project}/comment",
                         {"frame": 0, "text": "Please brighten the walrus a little", "clipBaseName": "shot_010", "clipVersion": 1})
    return {"ids": ids, "project": project, "page": page_id, "task": task, "comment": comment, "private": private}


def test_ctrl_k_from_the_pages_tab_finds_a_page_by_its_text_and_opens_it(scene, server, new_page):
    page = new_page(name="alice")
    login(page, server.base_url, "alice", goto=f"/p/{scene['project']}/pages")
    page.wait_for_selector("[data-testid=sidebar-search]", timeout=20000)
    palette(page, "pelican")
    result(page, "Quarterly roadmap").wait_for(timeout=10000)
    assert "pelican" in page.inner_text(f"{RESULT}:has-text('Quarterly roadmap')")  # the snippet
    assert page.locator(f"{PALETTE} mark").first.inner_text().lower() == "pelican"
    page.keyboard.press("Enter")
    wait_js(page, f"location.pathname === '/p/{scene['project']}/page/{scene['page']}'")
    page.wait_for_selector(PALETTE, state="detached", timeout=5000)
    scene["alice"] = page


def test_a_task_is_found_and_opens_in_the_panel(scene):
    page = scene["alice"]
    palette(page, "aquarium")
    result(page, "Storyboard the aquarium scene").wait_for(timeout=10000)
    page.keyboard.press("Enter")
    page.wait_for_selector("[data-testid=task-panel]", timeout=15000)
    wait_js(page, f"location.search.includes('task={scene['task']}')")
    page.keyboard.press("Escape")


def test_ctrl_k_works_on_a_legacy_tab_and_a_comment_lands_on_its_clip(scene, server):
    page = scene["alice"]
    page.goto(f"{server.base_url}/p/{scene['project']}/review")
    wait_js(page, "AppState.activeTab === 'review' && !!AppState.currentProject", 20000)
    assert page.locator(".cl-shell").count() == 0  # the Pages shell is not mounted here
    # a text box on this tab has focus: the shortcut is not claimed by it
    page.click("#commentInput")
    palette(page, "walrus")
    result(page, "brighten the walrus").wait_for(timeout=10000)
    page.keyboard.press("Enter")
    wait_js(page, "AppState.activeTab === 'review' && !!AppState.currentClip && AppState.currentClip.baseName === 'shot_010'", 15000)
    assert "clip=shot_010" in page.url


def test_the_top_bar_button_opens_the_palette_on_a_legacy_tab(scene):
    page = scene["alice"]
    page.keyboard.press("Escape")
    page.click("#searchBtn")
    page.wait_for_selector(INPUT, timeout=5000)
    page.keyboard.press("Escape")
    page.wait_for_selector(PALETTE, state="detached", timeout=5000)


def test_a_command_creates_a_page(scene, server):
    page = scene["alice"]
    page.goto(f"{server.base_url}/p/{scene['project']}/pages")
    page.wait_for_selector("[data-testid=sidebar-search]", timeout=20000)
    before = len(server.api(f"/api/spaces/p:{scene['project']}/pages"))
    palette(page, ">new page")
    result(page, "New page").wait_for(timeout=5000)
    page.keyboard.press("Enter")
    wait_js(page, f"/^\\/p\\/{scene['project']}\\/page\\//.test(location.pathname)", 15000)
    assert len(server.api(f"/api/spaces/p:{scene['project']}/pages")) == before + 1


def test_a_personal_page_is_found_by_its_owner_only(scene, server):
    page = scene["alice"]
    page.goto(f"{server.base_url}/p/{scene['project']}/pages")
    page.wait_for_selector("[data-testid=sidebar-search]", timeout=20000)
    palette(page, "walrus")
    # inside the project the search stays in the project: the personal page is not there until the chip is off
    result(page, "brighten the walrus").wait_for(timeout=10000)
    assert page.locator(f"{RESULT}:has-text('Secret diary')").count() == 0
    page.click("[data-testid=search-scope]")
    result(page, "Secret diary").wait_for(timeout=10000)


def test_a_person_without_access_finds_nothing_of_it(scene, server, new_page):
    page = new_page(name="bob")
    login(page, server.base_url, "bob", goto="/me")
    page.wait_for_selector("[data-testid=sidebar-search]", timeout=20000)
    palette(page, "pelican")
    for word in ("pelican", "roadmap", "walrus", "diary"):
        page.fill(INPUT, word)
        page.wait_for_function("w => (document.querySelector('.cl-search__note') || {textContent: ''}).textContent.includes('No results for \"' + w + '\"')", arg=word)
        assert page.locator(RESULT).count() == 0
