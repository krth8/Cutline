"""A tab with the all-tasks watch hears task changes in every project the user can see tasks of.

Uses the real legacy Live module in the real app (the same call the platform bridge makes),
without opening any project.
"""

import pytest

from e2e.e2e_support import ADMIN, login, wait_js

pytestmark = pytest.mark.e2e


def events(page):
    return page.evaluate("window.__rows.map(e => e.project)")


def test_all_tasks_watch_follows_access_changes(server, new_page):
    editor_id = server.create_user("tasker")
    a, b, c = server.create_project("Alpha"), server.create_project("Beta"), server.create_project("Gamma")
    server.grant_access(a, editor_id)
    server.grant_access(b, editor_id)

    page = new_page(name="editor")
    login(page, server.base_url, "tasker")
    wait_js(page, "window.Live && Live.isConnected()", 10000)
    page.evaluate("""() => { window.__rows = [];
        Live.on('rows_changed', m => window.__rows.push(m));
        Live.watchAllTasks('e2e', true); }""")
    page.wait_for_timeout(2500)  # the watch list is sent to the server within 2 s

    server.create_task(a, "in alpha")
    server.create_task(b, "in beta")
    server.create_task(c, "in gamma")  # no access: never arrives
    wait_js(page, "window.__rows.length >= 2", 8000)
    page.wait_for_timeout(500)
    assert sorted(events(page)) == sorted([a, b])

    # Access is lost and gained without reconnecting
    server.revoke_access(a, editor_id)
    server.grant_access(c, editor_id)
    page.evaluate("window.__rows.length = 0")
    server.create_task(a, "alpha again")
    server.create_task(c, "gamma now")
    wait_js(page, "window.__rows.length >= 1", 8000)
    page.wait_for_timeout(500)
    assert events(page) == [c]
