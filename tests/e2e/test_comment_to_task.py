"""Create a task from a review comment: the chip, the task in the project's tasks for everyone, and who may do it.

Tests run in order and build on one another (shared server, one browser context per person).
"""

import time

import pytest

from e2e.e2e_support import login, wait_js

pytestmark = pytest.mark.e2e

COMMENT = ".comment-item[data-comment-id]"


def wait_for(fn, timeout=15.0):
    end = time.time() + timeout
    last = None
    while time.time() < end:
        last = fn()
        if last:
            return last
        time.sleep(0.2)
    raise AssertionError(f"condition not met, last value: {last!r}")


def open_review(page, server, who, project):
    login(page, server.base_url, who, goto=f"/p/{project}/review")
    wait_js(page, "window.Live && Live.isConnected() && AppState.projectId && Object.keys(AppState.clips).length === 1"
                  " && !!AppState.currentClip", 20000)
    page.wait_for_timeout(2500)  # the watch list reaches the server within 2 s


@pytest.fixture(scope="module")
def scene(server, new_page):
    ids = {name: server.create_user(name) for name in ("alice", "bob", "rita")}
    project = server.create_project("Spot")
    server.grant_access(project, ids["alice"])
    server.grant_access(project, ids["bob"])
    server.grant_access(project, ids["rita"], can_review=True, can_tasks=False)
    server.upload_png_clip(project, "shot_010_v1.png")
    wait_for(lambda: "shot_010" in server.api(f"/api/projects/{project}")["clips"])
    comment = server.api(f"/api/projects/{project}/comment", {
        "frame": 48, "text": "Make the logo bigger\nand move it left", "clipBaseName": "shot_010", "clipVersion": 1})
    alice, bob, rita = new_page(name="alice"), new_page(name="bob"), new_page(name="rita")
    for page, who in ((alice, "alice"), (bob, "bob"), (rita, "rita")):
        open_review(page, server, who, project)
    return {"alice": alice, "bob": bob, "rita": rita, "project": project, "comment": comment["id"]}


def test_only_people_who_can_edit_tasks_get_the_button(scene):
    for who in ("alice", "bob"):
        page = scene[who]
        page.wait_for_selector(COMMENT, timeout=10000)
        assert page.locator(f"{COMMENT} .comment-task-btn").count() == 1
    rita = scene["rita"]
    rita.wait_for_selector(COMMENT, timeout=10000)
    assert rita.locator(".comment-task-btn, .comment-task-chip").count() == 0


def test_creating_a_task_shows_the_chip_and_the_task_reaches_the_other_person(scene, server):
    alice, bob = scene["alice"], scene["bob"]
    bob.evaluate(f"TaskManager.init('{scene['project']}')")
    bob.wait_for_timeout(2500)
    alice.hover(COMMENT)
    alice.click(f"{COMMENT} .comment-task-btn")
    alice.wait_for_selector(f"{COMMENT} .comment-task-chip", timeout=10000)
    assert alice.locator(f"{COMMENT} .comment-task-btn").count() == 0

    # The other person gets the task in the project's task list and the chip on the comment, without a reload
    wait_js(bob, "TaskManager.getTasks().some(t => t.name === 'Make the logo bigger')", 15000)
    bob.wait_for_selector(f"{COMMENT} .comment-task-chip", timeout=10000)

    tasks = server.api(f"/api/projects/{scene['project']}/tasks")["tasks"]
    made = [t for t in tasks if t.get("commentId") == scene["comment"]]
    assert len(made) == 1
    task = made[0]
    assert task["name"] == "Make the logo bigger"
    assert task["description"] == "Make the logo bigger\nand move it left"
    assert task["clipFrame"] == 48 and task["clipName"] == "shot_010"
    # The reviewer without task rights sees the comment but not the chip
    assert scene["rita"].locator(".comment-task-chip").count() == 0


def test_asking_again_does_not_make_a_second_task(scene, server):
    result = server.api(f"/api/projects/{scene['project']}/comments/{scene['comment']}/task", {})
    assert result["created"] is False
    tasks = server.api(f"/api/projects/{scene['project']}/tasks")["tasks"]
    assert len([t for t in tasks if t.get("commentId") == scene["comment"]]) == 1


def test_the_chip_opens_the_task_and_its_clip_link_opens_the_review(scene):
    alice = scene["alice"]
    # This test is about the old task detail, which only exists behind the "old task list" switch (T13)
    alice.evaluate("localStorage.setItem('legacyTasks', '1')")
    alice.click(f"{COMMENT} .comment-task-chip")
    alice.wait_for_selector("#taskDetailPanel:not(.hidden)", timeout=10000)
    wait_js(alice, "document.getElementById('taskDetailName').value === 'Make the logo bigger'")
    alice.wait_for_selector(".task-modal-clip-thumb", timeout=10000)
    alice.click(".task-modal-clip-thumb")
    wait_js(alice, "AppState.activeTab === 'review' && AppState.currentClip.baseName === 'shot_010'"
                   " && document.getElementById('taskDetailPanel').classList.contains('hidden')", 10000)


def test_with_the_new_task_list_the_chip_opens_the_task_panel(scene):
    bob = scene["bob"]
    bob.evaluate("localStorage.removeItem('legacyTasks')")
    bob.click(f"{COMMENT} .comment-task-chip")
    bob.wait_for_selector("[data-testid=task-panel]", timeout=15000)
    wait_js(bob, "location.pathname.endsWith('/tasks') && location.search.includes('task=')", 10000)


def test_deleting_the_task_takes_the_chip_away_for_everyone(scene, server):
    tasks = server.api(f"/api/projects/{scene['project']}/tasks")["tasks"]
    task = [t for t in tasks if t.get("commentId") == scene["comment"]][0]
    server.api(f"/api/tasks/{task['id']}", method="DELETE")
    for who in ("alice", "bob"):
        scene[who].wait_for_selector(f"{COMMENT} .comment-task-chip", state="detached", timeout=10000)
        assert scene[who].locator(f"{COMMENT} .comment-task-btn").count() == 1

