"""Old documents moved into Pages (migration 006): hierarchy, the hidden Docs tab, and the first open.

The old documents are created through the old Docs API, then migration 006 runs again at server
start (its record is removed first), as it does when a deployment with Docs data is updated.
"""

import pytest

from e2e.e2e_support import login
from e2e.test_pages_sync import PROSE, text_of, wait_status, wait_text

pytestmark = pytest.mark.e2e

HTML = "<h1>Shot list</h1><p>Opening scene</p><p>Closing scene</p>"


@pytest.fixture(scope="module")
def scene(server, new_page):
    alice_id = server.create_user("alice")
    bob_id = server.create_user("bob")
    project = server.create_project("Spot")
    server.grant_access(project, alice_id)
    server.grant_access(project, bob_id)
    folder = server.api(f"/api/projects/{project}/folders", {"name": "Scripts"})["id"]
    sub = server.api(f"/api/projects/{project}/folders", {"name": "Drafts", "parentId": folder})["id"]
    doc = server.create_document(project, "Shot list", HTML)
    server.api(f"/api/documents/{doc}", {"folderId": sub}, method="PATCH")
    # Run migration 006 again on this data
    server.sql("DELETE FROM schema_migrations WHERE version = '006'")
    server.restart()
    assert server.sql("SELECT COUNT(*) FROM schema_migrations WHERE version = '006'")[0][0] == 1
    return {"project": project, "folder": folder, "sub": sub, "doc": doc, "new_page": new_page}


def test_the_documents_are_pages_with_the_same_hierarchy(scene, server):
    tree = {p["id"]: p for p in server.api(f"/api/spaces/p:{scene['project']}/pages")}
    assert tree[scene["folder"]]["title"] == "Scripts" and tree[scene["folder"]]["parentId"] is None
    assert tree[scene["sub"]]["parentId"] == scene["folder"]
    assert tree[scene["doc"]]["title"] == "Shot list" and tree[scene["doc"]]["parentId"] == scene["sub"]
    assert server.api(f"/api/pages/{scene['doc']}")["needsImport"] is True


def test_there_is_no_docs_tab_and_a_stale_saved_docs_tab_opens_home(scene, server):
    page = scene["new_page"](name="tabs")
    login(page, server.base_url, "alice")
    page.wait_for_selector("[data-testid=cl-sidebar]")
    assert page.locator(".main-tab").count() == 0  # the sidebar is the only navigation
    page.evaluate("localStorage.setItem('activeTab', 'docs')")
    page.reload()
    page.wait_for_function("document.querySelector('.app').dataset.view === 'pages'", timeout=15000)
    assert page.locator(".main-tab").count() == 0


def test_opened_by_two_people_at_once_the_content_is_imported_exactly_once(scene, server):
    alice = scene["new_page"](name="alice")
    bob = scene["new_page"](name="bob")
    login(alice, server.base_url, "alice")
    login(bob, server.base_url, "bob")
    target = f"/dev/page/{scene['doc']}"
    alice.evaluate("(url) => { window.location.href = url; }", target)
    bob.evaluate("(url) => { window.location.href = url; }", target)
    for page in (alice, bob):
        # After the login both are on Home, which has an editor of its own: wait for the new address first
        page.wait_for_url("**/dev/page/**", timeout=20000)
        page.wait_for_selector(PROSE, timeout=20000)
        wait_text(page, ("contains", "Closing scene"), timeout=20000)
        wait_status(page, "synced")
    for page in (alice, bob):
        assert text_of(page) == "Shot list\nOpening scene\nClosing scene"
        assert page.locator(PROSE + " h1").count() == 1
    assert server.api(f"/api/pages/{scene['doc']}")["needsImport"] is False
    assert server.api(f"/api/pages/{scene['doc']}/claim-import", {}) == {"granted": False}
    # A later visit shows the same document and imports nothing again
    bob.reload()
    bob.wait_for_selector(PROSE, timeout=20000)
    wait_text(bob, ("contains", "Closing scene"))
    assert text_of(bob) == "Shot list\nOpening scene\nClosing scene"
