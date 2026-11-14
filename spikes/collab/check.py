"""End-to-end check for the collab spike. Run: python check.py  (needs `npm run build` first)."""
import asyncio
import json
import os
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request
from pathlib import Path

from playwright.async_api import async_playwright

HERE = Path(__file__).parent
RESULTS: list[tuple[str, bool, str]] = []


def free_port() -> int:
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    p = s.getsockname()[1]
    s.close()
    return p


class Server:
    def __init__(self, port, db):
        self.port, self.db, self.proc = port, db, None

    def start(self):
        env = dict(os.environ, COLLAB_DB=self.db)
        self.proc = subprocess.Popen([sys.executable, str(HERE / "server.py"), str(self.port)], env=env)
        for _ in range(100):
            try:
                self.get("/stats/x")
                return
            except Exception:
                time.sleep(0.1)
        raise RuntimeError("server did not start")

    def kill(self):
        self.proc.kill()
        self.proc.wait()

    def get(self, path, method="GET"):
        req = urllib.request.Request(f"http://127.0.0.1:{self.port}{path}", method=method)
        with urllib.request.urlopen(req, timeout=10) as r:
            return r.read().decode()


def record(name, ok, detail=""):
    RESULTS.append((name, ok, detail))
    print(f"{'PASS' if ok else 'FAIL'}  {name}  {detail}", flush=True)


async def text_of(page):
    return await page.evaluate("spike.editor.getText({blockSeparator: '\\n'})")


async def wait_text(page, pred, timeout=10):
    end = time.time() + timeout
    t = ""
    while time.time() < end:
        t = await text_of(page)
        if pred(t):
            return True, t
        await asyncio.sleep(0.1)
    return False, t


async def wait_connected(page, timeout=15):
    await page.wait_for_function("document.querySelector('#status').dataset.status==='connected' && document.querySelector('#status').dataset.synced==='1'", timeout=timeout * 1000)


async def open_client(browser, port, name, color, page_id="p1"):
    ctx = await browser.new_context()
    page = await ctx.new_page()
    await page.goto(f"http://127.0.0.1:{port}/?page={page_id}&name={name}&color=%23{color}")
    await wait_connected(page)
    return ctx, page


async def main():
    tmp = tempfile.mkdtemp()
    port = free_port()
    srv = Server(port, os.path.join(tmp, "collab.db"))
    srv.start()
    async with async_playwright() as pw:
        browser = await pw.chromium.launch()
        ctxA, A = await open_client(browser, port, "Alice", "e11d48")
        ctxB, B = await open_client(browser, port, "Bob", "2563eb")
        ed = ".ProseMirror"

        # (b) text typed in A appears in B
        await A.click(ed)
        await A.keyboard.type("Hello world")
        ok, t = await wait_text(B, lambda t: t == "Hello world")
        record("(b) A -> B", ok, repr(t))

        # (a) both type in the same paragraph at the same time
        await A.click(ed)
        await A.keyboard.press("Home")
        await B.click(ed)
        await B.keyboard.press("End")
        await asyncio.gather(A.keyboard.type("AAAAAAAAAA", delay=40), B.keyboard.type("BBBBBBBBBB", delay=40))
        want = lambda t: t == "AAAAAAAAAAHello worldBBBBBBBBBB"
        okA, ta = await wait_text(A, want)
        okB, tb = await wait_text(B, want)
        record("(a) concurrent typing, same paragraph", okA and okB, f"A={ta!r} B={tb!r}")

        # (g) the other user's caret is in the DOM
        carets = await B.evaluate(
            "[...document.querySelectorAll('.collaboration-carets__label')].map(e=>e.textContent)")
        record("(g) remote caret element present", "Alice" in carets, f"B sees {carets}")

        # awareness cleanup: closing A's page removes its caret from B
        ctxC, C = await open_client(browser, port, "Carol", "16a34a")
        await C.click(ed)
        await C.keyboard.press("End")
        ok_seen, _ = await wait_text(B, lambda t: True)
        seen = False
        for _ in range(50):
            labels = await B.evaluate(
                "[...document.querySelectorAll('.collaboration-carets__label')].map(e=>e.textContent)")
            if "Carol" in labels:
                seen = True
                break
            await asyncio.sleep(0.1)
        await C.close()
        await ctxC.close()
        await asyncio.sleep(0.5)
        carets_b = await B.evaluate(
            "[...document.querySelectorAll('.collaboration-carets__label')].map(e=>e.textContent)")
        record("(extra) Carol caret seen, then removed after she closes", seen and "Carol" not in carets_b, f"B sees {carets_b}")

        base = "AAAAAAAAAAHello worldBBBBBBBBBB"
        # (e) server-side plain text
        txt = srv.get("/text/p1")
        record("(e) server plain text", txt == base, repr(txt))

        # (c) kill + restart the server
        srv.kill()
        await asyncio.sleep(1.0)
        srv.start()
        await wait_connected(A, 20)
        await wait_connected(B, 20)
        ta, tb = await text_of(A), await text_of(B)
        await A.click(ed)
        await A.keyboard.press("Control+End")
        await A.keyboard.type(" after-restart")
        ok, t = await wait_text(B, lambda t: t == base + " after-restart")
        txt = srv.get("/text/p1")
        record("(c) server restart: content kept, editing continues",
               ok and ta == base and tb == base and txt == base + " after-restart",
               f"A={ta!r} B={tb!r} B-after={t!r} server={txt!r}")
        base += " after-restart"

        # fresh server process reading only SQLite (restart again, nobody typing)
        # (d) A offline, both edit, reconnect
        await ctxA.set_offline(True)
        await A.evaluate("spike.provider.ws.close()")
        await asyncio.sleep(0.5)
        await A.click(ed)
        await A.keyboard.press("Control+Home")
        await A.keyboard.type("OFFLINE-A ")
        await B.click(ed)
        await B.keyboard.press("Control+End")
        await B.keyboard.type(" ONLINE-B")
        await asyncio.sleep(0.5)
        mid_a = await text_of(A)
        await ctxA.set_offline(False)
        want = "OFFLINE-A " + base + " ONLINE-B"
        okA, ta = await wait_text(A, lambda t: t == want, 20)
        okB, tb = await wait_text(B, lambda t: t == want, 20)
        record("(d) offline edits converge", okA and okB and mid_a.startswith("OFFLINE-A"),
               f"A={ta!r} B={tb!r}")
        base = want

        # measurements need update sizes: collected below in measure.py; here (f) snapshot
        before = json.loads(srv.get("/stats/p1"))
        snap = json.loads(srv.get("/snapshot/p1", "POST"))
        after = json.loads(srv.get("/stats/p1"))
        srv.kill()
        srv.start()  # in-memory docs gone; rebuild from the snapshot only
        ctxD, D = await open_client(browser, port, "Dave", "9333ea")
        ok, t = await wait_text(D, lambda t: t == base)
        record("(f) after snapshot (+server restart) fresh client gets full doc",
               ok and after["update_rows"] == 0, f"D={t!r} before={before} snap={snap} after={after}")
        txt = srv.get("/text/p1")
        record("(e2) server plain text after snapshot reload", txt == base, repr(txt))

        await browser.close()
    srv.kill()
    failed = [r for r in RESULTS if not r[1]]
    print(f"\n{len(RESULTS) - len(failed)}/{len(RESULTS)} passed")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    asyncio.run(main())
