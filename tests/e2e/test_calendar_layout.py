"""Calendar layout: drag a task to another day (the server stores exactly that date, in any browser time
zone, and a second user sees it move live), drag a task without a date from the side list onto a day, and
click a day to create a task there. The view is shown at /dev/view/<viewId>."""

import time

import pytest

from e2e.e2e_support import ADMIN, login, wait_js

pytestmark = pytest.mark.e2e

VIEWPORT = {"width": 1400, "height": 1100}


@pytest.fixture(scope="module")
def scene(server):
    editor_id = server.create_user("editor")
    project = server.create_project("Spot")
    server.grant_access(project, editor_id)
    ref = f"tasks:{project}"
    view = server.api("/api/views", {"tableRef": ref, "name": "Calendar", "layout": "calendar",
                                     "config": {"query": {}, "calendar": {"dateColumn": "dueDate", "mode": "month"}}})
    return {"project": project, "view": view["id"], "ref": ref}


def wait_for(fn, timeout=10.0):
    end = time.time() + timeout
    last = None
    while time.time() < end:
        last = fn()
        if last:
            return last
        time.sleep(0.2)
    raise AssertionError(f"condition not met, last value: {last!r}")


def open_calendar(page, server, scene, username):
    if username == ADMIN["username"]:
        login(page, server.base_url, username, ADMIN["password"], goto=f"/dev/view/{scene['view']}")
    else:
        login(page, server.base_url, username, goto=f"/dev/view/{scene['view']}")
    page.wait_for_selector("[data-testid=calendar-layout]", timeout=15000)
    wait_js(page, "window.Live && Live.isConnected()", 10000)


def month_prefix(page):
    """'YYYY-MM' of the viewer's today (the calendar starts on it)."""
    return page.get_attribute("[data-today]", "data-day")[:7]


def make_task(server, scene, name, due=None):
    task = server.create_task(scene["project"], name)["task"]
    if due:
        server.api(f"/api/tables/{scene['ref']}/rows/{task['id']}", {"values": {"dueDate": due}}, method="PATCH")
    return task["id"]


def stored_due(server, scene, name):
    rows = server.api(f"/api/tables/{scene['ref']}/query", {})["rows"]
    return [r["values"]["dueDate"] for r in rows if r["values"]["name"] == name][0]


def bar_days(page, title):
    return page.evaluate("""(title) => [...document.querySelectorAll('[data-testid=calendar-item]')]
        .filter(e => e.innerText.trim() === title).map(e => e.dataset.start)""", title)


def drag(page, source, day):
    target = page.locator(f"[data-testid=calendar-day][data-day='{day}']")
    target.scroll_into_view_if_needed()
    s, t = source.bounding_box(), target.bounding_box()
    page.mouse.move(s["x"] + s["width"] / 2, s["y"] + s["height"] / 2)
    page.mouse.down()
    page.mouse.move(s["x"] + s["width"] / 2 + 10, s["y"] + s["height"] / 2 + 10, steps=3)
    page.mouse.move(t["x"] + t["width"] / 2, t["y"] + t["height"] / 2, steps=12)
    page.mouse.up()


def test_moving_a_task_to_another_day_is_seen_by_a_second_user(scene, server, new_page, browser):
    a = new_page(context=browser.new_context(viewport=VIEWPORT), name="admin")
    open_calendar(a, server, scene, ADMIN["username"])
    prefix = month_prefix(a)
    make_task(server, scene, "Shoot", f"{prefix}-09")
    a.reload()
    a.wait_for_selector("[data-testid=calendar-item]", timeout=15000)
    b = new_page(context=browser.new_context(viewport=VIEWPORT), name="editor")
    open_calendar(b, server, scene, "editor")
    wait_for(lambda: bar_days(b, "Shoot") == [f"{prefix}-09"])

    drag(a, a.locator("[data-testid=calendar-item]", has_text="Shoot").first, f"{prefix}-19")
    wait_for(lambda: bar_days(a, "Shoot") == [f"{prefix}-19"])
    # The second user sees it move without reloading
    wait_for(lambda: bar_days(b, "Shoot") == [f"{prefix}-19"])
    assert stored_due(server, scene, "Shoot") == f"{prefix}-19"


# Each zone uses its own days so that no day collects more bars than the cell shows
@pytest.mark.parametrize("tz,src,dst", [("America/Los_Angeles", 10, 20), ("Pacific/Auckland", 11, 21), ("Pacific/Kiritimati", 12, 22)])
def test_a_moved_date_never_shifts_with_the_browser_time_zone(scene, server, new_page, browser, tz, src, dst):
    a = new_page(context=browser.new_context(viewport=VIEWPORT, timezone_id=tz), name="admin")
    open_calendar(a, server, scene, ADMIN["username"])
    prefix = month_prefix(a)
    name = f"Tz {tz}"
    make_task(server, scene, name, f"{prefix}-{src:02d}")
    a.reload()
    a.wait_for_selector("[data-testid=calendar-item]", timeout=15000)
    assert bar_days(a, name) == [f"{prefix}-{src:02d}"]

    drag(a, a.locator("[data-testid=calendar-item]", has_text=name).first, f"{prefix}-{dst:02d}")
    wait_for(lambda: stored_due(server, scene, name) == f"{prefix}-{dst:02d}")
    wait_for(lambda: bar_days(a, name) == [f"{prefix}-{dst:02d}"])
    a.reload()
    a.wait_for_selector("[data-testid=calendar-item]", timeout=15000)
    assert bar_days(a, name) == [f"{prefix}-{dst:02d}"]


def test_dragging_a_task_without_a_date_onto_a_day_schedules_it(scene, server, new_page, browser):
    a = new_page(context=browser.new_context(viewport=VIEWPORT), name="admin")
    open_calendar(a, server, scene, ADMIN["username"])
    prefix = month_prefix(a)
    make_task(server, scene, "Someday")
    a.reload()
    chip = a.locator("[data-testid=calendar-undated-item]", has_text="Someday")
    chip.wait_for(timeout=15000)

    drag(a, chip, f"{prefix}-15")
    wait_for(lambda: stored_due(server, scene, "Someday") == f"{prefix}-15")
    wait_for(lambda: bar_days(a, "Someday") == [f"{prefix}-15"])
    assert a.locator("[data-testid=calendar-undated-item]", has_text="Someday").count() == 0


def test_clicking_a_day_creates_a_task_on_it(scene, server, new_page, browser):
    a = new_page(context=browser.new_context(viewport=VIEWPORT), name="admin")
    open_calendar(a, server, scene, ADMIN["username"])
    prefix = month_prefix(a)
    a.locator(f"[data-testid=calendar-day][data-day='{prefix}-05']").click(position={"x": 20, "y": 60})
    a.fill("[data-testid=calendar-create] input", "Quick one")
    a.press("[data-testid=calendar-create] input", "Enter")
    wait_for(lambda: stored_due(server, scene, "Quick one") == f"{prefix}-05")
    wait_for(lambda: bar_days(a, "Quick one") == [f"{prefix}-05"])


def test_the_mode_is_saved_in_the_view(scene, server, new_page, browser):
    a = new_page(context=browser.new_context(viewport=VIEWPORT), name="admin")
    open_calendar(a, server, scene, ADMIN["username"])
    a.click("[data-testid=calendar-mode-week]")
    wait_for(lambda: server.api(f"/api/views/{scene['view']}")["config"].get("calendar", {}).get("mode") == "week")
    a.reload()
    a.wait_for_selector("[data-testid=calendar-layout][data-mode=week]", timeout=15000)
    assert a.locator("[data-testid=calendar-day]").count() == 7
    a.click("[data-testid=calendar-mode-month]")
    wait_for(lambda: server.api(f"/api/views/{scene['view']}")["config"]["calendar"]["mode"] == "month")
