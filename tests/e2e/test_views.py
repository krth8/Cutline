"""A filter, sort and group built in the view toolbar are saved with the view: a second user sees them,
and sees later changes live. The view is shown at /dev/view/<viewId>."""

import time

import pytest

from e2e.e2e_support import ADMIN, login, wait_js

pytestmark = pytest.mark.e2e

NAMES = ["Cherry", "Apple pie", "Banana", "Date"]


@pytest.fixture(scope="module")
def scene(server):
    editor_id = server.create_user("editor")
    project = server.create_project("Spot")
    server.grant_access(project, editor_id)
    ref = f"tasks:{project}"
    statuses = [server.api("/api/statuses", {"name": n, "color": "#336699"})["status"]["id"] for n in ("Doing", "Done")]
    # Apple pie and Banana share a status, Date has another one, Cherry (filtered out by "a") a third
    assign = {"Cherry": statuses[0], "Apple pie": statuses[0], "Banana": statuses[0], "Date": statuses[1]}
    for name in NAMES:
        task = server.create_task(project, name)
        server.api(f"/api/tables/{ref}/rows/{task['task']['id']}", {"values": {"status": assign[name]}}, method="PATCH")
    view = server.api("/api/views", {"tableRef": ref, "name": "All tasks", "layout": "table", "config": {"query": {}}})
    return {"project": project, "view": view["id"], "ref": ref}


def open_view(page, server, scene, username, password=None):
    if username == ADMIN["username"]:
        login(page, server.base_url, username, ADMIN["password"], goto=f"/dev/view/{scene['view']}")
    else:
        login(page, server.base_url, username, goto=f"/dev/view/{scene['view']}")
    page.wait_for_selector("[data-testid=view-shell] [data-testid=table-layout]", timeout=15000)
    wait_js(page, "window.Live && Live.isConnected()", 10000)


def row_names(page):
    return page.evaluate("""() => [...document.querySelectorAll('[data-testid=table-row]')]
        .map(r => r.querySelector('[data-col=name] .cl-table__title').innerText.trim())""")


def grouped_rows(page):
    """Row names per group, in display order."""
    return page.evaluate("""() => {
        const out = [];
        for (const el of document.querySelectorAll('[data-testid=table-group], [data-testid=table-row]')) {
            if (el.dataset.testid === 'table-group') out.push([]);
            else out[out.length - 1].push(el.querySelector('[data-col=name] .cl-table__title').innerText.trim());
        }
        return out;
    }""")


def group_count(page):
    return page.locator("[data-testid=table-group]").count()


def stored_query(server, scene):
    return server.api(f"/api/views/{scene['view']}")["config"]["query"]


def wait_for(fn, timeout=10.0):
    end = time.time() + timeout
    last = None
    while time.time() < end:
        last = fn()
        if last:
            return last
        time.sleep(0.2)
    raise AssertionError(f"condition not met, last value: {last!r}")


def test_building_filter_sort_group_is_saved_and_seen_by_a_second_user(scene, server, new_page):
    a = new_page(name="admin")
    open_view(a, server, scene, ADMIN["username"])
    wait_for(lambda: len(row_names(a)) == 4)

    # Filter: Name contains "a"
    a.click("[data-testid=toolbar-filter]")
    a.click("text=+ Add filter")
    a.fill("[data-testid=panel-filter] [aria-label=Value]", "a")
    wait_for(lambda: sorted(row_names(a)) == ["Apple pie", "Banana", "Date"])

    # Sort: Name descending
    a.click("[data-testid=toolbar-sort]")
    a.click("text=+ Add sort")
    a.select_option("[aria-label='Sort direction']", "desc")
    wait_for(lambda: row_names(a) == ["Date", "Banana", "Apple pie"])

    # Group: by status (two groups among the three rows)
    a.click("[data-testid=toolbar-group]")
    a.select_option("[aria-label='Group by']", "status")
    wait_for(lambda: group_count(a) == 2)
    assert sorted(row_names(a)) == ["Apple pie", "Banana", "Date"]

    query = wait_for(lambda: stored_query(server, scene).get("groupBy") and stored_query(server, scene))
    assert query["filter"] == {"and": [{"column": "name", "op": "contains", "value": "a"}]}
    assert query["sort"] == [{"column": "name", "dir": "desc"}]
    assert query["groupBy"] == "status"

    # A second user opens the same view and sees the same result
    b = new_page(name="editor")
    open_view(b, server, scene, "editor")
    wait_for(lambda: group_count(b) == 2)
    assert "Cherry" not in row_names(b)
    assert grouped_rows(b) == [["Date"], ["Banana", "Apple pie"]] or grouped_rows(b) == [["Banana", "Apple pie"], ["Date"]]
    b.click("[data-testid=toolbar-filter]")
    assert b.locator("[data-testid=panel-filter] [aria-label=Value]").input_value() == "a"
    b.keyboard.press("Escape")

    # Live: a change by the first user reaches the second without a reload
    a.click("[data-testid=toolbar-sort]")
    a.select_option("[aria-label='Sort direction']", "asc")
    wait_for(lambda: ["Apple pie", "Banana"] in grouped_rows(b))

    # ... and so does a rename
    a.fill("[data-testid=view-name]", "Tasks with an a")
    a.press("[data-testid=view-name]", "Enter")
    wait_for(lambda: b.input_value("[data-testid=view-name]") == "Tasks with an a")
