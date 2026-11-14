"""Two users editing one document at the same time keep each other's changes.

Tests run in order and share one document, one server and two browser contexts.
"""

import json
import re
import time

import pytest

from e2e.e2e_support import ADMIN, login, wait_js

pytestmark = pytest.mark.e2e

EDITOR = "document.getElementById('docsEditorContent')"


def paragraphs(page):
    return page.evaluate(f"[...{EDITOR}.children].map(e => e.textContent)")


def caret_to_end(page, index):
    page.evaluate("""(i) => {
        const root = document.getElementById('docsEditorContent');
        root.focus();
        const range = document.createRange();
        range.selectNodeContents(root.children[i]);
        range.collapse(false);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
    }""", index)


def open_doc(page, project_id, doc_id):
    page.evaluate("switchTab('docs')")
    page.evaluate(f"(async () => {{ await DocsModule.init('{project_id}'); "
                  f"await DocsModule.openDocument('{doc_id}'); }})()")
    page.wait_for_selector("#docsEditorContent", timeout=10000)
    wait_js(page, "DocsModule.ws && DocsModule.ws.readyState === 1 && DocsModule.sync.docId", 10000)


def wait_paragraphs(page, expected, timeout=10000):
    """Wait for the document to show exactly these paragraphs; the assertion message shows what it had."""
    try:
        page.wait_for_function(
            f"[...{EDITOR}.children].map(e => e.textContent).join('\u0001') === {json.dumps(chr(1).join(expected))}",
            timeout=timeout)
    except Exception:
        raise AssertionError(f"expected {expected}, got {paragraphs(page)}") from None


@pytest.fixture(scope="module")
def scene(server, new_page):
    editor_id = server.create_user("editor")
    project_id = server.create_project("Spot")
    server.grant_access(project_id, editor_id)
    # an older document: no block ids yet
    doc_id = server.create_document(project_id, "Script", "<p>One</p><p>Two</p><p>Three</p>")
    pages = []
    for name, user, pw in (("anna", ADMIN["username"], ADMIN["password"]), ("ben", "editor", None)):
        page = new_page(name=name)
        login(page, server.base_url, user, *([pw] if pw else []))
        open_doc(page, project_id, doc_id)
        pages.append(page)
    return {"a": pages[0], "b": pages[1], "doc": doc_id, "project": project_id}


def server_text(server, scene):
    html = server.api(f"/api/documents/{scene['doc']}")["content"]
    return re.sub(r"<[^>]+>", "|", html)


def wait_server_text(server, scene, contains, absent=(), timeout=8.0):
    end = time.time() + timeout
    while time.time() < end:
        text = server_text(server, scene)
        if all(c in text for c in contains) and not any(x in text for x in absent):
            return
        time.sleep(0.3)
    raise AssertionError(f"server has {server_text(server, scene)!r}, wanted {contains} without {absent}")


def test_both_see_the_document(scene):
    expected = ["One", "Two", "Three"]
    assert paragraphs(scene["a"]) == expected
    assert paragraphs(scene["b"]) == expected


def test_simultaneous_edits_in_different_paragraphs(scene, server):
    a, b = scene["a"], scene["b"]
    caret_to_end(a, 0)
    caret_to_end(b, 1)
    for ch_a, ch_b in zip(" from Anna", " from Ben!"):
        a.keyboard.type(ch_a)
        b.keyboard.type(ch_b)
    expected = ["One from Anna", "Two from Ben!", "Three"]
    wait_paragraphs(a, expected)
    wait_paragraphs(b, expected)
    wait_server_text(server, scene, ["One from Anna", "Two from Ben!"])


def test_caret_stays_while_the_other_persons_text_arrives(scene):
    a, b = scene["a"], scene["b"]
    a.keyboard.type("?")
    b.keyboard.type("?")
    expected = ["One from Anna?", "Two from Ben!?", "Three"]
    wait_paragraphs(a, expected)
    wait_paragraphs(b, expected)


def test_new_paragraphs_added_by_both(scene):
    a, b = scene["a"], scene["b"]
    caret_to_end(a, 0)
    caret_to_end(b, 2)
    a.keyboard.press("Enter")
    b.keyboard.press("Enter")
    a.keyboard.type("Anna's new line")
    b.keyboard.type("Ben's new line")
    expected = ["One from Anna?", "Anna's new line", "Two from Ben!?", "Three", "Ben's new line"]
    wait_paragraphs(a, expected, 15000)
    wait_paragraphs(b, expected, 15000)


def test_same_paragraph_converges(scene):
    a, b = scene["a"], scene["b"]
    caret_to_end(a, 2)
    caret_to_end(b, 2)
    for ch_a, ch_b in zip("AAAA", "BBBB"):
        a.keyboard.type(ch_a)
        b.keyboard.type(ch_b)
    a.wait_for_timeout(3500)
    pa, pb = paragraphs(a), paragraphs(b)
    assert pa == pb, f"{pa} / {pb}"
    assert pa[0] == "One from Anna?" and pa[1] == "Anna's new line" and pa[-1] == "Ben's new line", pa


@pytest.mark.xfail(reason="Known limitation of the per-block merge (docMerge.js): when two people type in the same "
                          "paragraph at once, one side's text is dropped (last writer wins). Fixed by Yjs (PLAN D2).",
                   strict=False)
def test_same_paragraph_keeps_both_typings(scene):
    text = paragraphs(scene["a"])[2]
    assert "AAAA" in text and "BBBB" in text, text


def test_offline_edits_merge_on_reconnect(scene, server):
    a, b = scene["a"], scene["b"]
    last = len(paragraphs(b)) - 1
    b.context.set_offline(True)
    b.evaluate("DocsModule.ws && DocsModule.ws.close()")
    caret_to_end(a, 0)
    caret_to_end(b, last)
    a.keyboard.type(" (online)")
    b.keyboard.type(" (offline)")
    wait_server_text(server, scene, ["(online)"], absent=["(offline)"])
    b.context.set_offline(False)
    wait_js(a, "(() => { const t = [...document.getElementById('docsEditorContent').children]"
               ".map(e => e.textContent); return t[0].endsWith('(online)') && t[t.length-1].endsWith('(offline)'); })()",
            20000)
    wait_js(b, "(() => { const t = [...document.getElementById('docsEditorContent').children]"
               ".map(e => e.textContent); return t[0].endsWith('(online)') && t[t.length-1].endsWith('(offline)'); })()",
            20000)
    assert paragraphs(a) == paragraphs(b)
    wait_server_text(server, scene, ["(online)", "(offline)"])


def test_reload_shows_the_merged_document(scene):
    a, b = scene["a"], scene["b"]
    before = paragraphs(b)
    a.reload()
    wait_js(a, "typeof DocsModule !== 'undefined'", 10000)
    open_doc(a, scene["project"], scene["doc"])
    assert paragraphs(a) == before
