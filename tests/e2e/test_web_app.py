"""The installable web app: the manifest is linked, the service worker is registered for the whole app, and the
notifications panel offers push for this device.

Showing a notification and subscribing are not tested here: a headless browser refuses the permission, and
subscribing needs the browser vendor's push service. The server side is covered in tests/test_push.py.
"""

import pytest
from playwright.sync_api import expect

from e2e.e2e_support import login

pytestmark = pytest.mark.e2e


def test_the_app_is_installable_and_offers_push(server, browser):
    server.create_user("pia")
    context = browser.new_context(viewport={"width": 1280, "height": 800})
    page = context.new_page()
    try:
        login(page, server.base_url, "pia", goto="/home")
        page.wait_for_selector("[data-testid=cl-sidebar]", timeout=20000)

        manifest = page.evaluate("fetch(document.querySelector('link[rel=manifest]').href).then(r => r.json())")
        assert manifest["display"] == "standalone" and manifest["start_url"] == "/"
        assert {i["sizes"] for i in manifest["icons"]} >= {"192x192", "512x512"}

        scope = page.evaluate("navigator.serviceWorker.ready.then(r => r.scope)")
        assert scope == server.base_url + "/"

        page.click("#notificationsBtn")
        button = page.locator("#pushToggleBtn")
        expect(button).to_be_visible()
        expect(button).to_have_text("Notify me on this device")
    finally:
        context.close()
