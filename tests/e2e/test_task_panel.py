"""The task panel in real browsers: opened from a view, the body edited by two people at once, a property and
a comment seen live, a deep link, and the unavailable state for someone without access. Views are at /dev/view/<viewId>."""

import json
import re

import pytest

from e2e.e2e_support import login, wait_js

pytestmark = pytest.mark.e2e

PANEL = "[data-testid=task-panel]"
PROSE = "[data-testid=task-body] .cl-editor__prose"
EDITABLE = PROSE + '[contenteditable="true"]'

TEXT_JS = r"""(sel) => {
    const c = document.querySelector(sel).cloneNode(true);
    c.querySelectorAll('.cl-caret').forEach((e) => e.remove());
    return [...c.children].map((b) => b.textContent).join('\n').trim();
}"""


def text_of(page):
    return page.evaluate(TEXT_JS, PROSE)


def wait_text(page, expected, timeout=15000):
    """Wait until the body text equals `expected`, or contains it when given ("contains", text)."""
    if isinstance(expected, tuple):
        check = f"(t) => t.includes({json.dumps(expected[1])})"
    else:
        check = f"(t) => t === {json.dumps(expected)}"
    try:
        page.wait_for_function("([sel, src, getText]) => eval(src)(eval(getText)(sel))",
                               arg=[PROSE, check, TEXT_JS], timeout=timeout)
    except Exception:
        raise AssertionError(f"body text is {text_of(page)!r}, wanted {expected!r}") from None


def type_slowly(page, text, interval=30):
    """Type `text` at the caret in the page's own timers, so two pages really overlap."""
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
def scene(server):
    alice = server.create_user("alice")
    bob = server.create_user("bob")
    server.create_user("carol")  # no access to the project
    project = server.create_project("Panel")
    for uid in (alice, bob):
        server.grant_access(project, uid)
    for name in ("To do", "Done"):  # the done toggle needs a status column with a done option
        server.api("/api/statuses", {"name": name, "color": "#336699"})
    ref = f"tasks:{project}"
    server.api(f"/api/tables/{ref}/columns", {"name": "Note", "type": "text"})
    column = next(c["key"] for c in server.api(f"/api/tables/{ref}/schema")["columns"] if c["name"] == "Note")
    task = server.create_task(project, "Storyboard")["task"]
    server.api(f"/api/tasks/{task['id']}", {"description": "Old description text"}, method="PATCH")
    view = server.api("/api/views", {"tableRef": ref, "name": "All", "layout": "list", "config": {"query": {"parentId": None}}})
    return {"project": project, "ref": ref, "task": task["id"], "view": view["id"], "note": column, "state": {}}


def open_view(page, server, scene, who, task=False):
    suffix = f"?task={scene['task']}" if task else ""
    login(page, server.base_url, who, goto=f"/dev/view/{scene['view']}{suffix}")
    wait_js(page, "window.Live && Live.isConnected()", 10000)


def wait_panel_ready(page):
    page.wait_for_selector(f"{PANEL} [data-testid=task-properties]", timeout=15000)
    page.wait_for_selector(EDITABLE, timeout=20000)
    page.wait_for_selector(".cl-sync-status[data-status=synced]", timeout=20000)


@pytest.fixture(scope="module")
def people(server, scene, new_page):
    alice = new_page(name="alice")
    open_view(alice, server, scene, "alice")
    # Opened from the view: a click on the task title
    alice.wait_for_selector(f"[data-row-id='{scene['task']}'] [data-testid=list-title]", timeout=15000)
    alice.click(f"[data-row-id='{scene['task']}'] [data-testid=list-title]")
    wait_panel_ready(alice)
    # bob follows a deep link
    bob = new_page(name="bob")
    open_view(bob, server, scene, "bob", task=True)
    wait_panel_ready(bob)
    return {"alice": alice, "bob": bob}


def test_clicking_a_task_opens_the_panel_and_imports_the_old_description(scene, people):
    alice = people["alice"]
    assert scene["task"] in alice.url and "task=" in alice.url
    assert alice.input_value(f"{PANEL} [aria-label='Task name']") == "Storyboard"
    # The old plain-text description arrives as page content
    wait_text(alice, "Old description text")
    wait_text(people["bob"], "Old description text")
    # Properties: the empty ones are collapsed behind "Add property"; revealed, every column is there, the custom one too
    more = alice.locator(f"{PANEL} .cl-props__more")
    if more.count():
        more.click()
    labels = alice.locator(f"{PANEL} .cl-props__label").all_inner_texts()
    assert "Status" in labels and "Note" in labels and "Name" not in labels
    # Created and Created by are one muted line with a real date, not a dash row
    assert "Created" not in labels and "Created by" not in labels
    created = alice.inner_text(f"{PANEL} [data-testid=task-created]")
    assert re.fullmatch(r"Created by \w+ · .*\d{4}", created), created


def test_two_people_typing_in_the_body_at_once_keep_both_texts(scene, people):
    alice, bob = people["alice"], people["bob"]
    alice.click(PROSE)
    alice.keyboard.press("Control+Home")
    bob.click(PROSE)
    bob.keyboard.press("Control+End")
    type_slowly(alice, "AAAAAAAA")
    type_slowly(bob, "BBBBBBBB")
    alice.wait_for_function("!window.__typing")
    bob.wait_for_function("!window.__typing")
    want = "AAAAAAAAOld description textBBBBBBBB"
    wait_text(alice, want)
    wait_text(bob, want)


def test_a_property_changed_by_one_is_seen_by_the_other_without_reload(scene, server, people):
    alice, bob = people["alice"], people["bob"]
    cell = f"{PANEL} [data-column='{scene['note']}'] .cl-cellhost"
    alice.click(cell)
    alice.keyboard.type("needs a new angle")
    alice.keyboard.press("Enter")
    bob.wait_for_selector(f"{cell}:has-text('needs a new angle')", timeout=10000)
    row = next(r for r in server.api(f"/api/tables/{scene['ref']}/query", {})["rows"] if r["id"] == scene["task"])
    assert row["values"][scene["note"]] == "needs a new angle"


def test_a_comment_is_seen_live(scene, people):
    alice, bob = people["alice"], people["bob"]
    alice.fill(f"{PANEL} [aria-label='Add a comment']", "Looks good to me")
    alice.keyboard.press("Enter")
    alice.wait_for_selector(f"{PANEL} .cl-comment__text:has-text('Looks good to me')")
    bob.wait_for_selector(f"{PANEL} .cl-comment__text:has-text('Looks good to me')", timeout=10000)
    assert bob.locator(f"{PANEL} .cl-comment__author").first.inner_text() == "alice"


def test_a_comment_sent_with_ctrl_enter_from_the_composer_reaches_the_other_user(scene, people):
    alice, bob = people["alice"], people["bob"]
    box = f"{PANEL} [data-testid=task-composer] textarea"
    bob.fill(box, "First line")
    bob.keyboard.press("Shift+Enter")
    bob.keyboard.type("second line")
    assert bob.input_value(box) == "First line\nsecond line"
    bob.keyboard.press("Control+Enter")
    alice.wait_for_selector(f"{PANEL} .cl-comment__text:has-text('second line')", timeout=10000)
    # the composer stays at the bottom of the panel, in view
    assert bob.locator(box).is_visible() and bob.locator(box).bounding_box()["y"] > 500


def test_the_done_toggle_changes_the_status_the_other_user_sees(scene, server, people):
    alice, bob = people["alice"], people["bob"]
    toggle = f"{PANEL} [data-testid=task-done]"
    assert alice.get_attribute(toggle, "aria-checked") == "false"
    alice.click(toggle)
    bob.wait_for_selector(f"{toggle}[aria-checked=true]", timeout=10000)
    schema = server.api(f"/api/tables/{scene['ref']}/schema")
    done = {o["value"] for o in next(c for c in schema["columns"] if c["key"] == "status")["options"] if o.get("done")}
    row = next(r for r in server.api(f"/api/tables/{scene['ref']}/query", {})["rows"] if r["id"] == scene["task"])
    assert row["values"]["status"] in done
    bob.click(toggle)
    alice.wait_for_selector(f"{toggle}[aria-checked=false]", timeout=10000)


def test_escape_closes_the_panel_and_keeps_the_view(scene, people):
    bob = people["bob"]
    bob.click(f"{PANEL} .cl-task__title")
    bob.keyboard.press("Escape")  # leaves the field, the panel stays
    assert bob.is_visible(PANEL)
    bob.click(f"{PANEL} [aria-label='Add a comment']")
    bob.keyboard.press("Escape")  # leaves the composer
    assert bob.is_visible(PANEL)
    bob.keyboard.press("Escape")
    bob.wait_for_selector(PANEL, state="detached", timeout=5000)
    assert "task=" not in bob.url
    assert bob.is_visible("[data-testid=list-layout]")


def test_a_user_without_access_sees_the_unavailable_state(scene, server, new_page):
    carol = new_page(name="carol")
    open_view(carol, server, scene, "carol", task=True)
    carol.wait_for_selector(f"{PANEL} [data-testid=task-unavailable]", timeout=15000)
    assert "This task is not available" in carol.inner_text(PANEL)
    assert carol.locator(".toast, .toast-error").count() == 0


def test_the_panel_leaves_the_table_visible_and_clicking_another_row_swaps_the_task(scene, server, people):
    alice = people["alice"]
    second = server.create_task(scene["project"], "Second task")["task"]["id"]
    alice.reload()
    wait_js(alice, "window.Live && Live.isConnected()", 10000)
    alice.wait_for_selector(f"{PANEL} [data-testid=task-properties]", timeout=15000)
    # the panel is about 540 px wide and the list behind it is still there
    box = alice.locator(PANEL).bounding_box()
    assert 480 <= box["width"] <= 600, box
    assert alice.is_visible("[data-testid=list-layout]")
    assert alice.locator("[data-testid=task-scrim]").count() == 0
    alice.wait_for_selector(f"[data-row-id='{second}'] [data-testid=list-title]", timeout=15000)
    alice.click(f"[data-row-id='{second}'] [data-testid=list-title]")
    alice.wait_for_function(f"document.querySelector('{PANEL}').dataset.taskId === {json.dumps(second)}", timeout=10000)
    alice.wait_for_function("() => document.querySelector('[data-testid=task-panel] [aria-label=\"Task name\"]')?.value === 'Second task'", timeout=10000)
    assert alice.locator(PANEL).count() == 1
