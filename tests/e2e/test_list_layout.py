"""A task is checked off in a list view: the server stores the done status, a second user sees it live
without reloading, and unchecking brings back the first not-done status. The view is at /dev/view/<viewId>."""

import time

import pytest

from e2e.e2e_support import ADMIN, login, wait_js

pytestmark = pytest.mark.e2e


@pytest.fixture(scope="module")
def scene(server):
    editor_id = server.create_user("lister")
    project = server.create_project("Dash")
    server.grant_access(project, editor_id)
    ref = f"tasks:{project}"
    todo = server.api("/api/statuses", {"name": "To do", "color": "#336699"})["status"]["id"]
    done = server.api("/api/statuses", {"name": "Done", "color": "#22c55e"})["status"]["id"]
    tasks = {}
    for name in ("Write script", "Edit cut"):
        task = server.create_task(project, name)["task"]
        server.api(f"/api/tables/{ref}/rows/{task['id']}", {"values": {"status": todo}}, method="PATCH")
        tasks[name] = task["id"]
    view = server.api("/api/views", {"tableRef": ref, "name": "Checklist", "layout": "list", "config": {"query": {}}})
    return {"ref": ref, "view": view["id"], "tasks": tasks, "todo": todo, "done": done}


def open_view(page, server, scene, username):
    password = ADMIN["password"] if username == ADMIN["username"] else None
    kwargs = {"goto": f"/dev/view/{scene['view']}"}
    if password:
        login(page, server.base_url, username, password, **kwargs)
    else:
        login(page, server.base_url, username, **kwargs)
    page.wait_for_selector("[data-testid=view-shell] [data-testid=list-layout]", timeout=15000)
    wait_js(page, "window.Live && Live.isConnected()", 10000)


def row_sel(scene, name):
    return f"[data-row-id='{scene['tasks'][name]}']"


def stored_status(server, scene, name):
    rows = server.api(f"/api/tables/{scene['ref']}/query", {})["rows"]
    return next(r for r in rows if r["id"] == scene["tasks"][name])["values"]["status"]


def wait_for(fn, timeout=10.0):
    end = time.time() + timeout
    last = None
    while time.time() < end:
        last = fn()
        if last:
            return last
        time.sleep(0.2)
    raise AssertionError(f"condition not met, last value: {last!r}")


def test_checking_off_a_task_is_stored_and_seen_live(scene, server, new_page):
    a = new_page(name="admin")
    open_view(a, server, scene, ADMIN["username"])
    b = new_page(name="lister")
    open_view(b, server, scene, "lister")

    sel = row_sel(scene, "Write script")
    a.wait_for_selector(sel)
    assert a.get_attribute(sel, "data-done") == "false"

    a.check(f"{sel} [data-testid=list-check]")
    wait_for(lambda: a.get_attribute(sel, "data-done") == "true")
    wait_for(lambda: stored_status(server, scene, "Write script") == scene["done"])
    # The other task is untouched
    assert stored_status(server, scene, "Edit cut") == scene["todo"]

    # A second user sees it without a reload
    wait_for(lambda: b.get_attribute(sel, "data-done") == "true")
    assert b.locator(f"{sel} [data-testid=list-title]").evaluate("e => getComputedStyle(e).textDecorationLine") == "line-through"

    # Unchecking from the keyboard (focus the row, Space) restores the first not-done status
    b.focus(sel)
    b.keyboard.press(" ")
    wait_for(lambda: stored_status(server, scene, "Write script") == scene["todo"])
    wait_for(lambda: a.get_attribute(sel, "data-done") == "false")
