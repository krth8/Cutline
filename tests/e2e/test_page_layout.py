"""Deleting pages from their menus, blocks side by side (columns) and the width of a block (text, wide, full).

Needs the bundle: `cd web && npm run build`. Tests run in order and share the server and the browsers.
"""

from pathlib import Path

import pytest
from playwright.sync_api import expect

from e2e.e2e_support import ADMIN, REPO, login

pytestmark = pytest.mark.e2e

if not Path(REPO, "static", "dist", "pages.js").exists():
    pytest.skip("web bundle not built (cd web && npm run build)", allow_module_level=True)

SIDEBAR = "[data-testid=cl-sidebar]"
PROSE = ".cl-editor__prose"


def pages(server, project):
    return {p["title"]: p["id"] for p in server.api(f"/api/spaces/p:{project}/pages") if not p.get("system")}


def box(page, selector):
    return page.locator(selector).first.bounding_box()


@pytest.fixture(scope="module")
def scene(server, new_page):
    spot = server.create_project("Spot")
    server.create_task(spot, "Grade pass")
    notes = server.create_page(spot, "Notes")
    server.api(f"/api/spaces/p:{spot}/pages", {"title": "Sub", "parentId": notes})
    server.create_page(spot, "Scrap")
    page = new_page(name="admin")
    page.set_viewport_size({"width": 1700, "height": 900})
    login(page, server.base_url, ADMIN["username"], ADMIN["password"], goto=f"/p/{spot}/pages")
    page.wait_for_selector(f"{PROSE} .cl-columns", timeout=20000)
    return {"page": page, "spot": spot, "notes": notes}


def test_the_dashboard_has_its_blocks_side_by_side(scene):
    page = scene["page"]
    columns = page.locator(f"{PROSE} .cl-columns > .cl-column")
    expect(columns).to_have_count(2)
    left, right = columns.nth(0).bounding_box(), columns.nth(1).bounding_box()
    assert right["x"] >= left["x"] + left["width"], "the columns are beside each other, not stacked"
    assert abs(left["y"] - right["y"]) < 4
    expect(columns.nth(0).locator(".cl-chart")).to_be_visible(timeout=15000)
    expect(columns.nth(1).locator("[data-testid=view-block]")).to_have_count(2)


def test_a_wide_block_is_wider_than_the_text_and_text_width_brings_it_back(scene):
    page = scene["page"]
    page.click("#panelToggleBtn")  # without the activity panel the page has room to spare
    expect(page.locator("[data-testid=activity-panel]")).to_be_hidden()
    page.wait_for_function("parseFloat(getComputedStyle(document.getElementById('cl-main')).getPropertyValue('--cl-avail')) > 1250")
    text = box(page, "[data-testid=page-view]")  # the column of the page: where text and ordinary blocks stay
    schedule = f"{PROSE} > .react-renderer [data-view-block]"
    expect(page.locator(schedule)).to_have_attribute("data-width", "wide")
    wide = box(page, schedule)
    assert abs(wide["width"] - 1200) < 3 and text["width"] <= 860  # wide stops at 1200 px
    # centred on the column of the page
    assert abs((wide["x"] + wide["width"] / 2) - (text["x"] + text["width"] / 2)) < 3

    def choose(label):
        page.locator(schedule).hover(position={"x": 30, "y": 12})
        page.locator(".cl-handle__grip").click()
        page.get_by_role("menuitem", name=label).click()

    choose("Text width")
    expect(page.locator(schedule)).not_to_have_attribute("data-width", "wide")
    page.wait_for_function("([sel, w]) => Math.abs(document.querySelector(sel).getBoundingClientRect().width - w) < 3",
                           arg=[schedule, text["width"]])
    choose("Full width")
    expect(page.locator(schedule)).to_have_attribute("data-width", "full")
    main = page.evaluate("(() => { const m = document.getElementById('cl-main'); const s = getComputedStyle(m);"
                         " return m.clientWidth - parseFloat(s.paddingLeft) - parseFloat(s.paddingRight); })()")
    page.wait_for_function("([sel, w]) => Math.abs(document.querySelector(sel).getBoundingClientRect().width - w) < 3",
                           arg=[schedule, main])
    # the choice is part of the page: it is still there after a reload
    page.wait_for_timeout(1500)
    page.reload()
    page.wait_for_selector(schedule, timeout=20000)
    expect(page.locator(schedule)).to_have_attribute("data-width", "full")


def test_the_slash_menu_makes_columns(scene, server):
    page, spot = scene["page"], scene["spot"]
    page.goto(f"{server.base_url}/p/{spot}/page/{scene['notes']}")
    page.wait_for_selector(PROSE, timeout=20000)
    page.click(PROSE)
    page.keyboard.type("/columns")
    page.locator("[role=option]", has_text="2 columns").click()
    page.keyboard.type("Left side")
    columns = page.locator(f"{PROSE} .cl-columns > .cl-column")
    expect(columns).to_have_count(2)
    expect(columns.nth(0)).to_have_text("Left side")
    left, right = columns.nth(0).bounding_box(), columns.nth(1).bounding_box()
    assert right["x"] >= left["x"] + left["width"]


def test_delete_in_the_tree_menu_removes_a_page_after_asking(scene, server):
    page, spot = scene["page"], scene["spot"]
    row = page.locator(f"{SIDEBAR} [role=treeitem][aria-label=Scrap]")
    row.click(button="right")
    page.get_by_role("menuitem", name="Delete", exact=True).click()
    expect(page.locator(".confirm-submit")).to_be_visible()
    page.locator(".confirm-submit").click()
    expect(row).to_have_count(0)
    assert "Scrap" not in pages(server, spot)
    assert server.api(f"/api/spaces/p:{spot}/pages?archived=1") == []  # gone, not archived


def test_delete_in_the_page_menu_takes_the_sub_pages_and_leaves_the_page(scene, server):
    page, spot = scene["page"], scene["spot"]
    assert page.url.endswith(f"/page/{scene['notes']}")
    page.get_by_role("button", name="Page menu").click()
    page.get_by_role("menuitem", name="Delete", exact=True).click()
    expect(page.locator(".confirm-modal, .confirm-dialog, [role=dialog]").filter(has_text="1 sub-page")).to_be_visible()
    page.locator(".confirm-submit").click()
    page.wait_for_url(f"**/p/{spot}/pages")
    assert pages(server, spot) == {}
    # the dashboard has no Delete: it is the project's front page
    page.wait_for_selector(f"{PROSE} .cl-columns", timeout=20000)
    page.get_by_role("button", name="Page menu").click()
    assert page.get_by_role("menuitem", name="Delete", exact=True).count() == 0
