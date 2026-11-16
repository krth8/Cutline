"""Chart block in a page: a board view, a bar chart of tasks by status, a line chart by due week, a donut by priority.

Tests run in order and build on one another (shared server, one browser context per person). Alice builds the
page with the slash menu; Bob sees it and changes a task's status through the API as himself; both charts move
without a reload. Screenshots of every chart type in the dark and the light theme go to a temp folder.
"""

import re
import time

import pytest

from e2e.e2e_support import PASSWORD, login

pytestmark = pytest.mark.e2e

PROSE = ".cl-editor__prose"
CHART = "[data-testid=chart]"
MARK = "[data-testid=chart-mark]"


def wait_for(fn, timeout=10.0):
    end = time.time() + timeout
    last = None
    while time.time() < end:
        last = fn()
        if last:
            return last
        time.sleep(0.2)
    raise AssertionError(f"condition not met, last value: {last!r}")


def open_page(page, server, page_id, who):
    login(page, server.base_url, who, goto=f"/dev/page/{page_id}")
    page.wait_for_selector(PROSE, timeout=20000)
    page.wait_for_selector('.cl-sync-status[data-status="synced"], .cl-sync-status[data-status="readonly"]', timeout=20000)


BAR, LINE, DONUT = "Tasks by status", "Tasks per due week", "Priority"


def chart(title):
    """Selector of the chart with this title (charts are found by title: where a new block lands is not the point)."""
    return f'{CHART}:has([data-testid=chart-title]:text-is("{title}"))'


def values(page, title=BAR):
    """The marks of the nth chart as {name: number}, read from their accessible names ("Done: 3")."""
    names = page.evaluate(
        """(t) => { const f = [...document.querySelectorAll('[data-testid=chart]')]
              .find(c => (c.querySelector('[data-testid=chart-title]') || {}).innerText === t);
            return f ? [...f.querySelectorAll('[data-testid=chart-mark]')].map(e => e.getAttribute('aria-label')) : []; }""",
        title,
    )
    out = {}
    for name in names:
        label, _, rest = name.rpartition(": ")
        m = re.match(r"-?[\d\s .]+", rest)
        out[label] = float(re.sub(r"[\s ]", "", m.group(0))) if m else None
    return out


def add_chart(page, typed, option_text):
    page.focus(PROSE)  # not a click: the middle of the page may be a chart, which would open its settings
    page.keyboard.press("Control+End")
    page.keyboard.press("Enter")
    page.keyboard.type(typed)
    page.click(f'[role=option]:has-text("{option_text}")')
    page.wait_for_selector("[data-testid=chart-setup]")


def pick_view(page, view_id):
    page.click("[data-testid=chart-pick-view]")
    assert "on this page" in page.inner_text("[data-testid=view-picker-list]")
    page.click(f'[data-testid=view-picker-list] [data-view-id="{view_id}"]')
    page.wait_for_selector("[data-testid=chart-setup]")


def close_setup(page):
    page.click("[data-testid=chart-setup-done]")
    page.wait_for_selector("[data-testid=chart-setup]", state="detached")


@pytest.fixture(scope="module")
def scene(server, new_page, tmp_path_factory):
    ids = {name: server.create_user(name) for name in ("alice", "bob", "carol")}
    project = server.create_project("Charts")
    for name in ("alice", "bob"):
        server.grant_access(project, ids[name])
    server.grant_access(project, ids["carol"], can_review=True, can_tasks=False)
    page_id = server.create_page(project, "Report")
    ref = f"tasks:{project}"
    status = {}
    for name, color in (("Todo", "#e03131"), ("Doing", "#f08c00"), ("Finished", "#2f9e44")):
        status[name] = server.api("/api/statuses", {"name": name, "color": color})["status"]["id"]
    plan = [  # name, status, due date, priority
        ("One", "Todo", "2030-01-14", "high"),
        ("Two", "Doing", "2030-01-16", "high"),
        ("Three", "Finished", "2030-02-04", "low"),
        ("Four", "Finished", None, "medium"),
        ("Five", "Finished", "2030-01-14", "high"),
    ]
    tasks = {}
    for name, st, due, prio in plan:
        tid = server.create_task(project, name)["task"]["id"]
        tasks[name] = tid
        values_ = {"status": status[st], "priority": prio}
        if due:
            values_["dueDate"] = due
        server.api(f"/api/tables/{ref}/rows/{tid}", {"values": values_}, method="PATCH")
    tokens = {n: server.api("/api/auth/login", {"username": n, "password": PASSWORD}, token="")["token"] for n in ids}
    alice, bob = new_page(name="alice"), new_page(name="bob")
    alice.set_viewport_size({"width": 1280, "height": 1000})
    open_page(alice, server, page_id, "alice")
    open_page(bob, server, page_id, "bob")
    return {
        "alice": alice, "bob": bob, "project": project, "page": page_id, "ref": ref, "status": status,
        "tasks": tasks, "tokens": tokens, "shots": tmp_path_factory.mktemp("chart-shots"),
    }


def test_alice_builds_the_page_with_a_board_and_three_charts(scene):
    alice = scene["alice"]
    alice.click(PROSE)
    alice.keyboard.type("/board")
    alice.click('[role=option]:has-text("Tasks as a board of cards")')
    alice.wait_for_selector("[data-testid=view-block][data-state=ready]", timeout=15000)
    view_id = alice.get_attribute("[data-testid=view-block]", "data-view-id")
    scene["view"] = view_id

    # Bar chart by status: the settings open by themselves; the page's own board is listed first
    add_chart(alice, "/bar", "Compare groups of a view as bars")
    pick_view(alice, view_id)
    alice.wait_for_function("document.querySelector('[data-testid=chart-group]').value === 'status'")
    alice.fill("[data-testid=chart-title-input]", "Tasks by status")
    alice.press("[data-testid=chart-title-input]", "Enter")
    close_setup(alice)
    alice.wait_for_selector(f"{CHART} [data-testid=chart-state][data-state=ready]", timeout=15000)
    got = values(alice, BAR)
    assert got["Todo"] == 1 and got["Doing"] == 1 and got["Finished"] == 3
    assert sum(got.values()) == 5  # every other status is 0
    assert alice.locator(chart(BAR)).count() == 1

    # Line chart by due week
    add_chart(alice, "/line", "Follow a measure over dates")
    pick_view(alice, view_id)
    alice.select_option("[data-testid=chart-group]", label="Due date")
    alice.select_option("[data-testid=chart-bucket]", "week")
    alice.fill("[data-testid=chart-title-input]", "Tasks per due week")
    alice.press("[data-testid=chart-title-input]", "Enter")
    close_setup(alice)
    expected_weeks = {"Week of Jan 14, 2030": 3, "Week of Jan 21, 2030": 0, "Week of Jan 28, 2030": 0,
                      "Week of Feb 4, 2030": 1, "No value": 1}
    wait_for(lambda: values(alice, LINE) == expected_weeks)  # the weeks nobody has a task in are filled with 0

    # Donut by priority
    add_chart(alice, "/donut", "Show shares of a whole")
    pick_view(alice, view_id)
    alice.select_option("[data-testid=chart-group]", label="Priority")
    alice.fill("[data-testid=chart-title-input]", "Priority")
    alice.press("[data-testid=chart-title-input]", "Enter")
    close_setup(alice)
    wait_for(lambda: values(alice, DONUT) == {"High": 3, "Medium": 1, "Low": 1})
    assert alice.text_content(f"{chart(DONUT)} >> [data-testid=chart-total]") == "5"


def test_the_other_person_sees_the_same_numbers(scene):
    bob = scene["bob"]
    wait_for(lambda: values(bob, BAR).get("Finished") == 3 and values(bob, DONUT).get("High") == 3)
    assert values(bob, LINE)["Week of Jan 14, 2030"] == 3


def test_a_status_change_by_another_user_moves_the_bars_of_both_without_a_reload(scene, server):
    alice, bob = scene["alice"], scene["bob"]
    token = scene["tokens"]["bob"]
    server.api(f"/api/tables/{scene['ref']}/rows/{scene['tasks']['One']}",
               {"values": {"status": scene["status"]["Finished"]}}, method="PATCH", token=token)
    wait_for(lambda: values(alice, BAR).get("Todo") == 0 and values(alice, BAR).get("Finished") == 4)
    wait_for(lambda: values(bob, BAR).get("Finished") == 4)
    assert values(alice, BAR)["Doing"] == 1
    # A new task shows up too
    server.create_task(scene["project"], "Six")
    wait_for(lambda: sum(values(alice, BAR).values()) == 6)  # in whichever group a new task starts
    wait_for(lambda: sum(values(bob, BAR).values()) == 6)


def test_switching_to_donut_keeps_the_numbers(scene):
    alice = scene["alice"]
    before = values(alice, BAR)
    alice.click(f"{chart(BAR)} >> [data-testid=chart-settings-btn]")
    alice.wait_for_selector("[data-testid=chart-setup]")
    alice.select_option("[data-testid=chart-type]", "donut")
    close_setup(alice)
    wait_for(lambda: alice.locator(f"{chart(BAR)} >> [data-testid=chart-legend]").count() == 1)
    after = values(alice, BAR)
    # A donut draws only the groups that have rows; their numbers are the bars' numbers
    assert {k: v for k, v in before.items() if v} == after
    total = alice.text_content(f"{chart(BAR)} >> [data-testid=chart-total]")
    assert float(total) == sum(before.values())
    # Back to bars for the screenshots
    alice.click(f"{chart(BAR)} >> [data-testid=chart-settings-btn]")
    alice.wait_for_selector("[data-testid=chart-setup]")
    alice.select_option("[data-testid=chart-type]", "bar")
    close_setup(alice)
    wait_for(lambda: values(alice, BAR) == before)


def test_a_chart_follows_the_width_of_the_window(scene):
    alice = scene["alice"]
    widths = {}
    for w in (1000, 320):
        alice.set_viewport_size({"width": w, "height": 900})
        time.sleep(0.5)
        widths[w] = alice.evaluate(
            "() => { const f = document.querySelector('[data-testid=chart]'); const s = f.querySelector('svg');"
            " return [f.getBoundingClientRect().width, s.getBoundingClientRect().width, f.scrollWidth, f.clientWidth]; }")
        frame, svg, scroll, client = widths[w]
        assert svg <= frame and scroll <= client + 1, (w, widths[w])
    assert widths[320][1] < widths[1000][1]
    alice.set_viewport_size({"width": 1280, "height": 1000})


def test_screenshots_of_every_chart_in_both_themes(scene):
    alice = scene["alice"]
    alice.set_viewport_size({"width": 1100, "height": 1000})
    for theme in ("dark", "light"):
        alice.evaluate(f"document.documentElement.setAttribute('data-theme', '{theme}')")
        time.sleep(0.4)
        for kind, title in (("bar", BAR), ("line", LINE), ("donut", DONUT)):
            alice.locator(chart(title)).scroll_into_view_if_needed()
            alice.locator(chart(title)).screenshot(path=str(scene["shots"] / f"{kind}-{theme}.png"))
    # And a narrow one
    alice.set_viewport_size({"width": 340, "height": 900})
    time.sleep(0.5)
    for kind, title in (("bar", BAR), ("line", LINE), ("donut", DONUT)):
        alice.locator(chart(title)).screenshot(path=str(scene["shots"] / f"{kind}-narrow.png"))
    alice.set_viewport_size({"width": 1280, "height": 1000})
    print("CHART SHOTS:", scene["shots"])
    assert len(list(scene["shots"].glob("*.png"))) == 9


def test_a_user_without_task_access_sees_a_quiet_message(scene, server, new_page):
    carol = new_page(name="carol")
    open_page(carol, server, scene["page"], "carol")
    carol.wait_for_selector(f"{CHART} [data-testid=chart-state][data-state=denied]", timeout=15000)
    wait_for(lambda: carol.locator("[data-testid=chart-state][data-state=denied]").count() == 3)
    assert "You don't have access to this view" in carol.inner_text(CHART + " >> nth=0")
    assert carol.locator("[role=alert]").count() == 0
    assert carol.locator(".toast, .toast-container .toast").count() == 0
    assert carol.locator("[data-testid=chart-settings-btn]").count() == 0
    carol.click(CHART)
    assert carol.locator("[data-testid=chart-setup]").count() == 0
