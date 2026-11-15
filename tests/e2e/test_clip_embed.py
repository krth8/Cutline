"""The clip block in a page: one person inserts a clip with /clip, the others see the card and its status live.

Tests run in order and build on one another (shared server, one browser context per person).
"""

import time

import pytest

from e2e.e2e_support import login, wait_js

pytestmark = pytest.mark.e2e

PROSE = ".cl-editor__prose"
CARD = "[data-testid=clip-embed]"


def wait_for(fn, timeout=15.0):
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


def status_text(page):
    return page.inner_text(f"{CARD} [data-testid=clip-embed-status]").strip()


@pytest.fixture(scope="module")
def scene(server, new_page):
    ids = {name: server.create_user(name) for name in ("alice", "bob", "carol", "vera")}
    server.api(f"/api/admin/users/{ids['vera']}", {"role": "viewer"}, method="PATCH")
    project = server.create_project("Spot")
    for name in ("alice", "bob", "vera"):
        server.grant_access(project, ids[name])
    # Carol may read the project's pages but may not review (so she may not see its clips)
    server.grant_access(project, ids["carol"], can_review=False, can_tasks=True)
    server.upload_png_clip(project, "shot_010_v1.png")
    wait_for(lambda: "shot_010" in server.api(f"/api/projects/{project}")["clips"])
    statuses = server.api("/api/statuses")["statuses"]
    for name, color in (("In review", "#3b82f6"), ("Approved", "#22c55e")):
        if len(statuses) < 2 and name not in [s["name"] for s in statuses]:
            server.api("/api/statuses", {"name": name, "color": color})
            statuses = server.api("/api/statuses")["statuses"]
    page_id = server.create_page(project, "Notes")
    alice, bob = new_page(name="alice"), new_page(name="bob")
    open_page(alice, server, page_id, "alice")
    open_page(bob, server, page_id, "bob")
    return {"alice": alice, "bob": bob, "project": project, "page": page_id, "statuses": statuses}


def test_inserting_a_clip_with_the_slash_menu_shows_the_card_to_the_other_person(scene):
    alice, bob = scene["alice"], scene["bob"]
    alice.click(PROSE)
    alice.keyboard.type("/clip")
    alice.click('[role=option]:has-text("Show a clip and open its review")')
    alice.wait_for_selector("[data-testid=clip-picker-list]", timeout=10000)
    # The page's project is listed, with the clip and its thumbnail
    assert alice.inner_text(".cl-clippicker__project").strip().lower() == "spot"
    alice.click('.cl-clippicker__item[data-clip="shot_010"]')
    alice.wait_for_selector(f"{CARD}[data-state=ready]", timeout=10000)
    assert alice.inner_text(f"{CARD} [data-testid=clip-embed-name]") == "shot_010"
    assert alice.inner_text(f"{CARD} [data-testid=clip-embed-version]") == "v1"

    bob.wait_for_selector(f"{CARD}[data-state=ready]", timeout=15000)
    assert bob.get_attribute(CARD, "data-clip") == "shot_010"
    assert bob.get_attribute(CARD, "data-project-id") == scene["project"]
    # Bob's picker did not open by itself: only the inserting browser asks for a clip
    assert bob.locator("[data-testid=clip-picker-list]").count() == 0
    for page in (alice, bob):
        loaded = page.evaluate("document.querySelector('[data-testid=clip-embed-thumb]').complete && "
                               "document.querySelector('[data-testid=clip-embed-thumb]').naturalWidth > 0")
        assert loaded, "the thumbnail did not load with the login cookie"


def test_a_status_change_updates_both_cards_without_a_reload(scene, server):
    alice, bob = scene["alice"], scene["bob"]
    assert status_text(bob) == "No status"
    status = scene["statuses"][0]
    server.api(f"/api/projects/{scene['project']}/clips/shot_010/status", {"statusId": status["id"]}, method="PATCH")
    wait_for(lambda: status_text(alice) == status["name"] and status_text(bob) == status["name"])
    other = scene["statuses"][1]
    server.api(f"/api/projects/{scene['project']}/clips/shot_010/status", {"statusId": other["id"]}, method="PATCH")
    wait_for(lambda: status_text(bob) == other["name"])


def test_a_new_comment_updates_the_comment_count(scene, server):
    bob = scene["bob"]
    assert bob.inner_text(f"{CARD} [data-testid=clip-embed-comments]") == "0 comments"
    server.api(f"/api/projects/{scene['project']}/comment",
               {"frame": 0, "text": "Looks good", "clipBaseName": "shot_010", "clipVersion": 1})
    wait_for(lambda: bob.inner_text(f"{CARD} [data-testid=clip-embed-comments]") == "1 comment")


def test_a_user_who_may_not_review_sees_a_quiet_card_that_names_nothing(scene, server, new_page):
    carol = new_page(name="carol")
    open_page(carol, server, scene["page"], "carol")
    carol.wait_for_selector(f"{CARD}[data-state=denied]", timeout=15000)
    text = carol.inner_text(CARD)
    assert text.strip() == "You don't have access to this clip."
    assert "shot_010" not in text and "Spot" not in text
    assert carol.locator(".toast, .toast-container .toast").count() == 0
    assert carol.locator("[data-testid=clip-embed-remove]").count() == 0


def test_a_read_only_reader_sees_the_card_without_controls(scene, server, new_page):
    vera = new_page(name="vera")
    open_page(vera, server, scene["page"], "vera")
    vera.wait_for_selector(f"{CARD}[data-state=ready]", timeout=15000)
    assert vera.locator("[data-testid=clip-embed-change]").count() == 0
    assert vera.locator("[data-testid=clip-embed-remove]").count() == 0
    assert vera.locator("[data-testid=clip-embed-open]").count() == 1


def test_clicking_the_card_lands_in_review_on_that_clip(scene):
    alice = scene["alice"]
    link = alice.get_attribute("[data-testid=clip-embed-open]", "href")
    assert link == f"/p/{scene['project']}/review?clip=shot_010"
    alice.click("[data-testid=clip-embed-open]")
    wait_js(alice, "location.pathname.endsWith('/review') && AppState.activeTab === 'review'"
                   " && !!AppState.currentClip && AppState.currentClip.baseName === 'shot_010'", 15000)


def test_a_review_link_with_a_clip_and_frame_opens_that_clip(scene, server):
    page = scene["bob"]
    page.goto(f"{server.base_url}/p/{scene['project']}/review?clip=shot_010&v=1&frame=12")
    wait_js(page, "!!AppState.currentClip && AppState.currentClip.baseName === 'shot_010'"
                  " && AppState.currentClip.version === 1 && AppState.activeTab === 'review'", 20000)


def test_deleting_the_clip_shows_the_other_person_a_deleted_card(scene, server, new_page):
    alice = new_page(name="alice again")  # the first tab is in review by now
    open_page(alice, server, scene["page"], "alice")
    alice.wait_for_selector(f"{CARD}[data-state=ready]", timeout=20000)
    server.api(f"/api/projects/{scene['project']}/clips/shot_010", method="DELETE")
    alice.wait_for_selector(f"{CARD}[data-state=gone]", timeout=15000)
    assert "This clip was deleted" in alice.inner_text(CARD)
    alice.click("[data-testid=clip-embed-remove-gone]")
    alice.wait_for_selector(CARD, state="detached", timeout=10000)
