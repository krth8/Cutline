"""Task notifications in the browser: the Follow bell in the task panel, @ suggestions in the comment box that
reach the tagged person, and the switches on the Notifications page of Settings."""

import pytest
from playwright.sync_api import expect

from e2e.e2e_support import ADMIN, login

pytestmark = pytest.mark.e2e


@pytest.fixture(scope="module")
def scene(server):
    project = server.create_project("Bells")
    bob = server.create_user("bobnotify")
    server.grant_access(project, bob)
    task = server.api(f"/api/projects/{project}/tasks", {"name": "Grade pass", "assigneeIds": [bob]})["task"]
    return {"project": project, "task": task["id"], "bob": bob}


def notifications(page):
    return page.evaluate("fetch('/api/notifications').then(r => r.json()).then(b => b.notifications)")


def test_the_assignee_follows_and_can_stop(server, scene, new_page):
    page = new_page(name="bob-follow")
    login(page, server.base_url, "bobnotify", goto=f"/p/{scene['project']}/pages?task={scene['task']}")
    follow = page.locator("[data-testid=task-follow]")
    expect(follow).to_have_attribute("data-following", "true", timeout=20000)
    follow.locator("button").click()
    expect(follow).to_have_attribute("data-following", "false")
    assert page.evaluate(f"fetch('/api/tasks/{scene['task']}/follow').then(r => r.json())") == {"following": False}
    follow.locator("button").click()
    expect(follow).to_have_attribute("data-following", "true")
    # bob was told about the assignment
    assert any(n["type"] == "task_assigned" for n in notifications(page))


def test_a_mention_picked_from_the_suggestions_reaches_the_person(server, scene, new_page):
    admin = new_page(name="admin-mention")
    login(admin, server.base_url, ADMIN["username"], ADMIN["password"], goto=f"/p/{scene['project']}/pages?task={scene['task']}")
    box = admin.locator("[data-testid=task-composer] textarea")
    expect(box).to_be_visible(timeout=20000)
    box.click()
    box.type("Ready for review @bobn")
    options = admin.locator("[data-testid=comment-mentions] [role=option]")
    expect(options).to_have_count(1, timeout=10000)
    admin.keyboard.press("Enter")  # picks the suggestion
    expect(box).to_have_value("Ready for review @bobnotify ")
    admin.keyboard.press("Enter")  # sends
    expect(admin.locator("[data-testid=task-comments] .cl-comment__mention")).to_have_text("@bobnotify", timeout=10000)

    bob = new_page(name="bob-mentioned")
    login(bob, server.base_url, "bobnotify")
    assert any(n["type"] == "mention" and "Grade pass" in n["title"] for n in notifications(bob))


def test_the_settings_switch_turns_a_kind_off(server, scene, new_page):
    page = new_page(name="bob-settings")
    login(page, server.base_url, "bobnotify")
    page.evaluate("showSettingsPanel()")
    page.click("[data-settings-tab=notifications]")
    switch = page.locator("#settingsNotifyList input[data-kind=task_status]")
    expect(switch).to_be_checked(timeout=10000)
    switch.click()
    page.wait_for_function("fetch('/api/notifications/prefs').then(r => r.json()).then(b => !b.kinds.find(k => k.kind === 'task_status').enabled)")
    assert page.locator("#settingsNotifyList input[data-kind=session_joined]").is_checked() is False
