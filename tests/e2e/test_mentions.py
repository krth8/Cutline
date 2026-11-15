"""Mentions in real browsers: @ menu, chips that appear live for the other person, the notification, "Mentioned in".

Tests run in order and build on one another (shared server, one browser context per person).
"""

import time

import pytest

from e2e.e2e_support import PASSWORD, login

pytestmark = pytest.mark.e2e

PROSE = ".cl-editor__prose"
CHIP = "[data-testid=mention-chip]"
MENU = "[data-testid=mention-menu]"


def wait_for(fn, timeout=30.0):
    end = time.time() + timeout
    last = None
    while time.time() < end:
        last = fn()
        if last:
            return last
        time.sleep(0.3)
    raise AssertionError(f"condition not met, last value: {last!r}")


def open_page(page, server, project, page_id, who):
    login(page, server.base_url, who, goto=f"/p/{project}/page/{page_id}")
    page.wait_for_selector(PROSE, timeout=20000)
    page.wait_for_selector('.cl-sync-status[data-status="synced"], .cl-sync-status[data-status="readonly"]', timeout=20000)


def pick(page, text):
    page.wait_for_selector(f'{MENU} [role=option]:has-text("{text}")', timeout=10000)
    page.click(f'{MENU} [role=option]:has-text("{text}")')


@pytest.fixture(scope="module")
def scene(server, new_page):
    ids = {name: server.create_user(name) for name in ("alice", "bob")}
    project = server.create_project("Mentions")
    for name in ("alice", "bob"):
        server.grant_access(project, ids[name])
    plan = server.create_page(project, "Plan")
    overview = server.create_page(project, "Overview")
    task = server.create_task(project, "Storyboard")["task"]["id"]
    tokens = {name: server.api("/api/auth/login", {"username": name, "password": PASSWORD}, token="")["token"]
              for name in ("alice", "bob")}
    alice, bob = new_page(name="alice"), new_page(name="bob")
    open_page(alice, server, project, plan, "alice")
    open_page(bob, server, project, plan, "bob")
    return {"alice": alice, "bob": bob, "ids": ids, "tokens": tokens, "project": project, "plan": plan,
            "overview": overview, "task": task}


def test_picking_a_person_and_a_task_with_the_at_menu_shows_chips_to_the_other_person(scene):
    alice, bob = scene["alice"], scene["bob"]
    alice.click(PROSE)
    alice.keyboard.type("Ask @bo")
    pick(alice, "bob")
    alice.keyboard.type("about @Story")
    pick(alice, "Storyboard")
    chips = alice.locator(CHIP)
    assert chips.count() == 2
    assert [chips.nth(i).get_attribute("data-kind") for i in range(2)] == ["person", "task"]

    bob.wait_for_selector(f"{CHIP}[data-kind=task]", timeout=15000)
    bob_chips = bob.locator(CHIP)
    assert bob_chips.count() == 2
    # the chips show current names, resolved by the server
    bob.wait_for_selector(f"{CHIP}[data-kind=task][data-state=ready]", timeout=10000)
    assert "Storyboard" in bob_chips.nth(1).inner_text()
    assert "bob" in bob_chips.nth(0).inner_text()


def test_the_mentioned_person_gets_a_notification_with_a_link(scene, server):
    notes = wait_for(lambda: [n for n in server.api("/api/notifications", token=scene["tokens"]["bob"])["notifications"]
                              if n["type"] == "mention"])
    assert len(notes) == 1
    assert notes[0]["link"] == f"/p/{scene['project']}/page/{scene['plan']}"
    # it arrived live: the bell of the open page shows it
    scene["bob"].wait_for_function(
        "(() => { const b = document.getElementById('notificationsBadge'); return b && !b.classList.contains('hidden') && b.textContent.trim() === '1'; })()",
        timeout=10000)
    # the author is not notified about their own mention, and nobody gets a second one
    assert server.api("/api/notifications", token=scene["tokens"]["alice"])["notifications"] == []
    time.sleep(1)
    assert len([n for n in server.api("/api/notifications", token=scene["tokens"]["bob"])["notifications"]
                if n["type"] == "mention"]) == 1


def test_the_page_is_listed_under_mentioned_in_for_the_task(scene, server):
    found = wait_for(lambda: server.api(f"/api/backlinks?kind=task&id={scene['task']}", token=scene["tokens"]["alice"])["pages"])
    assert [p["id"] for p in found] == [scene["plan"]]
    assert found[0]["title"] == "Plan"
    assert [p["id"] for p in server.api(f"/api/backlinks?kind=person&id={scene['ids']['bob']}", token=scene["tokens"]["alice"])["pages"]] \
        == [scene["plan"]]


def test_a_mentioned_page_shows_mentioned_in_at_the_bottom(scene, server, new_page):
    carol = new_page(name="alice2")
    open_page(carol, server, scene["project"], scene["overview"], "alice")
    carol.click(PROSE)
    carol.keyboard.type("See @Pla")
    pick(carol, "Plan")
    wait_for(lambda: server.api(f"/api/backlinks?kind=page&id={scene['plan']}", token=scene["tokens"]["bob"])["pages"])
    # a fresh visit to the mentioned page shows the collapsed section; opening it lists the page
    scene["bob"].goto(f"{server.base_url}/p/{scene['project']}/page/{scene['plan']}")
    scene["bob"].wait_for_selector("[data-testid=backlinks]", timeout=20000)
    toggle = scene["bob"].locator("[data-testid=backlinks] button")
    assert toggle.inner_text().strip().endswith("Mentioned in 1 page")
    assert toggle.get_attribute("aria-expanded") == "false"
    toggle.click()
    scene["bob"].wait_for_selector('[data-testid=backlinks] a:has-text("Overview")', timeout=5000)
