"""Browser checks for routes and the Pages shell (WP F5).

Starts a throwaway server from this checkout (own port, own data directory),
then drives it with Playwright. Needs the bundle: run `npm run build` in web/ first.

    python web/dev/check_routes.py
"""
import json
import os
import re
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[2]
USER, PASSWORD = "admin", "correct-horse-battery"

failures: list[str] = []
page_errors: list[str] = []
passed = 0


def check(name: str, ok: bool, detail: str = "") -> None:
    global passed
    if ok:
        passed += 1
        print(f"  ok    {name}")
    else:
        failures.append(name)
        print(f"  FAIL  {name} {detail}")


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def api(base: str, method: str, path: str, body=None, token: str | None = None):
    req = urllib.request.Request(base + path, method=method)
    req.add_header("Content-Type", "application/json")
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    data = json.dumps(body).encode() if body is not None else None
    with urllib.request.urlopen(req, data) as res:
        return json.loads(res.read() or b"{}")


def start_server(tmp: str, port: int) -> subprocess.Popen:
    env = {
        **os.environ,
        "PORT": str(port),
        "DB_PATH": os.path.join(tmp, "check.db"),
        "JWT_SECRET": "check-routes-secret-" + "x" * 32,
        "UPLOAD_DIR": os.path.join(tmp, "uploads"),
        "PROXY_DIR": os.path.join(tmp, "proxy"),
        "THUMBNAIL_DIR": os.path.join(tmp, "thumbs"),
        "COVERS_DIR": os.path.join(tmp, "covers"),
        "PROFILES_DIR": os.path.join(tmp, "profiles"),
        "HTML_PREVIEWS": "0",
    }
    proc = subprocess.Popen([sys.executable, "server.py"], cwd=ROOT, env=env,
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    base = f"http://127.0.0.1:{port}"
    for _ in range(100):
        try:
            api(base, "GET", "/api/setup/status")
            return proc
        except Exception:
            time.sleep(0.2)
    proc.kill()
    raise RuntimeError("server did not start")


def main() -> int:
    if not (ROOT / "static" / "dist" / "pages.js").exists():
        print("static/dist/pages.js is missing: run `npm run build` in web/ first")
        return 2
    tmp = tempfile.mkdtemp(prefix="cutline-check-")
    port = free_port()
    base = f"http://127.0.0.1:{port}"
    server = start_server(tmp, port)
    try:
        setup = api(base, "POST", "/api/setup/complete", {"username": USER, "password": PASSWORD})
        token = setup["token"]
        project = api(base, "POST", "/api/projects", {"name": "Alpha"}, token)
        pid = project.get("id") or project.get("project", {}).get("id")
        api(base, "POST", "/api/projects", {"name": "Beta"}, token)
        share = api(base, "POST", f"/api/projects/{pid}/share", {}, token)
        link_id = share["link"]["id"]
        run_browser(base, pid, link_id)
    finally:
        server.kill()
    print(f"\n{passed} checks passed, {len(failures)} failed, {len(page_errors)} page errors")
    for e in page_errors:
        print("  page error:", e)
    for f in failures:
        print("  failed:", f)
    return 1 if failures or page_errors else 0


def view(page) -> str:
    return page.evaluate("document.querySelector('.app').dataset.view")


def path(page) -> str:
    return page.evaluate("location.pathname + location.search")


def wait_view(page, name: str) -> bool:
    try:
        page.wait_for_function(f"document.querySelector('.app').dataset.view === '{name}'", timeout=8000)
        return True
    except Exception:
        return False


def wait_path(page, expected: str) -> bool:
    try:
        page.wait_for_function("e => location.pathname + location.search === e", arg=expected, timeout=8000)
        return True
    except Exception:
        return False


def login(page) -> None:
    page.wait_for_selector("#loginOverlay:not(.hidden)", timeout=10000)
    page.fill("#loginUsername", USER)
    page.fill("#loginPassword", PASSWORD)
    page.press("#loginPassword", "Enter")
    page.wait_for_selector("#loginOverlay", state="hidden", timeout=10000)


def new_page(context):
    page = context.new_page()
    page.on("pageerror", lambda e: page_errors.append(str(e)))
    page.on("dialog", lambda d: (page_errors.append(f"unexpected dialog: {d.message}"), d.dismiss()))
    return page


def run_browser(base: str, pid: str, link_id: str) -> None:
    with sync_playwright() as pw:
        browser = pw.chromium.launch()
        ctx = browser.new_context(base_url=base)
        page = new_page(ctx)

        print("login")
        page.goto("/")
        login(page)
        page.wait_for_selector("#mainTabPages:not(.hidden)")
        check("Pages tab is shown for a logged-in user", True)
        state = ctx.storage_state()
        page.close()

        def logged_in_page(url: str):
            p = new_page(browser.new_context(base_url=base, storage_state=state))
            p.goto(url)
            return p

        print("deep links while logged in")
        for url, want_view in [("/me", "pages"), ("/me/page/abc", "pages"), (f"/p/{pid}/pages", "pages"),
                               (f"/p/{pid}/page/abc", "pages"), (f"/p/{pid}/review", "review"),
                               (f"/p/{pid}/pages?task=t1", "pages"), (f"/p/{pid}/review?clip=1&v=1", "review")]:
            p = logged_in_page(url)
            ok = wait_view(p, want_view)
            check(f"{url} shows the {want_view} view", ok, f"(got {view(p)})")
            if want_view == "pages":
                try:
                    p.wait_for_selector("#viewPages [data-testid=cl-shell]", timeout=8000)
                    check(f"{url} mounts the shell", True)
                except Exception:
                    check(f"{url} mounts the shell", False)
            else:
                try:
                    p.wait_for_function(f"AppState.projectId === '{pid}' && AppState.currentProject", timeout=8000)
                    check(f"{url} loads the project", True)
                except Exception:
                    check(f"{url} loads the project", False)
            check(f"{url} keeps its URL", path(p) == url, f"(got {path(p)})")
            p.context.close()
        p = logged_in_page("/")
        check("/ keeps today's behaviour (a legacy tab)", wait_view(p, "projects"), f"(got {view(p)})")
        p.context.close()

        print("deep link while logged out")
        for url, want_view in [(f"/p/{pid}/review", "review"), (f"/p/{pid}/pages", "pages")]:
            c = browser.new_context(base_url=base)
            p = new_page(c)
            p.goto(url)
            login(p)
            check(f"{url} -> login -> lands on the deep link", wait_view(p, want_view) and path(p) == url,
                  f"(view {view(p)}, path {path(p)})")
            c.close()

        print("idle logout returns to where the user was")
        p = logged_in_page(f"/p/{pid}/pages")
        wait_view(p, "pages")
        p.evaluate("Auth.end('idle')")
        p.wait_for_selector("#loginOverlay:not(.hidden)", timeout=10000)
        check("after the logout the page is the login screen", path(p) == f"/p/{pid}/pages", f"(got {path(p)})")
        login(p)
        check("re-login returns to the page", wait_view(p, "pages") and path(p) == f"/p/{pid}/pages")
        p.context.close()
        print("back and forward")
        p = logged_in_page(f"/p/{pid}/review")
        wait_view(p, "review")
        p.wait_for_function(f"AppState.projectId === '{pid}' && AppState.currentProject")
        p.click('.main-tab[data-tab="docs"]')
        check("Docs tab resets the path to /", wait_view(p, "docs") and path(p) == "/", f"({view(p)} {path(p)})")
        p.click('.main-tab[data-tab="pages"]')
        check("Pages tab pushes the project pages URL", wait_view(p, "pages") and path(p) == f"/p/{pid}/pages", f"({view(p)} {path(p)})")
        p.go_back()
        check("back: Docs at /", wait_view(p, "docs") and path(p) == "/", f"({view(p)} {path(p)})")
        p.go_back()
        check("back: Review", wait_view(p, "review") and path(p) == f"/p/{pid}/review", f"({view(p)} {path(p)})")
        p.go_forward()
        check("forward: Docs at /", wait_view(p, "docs") and path(p) == "/", f"({view(p)} {path(p)})")
        p.go_forward()
        check("forward: Pages", wait_view(p, "pages") and path(p) == f"/p/{pid}/pages", f"({view(p)} {path(p)})")
        for tab in ("projects", "lounge"):
            p.click(f'.main-tab[data-tab="{tab}"]')
            check(f"{tab} tab from a /p/... URL resets the path to /", wait_view(p, tab) and path(p) == "/", f"({view(p)} {path(p)})")
            p.click('.main-tab[data-tab="pages"]')
            wait_view(p, "pages")
        p.context.close()

        print("old ?project= links")
        for query in (f"/?project={pid}", f"/?project={pid}&session=does-not-exist"):
            p = logged_in_page(query)
            ok = wait_view(p, "review") and wait_path(p, f"/p/{pid}/review")
            check(f"{query} is rewritten to /p/<id>/review", ok, f"({view(p)} {path(p)})")
            try:
                p.wait_for_function(f"AppState.projectId === '{pid}' && AppState.currentProject", timeout=8000)
                check(f"{query} loads the project in Review", True)
            except Exception:
                check(f"{query} loads the project in Review", False)
            p.context.close()

        print("Pages shell")
        p = logged_in_page("/")
        wait_view(p, "projects")
        # Today's first visit at "/" opens the project picker after a moment (not related to routes)
        p.wait_for_selector(".ui-modal-visible", timeout=3000)
        p.evaluate("hideProjectSelectionModal()")
        p.click('.main-tab[data-tab="pages"]')
        p.wait_for_selector("#viewPages [data-testid=cl-sidebar]")
        names = p.locator("#viewPages .cl-nav__projects .cl-nav__label").all_inner_texts()
        check("the sidebar lists the projects", sorted(names) == ["Alpha", "Beta"], f"(got {names})")
        check("Pages tab at / goes to the personal space", path(p) == "/me", f"(got {path(p)})")
        p.click("#viewPages button:has-text('Alpha')")
        p.click("#viewPages a:has-text('Pages')")
        check("the sidebar navigates to project pages", path(p) == f"/p/{pid}/pages" and view(p) == "pages")
        check("the active item is highlighted",
              p.locator("#viewPages a.is-active", has_text="Pages").count() == 1)
        p.click("#viewPages a:has-text('Review')")
        check("Review in the sidebar opens the legacy review", wait_view(p, "review") and path(p) == f"/p/{pid}/review",
              f"({view(p)} {path(p)})")
        check("the shell is unmounted when leaving Pages", p.locator("#viewPages [data-testid=cl-shell]").count() == 0)
        p.go_back()
        check("back from Review returns to the shell", wait_view(p, "pages") and
              p.locator("#viewPages [data-testid=cl-shell]").count() == 1)
        p.context.close()

        print("share-link guest")
        c = browser.new_context(base_url=base)
        g = new_page(c)
        g.goto(f"/s/{link_id}")
        g.wait_for_selector("#shareNameInput", timeout=10000)
        g.fill("#shareNameInput", "Guesty")
        g.evaluate("submitShareLinkName()")
        try:
            g.wait_for_function("AppState.isShareLinkGuest && AppState.currentProject", timeout=10000)
            check("the guest sees the project", True)
        except Exception:
            check("the guest sees the project", False)
        check("the guest has no Pages tab", not g.locator("#mainTabPages").is_visible())
        check("the guest stays on the share URL", g.evaluate("location.pathname") == f"/s/{link_id}", f"(got {path(g)})")
        check("the guest is in the review view", view(g) == "review", f"(got {view(g)})")
        g.evaluate("switchTab('pages')")
        check("the guest cannot open Pages", view(g) == "review" and g.evaluate("location.pathname") == f"/s/{link_id}",
              f"({view(g)} {path(g)})")
        c.close()

        print("explicit logout")
        c = browser.new_context(base_url=base)  # own login: logging out ends it on the server
        p = new_page(c)
        p.goto(f"/p/{pid}/pages")
        login(p)
        wait_view(p, "pages")
        p.evaluate("Auth.logout()")
        p.wait_for_selector("#loginOverlay:not(.hidden)", timeout=10000)
        check("an explicit logout does not keep the URL", path(p) == "/", f"(got {path(p)})")
        c.close()

        browser.close()


if __name__ == "__main__":
    sys.exit(main())
