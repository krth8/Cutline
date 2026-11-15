"""The table layout, shown full screen at /dev/view/<viewId>: inline editing seen by a second user,
groups that collapse, bulk delete, subtasks, and 2,000 rows that scroll with only a window in the DOM."""

import os
import sqlite3
import time
import uuid

import pytest

from e2e.e2e_support import ADMIN, login, wait_js

pytestmark = pytest.mark.e2e

ROW = "[data-testid=table-row]"


@pytest.fixture(scope="module")
def editor_id(server):
    return server.create_user("editor")


def make_scene(server, editor_id, names, config=None, project_name="Spot"):
    """A project the editor can edit, with tasks called `names` and one table view on it."""
    project = server.create_project(project_name)
    server.grant_access(project, editor_id)
    ref = f"tasks:{project}"
    tasks = {n: server.create_task(project, n)["task"]["id"] for n in names}
    view = server.api("/api/views", {"tableRef": ref, "name": "All tasks", "layout": "table",
                                     "config": config or {"query": {}}})
    return {"project": project, "ref": ref, "view": view["id"], "tasks": tasks}


def open_view(page, server, scene, username):
    password = ADMIN["password"] if username == ADMIN["username"] else None
    if password:
        login(page, server.base_url, username, password, goto=f"/dev/view/{scene['view']}")
    else:
        login(page, server.base_url, username, goto=f"/dev/view/{scene['view']}")
    page.wait_for_selector("[data-testid=view-shell] [data-testid=table-layout]", timeout=15000)
    wait_js(page, "window.Live && Live.isConnected()", 10000)


def row_names(page):
    return page.evaluate("""() => [...document.querySelectorAll('[data-testid=table-row]')]
        .map(r => r.querySelector('[data-col=name] .cl-table__title').innerText.trim())""")


def wait_for(fn, timeout=10.0):
    end = time.time() + timeout
    last = None
    while time.time() < end:
        last = fn()
        if last:
            return last
        time.sleep(0.2)
    raise AssertionError(f"condition not met, last value: {last!r}")


def stored_names(server, scene):
    result = server.api(f"/api/tables/{scene['ref']}/query", {})
    return sorted(r["values"]["name"] for r in result["rows"])


def test_inline_edit_is_saved_and_seen_by_a_second_user(server, editor_id, new_page):
    scene = make_scene(server, editor_id, ["Alpha", "Beta", "Gamma"])
    a = new_page(name="admin")
    b = new_page(name="editor")
    open_view(a, server, scene, ADMIN["username"])
    open_view(b, server, scene, "editor")
    wait_for(lambda: sorted(row_names(a)) == ["Alpha", "Beta", "Gamma"])
    wait_for(lambda: len(row_names(b)) == 3)

    # Click a title cell, type a new title, Enter
    a.click(f"{ROW}:has-text('Beta') [data-col=name] .cl-cellhost")
    a.fill(f"{ROW} [data-col=name] input", "Beta renamed")
    a.keyboard.press("Enter")
    wait_for(lambda: "Beta renamed" in stored_names(server, scene))
    wait_for(lambda: "Beta renamed" in row_names(b))

    # Typing on a focused cell starts an edit too; arrow keys move between cells
    cell = f"{ROW}:has-text('Gamma') [data-col=name] .cl-cellhost"
    a.focus(cell)
    a.keyboard.press("ArrowUp")
    focused = a.evaluate("document.activeElement.closest('[data-testid=table-row]').innerText")
    assert "Beta renamed" in focused
    a.keyboard.press("ArrowDown")
    a.keyboard.type("G")
    a.keyboard.type("amma two")
    a.keyboard.press("Enter")
    wait_for(lambda: "Gamma two" in stored_names(server, scene))

    # The other user edits; the first sees it without a reload
    b.click(f"{ROW}:has-text('Alpha') [data-col=name] .cl-cellhost")
    b.fill(f"{ROW} [data-col=name] input", "Alpha by editor")
    b.keyboard.press("Enter")
    wait_for(lambda: "Alpha by editor" in row_names(a))


def test_a_new_row_from_quick_add_is_seen_by_a_second_user(server, editor_id, new_page):
    scene = make_scene(server, editor_id, ["One"])
    a = new_page(name="admin")
    b = new_page(name="editor")
    open_view(a, server, scene, ADMIN["username"])
    open_view(b, server, scene, "editor")
    a.fill("[data-testid=table-quick-add]", "Added in the grid")
    a.press("[data-testid=table-quick-add]", "Enter")
    wait_for(lambda: "Added in the grid" in row_names(a))
    wait_for(lambda: "Added in the grid" in row_names(b))
    assert "Added in the grid" in stored_names(server, scene)


def test_groups_show_counts_and_collapse(server, editor_id, new_page):
    scene = make_scene(server, editor_id, ["A1", "A2", "B1"], {"query": {"groupBy": "status"}})
    statuses = [server.api("/api/statuses", {"name": n, "color": "#336699"})["status"]["id"] for n in ("Doing", "Done")]
    for name, status in (("A1", statuses[0]), ("A2", statuses[0]), ("B1", statuses[1])):
        server.api(f"/api/tables/{scene['ref']}/rows/{scene['tasks'][name]}", {"values": {"status": status}}, method="PATCH")
    page = new_page(name="admin")
    open_view(page, server, scene, ADMIN["username"])
    wait_for(lambda: page.locator("[data-testid=table-group]").count() == 2)
    counts = page.evaluate("""() => [...document.querySelectorAll('[data-testid=table-group]')]
        .map(g => g.querySelector('.cl-table__grouplabel').innerText + ' '
                  + g.querySelector('[data-testid=table-group-count]').innerText)""")
    assert sorted(counts) == ["Doing 2", "Done 1"]
    assert sorted(row_names(page)) == ["A1", "A2", "B1"]

    page.click("[data-testid=table-group]:has-text('Doing') [data-testid=table-group-toggle]")
    wait_for(lambda: row_names(page) == ["B1"])
    page.click("[data-testid=table-group]:has-text('Doing') [data-testid=table-group-toggle]")
    wait_for(lambda: sorted(row_names(page)) == ["A1", "A2", "B1"])


def test_bulk_delete_removes_the_selected_rows_for_everyone(server, editor_id, new_page):
    scene = make_scene(server, editor_id, ["Keep", "Drop one", "Drop two", "Keep too"])
    a = new_page(name="admin")
    b = new_page(name="editor")
    open_view(a, server, scene, ADMIN["username"])
    open_view(b, server, scene, "editor")
    wait_for(lambda: len(row_names(a)) == 4)
    wait_for(lambda: len(row_names(b)) == 4)

    a.click(f"{ROW}:has-text('Drop one') [data-testid=table-select-row]")
    a.click(f"{ROW}:has-text('Drop two') [data-testid=table-select-row]")
    assert a.inner_text("[data-testid=table-bulk-count]").strip() == "2 selected"
    a.click("[data-testid=table-bulk-delete]")
    a.click(".confirm-overlay .confirm-submit")
    wait_for(lambda: sorted(row_names(a)) == ["Keep", "Keep too"])
    wait_for(lambda: stored_names(server, scene) == ["Keep", "Keep too"])
    wait_for(lambda: sorted(row_names(b)) == ["Keep", "Keep too"])
    assert a.locator("[data-testid=table-bulk-bar]").count() == 0


def test_bulk_edit_sets_a_column_for_all_selected_rows(server, editor_id, new_page):
    scene = make_scene(server, editor_id, ["One", "Two", "Three"])
    a = new_page(name="admin")
    open_view(a, server, scene, ADMIN["username"])
    wait_for(lambda: len(row_names(a)) == 3)
    a.click(f"{ROW}:has-text('One') [data-testid=table-select-row]")
    a.click(f"{ROW}:has-text('Two') [data-testid=table-select-row]")
    a.select_option("[data-testid=table-bulk-column]", "name")
    a.click("[data-testid=table-bulk-value] .cl-cellhost")
    a.fill("[data-testid=table-bulk-value] input", "Same")
    a.keyboard.press("Enter")
    wait_for(lambda: stored_names(server, scene) == ["Same", "Same", "Three"])


def test_subtasks_expand_and_can_be_added(server, editor_id, new_page):
    scene = make_scene(server, editor_id, ["Parent", "Lonely"], {"query": {"parentId": None}})
    server.api(f"/api/projects/{scene['project']}/tasks", {"name": "Child one", "parentId": scene["tasks"]["Parent"]})
    a = new_page(name="admin")
    b = new_page(name="editor")
    open_view(a, server, scene, ADMIN["username"])
    open_view(b, server, scene, "editor")
    wait_for(lambda: sorted(row_names(a)) == ["Lonely", "Parent"])

    # Only the parent has a caret; opening it shows the child, indented
    assert a.locator("[data-testid=table-expand]").count() == 1
    a.click("[data-testid=table-expand]")
    wait_for(lambda: row_names(a) == ["Parent", "Child one", "Lonely"] or row_names(a) == ["Lonely", "Parent", "Child one"])
    depths = a.evaluate("[...document.querySelectorAll('[data-testid=table-row]')].map(r => r.dataset.depth)")
    assert sorted(depths) == ["0", "0", "1"]

    # Add a subtask on the line under the children
    a.fill("[data-testid=table-add-child]", "Child two")
    a.press("[data-testid=table-add-child]", "Enter")
    wait_for(lambda: "Child two" in row_names(a))
    result = server.api(f"/api/tables/{scene['ref']}/query", {"parentId": scene["tasks"]["Parent"]})
    assert sorted(r["values"]["name"] for r in result["rows"]) == ["Child one", "Child two"]

    # The "+" button on a row without children opens an add line and focuses it
    a.hover(f"{ROW}:has-text('Lonely')")
    a.click(f"{ROW}:has-text('Lonely') [data-testid=table-add-subtask]")
    a.wait_for_selector("[data-testid=table-add-child]:focus", timeout=5000)
    a.keyboard.type("Under lonely")
    a.keyboard.press("Enter")
    wait_for(lambda: "Under lonely" in row_names(a))
    parent_of = server.api(f"/api/tables/{scene['ref']}/query", {"parentId": scene["tasks"]["Lonely"]})
    assert [r["values"]["name"] for r in parent_of["rows"]] == ["Under lonely"]

    # The second user sees the new child count on the parent after opening it
    wait_for(lambda: b.locator("[data-testid=table-expand]").count() == 2)


def test_resized_and_moved_columns_are_saved_in_the_view(server, editor_id, new_page):
    scene = make_scene(server, editor_id, ["Alpha"])
    a = new_page(name="admin")
    open_view(a, server, scene, ADMIN["username"])
    wait_for(lambda: len(row_names(a)) == 1)
    box = a.locator("[data-testid=table-header] [data-col=name] [data-testid=table-resize]").bounding_box()
    a.mouse.move(box["x"] + 4, box["y"] + 8)
    a.mouse.down()
    a.mouse.move(box["x"] + 104, box["y"] + 8, steps=5)
    a.mouse.up()
    stored = wait_for(lambda: server.api(f"/api/views/{scene['view']}")["config"].get("table"))
    assert stored["widths"]["name"] >= 400

    a.drag_and_drop("[data-testid=table-header] [data-col=priority] .cl-table__hlabel",
                    "[data-testid=table-header] [data-col=name]", target_position={"x": 5, "y": 10})
    columns = wait_for(lambda: server.api(f"/api/views/{scene['view']}")["config"].get("columns"))
    assert columns[0]["key"] == "priority"


def test_2000_rows_keep_only_a_window_in_the_dom_and_scroll(server, editor_id, new_page):
    project = server.create_project("Big")
    server.grant_access(project, editor_id)
    now = "2026-01-01T00:00:00"
    conn = sqlite3.connect(os.path.join(server.tmp, "e2e.db"), timeout=15)
    try:
        conn.executemany(
            "INSERT INTO tasks (id, project_id, name, priority, sort_order, created_at) VALUES (?, ?, ?, 'medium', ?, ?)",
            [(str(uuid.uuid4()), project, f"Task {i:04d}", i, now) for i in range(2000)],
        )
        conn.commit()
    finally:
        conn.close()
    server.restart()  # tasks are cached in memory: load the new rows
    view = server.api("/api/views", {"tableRef": f"tasks:{project}", "name": "Big", "layout": "table",
                                     "config": {"query": {"sort": [{"column": "name", "dir": "asc"}]}}})
    scene = {"view": view["id"], "project": project, "ref": f"tasks:{project}"}
    page = new_page(name="admin")
    open_view(page, server, scene, ADMIN["username"])
    wait_for(lambda: page.inner_text("[data-testid=table-count]").strip() == "2000 rows", timeout=20)

    rendered = page.locator(ROW).count()
    assert 5 < rendered < 80, rendered
    assert row_names(page)[0] == "Task 0000"

    # Jump far down: the window follows
    page.evaluate("document.querySelector('[data-testid=table-scroll]').scrollTop = 34 * 1500")
    wait_for(lambda: "Task 1500" in row_names(page))
    assert page.locator(ROW).count() < 80
    assert "Task 0000" not in row_names(page)

    # Scroll in steps and measure how long the frames take
    timing = page.evaluate("""() => new Promise(resolve => {
        const el = document.querySelector('[data-testid=table-scroll]');
        el.scrollTop = 0;
        const frames = [];
        let last = performance.now();
        let steps = 0;
        const tick = () => {
            const now = performance.now();
            frames.push(now - last);
            last = now;
            el.scrollTop += 400;
            steps += 1;
            if (steps < 120) requestAnimationFrame(tick);
            else resolve({ frames: frames.length, max: Math.max(...frames), avg: frames.reduce((a, b) => a + b, 0) / frames.length,
                           rows: document.querySelectorAll('[data-testid=table-row]').length });
        };
        requestAnimationFrame(tick);
    })""")
    print(f"2,000 rows: {timing}")
    assert timing["rows"] < 80
    assert timing["avg"] < 50, timing

    # Editing a row far down the list still works
    page.evaluate("document.querySelector('[data-testid=table-scroll]').scrollTop = 34 * 1800")
    wait_for(lambda: "Task 1805" in row_names(page))
    page.click(f"{ROW}:has-text('Task 1805') [data-col=name] .cl-cellhost")
    page.fill(f"{ROW} [data-col=name] input", "Task 1805 edited")
    page.keyboard.press("Enter")
    wait_for(lambda: any(r["values"]["name"] == "Task 1805 edited"
                         for r in server.api(f"/api/tables/{scene['ref']}/query", {"search": "edited"})["rows"]))
