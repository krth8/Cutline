"""Real-browser check of the table store (web/src/tables/store).

Starts a throwaway server, logs in twice (two browser contexts), mounts StoreDemo into the real
app page in both and checks: an edit shows at once in the editing tab, reaches the other tab
through the live event, a created and a deleted row do too, and the server holds the change.

Usage:  python web/dev/check_store.py
Requires: `npm ci` in web/, `pip install playwright && playwright install chromium`.
"""
from __future__ import annotations

import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

WEB = Path(__file__).resolve().parent.parent
ROOT = WEB.parent
sys.path.insert(0, str(ROOT / "tests"))

from e2e.e2e_support import ADMIN, _start, login  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

failures: list[str] = []


def check(name: str, ok: bool, detail: str = "") -> None:
    print(f"{'PASS' if ok else 'FAIL'}  {name}" + (f"  ({detail})" if detail and not ok else ""))
    if not ok:
        failures.append(name)


def names(page) -> list[str]:
    return page.eval_on_selector_all("[data-row-id] .cl-cellhost", "els => els.map(e => e.innerText.trim())")


def open_page(browser, server, site: Path, ref: str):
    ctx = browser.new_context()
    page = ctx.new_page()
    errors: list[str] = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    login(page, server.base_url, ADMIN["username"], ADMIN["password"])
    page.wait_for_function("window.Live && Live.isConnected()", timeout=10000)
    page.add_style_tag(path=str(site / "store.css"))
    page.add_script_tag(path=str(site / "store.js"))
    page.evaluate(
        """ref => { const el = document.createElement('div');
            el.style.cssText = 'position:fixed;inset:0;z-index:99999;background:#222;color:#eee;padding:24px';
            document.body.appendChild(el); window.StoreDemoMount(el, ref); }""",
        ref,
    )
    page.wait_for_selector('[data-testid="store-demo"]')
    return page, errors


def main() -> int:
    site = Path(tempfile.mkdtemp(prefix="cutline-store-"))
    server = None
    try:
        subprocess.run(["node", "dev/build_store_demo.mjs", str(site)], cwd=WEB, check=True, shell=sys.platform == "win32")
        server = _start()
        pid = server.create_project("Spot")
        server.create_task(pid, "Storyboard")
        server.create_task(pid, "Layout")
        ref = f"tasks:{pid}"
        with sync_playwright() as pw:
            browser = pw.chromium.launch()
            a, errs_a = open_page(browser, server, site, ref)
            b, errs_b = open_page(browser, server, site, ref)
            for p in (a, b):
                p.wait_for_function("document.querySelectorAll('[data-row-id]').length === 2", timeout=8000)
            check("both tabs list the two tasks", sorted(names(a)) == sorted(names(b)) == ["Layout", "Storyboard"], str(names(a)))
            a.wait_for_timeout(2500)  # the live watch list is sent to the server within 2 s

            # Rename "Layout" in tab A
            cell = a.locator("[data-row-id] .cl-cellhost", has_text="Layout").first
            cell.focus()
            a.keyboard.press("Enter")
            a.keyboard.press("Control+A")
            a.keyboard.type("Layout pass 1")
            a.keyboard.press("Enter")
            check("edit shows in the editing tab", "Layout pass 1" in names(a), str(names(a)))
            try:
                b.wait_for_function(
                    "[...document.querySelectorAll('[data-row-id] .cl-cellhost')].some(e => e.innerText.trim() === 'Layout pass 1')",
                    timeout=8000,
                )
                check("edit reaches the second tab through the live event", True)
            except Exception:
                check("edit reaches the second tab through the live event", False, str(names(b)))
            tasks = server.api(f"/api/projects/{pid}/tasks")
            tasks = tasks["tasks"] if isinstance(tasks, dict) else tasks
            stored = [t["name"] for t in tasks]
            check("server stored the new name", "Layout pass 1" in stored, str(stored))

            # Create in B, appears in A
            b.click('[data-testid="store-demo-add"]')
            check("created row shows at once in the creating tab", len(names(b)) == 3, str(names(b)))
            try:
                a.wait_for_function("document.querySelectorAll('[data-row-id]').length === 3", timeout=8000)
                check("created row reaches the first tab", True)
            except Exception:
                check("created row reaches the first tab", False, str(names(a)))
            check("temporary id replaced by the real one",
                  not b.eval_on_selector_all("[data-row-id]", "els => els.some(e => e.dataset.rowId.startsWith('tmp:'))"))

            # Delete in A, disappears in B
            a.locator("[data-row-id]", has_text="Storyboard").first.get_by_label("Delete").click()
            check("deleted row leaves at once in the deleting tab", "Storyboard" not in names(a), str(names(a)))
            try:
                b.wait_for_function("![...document.querySelectorAll('[data-row-id] .cl-cellhost')].some(e => e.innerText.trim() === 'Storyboard')", timeout=8000)
                check("deleted row leaves the second tab", True)
            except Exception:
                check("deleted row leaves the second tab", False, str(names(b)))

            check("no page errors", not (errs_a or errs_b), "; ".join(errs_a + errs_b))
            browser.close()
    finally:
        if server:
            server.stop()
            shutil.rmtree(server.tmp, ignore_errors=True)
        shutil.rmtree(site, ignore_errors=True)
    print(f"\n{'ALL CHECKS PASSED' if not failures else 'FAILED: ' + ', '.join(failures)}")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
