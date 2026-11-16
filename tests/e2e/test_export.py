"""Export in a real browser: a page as Markdown (zip with its image), a view as CSV, and the print state of a page
(print media emulated; the PDF and a screenshot are written to the tests' temp folder and checked)."""

import base64
import csv
import io
import os
import zipfile

import pytest

from e2e.e2e_support import TINY_PNG, login
from e2e.test_page_files import PASTE_JS
from e2e.test_pages_sync import PROSE

pytestmark = pytest.mark.e2e

OUT = os.path.join(os.environ.get("TEMP", "/tmp"), "cutline-h5-print")


@pytest.fixture(scope="module")
def scene(server, new_page):
    alice_id = server.create_user("alice")
    project = server.create_project("Export")
    server.grant_access(project, alice_id)
    for name in ("Alpha task", "Beta, with comma"):
        server.create_task(project, name)
    page_id = server.create_page(project, "Export me")
    page = new_page(name="alice")
    login(page, server.base_url, "alice", goto=f"/p/{project}/page/{page_id}")
    page.wait_for_selector(PROSE, timeout=20000)
    page.wait_for_selector('.cl-sync-status[data-status="synced"]', timeout=20000)
    return {"page": page, "project": project, "id": page_id, "state": {}}


def open_page_menu(page):
    page.get_by_role("button", name="Page menu").click()


def test_build_the_page(scene):
    page = scene["page"]
    page.click(PROSE)
    page.keyboard.type("Hello *world* export text")
    page.keyboard.press("Enter")
    page.evaluate(PASTE_JS, base64.b64encode(TINY_PNG).decode())
    page.wait_for_selector(PROSE + " img.cl-image__img", timeout=15000)
    page.wait_for_function("() => { const i = document.querySelector('img.cl-image__img'); return i && i.complete && i.naturalWidth > 0; }")
    page.click(PROSE)
    page.keyboard.press("Control+End")
    page.keyboard.press("Enter")
    page.keyboard.type("/table")
    page.click('[role=option]:has-text("Tasks as a table")')
    page.wait_for_selector("[data-testid=view-block][data-state=ready]", timeout=15000)
    scene["state"]["view"] = page.get_attribute("[data-testid=view-block]", "data-view-id")
    assert scene["state"]["view"]


def test_markdown_download_from_the_page_menu(scene):
    page = scene["page"]
    page.wait_for_selector('.cl-sync-status[data-status="synced"]', timeout=20000)
    # the server reads the saved document (typing is flushed by the export itself, no waiting for the snapshot)
    open_page_menu(page)
    with page.expect_download() as info:
        page.get_by_role("menuitem", name="Export...").click()
        page.click("[data-testid=export-md]")
    download = info.value
    assert download.suggested_filename == "Export me.zip"
    archive = zipfile.ZipFile(download.path())
    names = archive.namelist()
    assert "Export me.md" in names and any(n.startswith("files/") for n in names)
    text = archive.read("Export me.md").decode()
    assert text.startswith("# Export me\n")
    assert "Hello" in text and "export text" in text
    assert "![" in text and "](files/" in text
    assert "| Name |" in text and "Alpha task" in text and "Beta, with comma" in text


def test_a_page_without_files_downloads_a_plain_md(scene, server):
    other = server.create_page(scene["project"], "Plain page")
    page = scene["page"]
    page.goto(f"{server.base_url}/p/{scene['project']}/page/{other}")
    page.wait_for_selector(PROSE, timeout=20000)
    page.click(PROSE)
    page.keyboard.type("Only text")
    page.wait_for_selector('.cl-sync-status[data-status="synced"]', timeout=20000)
    open_page_menu(page)
    with page.expect_download() as info:
        page.get_by_role("menuitem", name="Export...").click()
        page.click("[data-testid=export-md]")
    assert info.value.suggested_filename == "Plain page.md"
    assert open(info.value.path(), encoding="utf-8").read() == "# Plain page\n\nOnly text\n"


def test_csv_download_from_the_view_menu(scene, server):
    page = scene["page"]
    page.goto(f"{server.base_url}/p/{scene['project']}/view/{scene['state']['view']}")
    page.wait_for_selector("[data-testid=view-shell]", timeout=20000)
    page.wait_for_selector("[data-testid=table-row], .cl-table__row", timeout=20000)
    page.get_by_test_id("toolbar-more").click()
    with page.expect_download() as info:
        page.get_by_role("menuitem", name="Export CSV").click()
    assert info.value.suggested_filename.endswith(".csv")
    raw = open(info.value.path(), "rb").read()
    assert raw.startswith(b"\xef\xbb\xbf") and b"\r\n" in raw
    rows = list(csv.reader(io.StringIO(raw.decode("utf-8-sig"), newline="")))
    assert rows[0][0] == "Name"
    assert sorted(r[0] for r in rows[1:]) == ["Alpha task", "Beta, with comma"]


def test_print_state_hides_the_chrome_and_keeps_the_content(scene, server):
    page = scene["page"]
    page.goto(f"{server.base_url}/p/{scene['project']}/page/{scene['id']}")
    page.wait_for_selector(PROSE + " img.cl-image__img", timeout=20000)
    page.wait_for_selector("[data-testid=view-block][data-state=ready]", timeout=20000)
    # the browser's print dialog cannot be driven: window.print is replaced by a recorder, so the page stays in its print state
    page.evaluate("() => { window.__printed = 0; window.print = () => { window.__printed++; }; }")
    open_page_menu(page)
    page.get_by_role("menuitem", name="Export...").click()
    page.click("[data-testid=export-print]")
    page.wait_for_function("() => window.__printed === 1")
    page.wait_for_selector(".cl-print-table tbody tr", state="attached")
    page.emulate_media(media="print")
    os.makedirs(OUT, exist_ok=True)
    page.screenshot(path=os.path.join(OUT, "print.png"), full_page=True)
    hidden = page.evaluate("""() => ['.cl-nav-host', '.header-global', '.cl-page__bar', '.cl-handle', '.cl-viewbar']
        .map((s) => [s, [...document.querySelectorAll(s)].every((e) => getComputedStyle(e).display === 'none')])""")
    assert all(ok for _s, ok in hidden), hidden
    shown = page.evaluate("""() => ({
        table: getComputedStyle(document.querySelector('.cl-print-table')).display,
        live: getComputedStyle(document.querySelector('.cl-viewshell')).display,
        theme: document.documentElement.getAttribute('data-theme'),
        text: document.querySelector('.cl-page').innerText })""")
    assert shown["table"] == "block" and shown["live"] == "none" and shown["theme"] == "light"
    assert "Hello" in shown["text"] and "Alpha task" in shown["text"]
    # the PDF is made last: Chromium fires beforeprint/afterprint around it, which also restores the page
    pdf = page.pdf(path=os.path.join(OUT, "print.pdf"), format="A4", print_background=True)
    assert pdf.startswith(b"%PDF")
    # coming back from print restores the page
    page.emulate_media(media="screen")
    page.evaluate("() => window.dispatchEvent(new Event('afterprint'))")
    page.wait_for_function("() => !document.documentElement.classList.contains('cl-print-page')")
    assert page.locator(".cl-print-table").count() == 0
