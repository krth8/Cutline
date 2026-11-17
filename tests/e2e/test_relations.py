"""Relation columns (C3): in a page, a custom table "Shots" gets a relation column to the project's tasks; two tasks
are linked to a row; a second person sees the chips live; renaming a task updates the chip without a reload;
a chip opens the task panel; the table is filtered by "contains task X".

Tests run in order and build on one another (shared server, one browser context per person).
"""

import time

import pytest

from e2e.e2e_support import ADMIN, login

pytestmark = pytest.mark.e2e

PROSE = ".cl-editor__prose"
BLOCK = "[data-testid=view-block]"
ROW = f"{BLOCK} [data-testid=table-row]"


def wait_for(fn, timeout=12.0):
    end = time.time() + timeout
    last = None
    while time.time() < end:
        last = fn()
        if last:
            return last
        time.sleep(0.2)
    raise AssertionError(f"condition not met, last value: {last!r}")


def open_page(page, server, page_id, who):
    if who == ADMIN["username"]:
        login(page, server.base_url, who, ADMIN["password"], goto=f"/dev/page/{page_id}")
    else:
        login(page, server.base_url, who, goto=f"/dev/page/{page_id}")
    page.wait_for_selector(PROSE, timeout=20000)
    page.wait_for_selector('.cl-sync-status[data-status="synced"], .cl-sync-status[data-status="readonly"]', timeout=20000)


def chips(page, row_text, key):
    return page.evaluate(f"""() => {{
        const row = [...document.querySelectorAll('{ROW}')].find(r => r.innerText.includes({row_text!r}));
        if (!row) return null;
        return [...row.querySelectorAll('[data-col={key}] [data-testid=relation-chip]')].map(c => c.innerText.trim());
    }}""")


def row_names(page):
    return page.evaluate(f"""() => [...document.querySelectorAll('{ROW}')]
        .map(r => r.querySelector('[data-col=name] .cl-table__title').innerText.trim())""")


@pytest.fixture(scope="module")
def scene(server, new_page):
    bob_id = server.create_user("bob")
    project = server.create_project("Relations")
    server.grant_access(project, bob_id)
    tasks = {name: server.api(f"/api/tables/tasks:{project}/rows", {"values": {"name": name}})["id"] for name in ("Task one", "Task two", "Task three")}
    page_id = server.create_page(project, "Plan")
    admin, bob = new_page(name="admin"), new_page(name="bob")
    open_page(admin, server, page_id, ADMIN["username"])
    open_page(bob, server, page_id, "bob")
    return {"admin": admin, "bob": bob, "project": project, "tasks": tasks, "state": {}}



def add_row(page, name):
    """A new row through the table's own "Add new row..." line (the toolbar has no New for tables)."""
    page.fill(f"{BLOCK} [data-testid=table-quick-add]", name)
    page.press(f"{BLOCK} [data-testid=table-quick-add]", "Enter")

def test_a_relation_column_to_the_projects_tasks_is_added_to_a_table(scene, server):
    admin, bob = scene["admin"], scene["bob"]
    admin.click(PROSE)
    admin.keyboard.type("/new")
    admin.click('[role=option]:has-text("A table with rows of your own")')
    admin.wait_for_selector(f"{BLOCK}[data-state=ready] [data-testid=table-layout]", timeout=20000)
    ref = server.api(f"/api/views/{admin.get_attribute(BLOCK, 'data-view-id')}")["tableRef"]
    server.api(f"/api/tables/{ref}", {"name": "Shots"}, method="PATCH")
    admin.click("[data-testid=table-add-column]")
    admin.fill("[data-testid=column-form-name]", "Tasks")
    admin.select_option("[data-testid=column-form-type]", "relation")
    admin.wait_for_selector("[data-testid=column-form-target] option[value^='tasks:']", timeout=10000, state="attached")
    admin.select_option("[data-testid=column-form-target]", f"tasks:{scene['project']}")
    admin.click("[data-testid=column-form-submit]")
    admin.wait_for_selector("[data-testid=table-header] [data-col^=cf_] >> text=Tasks", timeout=10000)
    column = next(c for c in server.api(f"/api/tables/{ref}/schema")["columns"] if c["name"] == "Tasks")
    assert column["type"] == "relation" and column["config"]["target"] == f"tasks:{scene['project']}"
    scene["state"].update(ref=ref, key=column["key"])
    bob.wait_for_selector("[data-testid=table-header] [data-col^=cf_] >> text=Tasks", timeout=10000)


def test_two_tasks_are_linked_and_the_other_person_sees_the_chips_live(scene, server):
    admin, bob = scene["admin"], scene["bob"]
    key = scene["state"]["key"]
    add_row(admin, "Untitled")
    wait_for(lambda: len(row_names(admin)) == 1)
    admin.click(f"{ROW} [data-col={key}] .cl-cellhost")
    admin.wait_for_selector("[data-testid=relation-search]", timeout=10000)
    admin.fill("[data-testid=relation-search]", "Task")
    admin.click("[data-testid=relation-option]:has-text('Task one')")
    admin.click("[data-testid=relation-option]:has-text('Task two')")
    admin.press("[data-testid=relation-search]", "Enter")
    wait_for(lambda: chips(admin, "Untitled", key) == ["Task one", "Task two"])
    stored = server.api(f"/api/tables/{scene['state']['ref']}/query", {})["rows"][0]["values"][key]
    assert [v["label"] for v in stored] == ["Task one", "Task two"]
    wait_for(lambda: chips(bob, "Untitled", key) == ["Task one", "Task two"])
    # a second row, linked through the API
    ref = scene["state"]["ref"]
    server.api(f"/api/tables/{ref}/rows", {"values": {"name": "Shot B", key: [scene["tasks"]["Task three"]]}})
    wait_for(lambda: chips(bob, "Shot B", key) == ["Task three"])


def test_renaming_a_task_updates_the_chip_without_a_reload(scene, server):
    admin, bob = scene["admin"], scene["bob"]
    key = scene["state"]["key"]
    server.api(f"/api/tables/tasks:{scene['project']}/rows/{scene['tasks']['Task one']}",
               {"values": {"name": "Task one renamed"}}, method="PATCH")
    wait_for(lambda: chips(admin, "Untitled", key) == ["Task one renamed", "Task two"])
    wait_for(lambda: chips(bob, "Untitled", key) == ["Task one renamed", "Task two"])


def test_clicking_a_chip_opens_the_task_panel(scene):
    admin = scene["admin"]
    key = scene["state"]["key"]
    admin.click(f"{ROW}:has-text('Shot B') [data-col={key}] [data-testid=relation-chip]")
    admin.wait_for_selector("[data-testid=task-panel]", timeout=15000)
    assert f"task={scene['tasks']['Task three']}" in admin.url
    admin.keyboard.press("Escape")
    admin.wait_for_selector("[data-testid=task-panel]", state="detached", timeout=10000)


def test_the_table_is_filtered_by_contains_task(scene):
    admin = scene["admin"]
    key = scene["state"]["key"]
    # In a page the unset Filter lives in the "..." menu of the view
    admin.click("[data-testid=toolbar-more]")
    admin.click("[data-testid=menu-filter]")
    admin.click("text=+ Add filter")
    admin.select_option("[data-testid=panel-filter] [aria-label=Column]", key)
    admin.click("[data-testid=panel-filter] [data-testid=filter-value] .cl-cellhost")
    admin.wait_for_selector("[data-testid=relation-search]", timeout=10000)
    admin.click("[data-testid=relation-option]:has-text('Task three')")
    wait_for(lambda: row_names(admin) == ["Shot B"])
