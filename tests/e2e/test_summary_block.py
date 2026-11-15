"""Summary numbers in a page: a board view block, a count, a "percent done" bar and an inline number.

Tests run in order and build on one another (shared server, one browser context per person). Alice builds the
page with the slash menu; Bob sees it; a row change made through the API moves the numbers of both without a reload.
"""

import time

import pytest

from e2e.e2e_support import login

pytestmark = pytest.mark.e2e

PROSE = ".cl-editor__prose"
BLOCK = "[data-testid=summary-block]"
INLINE = "[data-testid=summary-inline]"


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


def values(page, selector=BLOCK):
    """The shown number of each summary, in document order."""
    return page.evaluate(
        """(sel) => [...document.querySelectorAll(sel)].map(e => (e.querySelector('[data-testid=summary-value]') || {}).innerText)""",
        selector,
    )


def labels(page):
    return page.evaluate("() => [...document.querySelectorAll('[data-testid=summary-label]')].map(e => e.innerText)")


def pick_view_and_close(page, view_id):
    page.click("[data-testid=summary-pick-view]")
    page.click(f'[data-testid=view-picker-list] [data-view-id="{view_id}"]')
    page.wait_for_selector("[data-testid=summary-setup]")


@pytest.fixture(scope="module")
def scene(server, new_page):
    ids = {name: server.create_user(name) for name in ("alice", "bob", "carol")}
    project = server.create_project("Numbers")
    for name in ("alice", "bob"):
        server.grant_access(project, ids[name])
    server.grant_access(project, ids["carol"], can_review=True, can_tasks=False)
    page_id = server.create_page(project, "Dashboard")
    ref = f"tasks:{project}"
    done = server.api("/api/statuses", {"name": "Done", "color": "#2f9e44"})["status"]["id"]
    tasks = [server.create_task(project, n)["task"]["id"] for n in ("One", "Two")]
    server.api(f"/api/tables/{ref}/rows/{tasks[0]}", {"values": {"status": done}}, method="PATCH")
    alice, bob = new_page(name="alice"), new_page(name="bob")
    open_page(alice, server, page_id, "alice")
    open_page(bob, server, page_id, "bob")
    return {"alice": alice, "bob": bob, "project": project, "page": page_id, "ref": ref, "done": done, "tasks": tasks, "state": {}}


def test_alice_builds_the_page_with_a_board_and_two_summaries(scene, server):
    alice = scene["alice"]
    alice.click(PROSE)
    alice.keyboard.type("/board")
    alice.click('[role=option]:has-text("Tasks as a board of cards")')
    alice.wait_for_selector("[data-testid=view-block][data-state=ready]", timeout=15000)
    view_id = alice.get_attribute("[data-testid=view-block]", "data-view-id")
    scene["state"]["view"] = view_id

    # A count: the settings open by themselves on a new block; the page's own board is listed first
    alice.keyboard.press("Control+End")
    alice.keyboard.press("Enter")
    alice.keyboard.type("/summary")
    alice.click('[role=option]:has-text("A number or progress bar from a view")')
    alice.wait_for_selector("[data-testid=summary-setup]")
    alice.click("[data-testid=summary-pick-view]")
    assert "on this page" in alice.inner_text("[data-testid=view-picker-list]")
    alice.click(f'[data-testid=view-picker-list] [data-view-id="{view_id}"]')
    alice.fill("[data-testid=summary-label-input]", "Tasks")
    alice.press("[data-testid=summary-label-input]", "Enter")
    alice.click("[data-testid=summary-setup-done]")
    wait_for(lambda: values(alice) == ["2"])
    assert labels(alice) == ["Tasks"]

    # Percent done as a progress bar
    alice.click(PROSE)
    alice.keyboard.press("Control+End")
    alice.keyboard.press("Enter")
    alice.keyboard.type("/summary")
    alice.click('[role=option]:has-text("A number or progress bar from a view")')
    alice.wait_for_selector("[data-testid=summary-setup]")
    pick_view_and_close(alice, view_id)
    alice.select_option("[data-testid=summary-fn]", "percentDone")
    alice.select_option("[data-testid=summary-display]", "progress")
    alice.fill("[data-testid=summary-label-input]", "Done")
    alice.press("[data-testid=summary-label-input]", "Enter")
    alice.click("[data-testid=summary-setup-done]")
    wait_for(lambda: values(alice) == ["2", "50%"])
    assert alice.get_attribute("[data-testid=summary-bar]", "aria-valuenow") == "50"

    # An inline number inside a sentence
    alice.click(PROSE)
    alice.keyboard.press("Control+End")
    alice.keyboard.press("Enter")
    alice.keyboard.type("Open tasks: ")
    alice.keyboard.type("/number")
    alice.click('[role=option]:has-text("A live number from a view")')
    alice.wait_for_selector("[data-testid=summary-setup]")
    pick_view_and_close(alice, view_id)
    alice.click("[data-testid=summary-setup-done]")
    wait_for(lambda: values(alice, INLINE) == ["2"])


def test_the_other_person_sees_the_same_numbers(scene):
    bob = scene["bob"]
    wait_for(lambda: values(bob) == ["2", "50%"] and values(bob, INLINE) == ["2"])
    assert labels(bob) == ["Tasks", "Done"]


def test_a_change_made_elsewhere_moves_the_numbers_of_both_without_a_reload(scene, server):
    alice, bob = scene["alice"], scene["bob"]
    server.create_task(scene["project"], "Three")
    wait_for(lambda: values(alice) == ["3", "33%"] and values(bob) == ["3", "33%"])
    assert values(bob, INLINE) == ["3"]
    # A status change moves only the percentage
    server.api(f"/api/tables/{scene['ref']}/rows/{scene['tasks'][1]}", {"values": {"status": scene["done"]}}, method="PATCH")
    wait_for(lambda: values(alice) == ["3", "67%"] and values(bob) == ["3", "67%"])
    assert bob.get_attribute("[data-testid=summary-bar]", "aria-valuenow") == "67"


def test_editing_a_summary_later_goes_through_the_same_settings(scene):
    alice, bob = scene["alice"], scene["bob"]
    alice.click(f"{BLOCK} >> nth=0")
    alice.wait_for_selector("[data-testid=summary-setup]")
    alice.fill("[data-testid=summary-label-input]", "All tasks")
    alice.press("[data-testid=summary-label-input]", "Enter")
    alice.click("[data-testid=summary-setup-done]")
    wait_for(lambda: labels(bob)[0] == "All tasks")


def test_a_user_without_task_access_sees_a_dash_not_an_error(scene, server, new_page):
    carol = new_page(name="carol")
    open_page(carol, server, scene["page"], "carol")
    carol.wait_for_selector(f"{BLOCK} [data-state=denied]", timeout=15000)
    assert values(carol)[0] == "—"
    wait_for(lambda: values(carol, INLINE) == ["—"])  # the inline number loads on its own
    assert carol.locator("[role=alert]").count() == 0
    assert carol.locator(".toast, .toast-container .toast").count() == 0
    # Read-only for her: no settings on click
    carol.click(BLOCK)
    assert carol.locator("[data-testid=summary-setup]").count() == 0
