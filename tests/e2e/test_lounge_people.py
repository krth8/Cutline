"""The people panel of a project's Lounge: everyone in the project, online first, and what they are doing,
updated live as people move between tabs.

Needs the bundle: `cd web && npm run build`. Tests run in order and share the server and the browsers.
"""

from pathlib import Path

import pytest
from playwright.sync_api import expect

from e2e.e2e_support import ADMIN, REPO, login, wait_js

pytestmark = pytest.mark.e2e

if not Path(REPO, "static", "dist", "pages.js").exists():
    pytest.skip("web bundle not built (cd web && npm run build)", allow_module_level=True)

PANEL = ".lounge-sidebar-right"


def person(page, name):
    return page.locator(f"{PANEL} .lounge-person").filter(has_text=name)


@pytest.fixture(scope="module")
def scene(server, new_page):
    rita = server.create_user("rita")
    server.create_user("vera")  # never logs in
    spot = server.create_project("Spot")
    server.grant_access(spot, rita)
    vera = next(u["id"] for u in server.api("/api/admin/users")["users"] if u["username"] == "vera") \
        if False else None
    server.upload_png_clip(spot, "shot_010_v1.png")
    admin = new_page(name="admin")
    login(admin, server.base_url, ADMIN["username"], ADMIN["password"], goto=f"/p/{spot}/lounge")
    expect(admin.locator(PANEL)).to_be_visible(timeout=20000)
    return {"admin": admin, "spot": spot, "new_page": new_page, "server": server}


def test_the_panel_lists_the_project_and_says_where_people_are(scene):
    admin, spot, server = scene["admin"], scene["spot"], scene["server"]
    expect(person(admin, "admin (you)")).to_contain_text("Lounge")
    expect(person(admin, "rita")).to_have_class("lounge-person is-away")
    assert person(admin, "vera").count() == 0  # not in the project

    rita = scene["new_page"](name="rita")
    login(rita, server.base_url, "rita", goto=f"/p/{spot}/review")
    wait_js(rita, f"AppState.projectId === '{spot}' && !!AppState.currentClip", 20000)
    # rita is online and in Review, without anyone reloading
    expect(person(admin, "rita")).to_have_class("lounge-person is-online", timeout=15000)
    expect(person(admin, "rita")).to_contain_text("Review")
    # online people come first
    assert admin.locator(f"{PANEL} .lounge-people-head").first.inner_text().upper() == "ONLINE"

    # she moves to the project's dashboard
    rita.click("[data-testid=tab-main]")
    rita.wait_for_url(f"**/p/{spot}/pages")
    expect(person(admin, "rita")).to_contain_text("Dashboard", timeout=15000)

    # and leaves
    rita.close()
    expect(person(admin, "rita")).to_have_class("lounge-person is-away", timeout=15000)
    expect(person(admin, "rita")).to_contain_text("seen")
