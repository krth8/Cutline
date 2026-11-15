"""Gantt layout: resize a bar (a second user sees it live), move a bar keeping its length, give an unscheduled
row dates by dragging in its lane. The view is shown at /dev/view/<viewId>. Dates are relative to today because
the timeline opens around today."""

import time
from datetime import date, timedelta

import pytest

from e2e.e2e_support import ADMIN, login, wait_js

pytestmark = pytest.mark.e2e

TODAY = date.today()


def day(n):
    return (TODAY + timedelta(days=n)).isoformat()


@pytest.fixture(scope="module")
def scene(server):
    editor_id = server.create_user("editor")
    project = server.create_project("Plan")
    server.grant_access(project, editor_id)
    ref = f"tasks:{project}"
    ids = {}
    for name, start, due in (("Resize me", day(1), day(4)), ("Move me", day(6), day(8)), ("Schedule me", None, None)):
        task = server.create_task(project, name)["task"]
        ids[name] = task["id"]
        if start:
            server.api(f"/api/tables/{ref}/rows/{task['id']}", {"values": {"startDate": start, "dueDate": due}}, method="PATCH")
    view = server.api("/api/views", {"tableRef": ref, "name": "Gantt", "layout": "gantt",
                                     "config": {"query": {}, "gantt": {"startColumn": "startDate", "endColumn": "dueDate", "scale": "day"}}})
    return {"project": project, "view": view["id"], "ref": ref, "ids": ids}


def open_gantt(page, server, scene, username):
    if username == ADMIN["username"]:
        login(page, server.base_url, username, ADMIN["password"], goto=f"/dev/view/{scene['view']}")
    else:
        login(page, server.base_url, username, goto=f"/dev/view/{scene['view']}")
    page.wait_for_selector("[data-testid=gantt-layout]", timeout=15000)
    page.wait_for_selector("[data-testid=gantt-bar]", timeout=15000)
    wait_for(lambda: page.evaluate("window.Live && Live.isConnected()"))


def wait_for(fn, timeout=10.0):
    end = time.time() + timeout
    last = None
    while time.time() < end:
        last = fn()
        if last:
            return last
        time.sleep(0.2)
    raise AssertionError(f"condition not met, last value: {last!r}")


def bar(page, task_id):
    return page.locator(f"[data-testid=gantt-bar][data-row-id='{task_id}']")


def dates_of(server, scene, name):
    rows = server.api(f"/api/tables/{scene['ref']}/query", {})["rows"]
    values = [r["values"] for r in rows if r["values"]["name"] == name][0]
    return values["startDate"], values["dueDate"]


def drag(page, x0, y0, x1, y1):
    page.mouse.move(x0, y0)
    page.mouse.down()
    page.mouse.move(x0 + (6 if x1 >= x0 else -6), y0, steps=2)
    page.mouse.move(x1, y1, steps=8)
    page.mouse.up()


def day_width(page):
    return page.evaluate("document.querySelector('[data-testid=gantt-tick]').getBoundingClientRect().width")


def test_resizing_a_bar_saves_the_end_date_and_a_second_user_sees_it(scene, server, new_page):
    a = new_page(name="admin")
    open_gantt(a, server, scene, ADMIN["username"])
    b = new_page(name="editor")
    open_gantt(b, server, scene, "editor")
    task_id = scene["ids"]["Resize me"]
    assert bar(a, task_id).get_attribute("data-end") == day(4)

    width = day_width(a)
    handle = bar(a, task_id).locator("[data-testid=gantt-handle-end]").bounding_box()
    x, y = handle["x"] + handle["width"] / 2, handle["y"] + handle["height"] / 2
    drag(a, x, y, x + 2 * width, y)

    wait_for(lambda: dates_of(server, scene, "Resize me") == (day(1), day(6)))
    assert bar(a, task_id).get_attribute("data-end") == day(6)
    wait_for(lambda: bar(b, task_id).get_attribute("data-end") == day(6))  # no reload
    assert bar(b, task_id).get_attribute("data-start") == day(1)


def test_moving_a_bar_keeps_its_length(scene, server, new_page):
    a = new_page(name="admin")
    open_gantt(a, server, scene, ADMIN["username"])
    task_id = scene["ids"]["Move me"]
    width = day_width(a)
    box = bar(a, task_id).bounding_box()
    x, y = box["x"] + box["width"] / 2, box["y"] + box["height"] / 2
    drag(a, x, y, x + 3 * width, y)
    wait_for(lambda: dates_of(server, scene, "Move me") == (day(9), day(11)))


def test_a_click_on_a_bar_does_not_change_dates(scene, server, new_page):
    a = new_page(name="admin")
    open_gantt(a, server, scene, ADMIN["username"])
    before = dates_of(server, scene, "Resize me")
    bar(a, scene["ids"]["Resize me"]).click()
    time.sleep(0.5)
    assert dates_of(server, scene, "Resize me") == before


def test_an_unscheduled_row_gets_dates_by_dragging_in_its_lane(scene, server, new_page):
    a = new_page(name="admin")
    open_gantt(a, server, scene, ADMIN["username"])
    task_id = scene["ids"]["Schedule me"]
    assert a.locator("[data-testid=gantt-unscheduled]").count() == 1
    assert bar(a, task_id).count() == 0
    lane = a.locator(f"[data-testid=gantt-lane][data-row-id='{task_id}']").bounding_box()
    from_tick = a.locator(f"[data-testid=gantt-tick][data-date='{day(2)}']").bounding_box()
    to_tick = a.locator(f"[data-testid=gantt-tick][data-date='{day(5)}']").bounding_box()
    y = lane["y"] + lane["height"] / 2
    drag(a, from_tick["x"] + from_tick["width"] / 2, y, to_tick["x"] + to_tick["width"] / 2, y)

    wait_for(lambda: dates_of(server, scene, "Schedule me") == (day(2), day(5)))
    # The row leaves the Unscheduled section and is drawn as a bar
    wait_for(lambda: bar(a, task_id).count() == 1)
    assert bar(a, task_id).get_attribute("data-start") == day(2)


def test_the_scale_is_saved_in_the_view(scene, server, new_page):
    a = new_page(name="admin")
    open_gantt(a, server, scene, ADMIN["username"])
    a.click("[data-testid=gantt-scale-month]")
    wait_for(lambda: server.api(f"/api/views/{scene['view']}")["config"]["gantt"]["scale"] == "month")
    a.reload()
    a.wait_for_selector("[data-testid=gantt-layout]", timeout=15000)
    assert a.get_attribute("[data-testid=gantt-layout]", "data-scale") == "month"
    a.click("[data-testid=gantt-today]")
