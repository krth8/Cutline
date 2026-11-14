"""Browser check of the page editor (things jsdom cannot do: real typing, selection geometry, drag and drop).

Run from web/:   python dev/check_editor.py
It builds the demo bundle (dev/build_editor_demo.mjs), serves the repository root on a free port
and drives the two-editor demo in Chromium with Playwright.
"""
import http.server
import os
import subprocess
import sys
import threading
from functools import partial
from pathlib import Path

from playwright.sync_api import sync_playwright

WEB = Path(__file__).resolve().parent.parent
ROOT = WEB.parent
results = []


def check(name, ok, detail=""):
    results.append((name, bool(ok)))
    print(("PASS  " if ok else "FAIL  ") + name + (f"   [{detail}]" if detail and not ok else ""))


def build():
    npm = "npm.cmd" if os.name == "nt" else "npm"
    subprocess.run([npm, "run", "build:editor-demo", "--silent"], cwd=WEB, check=True, stdout=subprocess.DEVNULL)


def serve():
    handler = partial(http.server.SimpleHTTPRequestHandler, directory=str(ROOT))
    handler.log_message = lambda *a, **k: None  # type: ignore[attr-defined]
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server


def main():
    build()
    server = serve()
    url = f"http://127.0.0.1:{server.server_address[1]}/static/dist/editor-demo/index.html"
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(viewport={"width": 1280, "height": 900})
        errors = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.goto(url)
        page.wait_for_selector("[data-testid=pane-u1] .cl-editor__prose")
        page.wait_for_selector("[data-testid=pane-u2] .cl-editor__prose")
        a = page.locator("[data-testid=pane-u1] .cl-editor__prose")
        b = page.locator("[data-testid=pane-u2] .cl-editor__prose")

        def reset():
            a.click()
            page.keyboard.press("Control+a")
            page.keyboard.press("Backspace")
            page.keyboard.press("Backspace")

        # 1. typing each base block -------------------------------------------------
        cases = [
            ("heading 1", "# Title", "h1"),
            ("heading 2", "## Title", "h2"),
            ("heading 3", "### Title", "h3"),
            ("bullet list", "- item", "ul:not([data-type]) > li"),
            ("ordered list", "1. item", "ol > li"),
            ("task list", "[ ] todo", "ul[data-type=taskList] > li"),
            ("blockquote", "> quote", "blockquote"),
            ("code block", "``` code", "pre code"),
            ("divider", "---", "hr"),
            ("bold", "**strong** x", "strong"),
            ("italic", "*slanted* x", "em"),
            ("strike", "~~gone~~ x", "s"),
            ("inline code", "`mono` x", "p code"),
            ("callout", "!> note", ".cl-callout"),
        ]
        for name, text, selector in cases:
            reset()
            page.keyboard.type(text)
            check(f"typing: {name}", a.locator(selector).count() >= 1, a.inner_html()[:200])

        reset()
        page.keyboard.type("[x] done")
        check("typing: checked task item", a.locator("li[data-checked=true]").count() == 1)

        # keyboard: Enter on empty list item exits, Tab nests
        reset()
        page.keyboard.type("- a")
        page.keyboard.press("Enter")
        page.keyboard.type("b")
        page.keyboard.press("Tab")
        check("Tab nests a list item", a.locator("ul ul li").count() == 1)
        page.keyboard.press("Shift+Tab")
        check("Shift+Tab lifts it", a.locator("ul ul").count() == 0)
        page.keyboard.press("Enter")
        page.keyboard.press("Enter")
        check("Enter on empty item exits the list", a.locator("ul > li").count() == 2 and a.locator("p").count() >= 1)

        # 2. slash menu ---------------------------------------------------------------
        reset()
        page.keyboard.type("/")
        check("slash: menu opens", page.locator(".cl-slash").is_visible())
        check("slash: lists all blocks", page.locator(".cl-slash__item").count() >= 14)
        page.keyboard.type("head")
        check("slash: filters", page.locator(".cl-slash__item").count() == 3)
        page.keyboard.press("ArrowDown")
        page.keyboard.press("Enter")
        check("slash: Enter runs the item (heading 2)", a.locator("h2").count() == 1 and page.locator(".cl-slash").count() == 0)
        reset()
        page.keyboard.type("/quo")
        page.locator(".cl-slash__item", has_text="Quote").click()
        check("slash: mouse click runs the item", a.locator("blockquote").count() == 1)
        reset()
        page.keyboard.type("/tod")
        page.keyboard.press("Escape")
        check("slash: Escape closes and keeps text", page.locator(".cl-slash").count() == 0 and "/tod" in a.inner_text())

        # 3. floating toolbar -----------------------------------------------------------
        reset()
        page.keyboard.type("format me please")
        page.keyboard.press("Home")
        page.keyboard.press("Shift+Control+ArrowRight")
        toolbar = page.locator(".cl-toolbar")
        page.wait_for_selector(".cl-toolbar [aria-label=Bold]", state="visible", timeout=3000)
        check("toolbar: appears on selection", toolbar.is_visible())
        for label, tag in [("Bold", "strong"), ("Italic", "em"), ("Underline", "u"), ("Strikethrough", "s"), ("Highlight", "mark")]:
            page.locator(f".cl-toolbar [aria-label='{label}']").click()
            check(f"toolbar: {label.lower()}", a.locator(tag).count() >= 1, a.inner_html()[:160])
        page.locator(".cl-toolbar [aria-label=Link]").click()
        page.locator(".cl-toolbar__input").fill("example.com")
        page.keyboard.press("Enter")
        check("toolbar: link applied with https", a.locator("a[href='https://example.com']").count() == 1)
        # Ctrl+K edits the link, Remove removes it
        a.locator("a").click()
        page.keyboard.press("Control+k")
        try:
            page.wait_for_selector(".cl-toolbar__input", state="visible", timeout=3000)
            opened = True
        except Exception:
            opened = False
        check("toolbar: Ctrl+K opens the link field", opened)
        page.get_by_role("button", name="Remove").click()
        check("toolbar: link removed", a.locator("a").count() == 0)
        # code excludes other marks, so it gets its own selection
        reset()
        page.keyboard.type("mono text")
        page.keyboard.press("Shift+Home")
        page.locator(".cl-toolbar [aria-label=Code]").click()
        check("toolbar: code", a.locator("p code").count() == 1, a.inner_html()[:160])
        # turn into
        page.keyboard.press("Home")
        page.keyboard.press("Shift+End")
        page.locator(".cl-toolbar [title='Turn into']").click()
        page.get_by_role("menuitem", name="Heading 2").click()
        check("toolbar: turn into heading 2", a.locator("h2").count() == 1)
        # not in code blocks
        reset()
        page.keyboard.type("``` some code")
        page.keyboard.press("Shift+Home")
        page.wait_for_timeout(300)
        check("toolbar: hidden in code blocks", not toolbar.is_visible())

        # 4. drag handle ----------------------------------------------------------------
        reset()
        for word in ["first", "second", "third"]:
            page.keyboard.type(word)
            page.keyboard.press("Enter")
        page.keyboard.press("Backspace")
        texts = lambda: [t.strip() for t in a.locator("> p").all_inner_texts() if t.strip()]
        check("drag: setup has three paragraphs", texts() == ["first", "second", "third"], str(texts()))
        def show_handle(index):
            a.locator("> *").nth(2 if index == 0 else 0).hover()  # a real mouse move is needed to show the handle
            a.locator("> *").nth(index).hover()
            page.wait_for_selector(".cl-handle__grip", state="visible")

        show_handle(0)
        grip = page.locator(".cl-handle__grip").first
        gbox = grip.bounding_box()
        target = a.locator("> p").nth(2).bounding_box()
        page.mouse.move(gbox["x"] + gbox["width"] / 2, gbox["y"] + gbox["height"] / 2)
        page.mouse.down()
        page.mouse.move(target["x"] + 20, target["y"] + target["height"] * 0.9, steps=12)
        page.mouse.up()
        page.wait_for_timeout(300)
        check("drag: block reordered", texts()[0] != "first" and "first" in texts(), str(texts()))
        # click opens the menu; duplicate
        show_handle(0)
        page.locator(".cl-handle__grip").first.click()
        page.get_by_role("menuitem", name="Duplicate").click()
        check("drag: handle menu duplicates", len(texts()) == 4, str(texts()))
        show_handle(0)
        page.locator(".cl-handle__grip").first.click()
        page.get_by_role("menuitem", name="Turn into Heading 1").click()
        check("drag: handle menu turns into heading", a.locator("h1").count() == 1)
        show_handle(0)
        page.locator(".cl-handle__grip").first.click()
        page.get_by_role("menuitem", name="Delete").click()
        check("drag: handle menu deletes", a.locator("h1").count() == 0 and len(texts()) == 3, str(texts()))

        # 5. two editors in sync -----------------------------------------------------------
        reset()
        a.click()
        page.keyboard.type("hello from Ada")
        page.wait_for_timeout(200)
        check("sync: text appears in the other editor", "hello from Ada" in b.inner_text())
        b.click()
        page.keyboard.press("Control+End")
        page.keyboard.type(" and Grace")
        page.wait_for_timeout(200)
        check("sync: and the other way", "hello from Ada and Grace" in a.inner_text(), a.inner_text())
        check("sync: remote caret label shown", page.locator("[data-testid=pane-u1] .cl-caret__label").count() >= 1)
        # offline: edits diverge, then merge
        page.get_by_label("Offline").check()
        a.click()
        page.keyboard.press("Control+Home")
        page.keyboard.type("A> ")
        b.click()
        page.keyboard.press("Control+End")
        page.keyboard.type(" <B")
        page.wait_for_timeout(200)
        check("offline: edits stay local", "<B" not in a.inner_text() and "A>" not in b.inner_text())
        page.get_by_label("Offline").uncheck()
        page.wait_for_timeout(300)
        check("offline: merged on reconnect", a.inner_text() == b.inner_text() and "A> " in a.inner_text() and "<B" in a.inner_text(), a.inner_text())
        # read-only
        page.get_by_label("Editable").uncheck()
        page.wait_for_timeout(200)
        check("read-only: not editable", a.get_attribute("contenteditable") == "false" and b.get_attribute("contenteditable") == "false")
        a.click()
        page.keyboard.type("zzz")
        check("read-only: typing does nothing", "zzz" not in a.inner_text())
        check("read-only: no toolbar or handle", page.locator(".cl-handle__grip").count() == 0)

        check("no page errors", not errors, "; ".join(errors))
        browser.close()
    server.shutdown()
    failed = [n for n, ok in results if not ok]
    print(f"\n{len(results) - len(failed)}/{len(results)} checks passed")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
