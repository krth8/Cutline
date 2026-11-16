"""Duplicate a page, save it as a template, use the template in another project, built-in templates.

Tests run in order and build on one another (shared server). The source page's document is written
straight into the database (text, an image and a board view), as if it had been typed in earlier.
Needs the bundle: `cd web && npm run build`.
"""

import json
import urllib.request
import uuid
from pathlib import Path

import pytest
from playwright.sync_api import expect
from pycrdt import Doc, XmlElement, XmlFragment, XmlText

from e2e.e2e_support import REPO, TINY_PNG, login, wait_js

pytestmark = pytest.mark.e2e

if not Path(REPO, "static", "dist", "pages.js").exists():
    pytest.skip("web bundle not built (cd web && npm run build)", allow_module_level=True)

BLOCK = "[data-testid=view-block]"
PROSE = ".cl-editor__prose"


def upload_png(server, page_id):
    boundary = uuid.uuid4().hex
    body = (f"--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"shot.png\"\r\n"
            "Content-Type: image/png\r\n\r\n").encode() + TINY_PNG + f"\r\n--{boundary}--\r\n".encode()
    req = urllib.request.Request(f"{server.base_url}/api/pages/{page_id}/files", data=body, method="POST")
    req.add_header("Content-Type", f"multipart/form-data; boundary={boundary}")
    req.add_header("Authorization", f"Bearer {server.token}")
    with urllib.request.urlopen(req, timeout=15) as res:
        return json.loads(res.read())


def card_titles(page):
    return sorted(page.evaluate("""() => [...document.querySelectorAll('[data-testid=view-block] .cl-board__card-title')]
        .map(e => e.innerText.trim())"""))


def open_page(page, server, project, page_id, who):
    if page.url.startswith("http"):  # already logged in
        page.goto(f"{server.base_url}/p/{project}/page/{page_id}")
    else:
        login(page, server.base_url, who, goto=f"/p/{project}/page/{page_id}")
    page.wait_for_selector(PROSE, timeout=20000)


def page_menu(page, item):
    page.get_by_role("button", name="Page menu").click()
    page.get_by_role("menuitem", name=item).click()


@pytest.fixture(scope="module")
def scene(server, new_page):
    alice_id, bob_id = server.create_user("alice"), server.create_user("bob")
    alpha, beta = server.create_project("Alpha"), server.create_project("Beta")
    server.grant_access(alpha, alice_id)
    server.grant_access(beta, alice_id)
    server.grant_access(alpha, bob_id)
    server.create_task(alpha, "Alpha task")
    server.create_task(beta, "Beta task")
    page = server.create_page(alpha, "Plan")
    image = upload_png(server, page)
    view = server.api("/api/views", {"tableRef": f"tasks:{alpha}", "name": "Board", "layout": "board",
                                     "ownerPageId": page, "config": {"query": {}, "board": {"groupBy": "status"}}})["id"]
    doc = Doc()
    frag = doc.get("default", type=XmlFragment)
    para = XmlElement("paragraph")
    frag.children.append(para)
    para.children.append(XmlText("Hello from the original"))
    frag.children.append(XmlElement("image", {"src": image["url"], "fileId": image["id"], "alt": "shot"}))
    frag.children.append(XmlElement("viewBlock", {"viewId": view}))
    server.sql("UPDATE pages SET ydoc = ?, text = ? WHERE id = ?", (doc.get_update(), "Hello from the original", page))
    alice = new_page(name="alice")
    return {"alice": alice, "alpha": alpha, "beta": beta, "page": page, "view": view, "state": {}}


def test_duplicate_shows_text_image_and_board_and_views_are_independent(scene, server):
    alice = scene["alice"]
    open_page(alice, server, scene["alpha"], scene["page"], "alice")
    alice.wait_for_selector(f"{BLOCK}[data-state=ready]", timeout=15000)
    page_menu(alice, "Duplicate")
    alice.wait_for_function("() => !location.pathname.endsWith('%s')" % scene["page"], timeout=15000)
    alice.wait_for_selector(PROSE, timeout=20000)
    expect(alice.locator(PROSE)).to_contain_text("Hello from the original")
    alice.wait_for_selector(f"{BLOCK}[data-state=ready]", timeout=15000)
    assert card_titles(alice) == ["Alpha task"]
    image = alice.locator(f"{PROSE} img")
    expect(image).to_be_visible()
    assert alice.evaluate("() => document.querySelector('.cl-editor__prose img').naturalWidth") > 0
    copy_id = alice.url.rsplit("/", 1)[1]
    assert copy_id != scene["page"] and f"/api/pages/{copy_id}/files/" in image.get_attribute("src")
    # the copy has a view of its own; changing its config leaves the original alone
    copy_view = alice.get_attribute(BLOCK, "data-view-id")
    assert copy_view and copy_view != scene["view"]
    server.api(f"/api/views/{copy_view}", {"config": {"query": {}, "board": {"groupBy": "priority"}}}, method="PATCH")
    assert server.api(f"/api/views/{scene['view']}")["config"]["board"]["groupBy"] == "status"
    scene["state"]["copy"] = copy_id


def test_save_as_template_and_use_it_in_another_project(scene, server):
    alice = scene["alice"]
    open_page(alice, server, scene["alpha"], scene["page"], "alice")
    page_menu(alice, "Save as template...")
    alice.get_by_label("Template name").fill("Plan template")
    alice.get_by_role("button", name="Save template").click()
    expect(alice.get_by_text("Template saved")).to_be_visible()

    alice.goto(f"{server.base_url}/p/{scene['beta']}/pages")
    alice.wait_for_selector("[data-testid=space-overview]", timeout=15000)
    alice.locator(f'.cl-tree[data-space="p:{scene["beta"]}"]').get_by_role("button", name="New from template...").first.click()
    dialog = alice.get_by_role("dialog")
    dialog.get_by_role("searchbox", name="Search templates").fill("plan")
    dialog.get_by_role("button", name="Use Plan template").click()
    alice.wait_for_selector(PROSE, timeout=20000)
    expect(alice.locator(PROSE)).to_contain_text("Hello from the original")
    alice.wait_for_selector(f"{BLOCK}[data-state=ready]", timeout=15000)
    alice.wait_for_function("() => document.querySelectorAll('[data-testid=view-block] .cl-board__card-title').length > 0", timeout=15000)
    assert card_titles(alice) == ["Beta task"]  # the board reads the new project's tasks
    assert alice.url.split("/p/")[1].startswith(scene["beta"])


def test_meeting_notes_appears_in_a_second_users_tree(scene, server, new_page):
    bob = new_page(name="bob")
    login(bob, server.base_url, "bob", goto=f"/p/{scene['alpha']}/pages")
    expect(bob.locator("[data-testid=space-overview]")).to_be_visible()
    wait_js(bob, "window.Live && Live.isConnected()", 10000)
    bob.wait_for_timeout(2500)  # the watch list is sent to the server within 2 s

    alice = scene["alice"]
    alice.goto(f"{server.base_url}/p/{scene['alpha']}/pages")
    alice.wait_for_selector("[data-testid=space-overview]", timeout=15000)
    alice.locator(f'.cl-tree[data-space="p:{scene["alpha"]}"]').get_by_role("button", name="New from template...").first.click()
    alice.get_by_role("dialog").get_by_role("button", name="Use Meeting notes").click()
    alice.wait_for_selector(PROSE, timeout=20000)
    expect(alice.locator(PROSE)).to_contain_text("Attendees")
    expect(bob.locator(".cl-sidebar").get_by_role("treeitem", name="Meeting notes", exact=True)).to_be_visible(timeout=10000)
