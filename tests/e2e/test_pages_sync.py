"""Collaborative page editing in real browsers: the page editor on /dev/page/<id> against the real server.

Tests run in order and build on one another (shared server, shared pages, one browser context per person).
"""

import json

import pytest

from e2e.e2e_support import login

pytestmark = pytest.mark.e2e

PROSE = ".cl-editor__prose"
EDITABLE = PROSE + '[contenteditable="true"]'
READONLY = PROSE + '[contenteditable="false"]'
LEGACY_HTML = (
    '<h1 data-bid="b1">Legacy title</h1>'
    '<p data-bid="b2" style="color:red" onclick="window.hacked=1">Legacy text</p>'
    '<div class="docs-todo completed"><input type="checkbox"><span>Legacy todo</span></div>'
    "<script>window.hacked = 1</script>"
)


def status_of(page):
    return page.locator(".cl-sync-status").get_attribute("data-status")


def wait_status(page, status, timeout=20000):
    page.wait_for_selector(f'.cl-sync-status[data-status="{status}"]', timeout=timeout)


# The document text: one line per top-level block, without the labels of remote carets
TEXT_JS = r"""(sel) => {
    const c = document.querySelector(sel).cloneNode(true);
    c.querySelectorAll('.cl-caret').forEach((e) => e.remove());
    return [...c.children].map((b) => b.textContent).join('\n').trim();
}"""


def text_of(page):
    return page.evaluate(TEXT_JS, PROSE)


def wait_text(page, expected, timeout=15000):
    """Wait until the editor text equals `expected`, or contains it when given ("contains", text)."""
    if isinstance(expected, tuple):
        check = f"(t) => t.includes({json.dumps(expected[1])})"
    else:
        check = f"(t) => t === {json.dumps(expected)}"
    try:
        page.wait_for_function(
            "([sel, src, getText]) => eval(src)(eval(getText)(sel))",
            arg=[PROSE, check, TEXT_JS], timeout=timeout)
    except Exception:
        raise AssertionError(f"editor text is {text_of(page)!r}, wanted {expected!r}") from None


def open_page(page, server, page_id, who):
    login(page, server.base_url, who, goto=f"/dev/page/{page_id}")
    page.wait_for_selector(PROSE, timeout=20000)
    wait_status(page, "synced")


def type_slowly(page, text, interval=30):
    """Start typing `text` at the caret in the page's own timers, without blocking the test."""
    page.evaluate(
        """([text, interval]) => {
            window.__typing = true;
            let i = 0;
            const timer = setInterval(() => {
                document.execCommand('insertText', false, text[i++]);
                if (i >= text.length) { clearInterval(timer); window.__typing = false; }
            }, interval);
        }""", [text, interval])


@pytest.fixture(scope="module")
def scene(server, new_page):
    alice_id = server.create_user("alice")
    bob_id = server.create_user("bob")
    vera_id = server.create_user("vera")
    server.api(f"/api/admin/users/{vera_id}", {"role": "viewer"}, method="PATCH")
    project = server.create_project("Pages")
    for uid in (alice_id, bob_id, vera_id):
        server.grant_access(project, uid)
    page_id = server.create_page(project, "Notes")

    alice = new_page(name="alice")
    bob = new_page(name="bob")
    ws_urls = []
    alice.on("websocket", lambda w: ws_urls.append(w.url))
    bob.on("websocket", lambda w: ws_urls.append(w.url))
    open_page(alice, server, page_id, "alice")
    open_page(bob, server, page_id, "bob")
    return {"alice": alice, "bob": bob, "project": project, "page": page_id, "vera_id": vera_id,
            "ws_urls": ws_urls, "doc": {}}


def test_text_typed_by_one_appears_for_the_other(scene):
    alice, bob = scene["alice"], scene["bob"]
    assert alice.is_visible(EDITABLE) and bob.is_visible(EDITABLE)
    alice.click(PROSE)
    alice.keyboard.type("Hello from Alice")
    wait_text(bob, "Hello from Alice")
    wait_status(alice, "synced")  # saved: the server confirmed it
    assert alice.inner_text(".cl-sync-status") == "Saved"


def test_both_typing_in_the_same_paragraph_keeps_both_texts(scene):
    alice, bob = scene["alice"], scene["bob"]
    alice.click(PROSE)
    alice.keyboard.press("Home")
    bob.click(PROSE)
    bob.keyboard.press("End")
    # Each page types in its own timers, so the two really overlap
    type_slowly(alice, "AAAAAAAA")
    type_slowly(bob, "BBBBBBBB")
    alice.wait_for_function("!window.__typing")
    bob.wait_for_function("!window.__typing")
    want = "AAAAAAAAHello from AliceBBBBBBBB"
    wait_text(alice, want)
    wait_text(bob, want)
    scene["doc"]["text"] = want


def test_the_other_persons_caret_is_visible_with_their_name(scene):
    alice, bob = scene["alice"], scene["bob"]
    alice.click(PROSE)
    bob.wait_for_selector('.cl-caret__label:has-text("alice")', timeout=10000)
    alice.wait_for_selector('.cl-caret__label:has-text("bob")', timeout=10000)


def test_offline_edits_from_both_sides_converge_after_reconnect(scene):
    alice, bob = scene["alice"], scene["bob"]
    context = alice.context
    context.set_offline(True)
    try:
        wait_status(alice, "offline", timeout=10000)
        assert "Offline" in alice.inner_text(".cl-sync-status")
        alice.click(PROSE)
        alice.keyboard.press("Control+End")
        alice.keyboard.type(" [alice offline]")
        bob.click(PROSE)
        bob.keyboard.press("Control+Home")
        bob.keyboard.type("[bob online] ")
        wait_text(bob, ("contains", "[bob online] "))
        assert "[bob online]" not in text_of(alice)
    finally:
        context.set_offline(False)
    for page in (alice, bob):
        wait_text(page, ("contains", "[alice offline]"), timeout=30000)
        wait_text(page, ("contains", "[bob online] "), timeout=30000)
    assert text_of(alice) == text_of(bob)
    wait_status(alice, "synced", timeout=30000)
    scene["doc"]["text"] = text_of(bob)


def test_reload_shows_the_same_document(scene, server):
    bob = scene["bob"]
    expected = scene["doc"]["text"]
    bob.reload()
    bob.wait_for_selector(PROSE, timeout=20000)
    wait_text(bob, expected)
    wait_status(bob, "synced")


def test_viewer_sees_the_content_but_cannot_type(scene, server, new_page):
    vera = new_page(name="vera")
    login(vera, server.base_url, "vera", goto=f"/dev/page/{scene['page']}")
    vera.wait_for_selector(READONLY, timeout=20000)
    wait_text(vera, scene["doc"]["text"])
    wait_status(vera, "readonly")
    assert vera.inner_text(".cl-sync-status") == "Read only"
    vera.click(PROSE)
    vera.keyboard.type("intruder")
    vera.wait_for_timeout(500)
    assert text_of(vera) == scene["doc"]["text"]
    assert text_of(scene["bob"]) == scene["doc"]["text"]


def test_a_page_the_person_cannot_read_says_not_available(scene, server, new_page):
    other_project = server.create_project("Private")
    secret = server.create_page(other_project, "Secret")
    page = new_page(name="alice-denied")
    login(page, server.base_url, "alice", goto=f"/dev/page/{secret}")
    wait_status(page, "gone")
    assert page.inner_text(".cl-sync-status") == "Not available"
    assert page.query_selector(PROSE) is None


def test_legacy_html_opened_by_two_people_at_once_is_imported_exactly_once(scene, server):
    alice, bob = scene["alice"], scene["bob"]
    legacy = server.create_page(scene["project"], "Legacy")
    server.sql("UPDATE pages SET legacy_html = ? WHERE id = ?", (LEGACY_HTML, legacy))
    assert server.api(f"/api/pages/{legacy}")["needsImport"] is True

    # Navigate both pages in the same instant (the pages are logged in already)
    target = f"/dev/page/{legacy}"
    alice.evaluate("(url) => { window.location.href = url; }", target)
    bob.evaluate("(url) => { window.location.href = url; }", target)
    for page in (alice, bob):
        page.wait_for_selector(PROSE, timeout=20000)
        wait_text(page, ("contains", "Legacy text"), timeout=20000)
    wait_status(alice, "synced")
    wait_status(bob, "synced")
    expected = "Legacy title\nLegacy text\nLegacy todo"
    for page in (alice, bob):
        wait_text(page, ("contains", "Legacy todo"))
        assert page.locator(PROSE + " h1").count() == 1
        assert page.locator(PROSE + ' ul[data-type="taskList"] li').count() == 1
        assert page.locator(PROSE + ' ul[data-type="taskList"] li[data-checked="true"]').count() == 1
        assert text_of(page).count("Legacy text") == 1
        assert page.evaluate("window.hacked") is None
        assert page.locator(PROSE + " script").count() == 0
        assert page.locator(PROSE + " [onclick], " + PROSE + " [style*='red']").count() == 0
    assert text_of(alice) == text_of(bob)
    assert text_of(alice).startswith("Legacy title\nLegacy text\n")
    assert text_of(alice).endswith("Legacy todo")
    # Stored once: the server no longer asks for an import and the claim cannot be taken again
    assert server.api(f"/api/pages/{legacy}")["needsImport"] is False
    assert server.api(f"/api/pages/{legacy}/claim-import", {}) == {"granted": False}
    assert server.sql("SELECT import_claimed_by FROM pages WHERE id = ?", (legacy,))[0][0] is not None
    # A fresh visit gets the same document and does not import again
    bob.reload()
    bob.wait_for_selector(PROSE, timeout=20000)
    wait_text(bob, ("contains", "Legacy todo"))
    assert text_of(bob).count("Legacy text") == 1
    scene["doc"]["legacy"] = legacy


def test_server_restart_keeps_the_content_and_editing_continues(scene, server):
    alice, bob = scene["alice"], scene["bob"]
    before = text_of(bob)
    server.restart()
    for page in (alice, bob):
        wait_status(page, "synced", timeout=45000)
    assert text_of(alice) == before
    bob.click(PROSE)
    bob.keyboard.press("Control+End")
    bob.keyboard.type(" after restart")
    wait_text(alice, ("contains", "after restart"), timeout=20000)
    wait_status(bob, "synced", timeout=20000)
    assert text_of(alice) == text_of(bob)


def test_no_token_in_any_page_socket_url(scene):
    urls = [u for u in scene["ws_urls"] if "/ws/pages/" in u]
    assert urls, "the page sockets were not seen"
    for url in urls:
        assert "ticket=" in url
        assert "token=" not in url
        assert "eyJ" not in url, "a JWT is in a WebSocket URL"
    # A new ticket for every connection: no two page sockets share one
    tickets = [u.split("ticket=")[1] for u in urls]
    assert len(tickets) == len(set(tickets))
