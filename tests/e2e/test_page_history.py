"""Page history in real browsers: save a named version, keep writing, preview it, restore it, undo the restore.

Tests run in order and build on one another (shared server, one browser context per person).
"""

import json

import pytest

from e2e.e2e_support import login

pytestmark = pytest.mark.e2e

PROSE = ".cl-editor__prose"
DIALOG = ".cl-history"
TEXT_JS = r"""(sel) => {
    const c = document.querySelector(sel).cloneNode(true);
    c.querySelectorAll('.cl-caret').forEach((e) => e.remove());
    return [...c.children].map((b) => b.textContent).join('\n').trim();
}"""


def page_text(page):
    return page.evaluate(TEXT_JS, f"[data-testid=page-view] {PROSE}")


def wait_text(page, expected, timeout=15000):
    check = f"(t) => t === {json.dumps(expected)}"
    try:
        page.wait_for_function("([sel, src, getText]) => eval(src)(eval(getText)(sel))",
                               arg=[f"[data-testid=page-view] {PROSE}", check, TEXT_JS], timeout=timeout)
    except Exception:
        raise AssertionError(f"page text is {page_text(page)!r}, wanted {expected!r}") from None


def open_page(page, server, project, page_id, who):
    login(page, server.base_url, who, goto=f"/p/{project}/page/{page_id}")
    page.wait_for_selector(f"[data-testid=page-view] {PROSE}", timeout=20000)
    page.wait_for_selector('.cl-sync-status[data-status="synced"]', timeout=20000)


def open_history(page):
    page.get_by_role("button", name="Page menu").click()
    page.get_by_role("menuitem", name="History").click()
    page.wait_for_selector(DIALOG, timeout=10000)


def append_line(page, text):
    page.click(f"[data-testid=page-view] {PROSE}")
    page.keyboard.press("Control+End")
    page.keyboard.press("Enter")
    page.keyboard.type(text)


@pytest.fixture(scope="module")
def scene(server, new_page):
    ids = {name: server.create_user(name) for name in ("alice", "bob")}
    project = server.create_project("History")
    for uid in ids.values():
        server.grant_access(project, uid)
    page_id = server.create_page(project, "Notes")
    alice, bob = new_page(name="alice"), new_page(name="bob")
    open_page(alice, server, project, page_id, "alice")
    open_page(bob, server, project, page_id, "bob")
    return {"alice": alice, "bob": bob, "project": project, "page": page_id}


def test_save_a_named_version_then_both_keep_writing(scene):
    alice, bob = scene["alice"], scene["bob"]
    alice.click(f"[data-testid=page-view] {PROSE}")
    alice.keyboard.type("Version one text")
    wait_text(bob, "Version one text")

    open_history(alice)
    alice.get_by_label("Version name").fill("First draft")
    alice.get_by_role("button", name="Save version now").click()
    alice.wait_for_selector(f"{DIALOG} .cl-history__list :text('First draft')", timeout=10000)
    alice.keyboard.press("Escape")
    alice.wait_for_selector(DIALOG, state="detached")

    append_line(alice, "Alice wrote later")
    wait_text(bob, "Version one text\nAlice wrote later")
    append_line(bob, "Bob wrote later")
    wait_text(alice, "Version one text\nAlice wrote later\nBob wrote later")


def test_preview_and_restore_the_named_version_for_everyone(scene):
    alice, bob = scene["alice"], scene["bob"]
    open_history(alice)
    alice.locator(f"{DIALOG} .cl-history__item", has_text="First draft").click()
    preview = f"{DIALOG} [data-testid=history-preview] {PROSE}"
    alice.wait_for_selector(preview, timeout=15000)
    alice.wait_for_function(
        "(sel) => document.querySelector(sel).textContent.includes('Version one text')", arg=preview)
    assert "later" not in alice.inner_text(preview)
    assert alice.get_attribute(preview, "contenteditable") == "false"
    # the page behind the dialog is untouched until we restore
    assert "Bob wrote later" in page_text(alice)

    alice.get_by_role("button", name="Restore this version").click()
    alice.locator(f"{DIALOG} [role=alert]").wait_for()
    alice.locator(DIALOG).get_by_role("button", name="Restore", exact=True).click()
    alice.wait_for_selector(DIALOG, state="detached", timeout=15000)

    wait_text(alice, "Version one text")
    wait_text(bob, "Version one text")  # no reload

    # both can keep typing and see each other
    append_line(bob, "Bob after restore")
    wait_text(alice, "Version one text\nBob after restore")
    append_line(alice, "Alice after restore")
    wait_text(bob, "Version one text\nBob after restore\nAlice after restore")


def test_the_state_before_the_restore_is_in_the_list_and_can_be_restored(scene):
    alice, bob = scene["alice"], scene["bob"]
    open_history(alice)
    before = alice.locator(f"{DIALOG} .cl-history__item", has_text="Before restore").first
    before.wait_for(timeout=10000)
    before.click()
    preview = f"{DIALOG} [data-testid=history-preview] {PROSE}"
    alice.wait_for_function(
        "(sel) => document.querySelector(sel) && document.querySelector(sel).textContent.includes('Bob wrote later')",
        arg=preview, timeout=15000)
    alice.get_by_role("button", name="Restore this version").click()
    alice.locator(DIALOG).get_by_role("button", name="Restore", exact=True).click()
    alice.wait_for_selector(DIALOG, state="detached", timeout=15000)
    expected = "Version one text\nAlice wrote later\nBob wrote later"
    wait_text(alice, expected)
    wait_text(bob, expected)
