"""The Tasks tab on the new table (T13): /p/<projectId>/tasks shows the project's Tasks view full page inside the
shell. Editing seen by a second user, a custom column added from the header, sorting by header click, the task
panel, the Tasks page in the sidebar, the fallback to the old list, and a user without task access."""

import time

import pytest
from playwright.sync_api import expect

from e2e.e2e_support import ADMIN, login, wait_js

pytestmark = pytest.mark.e2e

ROW = "[data-testid=table-row]"
TAB = "[data-testid=tasks-tab]"


def wait_for(fn, timeout=12.0):
    end = time.time() + timeout
    last = None
    while time.time() < end:
        last = fn()
        if last:
            return last
        time.sleep(0.2)
    raise AssertionError(f"condition not met, last value: {last!r}")


@pytest.fixture(scope="module")
def scene(server):
    editor = server.create_user("editor")
    reviewer = server.create_user("reviewer")  # may review, may not see tasks
    project = server.create_project("Tab")
    server.grant_access(project, editor)
    server.grant_access(project, reviewer, can_review=True, can_tasks=False)
    ref = f"tasks:{project}"
    ids = {n: server.create_task(project, n)["task"]["id"] for n in ("Alpha", "Beta", "Gamma")}
    return {"project": project, "ref": ref, "tasks": ids}


def open_tab(page, server, scene, who="editor", task=None):
    url = f"/p/{scene['project']}/tasks" + (f"?task={task}" if task else "")
    if who == ADMIN["username"]:
        login(page, server.base_url, who, ADMIN["password"], goto=url)
    else:
        login(page, server.base_url, who, goto=url)


def open_table(page, server, scene, who="editor", task=None):
    open_tab(page, server, scene, who, task)
    page.wait_for_selector(f"{TAB} [data-testid=table-layout]", timeout=20000)


def names(page):
    return page.evaluate("""() => [...document.querySelectorAll('[data-testid=table-row]')]
        .map(r => r.querySelector('[data-col=name] .cl-table__title').innerText.trim())""")


def test_the_tab_shows_the_projects_tasks_as_a_table_inside_the_shell(server, scene, new_page):
    page = new_page(name="editor")
    open_table(page, server, scene)
    wait_for(lambda: sorted(names(page)) == ["Alpha", "Beta", "Gamma"])
    assert page.locator("[data-testid=cl-sidebar]").is_visible()
    # The columns of the old list, in its order
    headers = page.evaluate("() => [...document.querySelectorAll('[data-testid=table-header] [data-col]')].map(h => h.dataset.col)")
    assert headers == ["name", "status", "priority", "assignees", "dueDate", "stage"]
    # There is no fixed Tasks page: the sidebar has no Tasks entry, and the view belongs to the project's dashboard
    assert page.locator("[data-testid=cl-sidebar] [data-testid=nav-tasks]").count() == 0
    assert page.locator("[data-testid=cl-sidebar] [role=treeitem][aria-label=Tasks]").count() == 0
    page.click("[data-testid=toolbar-more]")
    page.click("[data-testid=tasks-open-page]")
    page.wait_for_url(f"**/p/{scene['project']}/pages", timeout=20000)
    page.wait_for_selector("[data-testid=view-block]", timeout=20000)
    # "Open full page" of a block uses the real route
    page.locator("[data-testid=view-block] [data-testid=toolbar-more]").first.click()
    href = page.get_attribute("[data-testid=viewblock-open]", "href")
    assert href.startswith(f"/p/{scene['project']}/view/")


def test_the_full_page_view_route_works(server, scene, new_page):
    view = server.api("/api/views", {"tableRef": scene["ref"], "name": "Mine", "layout": "table", "config": {"query": {}}})
    page = new_page(name="editor-view")
    login(page, server.base_url, "editor", goto=f"/p/{scene['project']}/view/{view['id']}")
    page.wait_for_selector("[data-testid=view-page] [data-testid=table-layout]", timeout=20000)
    assert page.locator("[data-testid=cl-sidebar]").is_visible()


def test_an_edit_is_saved_and_a_second_user_sees_it(server, scene, new_page):
    a, b = new_page(name="admin-edit"), new_page(name="editor-edit")
    open_table(a, server, scene, ADMIN["username"])
    open_table(b, server, scene, "editor")
    wait_for(lambda: len(names(a)) == 3 and len(names(b)) == 3)
    a.click(f"{ROW}:has-text('Beta') [data-col=name] .cl-cellhost")
    a.fill(f"{ROW} [data-col=name] input", "Beta renamed")
    a.keyboard.press("Enter")
    wait_for(lambda: "Beta renamed" in names(b))
    stored = server.api(f"/api/tables/{scene['ref']}/query", {})["rows"]
    assert "Beta renamed" in [r["values"]["name"] for r in stored]
    server.api(f"/api/tasks/{scene['tasks']['Beta']}", {"name": "Beta"}, method="PATCH")


def test_a_custom_column_is_added_from_the_header_and_filled(server, scene, new_page):
    page = new_page(name="admin-col")
    open_table(page, server, scene, ADMIN["username"])
    page.click("[data-testid=table-add-column]")
    page.fill("[data-testid=column-form-name]", "Budget")
    page.select_option("[data-testid=column-form-type]", "number")
    page.click("[data-testid=column-form-submit]")
    page.wait_for_selector("[data-testid=table-header] [data-col^=cf_]", timeout=10000)
    key = page.evaluate("document.querySelector('[data-testid=table-header] [data-col^=cf_]').dataset.col")
    page.click(f"{ROW}:has-text('Alpha') [data-col={key}] .cl-cellhost")
    page.fill(f"{ROW} [data-col={key}] input", "42")
    page.keyboard.press("Enter")
    wait_for(lambda: any(r["values"].get(key) == 42 for r in server.api(f"/api/tables/{scene['ref']}/query", {})["rows"]))
    # the column header menu renames it
    page.click("[aria-label='Column menu for Budget']")
    page.click("text=Rename")
    page.fill("[data-testid=column-form-name]", "Cost")
    page.click("[data-testid=column-form-submit]")
    page.wait_for_selector("[data-testid=table-header] [data-col^=cf_] >> text=Cost", timeout=10000)


def test_a_header_click_sorts_and_toggles(server, scene, new_page):
    page = new_page(name="editor-sort")
    open_table(page, server, scene, "editor")
    wait_for(lambda: len(names(page)) == 3)
    label = "[data-testid=table-header] [data-col=name] [data-testid=table-hlabel]"
    page.click(label)
    wait_for(lambda: names(page) == sorted(names(page)))
    page.click(label)
    wait_for(lambda: names(page) == sorted(names(page), reverse=True))
    page.click(label)
    page.wait_for_function("() => !document.querySelector('[data-testid=table-header] [aria-sort]')", timeout=5000)


def test_a_task_opens_in_the_panel_from_the_tab(server, scene, new_page):
    page = new_page(name="editor-panel")
    open_table(page, server, scene, "editor")
    page.click(f"{ROW}:has-text('Gamma') [aria-label='Open details']")
    page.wait_for_selector("[data-testid=task-panel]", timeout=15000)
    assert f"task={scene['tasks']['Gamma']}" in page.url
    page.wait_for_function("() => [...document.querySelectorAll('[data-testid=task-panel] input')].some(i => i.value === 'Gamma')",
                           timeout=15000)
    # a link with ?task= opens it straight away, and the legacy "open task" function leads here too
    page.goto(f"{server.base_url}/p/{scene['project']}/tasks")
    page.wait_for_selector(f"{TAB} [data-testid=table-layout]", timeout=20000)
    page.evaluate(f"AppState.projectId = '{scene['project']}'; openTaskFromClip('{scene['tasks']['Alpha']}')")
    page.wait_for_function(f"location.search.includes('task={scene['tasks']['Alpha']}')", timeout=10000)
    page.wait_for_selector("[data-testid=task-panel]", timeout=15000)


def test_the_old_task_list_comes_back_with_the_switch(server, scene, new_page):
    page = new_page(name="editor-legacy")
    page.goto(server.base_url)
    page.evaluate("localStorage.setItem('legacyTasks', '1')")
    open_tab(page, server, scene, "editor")
    page.wait_for_selector("#tasksTableContainer:not(.hidden)", timeout=20000)
    assert page.locator("[data-testid=tasks-tab]").count() == 0
    wait_js(page, "AppState.activeTab === 'projects'", 10000)
    page.wait_for_selector("#projectsTableBody .task-row", timeout=10000)
    # the switch lives in the user menu (Settings, Appearance)
    page.click("#userMenuBtn")
    page.click("[data-settings-tab=appearance]")
    expect(page.locator("#tasksListToggle")).to_have_text("Use the new task list")
    # switching back brings the new table
    page.click("#tasksListToggle")
    page.wait_for_selector(f"{TAB} [data-testid=table-layout]", timeout=20000)
    assert page.evaluate("localStorage.getItem('legacyTasks')") == "0"


def test_the_tasks_address_opens_the_new_list_by_default(server, scene, new_page):
    page = new_page(name="editor-projects")
    login(page, server.base_url, "editor")
    page.wait_for_selector("[data-testid=cl-sidebar]", timeout=10000)
    page.goto(f"{server.base_url}/p/{scene['project']}/tasks")
    page.wait_for_selector(f"{TAB} [data-testid=table-layout]", timeout=20000)
    assert page.url.endswith(f"/p/{scene['project']}/tasks")


def test_someone_without_the_main_tab_is_sent_to_a_tab_they_have(server, scene, new_page):
    page = new_page(name="reviewer")
    open_tab(page, server, scene, "reviewer")
    page.wait_for_url(f"**/p/{scene['project']}/review", timeout=20000)
    assert page.locator("[data-testid=table-layout]").count() == 0
    # the sidebar offers no Tasks link for this project
    assert page.locator("[data-testid=cl-sidebar] a:text-is('Tasks')").count() == 0
