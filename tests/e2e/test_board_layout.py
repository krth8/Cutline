"""Board layout: drag a card to another column (a second user sees it live), quick add in a column,
and a collapsed column stays collapsed after a reload. The view is shown at /dev/view/<viewId>."""

import time

import pytest

from e2e.e2e_support import ADMIN, login, wait_js

pytestmark = pytest.mark.e2e

LANES = "[data-testid=board-lane]"


@pytest.fixture(scope="module")
def scene(server):
    editor_id = server.create_user("editor")
    project = server.create_project("Spot")
    server.grant_access(project, editor_id)
    ref = f"tasks:{project}"
    ids = {n: server.api("/api/statuses", {"name": n, "color": "#336699"})["status"]["id"] for n in ("Doing", "Done")}
    for name, status in (("Alpha", "Doing"), ("Beta", "Doing"), ("Gamma", "Done")):
        task = server.create_task(project, name)
        server.api(f"/api/tables/{ref}/rows/{task['task']['id']}", {"values": {"status": ids[status]}}, method="PATCH")
    view = server.api("/api/views", {"tableRef": ref, "name": "Board", "layout": "board",
                                     "config": {"query": {"groupBy": "status"}}})
    return {"project": project, "view": view["id"], "ref": ref, "status": ids}


def open_board(page, server, scene, username):
    if username == ADMIN["username"]:
        login(page, server.base_url, username, ADMIN["password"], goto=f"/dev/view/{scene['view']}")
    else:
        login(page, server.base_url, username, goto=f"/dev/view/{scene['view']}")
    page.wait_for_selector("[data-testid=board-layout]", timeout=15000)
    wait_js(page, "window.Live && Live.isConnected()", 10000)


def lane_cards(page, label):
    return page.evaluate("""(label) => {
        const lane = [...document.querySelectorAll('[data-testid=board-lane]')].find(l => l.dataset.laneLabel === label);
        return lane ? [...lane.querySelectorAll('[data-testid=board-card] .cl-board__card-title')].map(e => e.innerText.trim()) : null;
    }""", label)


def wait_for(fn, timeout=10.0):
    end = time.time() + timeout
    last = None
    while time.time() < end:
        last = fn()
        if last:
            return last
        time.sleep(0.2)
    raise AssertionError(f"condition not met, last value: {last!r}")


def drag_card(page, title, lane_label):
    card = page.locator("[data-testid=board-card]", has_text=title).first
    target = page.locator(f"{LANES}[data-lane-label='{lane_label}'] .cl-board__lane-head")
    c, t = card.bounding_box(), target.bounding_box()
    page.mouse.move(c["x"] + c["width"] / 2, c["y"] + c["height"] / 2)
    page.mouse.down()
    page.mouse.move(c["x"] + c["width"] / 2 + 10, c["y"] + c["height"] / 2 + 10, steps=3)
    page.mouse.move(t["x"] + t["width"] / 2, t["y"] + t["height"] / 2, steps=10)
    page.mouse.up()


def task_status(server, scene, title):
    rows = server.api(f"/api/tables/{scene['ref']}/query", {})["rows"]
    return [r["values"]["status"] for r in rows if r["values"]["name"] == title][0]


def test_dragging_a_card_to_another_column_is_seen_by_a_second_user(scene, server, new_page):
    a = new_page(name="admin")
    open_board(a, server, scene, ADMIN["username"])
    b = new_page(name="editor")
    open_board(b, server, scene, "editor")
    wait_for(lambda: sorted(lane_cards(a, "Doing") or []) == ["Alpha", "Beta"])
    assert lane_cards(a, "Done") == ["Gamma"]

    drag_card(a, "Alpha", "Done")
    wait_for(lambda: sorted(lane_cards(a, "Done") or []) == ["Alpha", "Gamma"])
    assert lane_cards(a, "Doing") == ["Beta"]
    # The second user sees the card in its new column without reloading
    wait_for(lambda: sorted(lane_cards(b, "Done") or []) == ["Alpha", "Gamma"])
    assert lane_cards(b, "Doing") == ["Beta"]
    assert task_status(server, scene, "Alpha") == scene["status"]["Done"]


def test_quick_add_creates_a_card_with_the_columns_value(scene, server, new_page):
    a = new_page(name="admin")
    open_board(a, server, scene, ADMIN["username"])
    lane = a.locator(f"{LANES}[data-lane-label='Doing']")
    lane.locator("[data-testid=board-add]").click()
    a.fill("[data-testid=board-add-form] input", "Quick one")
    a.press("[data-testid=board-add-form] input", "Enter")
    wait_for(lambda: "Quick one" in (lane_cards(a, "Doing") or []))
    wait_for(lambda: task_status(server, scene, "Quick one") == scene["status"]["Doing"])


def test_collapsed_column_stays_collapsed_after_reload(scene, server, new_page):
    a = new_page(name="admin")
    open_board(a, server, scene, ADMIN["username"])
    a.click(f"{LANES}[data-lane-label='Done'] [data-testid=board-fold]")
    wait_for(lambda: lane_cards(a, "Done") == [])
    wait_for(lambda: server.api(f"/api/views/{scene['view']}")["config"].get("board", {}).get("collapsed"))
    a.reload()
    a.wait_for_selector("[data-testid=board-layout]", timeout=15000)
    assert lane_cards(a, "Done") == []
    assert a.locator(f"{LANES}[data-lane-label='Done'] [data-testid=board-fold]").get_attribute("aria-expanded") == "false"
    assert lane_cards(a, "Doing")
