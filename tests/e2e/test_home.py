"""Home: a new user lands on "My dashboard", sees their open tasks and the numbers, checks one off, is assigned
another one by a colleague without reloading, and chooses another personal page as Home. Deep links and
?project= links still open what they opened before.

Needs the bundle: `cd web && npm run build`. Tests run in order and share the server and the browsers.
"""

import time
from datetime import date, timedelta
from pathlib import Path

import pytest
from playwright.sync_api import expect

from e2e.e2e_support import PASSWORD, REPO, login, wait_js

pytestmark = pytest.mark.e2e

if not Path(REPO, "static", "dist", "pages.js").exists():
    pytest.skip("web bundle not built (cd web && npm run build)", allow_module_level=True)

BLOCK = "[data-testid=view-block]"
NUMBER = "[data-testid=summary-inline] [data-testid=summary-value]"


def wait_for(fn, timeout=12.0):
    end = time.time() + timeout
    last = None
    while time.time() < end:
        last = fn()
        if last:
            return last
        time.sleep(0.2)
    raise AssertionError(f"condition not met, last value: {last!r}")


def numbers(page):
    return page.evaluate(f"() => [...document.querySelectorAll('{NUMBER}')].map(e => e.innerText.trim())")


def open_titles(page):
    """Titles in the first list block ("My open tasks")."""
    return page.evaluate("""() => {
        const block = document.querySelector('[data-testid=view-block]');
        return block ? [...block.querySelectorAll('[data-testid=list-title]')].map(e => e.innerText.trim()) : [];
    }""")


def set_assignees(server, token, ref, task_id, user_ids):
    server.api(f"/api/tables/{ref}/rows/{task_id}", {"values": {"assignees": user_ids}}, token=token, method="PATCH")


@pytest.fixture(scope="module")
def scene(server):
    ids = {name: server.create_user(name) for name in ("ana", "ben")}
    project = server.create_project("Spot")
    for uid in ids.values():
        server.grant_access(project, uid)
    ref = f"tasks:{project}"
    todo = server.api("/api/statuses", {"name": "To do", "color": "#336699"})["status"]["id"]
    server.api("/api/statuses", {"name": "Done", "color": "#22c55e"})
    tokens = {n: server.api("/api/auth/login", {"username": n, "password": PASSWORD}, token="")["token"] for n in ids}
    tasks = {}
    for name, who, due in (("Write script", "ana", None), ("Edit cut", "ana", date.today() + timedelta(days=2)),
                           ("Ben only", "ben", None), ("Later on", "ben", None)):
        task = server.create_task(project, name)["task"]
        values = {"status": todo, "assignees": [ids[who]]}
        if due:
            values["dueDate"] = due.isoformat()
        server.api(f"/api/tables/{ref}/rows/{task['id']}", {"values": values}, method="PATCH")
        tasks[name] = task["id"]
    return {"ids": ids, "project": project, "ref": ref, "tokens": tokens, "tasks": tasks}


def test_a_new_user_lands_on_the_dashboard_with_their_tasks_and_numbers(scene, server, new_page):
    ana = new_page(name="ana")
    login(ana, server.base_url, "ana")  # the bare "/" with nothing saved
    ana.wait_for_url("**/home", timeout=15000)
    expect(ana.locator("[data-testid=page-view]")).to_be_visible(timeout=15000)
    expect(ana.locator(".cl-page__title")).to_have_value("My dashboard")
    expect(ana.locator("[data-testid=cl-sidebar]")).to_be_visible()
    ana.wait_for_selector(f"{BLOCK}[data-state=ready]", timeout=20000)
    scene["ana"] = ana

    wait_for(lambda: sorted(open_titles(ana)) == ["Edit cut", "Write script"])
    # open, due in the next 7 days, overdue
    wait_for(lambda: numbers(ana) == ["2", "1", "0"])
    # the recent pages block lists the dashboard itself
    expect(ana.locator("[data-testid=page-list]")).to_contain_text("My dashboard")
    # the page was made once, as a personal page, and is Home
    home = server.api("/api/home", token=scene["tokens"]["ana"])["pageId"]
    assert home and server.api(f"/api/pages/{home}", token=scene["tokens"]["ana"])["space"] == "me"
    scene["home"] = home


def test_checking_a_task_off_changes_the_list_and_the_numbers(scene):
    ana = scene["ana"]
    row = ana.locator(f"{BLOCK} >> nth=0").locator(f"[data-row-id='{scene['tasks']['Write script']}']")
    # a click by script: scrolling the row into view can leave it under the block's sticky toolbar
    row.locator("[data-testid=list-check]").evaluate("e => e.click()")
    wait_for(lambda: open_titles(ana) == ["Edit cut"])
    wait_for(lambda: numbers(ana) == ["1", "1", "0"])


def test_a_task_assigned_by_someone_else_appears_without_a_reload(scene, server):
    ana = scene["ana"]
    set_assignees(server, scene["tokens"]["ben"], scene["ref"], scene["tasks"]["Ben only"], [scene["ids"]["ana"]])
    wait_for(lambda: sorted(open_titles(ana)) == ["Ben only", "Edit cut"])
    wait_for(lambda: numbers(ana) == ["2", "1", "0"])
    # and takes it away again
    set_assignees(server, scene["tokens"]["ben"], scene["ref"], scene["tasks"]["Ben only"], [scene["ids"]["ben"]])
    wait_for(lambda: open_titles(ana) == ["Edit cut"])


def test_set_as_home_on_another_personal_page_changes_what_home_shows(scene, server):
    ana, token = scene["ana"], scene["tokens"]["ana"]
    other = server.api("/api/spaces/me/pages", {"title": "Scratch pad"}, token=token)["id"]
    # the tree marks the current home page
    ana.goto(f"{server.base_url}/me/page/{other}")
    expect(ana.locator("[data-testid=page-view]")).to_be_visible(timeout=15000)
    tree = ana.locator(".cl-sidebar")
    expect(tree.get_by_role("treeitem", name="My dashboard").get_by_role("img", name="Home page")).to_be_visible()

    ana.get_by_role("button", name="Page menu").click()
    ana.get_by_role("menuitem", name="Set as home").click()
    wait_for(lambda: server.api("/api/home", token=token)["pageId"] == other)
    expect(tree.get_by_role("treeitem", name="Scratch pad").get_by_role("img", name="Home page")).to_be_visible()
    assert tree.get_by_role("treeitem", name="My dashboard").get_by_role("img", name="Home page").count() == 0

    tree.get_by_role("link", name="Home", exact=True).click()
    ana.wait_for_url("**/home")
    expect(ana.locator(".cl-page__title")).to_have_value("Scratch pad")

    # a reload of "/" keeps Home (the Pages tab was last on Home)
    ana.goto(server.base_url + "/")
    ana.wait_for_url("**/home", timeout=15000)
    expect(ana.locator(".cl-page__title")).to_have_value("Scratch pad")


def test_archiving_the_home_page_brings_back_a_fresh_dashboard(scene, server):
    ana, token = scene["ana"], scene["tokens"]["ana"]
    other = server.api("/api/home", token=token)["pageId"]
    # ana still has Home open: the archive event makes it ask for a Home page again
    server.api(f"/api/pages/{other}", {"archived": True}, token=token, method="PATCH")
    expect(ana.locator(".cl-page__title")).to_have_value("My dashboard", timeout=15000)
    fresh = server.api("/api/home", token=token)["pageId"]
    assert fresh and fresh not in (other, scene["home"])


def test_deep_links_and_project_links_still_open_what_they_opened(scene, server, new_page):
    project = scene["project"]
    ben = new_page(name="ben")
    login(ben, server.base_url, "ben", goto=f"/?project={project}")
    wait_js(ben, f"AppState.projectId === '{project}'", 15000)
    assert ben.evaluate("location.pathname") == f"/p/{project}/review"
    assert ben.evaluate("AppState.activeTab") == "review"

    ben.goto(f"{server.base_url}/p/{project}/pages")
    expect(ben.locator("[data-testid=space-overview]")).to_be_visible(timeout=15000)
    assert ben.evaluate("AppState.activeTab") == "pages"

    ben.goto(f"{server.base_url}/me")
    expect(ben.locator("[data-testid=space-overview]")).to_be_visible(timeout=15000)

    # a saved tab still wins on the bare "/": Projects stays Projects
    ben.evaluate("localStorage.setItem('activeTab', 'projects')")
    ben.goto(server.base_url + "/")
    wait_js(ben, "AppState.activeTab === 'projects'", 15000)
    assert ben.evaluate("location.pathname") == "/"

    # the Home button of the top bar opens the dashboard
    ben.click("#mainTabHome")
    ben.wait_for_url("**/home", timeout=15000)
    expect(ben.locator(".cl-page__title")).to_have_value("My dashboard", timeout=15000)
