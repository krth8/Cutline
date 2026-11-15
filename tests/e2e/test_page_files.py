"""Images in pages, in real browsers: paste an image, a second person sees it load, a stranger is refused."""

import base64

import pytest

from e2e.e2e_support import TINY_PNG, login
from e2e.test_pages_sync import PROSE, open_page

pytestmark = pytest.mark.e2e

PASTE_JS = """async (b64) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const dt = new DataTransfer();
    dt.items.add(new File([bytes], 'shot.png', { type: 'image/png' }));
    const prose = document.querySelector('.cl-editor__prose');
    prose.focus();
    prose.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
}"""

LOADED_JS = "(sel) => { const i = document.querySelector(sel); return !!i && i.complete && i.naturalWidth > 0; }"


@pytest.fixture(scope="module")
def scene(server, new_page):
    alice_id = server.create_user("alice")
    bob_id = server.create_user("bob")
    server.create_user("carol")  # no access to the project
    project = server.create_project("Files")
    for uid in (alice_id, bob_id):
        server.grant_access(project, uid)
    page_id = server.create_page(project, "Pictures")
    alice, bob = new_page(name="alice"), new_page(name="bob")
    open_page(alice, server, page_id, "alice")
    open_page(bob, server, page_id, "bob")
    return {"alice": alice, "bob": bob, "page": page_id, "new_page": new_page, "urls": {}}


def test_pasting_an_image_shows_it_and_the_other_person_sees_it_load(scene):
    alice, bob = scene["alice"], scene["bob"]
    alice.click(PROSE)
    alice.evaluate(PASTE_JS, base64.b64encode(TINY_PNG).decode())
    img = PROSE + " img.cl-image__img"
    alice.wait_for_selector(img, timeout=15000)
    alice.wait_for_function(LOADED_JS, arg=img, timeout=15000)
    assert alice.locator(".cl-upload").count() == 0
    # Bob never reloads: the block arrives through sync and the file loads with his own login
    bob.wait_for_selector(img, timeout=15000)
    bob.wait_for_function(LOADED_JS, arg=img, timeout=15000)
    url = bob.get_attribute(img, "src")
    assert url.startswith(f"/api/pages/{scene['page']}/files/")
    scene["urls"]["image"] = url


def test_a_user_without_access_is_refused(scene, server):
    carol = scene["new_page"](name="carol")
    login(carol, server.base_url, "carol")
    status = carol.evaluate("async (u) => (await fetch(u)).status", scene["urls"]["image"])
    assert status in (403, 404)
    anonymous = scene["new_page"](name="anonymous")
    anonymous.goto(server.base_url + "/")
    status = anonymous.evaluate("async (u) => (await fetch(u)).status", scene["urls"]["image"])
    assert status in (401, 403)
