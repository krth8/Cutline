"""Login, idle warning and logout, in two tabs of one browser.

The tests run in order and share one server (idle timeout 1 minute) and two tabs; the whole module
takes about two minutes because it waits for the idle timeout.
"""

import pytest

from e2e.e2e_support import ADMIN, login_visible, wait_logged_in, wait_logged_out

pytestmark = [pytest.mark.e2e, pytest.mark.slow]


@pytest.fixture(scope="module")
def server(server_factory):
    return server_factory(IDLE_TIMEOUT_MINUTES=1)


@pytest.fixture(scope="module")
def ctx(browser):
    c = browser.new_context()
    yield c
    c.close()


@pytest.fixture(scope="module")
def tabs(new_page, ctx, server):
    a = new_page(ctx, "A")
    a.goto(server.base_url + "/")
    a.wait_for_selector("#mainLoginBtn")
    return {"a": a, "b": None, "ctx": ctx}


def ui_login(page):
    page.fill("#loginUsername", ADMIN["username"])
    page.fill("#loginPassword", ADMIN["password"])
    page.click("#mainLoginBtn")
    wait_logged_in(page, 5000)


def session_token(ctx):
    return [c for c in ctx.cookies() if c["name"] == "cutline_session"][0]["value"]


def test_login_overlay_shown_when_logged_out(tabs):
    assert login_visible(tabs["a"])


def test_ui_login(tabs):
    a = tabs["a"]
    ui_login(a)
    assert not login_visible(a)
    assert a.evaluate("AppState.userId === AppState.adminUser.id")


def test_second_tab_picks_up_the_login(tabs, new_page, server):
    b = new_page(tabs["ctx"], "B")
    b.goto(server.base_url + "/")
    wait_logged_in(b)
    tabs["b"] = b


def test_token_not_readable_by_scripts(tabs):
    a = tabs["a"]
    assert a.evaluate("AppState.authToken === true"), "authToken should be a flag, not the token"
    assert a.evaluate("!/eyJ/.test(JSON.stringify(localStorage))")
    assert a.evaluate("!document.cookie.includes('cutline_session')")
    assert a.evaluate("sessionStorage.length === 0 || !/eyJ/.test(JSON.stringify(sessionStorage))")


def test_idle_warning_in_both_tabs(tabs):
    # timeout 60 s, warning 30 s before the end
    tabs["a"].wait_for_selector(".idle-warning", timeout=50000)
    tabs["b"].wait_for_selector(".idle-warning", timeout=10000)


def test_stay_logged_in_dismisses_warning_everywhere(tabs):
    a, b = tabs["a"], tabs["b"]
    a.click(".idle-warning [data-action=stay]")
    a.wait_for_selector(".idle-warning", state="detached", timeout=3000)
    b.wait_for_selector(".idle-warning", state="detached", timeout=8000)
    me = a.evaluate("fetch('/api/auth/me').then(r => r.json())")
    assert me["idleRemaining"] > 50, "the server should have heard about the activity"


def test_idle_logout_in_both_tabs_with_message(tabs):
    a, b = tabs["a"], tabs["b"]
    a.wait_for_function(
        "!document.getElementById('loginOverlay').classList.contains('hidden') && !window.AppState.authToken",
        timeout=95000)
    a.wait_for_load_state("load")
    a.wait_for_function("document.getElementById('loginError').innerText.includes('inactive')", timeout=5000)
    wait_logged_out(b, 10000)
    assert a.evaluate("localStorage.getItem('authData')") is None


def test_login_in_one_tab_logs_the_other_in(tabs):
    ui_login(tabs["a"])
    wait_logged_in(tabs["b"])


def test_logout_in_one_tab_logs_the_other_out(tabs, server):
    a, b = tabs["a"], tabs["b"]
    token = session_token(tabs["ctx"])
    b.evaluate("logout()")
    wait_logged_out(b)
    wait_logged_out(a)
    a.wait_for_load_state("load")
    from e2e.e2e_support import ApiError
    with pytest.raises(ApiError) as e:
        server.api("/api/auth/me", token=token)
    assert e.value.status == 401, "token should be dead on the server after logout"
    assert a.evaluate("document.getElementById('loginError').classList.contains('hidden')"), \
        "no idle message after a normal logout"


def test_server_side_session_end_shows_login_screen(tabs, server):
    a = tabs["a"]
    ui_login(a)
    token = session_token(tabs["ctx"])
    server.api("/api/auth/logout", {}, token=token)  # live connection closes; no request needed
    wait_logged_out(a)
    a.wait_for_load_state("load")
    a.wait_for_function("document.getElementById('loginError').innerText.includes('session has ended')",
                        timeout=5000)
    assert login_visible(a)
