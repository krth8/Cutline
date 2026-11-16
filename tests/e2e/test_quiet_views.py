"""Quiet views: a view embedded in a page shows its title and content; the controls come with hover or focus.

The Home dashboard has two lists on tasks:* (across projects). Tests run in order and share the server.
Needs the bundle: `cd web && npm run build`.
"""

from pathlib import Path

import pytest
from playwright.sync_api import expect

from e2e.e2e_support import PASSWORD, login

pytestmark = pytest.mark.e2e

from e2e.e2e_support import REPO  # noqa: E402

if not Path(REPO, "static", "dist", "pages.js").exists():
    pytest.skip("web bundle not built (cd web && npm run build)", allow_module_level=True)

BLOCK = "[data-testid=view-block]"
STRIP = "[data-testid=view-toolbar]"


def opacity(page, selector):
    return page.evaluate("(s) => getComputedStyle(document.querySelector(s)).opacity", selector)


@pytest.fixture(scope="module")
def scene(server, new_page):
    uid = server.create_user("quin")
    for name in ("Alpha", "Beta"):
        project = server.create_project(name)
        server.grant_access(project, uid)
        server.create_task(project, f"{name} task")
    page = new_page(name="quin")
    login(page, server.base_url, "quin", goto="/home")
    page.wait_for_url("**/home", timeout=15000)
    page.wait_for_selector(f"{BLOCK}[data-state=ready]", timeout=20000)
    page.wait_for_selector(f"{BLOCK} [data-testid=list-new]", timeout=20000)
    token = server.api("/api/auth/login", {"username": "quin", "password": PASSWORD}, token="")["token"]
    return {"page": page, "token": token}


def first(scene):
    return scene["page"].locator(BLOCK).first


def test_no_controls_are_visible_at_rest_and_hover_shows_them(scene):
    page = scene["page"]
    page.mouse.move(5, 5)
    page.wait_for_timeout(400)
    assert opacity(page, f"{BLOCK} {STRIP}") == "0"
    # the title line and the content are there
    expect(first(scene).locator("[data-testid=viewblock-name]")).to_have_value("My open tasks")
    expect(first(scene).locator("[data-testid=view-count]")).to_be_visible()
    first(scene).locator("[data-testid=viewblock-name]").hover()
    page.wait_for_function(f"getComputedStyle(document.querySelector('{BLOCK} {STRIP}')).opacity === '1'")
    expect(first(scene).locator("[data-testid=layout-switch]")).to_be_visible()
    expect(first(scene).locator("[data-testid=new-row]")).to_be_visible()


def test_the_strip_shows_on_keyboard_focus_too(scene):
    page = scene["page"]
    page.mouse.move(5, 5)
    first(scene).locator("[data-testid=toolbar-more]").focus()
    page.wait_for_function(f"getComputedStyle(document.querySelector('{BLOCK} {STRIP}')).opacity === '1'")
    page.evaluate("document.activeElement.blur()")


def test_changing_the_layout_from_the_dropdown_persists(scene, server):
    token = scene["token"]
    page = scene["page"]
    view_id = first(scene).get_attribute("data-view-id")
    first(scene).locator("[data-testid=viewblock-name]").hover()
    first(scene).locator("[data-testid=layout-switch]").click()
    page.locator("[data-testid=layout-board]").click()
    page.wait_for_function(f"document.querySelector('{BLOCK}').querySelector('[data-testid=board-layout], .cl-board')")
    assert server.api(f"/api/views/{view_id}", token=token)["layout"] == "board"
    page.reload()
    page.wait_for_selector(f"{BLOCK}[data-state=ready]", timeout=20000)
    expect(first(scene).locator(".cl-board").first).to_be_visible()
    # back to the list for the next tests
    first(scene).locator("[data-testid=viewblock-name]").hover()
    first(scene).locator("[data-testid=layout-switch]").click()
    page.locator("[data-testid=layout-list]").click()
    page.wait_for_selector(f"{BLOCK} [data-testid=list-new]")


def test_a_filter_chip_shows_only_when_a_filter_is_set(scene, server):
    token = scene["token"]
    page = scene["page"]
    view_id = first(scene).get_attribute("data-view-id")
    first(scene).locator("[data-testid=viewblock-name]").hover()
    # The dashboard list has a filter; clear it through the API and the chip goes away
    config = server.api(f"/api/views/{view_id}", token=token)["config"]
    query = {k: v for k, v in config.get("query", {}).items() if k != "filter"}
    server.api(f"/api/views/{view_id}", {"config": {"query": query}}, token=token, method="PATCH")
    page.reload()
    page.wait_for_selector(f"{BLOCK}[data-state=ready]", timeout=20000)
    page.wait_for_selector(f"{BLOCK} [data-testid=list-new]", timeout=20000)
    assert first(scene).locator("[data-testid=toolbar-filter]").count() == 0
    # and it comes back, with its count, once one is set
    flt = {"and": [{"column": "name", "op": "contains", "value": "task"}]}
    server.api(f"/api/views/{view_id}", {"config": {"query": {**query, "filter": flt}}}, token=token, method="PATCH")
    page.reload()
    page.wait_for_selector(f"{BLOCK}[data-state=ready]", timeout=20000)
    first(scene).locator("[data-testid=toolbar-filter]").wait_for(timeout=10000)
    expect(first(scene).locator("[data-testid=toolbar-filter]")).to_contain_text("1")


def test_adding_a_task_asks_for_the_project_only_after_clicking_new(scene):
    page = scene["page"]
    block = first(scene)
    block.locator("[data-testid=viewblock-name]").hover()
    assert block.locator(".cl-addproject").count() == 0
    assert page.locator("[data-testid=new-row-project]").count() == 0
    block.locator("[data-testid=new-row]").click()
    expect(page.locator("[data-testid=new-row-title]")).to_be_visible()
    expect(page.locator("[data-testid=new-row-project]")).to_be_visible()
    page.keyboard.press("Escape")
    # the quick-add line of the list shows the picker once it has focus
    block.locator("[data-testid=list-new]").click()
    expect(block.locator(".cl-addproject")).to_be_visible()
