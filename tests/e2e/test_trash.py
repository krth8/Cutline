"""Trash and undo for tasks, in the table layout at /dev/view/<viewId>: Undo in the toast brings a deleted
task back for everyone, the Trash dialog restores or deletes for good."""

import pytest

from e2e.e2e_support import ADMIN
from e2e.test_table_layout import ROW, make_scene, open_view, row_names, wait_for

pytestmark = pytest.mark.e2e


@pytest.fixture(scope="module")
def editor_id(server):
    return server.create_user("trasher")


def trash_names(server, scene):
    return sorted(i["name"] for i in server.api(f"/api/tables/{scene['ref']}/trash")["items"])


def select_and_delete(page, *names):
    for name in names:
        page.click(f"{ROW}:has-text('{name}') [data-testid=table-select-row]")
    page.click("[data-testid=table-bulk-delete]")
    page.click(".confirm-overlay .confirm-submit")


def open_trash(page):
    page.click("[data-testid=toolbar-more]")
    page.click("role=menuitem[name='Trash']")
    page.wait_for_selector("role=dialog[name='Trash']")


def test_undo_in_the_toast_brings_a_deleted_task_back_for_everyone(server, editor_id, new_page):
    scene = make_scene(server, editor_id, ["Keep", "Oops"])
    a = new_page(name="admin")
    b = new_page(name="editor")
    open_view(a, server, scene, ADMIN["username"])
    open_view(b, server, scene, "trasher")
    wait_for(lambda: len(row_names(a)) == 2 and len(row_names(b)) == 2)

    select_and_delete(a, "Oops")
    wait_for(lambda: row_names(a) == ["Keep"])
    wait_for(lambda: row_names(b) == ["Keep"])
    toast = a.wait_for_selector(".toast:has-text('Deleted 1 task')")
    assert toast.query_selector(".toast-action").inner_text().strip() == "Undo"
    assert trash_names(server, scene) == ["Oops"]

    a.click(".toast:has-text('Deleted 1 task') .toast-action")
    wait_for(lambda: sorted(row_names(a)) == ["Keep", "Oops"])
    wait_for(lambda: sorted(row_names(b)) == ["Keep", "Oops"])
    assert trash_names(server, scene) == []


def test_bulk_delete_then_restore_from_the_trash_dialog(server, editor_id, new_page):
    scene = make_scene(server, editor_id, ["Stay", "Gone one", "Gone two"])
    a = new_page(name="admin")
    b = new_page(name="editor")
    open_view(a, server, scene, ADMIN["username"])
    open_view(b, server, scene, "trasher")
    wait_for(lambda: len(row_names(a)) == 3 and len(row_names(b)) == 3)

    select_and_delete(a, "Gone one", "Gone two")
    a.wait_for_selector(".toast:has-text('Deleted 2 tasks')")
    wait_for(lambda: row_names(b) == ["Stay"])

    open_trash(a)
    a.wait_for_selector("[aria-label='Deleted tasks'] li")
    a.check("[aria-label='Select Gone one']")
    a.check("[aria-label='Select Gone two']")
    a.click("role=button[name='Restore selected (2)']")
    a.wait_for_selector("text=The trash is empty.")
    a.click("role=dialog[name='Trash'] >> role=button[name='Close']")
    wait_for(lambda: sorted(row_names(a)) == ["Gone one", "Gone two", "Stay"])
    wait_for(lambda: sorted(row_names(b)) == ["Gone one", "Gone two", "Stay"])
    assert trash_names(server, scene) == []


def test_delete_forever_removes_the_task_from_the_trash(server, editor_id, new_page):
    scene = make_scene(server, editor_id, ["Stay", "Doomed"])
    a = new_page(name="admin")
    open_view(a, server, scene, ADMIN["username"])
    wait_for(lambda: len(row_names(a)) == 2)
    select_and_delete(a, "Doomed")
    wait_for(lambda: row_names(a) == ["Stay"])

    open_trash(a)
    a.click("role=button[name='Delete Doomed forever']")
    a.click(".confirm-overlay .confirm-submit")
    a.wait_for_selector("text=The trash is empty.")
    assert trash_names(server, scene) == []
    # the task is gone for good: restoring it is a 404
    task_id = scene["tasks"]["Doomed"]
    with pytest.raises(Exception):
        server.api(f"/api/tables/{scene['ref']}/rows/{task_id}/restore", {})
