"""Browser test fixtures: a real Cutline server per test module, driven by headless Chromium.

Independent of tests/conftest.py (which imports the app in-process). Shared code lives in
e2e_support.py (not here, so test files can import it without clashing with tests/conftest.py).
"""

import os
import shutil
from pathlib import Path

import pytest

pytest.importorskip("playwright")
from playwright.sync_api import sync_playwright  # noqa: E402

from e2e.e2e_support import _active_servers, _start  # noqa: E402


def pytest_collection_modifyitems(items):
    for item in items:
        if "e2e" in Path(str(item.fspath)).parts:
            item.add_marker(pytest.mark.e2e)


@pytest.hookimpl(hookwrapper=True)
def pytest_runtest_makereport(item, call):
    outcome = yield
    rep = outcome.get_result()
    if rep.when == "call" and rep.failed:
        for srv in _active_servers:
            rep.sections.append((f"server log tail ({srv.base_url})", srv.log_tail()))


@pytest.fixture(scope="module")
def server_factory():
    """Start servers on demand: `server_factory(IDLE_TIMEOUT_MINUTES=1)`. All stop at module end."""
    started = []

    def make(**env):
        srv = _start(env)
        started.append(srv)
        _active_servers.append(srv)
        return srv

    yield make
    for srv in started:
        srv.stop()
        if srv in _active_servers:
            _active_servers.remove(srv)
        shutil.rmtree(srv.tmp, ignore_errors=True)


@pytest.fixture(scope="module")
def server(server_factory):
    """One server (admin already set up) shared by the tests of a module."""
    return server_factory()


@pytest.fixture(scope="session")
def browser():
    headed = os.environ.get("E2E_HEADED", "") not in ("", "0")
    with sync_playwright() as p:
        b = p.chromium.launch(headless=not headed, slow_mo=int(os.environ.get("E2E_SLOWMO", "0")))
        yield b
        b.close()


@pytest.fixture(scope="module")
def new_page(browser):
    """Factory: `new_page(context=None, name="a")` gives a Page in a fresh (or the given) context.

    Uncaught page errors and tokens in WebSocket URLs are collected and fail the test that
    was running when they happened.
    """
    contexts, errors = [], []

    def make(context=None, name="page"):
        ctx = context or browser.new_context()
        if ctx not in contexts:
            contexts.append(ctx)
        page = ctx.new_page()
        page.set_default_timeout(10000)
        page.on("pageerror", lambda e: errors.append(f"{name}: uncaught {e}"))
        page.on("websocket", lambda w: errors.append(f"{name}: token in WebSocket URL {w.url}")
                if "token=" in w.url else None)
        page.on("dialog", lambda d: d.accept())
        return page

    make.errors = errors
    yield make
    for c in contexts:
        try:
            c.close()
        except Exception:
            pass


@pytest.fixture(autouse=True)
def _fail_on_page_errors(request):
    yield
    if "new_page" in request.fixturenames:
        errors = request.getfixturevalue("new_page").errors
        if errors:
            msgs = list(errors)
            errors.clear()
            pytest.fail("page errors:\n" + "\n".join(msgs), pytrace=False)
