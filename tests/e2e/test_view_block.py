"""The view block in a page: one person inserts a view with the slash menu, the others see it and its rows live.

Tests run in order and build on one another (shared server, one browser context per person). The board layout is used: one
person adds a card inside the block and the other sees it live; a row change through the API reaches both blocks.
"""

import time

import pytest

from e2e.e2e_support import ApiError, login

pytestmark = pytest.mark.e2e

PROSE = ".cl-editor__prose"
BLOCK = "[data-testid=view-block]"


def wait_for(fn, timeout=10.0):
    end = time.time() + timeout
    last = None
    while time.time() < end:
        last = fn()
        if last:
            return last
        time.sleep(0.2)
    raise AssertionError(f"condition not met, last value: {last!r}")


def open_page(page, server, page_id, who):
    login(page, server.base_url, who, goto=f"/dev/page/{page_id}")
    page.wait_for_selector(PROSE, timeout=20000)
    page.wait_for_selector('.cl-sync-status[data-status="synced"], .cl-sync-status[data-status="readonly"]', timeout=20000)


def row_names(page):
    return sorted(page.evaluate("""() => [...document.querySelectorAll('[data-testid=view-block] [data-testid=board-card] .cl-board__card-title')]
        .map(e => e.innerText.trim())"""))


@pytest.fixture(scope="module")
def scene(server, new_page):
    ids = {name: server.create_user(name) for name in ("alice", "bob", "carol", "vera")}
    server.api(f"/api/admin/users/{ids['vera']}", {"role": "viewer"}, method="PATCH")
    project = server.create_project("Blocks")
    for name in ("alice", "bob", "vera"):
        server.grant_access(project, ids[name])
    # Carol may read the project's pages but has no access to its tasks
    server.grant_access(project, ids["carol"], can_review=True, can_tasks=False)
    page_id = server.create_page(project, "Plan")
    task = server.create_task(project, "First task")["task"]["id"]
    alice, bob = new_page(name="alice"), new_page(name="bob")
    open_page(alice, server, page_id, "alice")
    open_page(bob, server, page_id, "bob")
    return {"alice": alice, "bob": bob, "project": project, "page": page_id, "task": task, "state": {}}


def test_inserting_a_view_with_the_slash_menu_shows_it_to_the_other_person(scene, server):
    alice, bob = scene["alice"], scene["bob"]
    alice.click(PROSE)
    alice.keyboard.type("/board")
    alice.click('[role=option]:has-text("Tasks as a board of cards")')
    alice.wait_for_selector(f"{BLOCK}[data-state=ready]", timeout=15000)
    view_id = alice.get_attribute(BLOCK, "data-view-id")
    assert view_id
    # The view belongs to the page and shows the page's project
    view = server.api(f"/api/views/{view_id}")
    assert view["ownerPageId"] == scene["page"] and view["tableRef"] == f"tasks:{scene['project']}"
    assert view["layout"] == "board"
    scene["state"]["view"] = view_id

    bob.wait_for_selector(f"{BLOCK}[data-state=ready]", timeout=15000)
    assert bob.get_attribute(BLOCK, "data-view-id") == view_id
    wait_for(lambda: row_names(alice) == ["First task"] and row_names(bob) == ["First task"])
    assert bob.input_value("[data-testid=viewblock-name]") == "Board"


def test_a_row_change_reaches_both_blocks_live(scene, server):
    alice, bob = scene["alice"], scene["bob"]
    ref = f"tasks:{scene['project']}"
    server.api(f"/api/tables/{ref}/rows/{scene['task']}", {"values": {"name": "Renamed task"}}, method="PATCH")
    wait_for(lambda: row_names(alice) == ["Renamed task"] and row_names(bob) == ["Renamed task"])
    server.create_task(scene["project"], "Second task")
    wait_for(lambda: len(row_names(alice)) == 2 and len(row_names(bob)) == 2)


def test_a_card_added_inside_the_block_is_seen_by_the_other_person(scene, server):
    alice, bob = scene["alice"], scene["bob"]
    alice.locator("[data-testid=view-block] [data-testid=board-add]").first.click()
    alice.fill("[data-testid=board-add-form] input", "From the block")
    alice.press("[data-testid=board-add-form] input", "Enter")
    wait_for(lambda: "From the block" in row_names(bob) and "From the block" in row_names(alice))


def test_resizing_is_saved_in_the_page_and_seen_by_the_other_person(scene):
    alice, bob = scene["alice"], scene["bob"]
    handle = alice.locator("[data-testid=viewblock-resize]")
    handle.focus()
    alice.keyboard.press("ArrowDown")
    wait_for(lambda: bob.evaluate("() => document.querySelector('[data-testid=viewblock-body]').style.height") not in ("", None))
    assert bob.evaluate("() => document.querySelector('[data-testid=viewblock-body]').style.height").endswith("px")


def test_a_user_without_task_access_sees_an_empty_state_not_an_error(scene, server, new_page):
    carol = new_page(name="carol")
    open_page(carol, server, scene["page"], "carol")
    carol.wait_for_selector(f"{BLOCK}[data-state=denied]", timeout=15000)
    assert "You don't have access to this view." in carol.inner_text(BLOCK)
    assert carol.locator("[role=alert]").count() == 0
    assert carol.locator(".toast, .toast-container .toast").count() == 0
    assert carol.locator("[data-testid=viewblock-remove]").count() == 0


def test_a_read_only_reader_sees_the_view_but_cannot_remove_or_resize_it(scene, server, new_page):
    vera = new_page(name="vera")
    open_page(vera, server, scene["page"], "vera")
    vera.wait_for_selector(f"{BLOCK}[data-state=ready]", timeout=15000)
    assert vera.locator("[data-testid=viewblock-remove]").count() == 0
    assert vera.locator("[data-testid=viewblock-resize]").count() == 0
    wait_for(lambda: len(row_names(vera)) == 3)


def test_picking_an_existing_view_and_removing_the_block_keeps_that_view(scene, server):
    alice, bob = scene["alice"], scene["bob"]
    other = server.api("/api/views", {"tableRef": f"tasks:{scene['project']}", "name": "Shared list", "layout": "list",
                                     "config": {"query": {}}})
    alice.click(PROSE)
    alice.keyboard.press("Control+End")
    alice.keyboard.press("Enter")
    alice.keyboard.type("/existing")
    alice.click('[role=option]:has-text("Existing view")')
    alice.click("[data-testid=viewblock-pick]")
    alice.click(f'[data-testid=view-picker-list] [data-view-id="{other["id"]}"]')
    alice.wait_for_selector(f'{BLOCK}[data-view-id="{other["id"]}"]', timeout=10000)
    bob.wait_for_selector(f'{BLOCK}[data-view-id="{other["id"]}"]', timeout=10000)

    # Removing a block of a view the page does not own: no question, the view stays
    alice.click(f'{BLOCK}[data-view-id="{other["id"]}"] [data-testid=viewblock-remove]')
    alice.wait_for_selector(f'{BLOCK}[data-view-id="{other["id"]}"]', state="detached", timeout=10000)
    assert server.api(f"/api/views/{other['id']}")["id"] == other["id"]


def test_removing_the_block_deletes_the_view_the_page_owns_after_a_confirm(scene, server):
    alice = scene["alice"]
    view_id = scene["state"]["view"]
    alice.click(f'{BLOCK}[data-view-id="{view_id}"] [data-testid=viewblock-remove]')
    alice.click(".confirm-dialog .confirm-submit")
    alice.wait_for_selector(f'{BLOCK}[data-view-id="{view_id}"]', state="detached", timeout=10000)
    with pytest.raises(ApiError) as err:
        server.api(f"/api/views/{view_id}")
    assert err.value.status == 404


def test_the_other_person_sees_the_block_go(scene):
    scene["bob"].wait_for_selector(f'{BLOCK}[data-view-id="{scene["state"]["view"]}"]', state="detached", timeout=5000)
