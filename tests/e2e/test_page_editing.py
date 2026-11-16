"""The page as a document, in real browsers: the slash menu after typing, formatting from the bubble toolbar,
the sync status in the page header, and one left edge for title and text.

Tests share one server and one project; every test opens its own page.
"""

import pytest

from e2e.e2e_support import login

pytestmark = pytest.mark.e2e

PROSE = ".cl-editor__prose"
SYNCED = '.cl-sync-status[data-status="synced"]'


@pytest.fixture(scope="module")
def scene(server, new_page):
    ids = {name: server.create_user(name) for name in ("alice", "bob")}
    project = server.create_project("Docs")
    for uid in ids.values():
        server.grant_access(project, uid)
    return {"server": server, "project": project, "new_page": new_page}


def open_dev(page, scene, who, page_id):
    login(page, scene["server"].base_url, who, goto=f"/dev/page/{page_id}")
    page.wait_for_selector(PROSE + '[contenteditable="true"]', timeout=20000)
    page.wait_for_selector(SYNCED, timeout=20000)


def open_app(page, scene, who, page_id):
    login(page, scene["server"].base_url, who, goto=f"/p/{scene['project']}/page/{page_id}")
    page.wait_for_selector(PROSE + '[contenteditable="true"]', timeout=20000)
    page.wait_for_selector(SYNCED, timeout=20000)


@pytest.mark.parametrize("delay", [0, 60])
def test_the_slash_menu_opens_after_two_paragraphs_and_survives_the_block_handle(scene, delay):
    """Regression: the block handle re-registers its plugin while typing, which closed the open menu and left "/board" as text."""
    page = scene["new_page"](name=f"slash{delay}")
    page_id = scene["server"].create_page(scene["project"], f"Slash {delay}")
    open_dev(page, scene, "alice", page_id)
    page.click(PROSE)
    kb = page.keyboard
    kb.type("Goal", delay=delay)
    kb.press("Enter")
    kb.type("A sentence about the goal.", delay=delay)
    kb.press("Enter")
    kb.type("/board", delay=delay)
    page.wait_for_selector('[role=option]:has-text("Tasks as a board of cards")')
    # Still there a moment later, after the handle's own plugin work
    page.wait_for_timeout(1500)
    assert page.locator('[role=option]:has-text("Tasks as a board of cards")').count() == 1
    kb.press("Escape")
    page.wait_for_selector(".cl-slash", state="detached")
    assert page.inner_text(PROSE).endswith("/board")


def test_the_slash_menu_has_groups_in_order_and_the_plus_handle_opens_it(scene):
    page = scene["new_page"](name="plus")
    page_id = scene["server"].create_page(scene["project"], "Plus")
    open_app(page, scene, "alice", page_id)
    page.click(PROSE)
    page.keyboard.type("Some text")
    page.hover(PROSE + " p")
    page.click(".cl-handle__add")
    page.wait_for_selector(".cl-slash")
    groups = page.eval_on_selector_all(".cl-slash__group", "els => els.map(e => e.textContent)")
    assert groups[:2] == ["Basic", "Lists"]
    page.keyboard.press("Escape")


def test_a_heading_made_in_the_bubble_toolbar_is_seen_by_the_other_person(scene):
    alice, bob = scene["new_page"](name="alice"), scene["new_page"](name="bob")
    page_id = scene["server"].create_page(scene["project"], "Bubble")
    open_dev(alice, scene, "alice", page_id)
    open_dev(bob, scene, "bob", page_id)
    alice.click(PROSE)
    alice.keyboard.type("Quarterly goals")
    alice.keyboard.press("Shift+Home")
    alice.wait_for_selector(".cl-toolbar")
    alice.click('.cl-toolbar [title="Turn into"]')
    alice.click('.cl-toolbar__menuitem:has-text("Heading 1")')
    alice.wait_for_selector(PROSE + " h1")
    bob.wait_for_selector(PROSE + " h1:has-text('Quarterly goals')", timeout=15000)


def test_the_sync_status_sits_in_the_page_header_and_goes_saving_then_saved(scene):
    page = scene["new_page"](name="status")
    page_id = scene["server"].create_page(scene["project"], "Status")
    open_app(page, scene, "alice", page_id)
    assert page.locator(".cl-page__bar .cl-sync-status").count() == 1
    assert page.locator(".cl-collab .cl-sync-status").count() == 0
    page.evaluate("""() => {
        window.__seen = [];
        const el = document.querySelector('.cl-page__bar .cl-sync-status');
        new MutationObserver(() => window.__seen.push(el.dataset.status)).observe(el, { attributes: true, attributeFilter: ['data-status'] });
    }""")
    page.click(PROSE)
    page.keyboard.type("Typing makes the page save")
    page.wait_for_selector(SYNCED, timeout=20000)
    seen = page.evaluate("window.__seen")
    assert "saving" in seen and seen[-1] == "synced", seen
    # Saved shows only as a dot until hovered
    status = page.locator(".cl-page__bar .cl-sync-status")
    assert not status.locator(".cl-sync-status__label").is_visible()
    status.hover()
    assert status.locator(".cl-sync-status__label").text_content() == "Saved"
    # The status is not inside the text column
    box, prose = status.bounding_box(), page.locator(PROSE).bounding_box()
    assert box["y"] + box["height"] < prose["y"]


@pytest.mark.parametrize("with_icon", [False, True])
def test_title_and_first_paragraph_share_one_left_edge(scene, with_icon):
    server = scene["server"]
    page_id = server.create_page(scene["project"], f"Edge {with_icon}")
    if with_icon:
        server.api(f"/api/pages/{page_id}", {"icon": "\U0001F680"}, method="PATCH")
    page = scene["new_page"](name=f"edge{with_icon}")
    open_app(page, scene, "alice", page_id)
    page.click(PROSE)
    page.keyboard.type("First paragraph")
    title = page.locator(".cl-page__title").bounding_box()
    paragraph = page.locator(PROSE + " p").first.bounding_box()
    assert abs(title["x"] - paragraph["x"]) < 1, (title, paragraph)
    if with_icon:
        icon = page.locator(".cl-page__icon").first.bounding_box()
        assert icon["y"] + icon["height"] <= title["y"] + 2  # the icon sits above the title, not beside it
