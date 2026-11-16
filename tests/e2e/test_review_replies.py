"""Review comments: Reply is a word under the comment, a reply is written in the comment box (so it can carry a
drawing), and @ in the box lists people to tag, who get a notification.

Needs the bundle: `cd web && npm run build`. Tests run in order and share the server and the browsers.
"""

from pathlib import Path

import pytest
from playwright.sync_api import expect

from e2e.e2e_support import ADMIN, PASSWORD, REPO, login, wait_js

pytestmark = pytest.mark.e2e

if not Path(REPO, "static", "dist", "pages.js").exists():
    pytest.skip("web bundle not built (cd web && npm run build)", allow_module_level=True)


@pytest.fixture(scope="module")
def scene(server, new_page):
    rita = server.create_user("rita")
    spot = server.create_project("Spot")
    server.grant_access(spot, rita)
    server.upload_png_clip(spot, "shot_010_v1.png")
    page = new_page(name="admin")
    login(page, server.base_url, ADMIN["username"], ADMIN["password"], goto=f"/p/{spot}/review")
    wait_js(page, f"AppState.projectId === '{spot}' && !!AppState.currentClip", 20000)
    token = server.api("/api/auth/login", {"username": "rita", "password": PASSWORD}, token="")["token"]
    return {"page": page, "spot": spot, "rita": token}


def test_reply_is_a_word_and_the_reply_is_written_in_the_comment_box(scene):
    page = scene["page"]
    page.fill("#commentInput", "Too dark here")
    page.click("#submitCommentBtn")
    wait_js(page, "AppState.comments.length === 1")
    first = page.locator(".comment-item").first
    expect(first.get_by_role("button", name="Reply", exact=True)).to_be_visible()
    first.get_by_role("button", name="Reply", exact=True).click()
    expect(page.locator("#replyIndicator")).to_contain_text("Replying to admin")
    expect(page.locator("#submitCommentBtn")).to_have_text("Reply")
    expect(page.locator("#commentInput")).to_be_focused()
    assert page.locator(".inline-reply-form").count() == 0

    # Escape leaves the reply
    page.keyboard.press("Escape")
    expect(page.locator("#replyIndicator")).to_be_hidden()
    expect(page.locator("#submitCommentBtn")).to_have_text("Post")


def test_a_reply_can_carry_a_drawing(scene):
    page = scene["page"]
    parent = page.evaluate("AppState.comments[0].id")
    page.locator(".comment-item").first.get_by_role("button", name="Reply", exact=True).click()
    page.click("#drawToggleBtn")
    box = page.locator("#svgOverlay, .svg-overlay").first.bounding_box()
    x, y = box["x"] + box["width"] / 2, box["y"] + box["height"] / 2
    page.mouse.move(x - 40, y)
    page.mouse.down()
    page.mouse.move(x, y + 30, steps=5)
    page.mouse.move(x + 40, y, steps=5)
    page.mouse.up()
    wait_js(page, "AppState.pendingDrawing && AppState.pendingDrawing.strokes.length > 2")
    page.fill("#commentInput", "Lift it like this")
    page.click("#submitCommentBtn")
    wait_js(page, "AppState.comments.length === 2")
    reply = page.evaluate("AppState.comments[1]")
    assert reply["parentId"] == parent and reply["text"] == "Lift it like this"
    assert len(reply["drawing"]["strokes"]) > 2
    expect(page.locator(".comment-item.comment-reply")).to_have_count(1)
    expect(page.locator("#replyIndicator")).to_be_hidden()


def test_typing_at_lists_people_and_the_tagged_person_is_told(scene, server):
    page = scene["page"]
    page.click("#commentInput")
    page.keyboard.type("Can you check this @ri")
    option = page.locator(".comment-tag-option")
    expect(option).to_have_count(1)
    expect(option).to_contain_text("rita")
    page.keyboard.press("Enter")  # picks the person, does not post
    assert page.input_value("#commentInput") == "Can you check this @rita "
    assert page.evaluate("AppState.comments.length") == 2
    page.keyboard.press("Enter")
    wait_js(page, "AppState.comments.length === 3")
    expect(page.locator(".comment-mention")).to_have_text("@rita")
    told = [n for n in server.api("/api/notifications", token=scene["rita"])["notifications"] if n["type"] == "mention"]
    assert len(told) == 1 and "tagged you on shot_010" in told[0]["title"]
