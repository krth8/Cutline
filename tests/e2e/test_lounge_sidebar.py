"""The Lounge's rooms live in the app's sidebar: channels above the projects, each with its own address; the Lounge
view has no room list of its own. A channel added from the sidebar opens at once."""

import pytest
from playwright.sync_api import expect

from e2e.e2e_support import ADMIN, login, wait_js

pytestmark = pytest.mark.e2e


@pytest.fixture(scope="module")
def scene(server):
    project = server.create_project("Roomy")
    channel = server.api("/api/chat/channels", {"name": "Generelt"})
    return {"project": project, "channel": channel["id"]}


def test_channels_and_projects_are_in_the_sidebar_and_open_their_room(server, scene, new_page):
    page = new_page(name="admin-lounge-sidebar")
    login(page, server.base_url, ADMIN["username"], ADMIN["password"], goto=f"/p/{scene['project']}/lounge")
    wait_js(page, "AppState.activeTab === 'lounge'")
    channels = page.locator("[data-testid=nav-channels]")
    expect(channels.locator("[data-testid=nav-channel]", has_text="Generelt")).to_be_visible(timeout=15000)
    expect(page.locator(".lounge-sidebar")).to_be_hidden()
    expect(page.locator(".lounge-main")).to_contain_text("Roomy", timeout=15000)

    channels.locator("[data-testid=nav-channel]", has_text="Generelt").click()
    page.wait_for_url(f"**/lounge/c/{scene['channel']}")
    expect(page.locator(".lounge-main")).to_contain_text("Generelt", timeout=15000)
    expect(channels.locator("[data-testid=nav-channel][aria-current=page]")).to_have_text("#Generelt")

    page.click(f"[data-testid=nav-project]:has-text('Roomy')")
    page.wait_for_url(f"**/p/{scene['project']}/lounge")
    expect(page.locator(".lounge-main")).to_contain_text("Roomy", timeout=15000)


def test_a_channel_added_in_the_sidebar_opens(server, scene, new_page):
    page = new_page(name="admin-lounge-add")
    login(page, server.base_url, ADMIN["username"], ADMIN["password"], goto=f"/p/{scene['project']}/lounge")
    page.click("[data-testid=channel-add]")
    page.fill("[data-testid=channel-name]", "Salg")
    page.keyboard.press("Enter")
    page.wait_for_url("**/lounge/c/*")
    expect(page.locator(".lounge-main")).to_contain_text("Salg", timeout=15000)
    assert any(c["name"] == "Salg" for c in server.api("/api/chat/channels")["channels"])
