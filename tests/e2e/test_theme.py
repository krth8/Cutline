"""Theme: theme.css is served and loaded before main.css; the light theme can be chosen, survives a reload
without a dark flash, and the operating system's preference is followed when nothing is stored;
/dev/theme is for admins only.

Needs the bundle: `cd web && npm run build`.
"""

from pathlib import Path

import pytest
from playwright.sync_api import expect

from e2e.e2e_support import PASSWORD, REPO, login

pytestmark = pytest.mark.e2e

if not Path(REPO, "static", "dist", "pages.js").exists():
    pytest.skip("web bundle not built (cd web && npm run build)", allow_module_level=True)

BG = "getComputedStyle(document.documentElement).getPropertyValue('--bg-dark').trim()"


@pytest.fixture(scope="module")
def scene(server):
    server.create_user("tina")
    return server


def new_context(browser, color_scheme, stored=None):
    ctx = browser.new_context(color_scheme=color_scheme)
    if stored:
        ctx.add_init_script(f"try {{ localStorage.setItem('theme', '{stored}') }} catch (e) {{}}")
    return ctx


def test_theme_css_is_served_and_loaded_before_main_css(scene, browser, new_page):
    res = browser.new_context().request.get(scene.base_url + "/static/css/theme.css")
    assert res.status == 200 and "--bg-dark" in res.text()
    page = new_page()
    page.goto(scene.base_url + "/")
    hrefs = page.evaluate("[...document.querySelectorAll('link[rel=stylesheet]')].map(l => l.getAttribute('href'))")
    local = [h for h in hrefs if h.startswith("/static/css/")]
    assert local[0].startswith("/static/css/theme.css") and local[1].startswith("/static/css/main.css"), local
    # main.css no longer carries the palette
    css = browser.new_context().request.get(scene.base_url + "/static/css/main.css").text()
    assert "--bg-dark:" not in css


def test_dark_is_the_default_and_system_follows_the_os_when_chosen(scene, browser, new_page):
    # Nothing stored: dark, whatever the operating system prefers
    page = new_page(new_context(browser, "light"))
    page.goto(scene.base_url + "/")
    assert page.evaluate("document.documentElement.getAttribute('data-theme')") == "dark"
    assert page.evaluate("window.CutlineTheme.get()") == "dark"
    for scheme, expected in (("light", "light"), ("dark", "dark")):
        page = new_page(new_context(browser, scheme, stored="system"))
        page.goto(scene.base_url + "/")
        assert page.evaluate("document.documentElement.getAttribute('data-theme')") == expected
        assert page.evaluate("window.CutlineTheme.get()") == "system"
    # A stored choice wins over the system preference
    page = new_page(new_context(browser, "light", stored="dark"))
    page.goto(scene.base_url + "/")
    assert page.evaluate("document.documentElement.getAttribute('data-theme')") == "dark"


def test_switching_to_light_survives_a_reload_without_a_dark_flash(scene, browser, new_page):
    page = new_page(new_context(browser, "dark"))
    login(page, scene.base_url, "tina")
    assert page.evaluate("document.documentElement.getAttribute('data-theme')") == "dark"
    page.evaluate("window.CutlineTheme.set('light')")
    assert page.evaluate("document.documentElement.getAttribute('data-theme')") == "light"
    assert page.evaluate("localStorage.getItem('theme')") == "light"
    assert page.evaluate(BG) == "#f4f4f8"

    # Reload and record <html data-theme> at the moment the browser first meets the theme.css link:
    # the inline script in the head must already have set it
    page.add_init_script("""
        window.__themeAtLink = [];
        new MutationObserver((records) => {
            for (const r of records) for (const n of r.addedNodes) {
                if (n.nodeName === 'LINK' && (n.getAttribute('href') || '').includes('theme.css')) {
                    window.__themeAtLink.push(document.documentElement.getAttribute('data-theme'));
                }
            }
        }).observe(document, { childList: true, subtree: true });
    """)
    page.reload()
    seen = page.evaluate("window.__themeAtLink")
    assert seen == ["light"], seen
    assert page.evaluate("document.documentElement.getAttribute('data-theme')") == "light"
    assert page.evaluate("getComputedStyle(document.body).backgroundColor") == "rgb(244, 244, 248)"


def test_system_choice_follows_a_change_of_the_os_preference(scene, browser, new_page):
    page = new_page(new_context(browser, "dark", stored="system"))
    page.goto(scene.base_url + "/")
    page.emulate_media(color_scheme="light")
    page.wait_for_function("document.documentElement.getAttribute('data-theme') === 'light'")


def test_switch_theme_command_cycles_system_light_dark(scene, browser, new_page):
    page = new_page(new_context(browser, "dark"))
    login(page, scene.base_url, "tina", goto="/home")
    page.wait_for_selector("[data-testid=sidebar-search]", timeout=20000)
    seen = []
    for _ in range(3):
        page.keyboard.press("Control+k")
        page.wait_for_selector("[data-testid=search-input]")
        page.fill("[data-testid=search-input]", ">switch theme")
        page.locator("[data-testid=search-result]:has-text('Switch theme')").first.wait_for()
        page.keyboard.press("Enter")
        page.wait_for_timeout(300)
        seen.append(page.evaluate("window.CutlineTheme.get()"))
    assert seen == ["system", "light", "dark"], seen


def test_dev_theme_page_is_for_admins_only(scene, browser, new_page):
    admin_page = new_page(new_context(browser, "dark"))
    login(admin_page, scene.base_url, "admin", password=scene.admin["password"], goto="/dev/theme")
    expect(admin_page.locator("[data-testid=dev-theme]")).to_be_visible()
    expect(admin_page.locator("[data-testid='chip--accent']")).to_be_visible()
    admin_page.get_by_role("button", name="Light").click()
    expect(admin_page.locator("[data-testid=theme-resolved]")).to_have_text("light")

    user_page = new_page(new_context(browser, "dark"))
    login(user_page, scene.base_url, "tina", password=PASSWORD, goto="/dev/theme")
    user_page.wait_for_timeout(2500)
    assert user_page.locator("[data-testid=dev-theme]").count() == 0
