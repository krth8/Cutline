"""Real-browser check of the table cells (web/src/tables/cells).

Builds a dev-only bundle that renders CellsDemo, serves it together with static/css/main.css,
and drives it with Playwright: popovers must open next to their cell even inside a scrolled
container, and the keyboard paths must work. Screenshots (dark and light theme) are written
to the output directory.

Usage (from anywhere):  python web/dev/check_cells.py [output-dir]
Requires: Node.js with `npm ci` done in web/, and `pip install playwright && playwright install chromium`.
"""
from __future__ import annotations

import http.server
import shutil
import subprocess
import sys
import tempfile
import threading
from pathlib import Path

from playwright.sync_api import Page, expect, sync_playwright

WEB = Path(__file__).resolve().parent.parent
ROOT = WEB.parent
OUT = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(tempfile.gettempdir()) / "cutline-cells-check"

PAGE = """<!doctype html>
<html><head><meta charset="utf-8"><title>cells</title>
<link rel="stylesheet" href="/static/css/main.css"><link rel="stylesheet" href="/cells.css">
<style>body{background:var(--bg-dark);color:var(--text);font-family:system-ui,sans-serif;margin:0}</style>
</head><body><div id="root"></div><script src="/cells.js"></script></body></html>"""

failures: list[str] = []


def check(name: str, ok: bool, detail: str = "") -> None:
    print(f"{'PASS' if ok else 'FAIL'}  {name}" + (f"  ({detail})" if detail and not ok else ""))
    if not ok:
        failures.append(name)


class Handler(http.server.SimpleHTTPRequestHandler):
    site: Path

    def translate_path(self, path: str) -> str:
        path = path.split("?", 1)[0].split("#", 1)[0]
        if path.startswith("/static/"):
            return str(ROOT / path.lstrip("/"))
        return str(self.site / path.lstrip("/"))

    def log_message(self, *args) -> None:  # quiet
        pass


def cell(page: Page, typ: str, state: str):
    return page.locator(f'tr[data-type="{typ}"] td[data-state="{state}"] .cl-cellhost')


def near(page: Page, anchor, panel_sel: str, label: str) -> None:
    a = anchor.bounding_box()
    p = page.locator(panel_sel).first.bounding_box()
    vp = page.viewport_size
    assert a and p and vp
    below = abs(p["y"] - (a["y"] + a["height"])) <= 24
    above = abs((p["y"] + p["height"]) - a["y"]) <= 24
    aligned = abs(p["x"] - a["x"]) <= 12 or p["x"] <= 12 or p["x"] + p["width"] >= vp["width"] - 12
    inside = p["x"] >= 0 and p["y"] >= 0 and p["x"] + p["width"] <= vp["width"] and p["y"] + p["height"] <= vp["height"]
    check(f"{label}: popover next to its cell", (below or above) and aligned, f"cell={a} popover={p}")
    check(f"{label}: popover fully inside the viewport", inside, f"popover={p}")


def run(page: Page, base: str) -> None:
    page.goto(f"{base}/?theme=dark")
    page.wait_for_selector('[data-testid="cells-demo"]')

    # --- popovers inside a scrolled container --------------------------------------------
    scroll = page.locator('[data-testid="cells-demo-scroll"]')
    scroll.evaluate("el => { el.scrollTop = 120; }")
    scrolled = scroll.evaluate("el => el.scrollTop")
    check("container is scrolled", scrolled > 0, str(scrolled))

    for typ, panel in [("status", ".cl-picker"), ("people", ".cl-picker"), ("date", ".cl-datepop")]:
        c = cell(page, typ, "filled")
        c.scroll_into_view_if_needed()
        c.click()
        page.wait_for_selector(panel)
        near(page, c, panel, typ)
        parent_is_body = page.locator(panel).first.evaluate("el => el.parentElement === document.body")
        check(f"{typ}: popover is portalled to body (not clipped by the scroller)", parent_is_body)
        # scrolling the container while open keeps the popover attached to its cell
        scroll.evaluate("el => { el.scrollTop = el.scrollTop + 30; }")
        page.wait_for_timeout(100)
        near(page, c, panel, f"{typ} after scrolling")
        page.keyboard.press("Escape")
        page.wait_for_selector(panel, state="detached")

    # --- keyboard paths --------------------------------------------------------------------
    t = cell(page, "text", "filled")
    t.scroll_into_view_if_needed()
    t.focus()
    page.keyboard.type("New title")  # type-to-edit replaces the value
    page.keyboard.press("Enter")
    expect(t).to_contain_text("New title")
    check("text: type to edit, Enter commits", True)
    check("text: focus is back on the cell", t.evaluate("el => el === document.activeElement"))

    t.focus()
    page.keyboard.press("F2")
    page.keyboard.type("discarded")
    page.keyboard.press("Escape")
    expect(t).to_contain_text("New title")
    check("text: Escape cancels", True)

    n = cell(page, "number", "filled")
    n.focus()
    page.keyboard.press("Enter")
    page.keyboard.type("abc")
    page.keyboard.press("Enter")
    check("number: garbage restores the old value", "1" in n.inner_text() and "abc" not in n.inner_text(), n.inner_text())
    n.focus()
    page.keyboard.type("7,25")
    page.keyboard.press("Enter")
    check("number: comma decimal accepted", "7.25" in n.inner_text() or "7,25" in n.inner_text(), n.inner_text())

    s = cell(page, "status", "empty")
    s.focus()
    page.keyboard.press("Enter")
    page.wait_for_selector(".cl-picker")
    page.keyboard.type("rev")
    page.keyboard.press("Enter")
    expect(s).to_contain_text("Review")
    check("status: filter, Enter picks", True)

    p = cell(page, "people", "empty")
    p.focus()
    page.keyboard.press("Enter")
    page.wait_for_selector(".cl-picker")
    page.keyboard.type("ada")
    page.keyboard.press("Enter")  # toggles and clears the filter
    page.keyboard.type("grace")
    page.keyboard.press("Enter")
    page.keyboard.press("Enter")  # commits
    page.wait_for_selector(".cl-picker", state="detached")
    check("people: two picked with the keyboard", p.locator(".cl-avatar").count() == 2, str(p.locator(".cl-avatar").count()))

    d = cell(page, "date", "empty")
    d.focus()
    page.keyboard.type("tomorrow")
    page.keyboard.press("Enter")
    expect(d).to_contain_text("Tomorrow")
    check("date: typed 'tomorrow' commits", True)

    c = cell(page, "checkbox", "empty")
    c.locator("input").click()
    check("checkbox: toggles directly", c.locator("input").is_checked())

    ro = cell(page, "text", "readonly")
    ro.click()
    check("read-only cell does not open an editor", page.locator(".cl-cell__input").count() == 0)

    # Tab does not get trapped
    t.focus()
    page.keyboard.press("Enter")
    page.keyboard.type("tabbed")
    page.keyboard.press("Tab")
    expect(t).to_contain_text("tabbed")
    check("text: Tab commits and moves focus on", page.evaluate("document.activeElement !== document.body"))

    # --- screenshots -----------------------------------------------------------------------
    OUT.mkdir(parents=True, exist_ok=True)
    for theme in ("dark", "light"):
        page.goto(f"{base}/?theme={theme}")
        page.wait_for_selector('[data-testid="cells-demo"]')
        page.evaluate("document.querySelector('[data-testid=\"cells-demo-scroll\"]').style.maxHeight = 'none'")
        cell(page, "status", "filled").click()
        page.wait_for_selector(".cl-picker")
        shot = OUT / f"cells-{theme}-picker.png"
        page.screenshot(path=str(shot))
        print(f"      screenshot: {shot}")
        page.keyboard.press("Escape")
        cell(page, "date", "filled").click()
        page.wait_for_selector(".cl-datepop")
        shot = OUT / f"cells-{theme}-date.png"
        page.screenshot(path=str(shot))
        print(f"      screenshot: {shot}")
        page.keyboard.press("Escape")


def main() -> int:
    site = Path(tempfile.mkdtemp(prefix="cutline-cells-"))
    try:
        subprocess.run(["node", "dev/build_cells_demo.mjs", str(site)], cwd=WEB, check=True, shell=sys.platform == "win32")
        (site / "index.html").write_text(PAGE, encoding="utf-8")
        Handler.site = site
        server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        base = f"http://127.0.0.1:{server.server_address[1]}"
        with sync_playwright() as pw:
            browser = pw.chromium.launch()
            page = browser.new_page(viewport={"width": 1100, "height": 800})
            errors: list[str] = []
            page.on("pageerror", lambda e: errors.append(str(e)))
            page.on("console", lambda m: m.type == "error" and errors.append(m.text))
            try:
                run(page, base)
            except Exception as e:  # noqa: BLE001
                check(f"script ran to the end ({type(e).__name__})", False, str(e).splitlines()[0] if str(e) else "")
            check("no console errors", not errors, "; ".join(errors))
            browser.close()
        server.shutdown()
    finally:
        shutil.rmtree(site, ignore_errors=True)
    print(f"\n{'ALL CHECKS PASSED' if not failures else 'FAILED: ' + ', '.join(failures)}")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
