"""Custom tables (C1/C2): one person creates a table in a page with the slash menu, adds a column from the header,
adds rows and edits cells; a second person sees it all live; the view switches to a board grouped by a select
column; a row opens in the row panel; a user outside the project gets no access.

Tests run in order and build on one another (shared server, one browser context per person).
"""

import time

import pytest

from e2e.e2e_support import ADMIN, ApiError, login

pytestmark = pytest.mark.e2e

PROSE = ".cl-editor__prose"
BLOCK = "[data-testid=view-block]"
ROW = f"{BLOCK} [data-testid=table-row]"


def wait_for(fn, timeout=12.0):
    end = time.time() + timeout
    last = None
    while time.time() < end:
        last = fn()
        if last:
            return last
        time.sleep(0.2)
    raise AssertionError(f"condition not met, last value: {last!r}")


def open_page(page, server, page_id, who, password=None):
    if who == ADMIN["username"]:
        login(page, server.base_url, who, ADMIN["password"], goto=f"/dev/page/{page_id}")
    else:
        login(page, server.base_url, who, goto=f"/dev/page/{page_id}")
    page.wait_for_selector(PROSE, timeout=20000)
    page.wait_for_selector('.cl-sync-status[data-status="synced"], .cl-sync-status[data-status="readonly"]', timeout=20000)


def names(page):
    return page.evaluate(f"""() => [...document.querySelectorAll('{ROW}')]
        .map(r => r.querySelector('[data-col=name] .cl-table__title').innerText.trim())""")


def stored_rows(server, ref):
    return server.api(f"/api/tables/{ref}/query", {})["rows"]


def edit_cell(page, row_text, col, value):
    page.click(f"{ROW}:has-text('{row_text}') [data-col={col}] .cl-cellhost")
    page.fill(f"{ROW} [data-col={col}] input", value)
    page.keyboard.press("Enter")


@pytest.fixture(scope="module")
def scene(server, new_page):
    ids = {name: server.create_user(name) for name in ("bob", "dave")}
    project = server.create_project("Tables")
    server.grant_access(project, ids["bob"])  # a member: edits rows, not columns; dave has no access at all
    page_id = server.create_page(project, "Plan")
    admin, bob = new_page(name="admin"), new_page(name="bob")
    open_page(admin, server, page_id, ADMIN["username"])
    open_page(bob, server, page_id, "bob")
    return {"admin": admin, "bob": bob, "project": project, "page": page_id, "state": {}}


def test_a_table_is_created_in_the_page_with_the_slash_menu(scene, server):
    admin, bob = scene["admin"], scene["bob"]
    admin.click(PROSE)
    admin.keyboard.type("/new")
    admin.click('[role=option]:has-text("A table with rows of your own")')
    admin.wait_for_selector(f"{BLOCK}[data-state=ready] [data-testid=table-layout]", timeout=20000)
    view_id = admin.get_attribute(BLOCK, "data-view-id")
    view = server.api(f"/api/views/{view_id}")
    ref = view["tableRef"]
    assert ref.startswith("tbl_") and view["layout"] == "table" and view["ownerPageId"] == scene["page"]
    schema = server.api(f"/api/tables/{ref}/schema")
    assert [c["name"] for c in schema["columns"]] == ["Name", "Notes", "Created", "Created by"]
    assert schema["space"] == {"type": "project", "projectId": scene["project"]}
    scene["state"].update(view=view_id, ref=ref)
    # the title and the Notes column show; the read-only author columns start hidden
    headers = admin.evaluate("() => [...document.querySelectorAll('[data-testid=table-header] [data-col]')].map(h => h.dataset.col)")
    assert headers[0] == "name" and len(headers) == 2
    # the other person gets the block too
    bob.wait_for_selector(f"{BLOCK}[data-state=ready] [data-testid=table-layout]", timeout=20000)
    assert bob.get_attribute(BLOCK, "data-view-id") == view_id


def test_a_column_is_added_from_the_header_by_someone_who_may_change_the_schema(scene, server):
    admin, bob = scene["admin"], scene["bob"]
    ref = scene["state"]["ref"]
    admin.click("[data-testid=table-add-column]")
    admin.fill("[data-testid=column-form-name]", "Stage")
    admin.select_option("[data-testid=column-form-type]", "select")
    admin.fill("[data-testid=column-form-options]", "Todo\nDoing\nDone")
    admin.click("[data-testid=column-form-submit]")
    admin.wait_for_selector("[data-testid=table-header] [data-col^=cf_] >> text=Stage", timeout=10000)
    columns = {c["name"]: c for c in server.api(f"/api/tables/{ref}/schema")["columns"]}
    assert [o["label"] for o in columns["Stage"]["options"]] == ["Todo", "Doing", "Done"]
    scene["state"]["stage"] = columns["Stage"]["key"]
    scene["state"]["notes"] = columns["Notes"]["key"]
    # the member sees the new column live but has no way to add one
    bob.wait_for_selector("[data-testid=table-header] [data-col^=cf_] >> text=Stage", timeout=10000)
    assert bob.locator("[data-testid=table-add-column]").count() == 0


def test_rows_are_added_and_edited_and_the_other_person_sees_them_live(scene, server):
    admin, bob = scene["admin"], scene["bob"]
    ref = scene["state"]["ref"]
    admin.click(f"{BLOCK} [data-testid=new-row]")
    wait_for(lambda: len(names(admin)) == 1 and len(names(bob)) == 1)
    edit_cell(admin, "Untitled", "name", "Shot A")
    wait_for(lambda: names(bob) == ["Shot A"])
    admin.click(f"{BLOCK} [data-testid=new-row]")
    wait_for(lambda: len(names(admin)) == 2 and len(names(bob)) == 2)
    edit_cell(admin, "Untitled", "name", "Shot B")
    wait_for(lambda: sorted(names(bob)) == ["Shot A", "Shot B"])
    # the member edits a cell; the admin sees it
    notes = scene["state"]["notes"]
    edit_cell(bob, "Shot B", notes, "needs a retake")
    wait_for(lambda: any(r["values"].get(notes) == "needs a retake" for r in stored_rows(server, ref)))
    wait_for(lambda: admin.locator(f"{ROW}:has-text('Shot B') [data-col={notes}]").inner_text().strip() == "needs a retake")
    # values are stored under the column key, the title under "name"
    row = next(r for r in stored_rows(server, ref) if r["values"]["name"] == "Shot B")
    assert row["tableRef"] == ref and row["canEdit"] is True
    # and a change through the API reaches both open pages
    stage = scene["state"]["stage"]
    options = {o["label"]: o["value"] for o in next(c for c in server.api(f"/api/tables/{ref}/schema")["columns"]
                                                    if c["key"] == stage)["options"]}
    a = next(r for r in stored_rows(server, ref) if r["values"]["name"] == "Shot A")
    server.api(f"/api/tables/{ref}/rows/{a['id']}", {"values": {stage: options["Doing"]}}, method="PATCH")
    server.api(f"/api/tables/{ref}/rows/{row['id']}", {"values": {stage: options["Todo"]}}, method="PATCH")
    scene["state"]["options"] = options


def test_the_view_switches_to_a_board_grouped_by_the_select_column(scene, server):
    admin, bob = scene["admin"], scene["bob"]
    admin.click(f"{BLOCK} [data-testid=layout-board]")
    admin.wait_for_selector(f"{BLOCK} [data-testid=board-layout]", timeout=10000)
    lanes = lambda p: p.evaluate(f"""() => [...document.querySelectorAll('{BLOCK} [data-testid=board-lane]')].map(l => ({{
        title: l.dataset.laneLabel, cards: [...l.querySelectorAll('.cl-board__card-title')].map(c => c.innerText.trim())}}))""")
    wait_for(lambda: any(l["cards"] == ["Shot A"] for l in lanes(admin)))
    found = {l["title"]: l["cards"] for l in lanes(admin)}
    assert found.get("Doing") == ["Shot A"] and found.get("Todo") == ["Shot B"]
    view = server.api(f"/api/views/{scene['state']['view']}")
    assert view["layout"] == "board" and view["config"]["board"]["groupBy"] == scene["state"]["stage"]
    # the member's page switches too (the view is shared), and a change made through the API moves the card live
    bob.wait_for_selector(f"{BLOCK} [data-testid=board-layout]", timeout=10000)
    ref = scene["state"]["ref"]
    b = next(r for r in stored_rows(server, ref) if r["values"]["name"] == "Shot B")
    server.api(f"/api/tables/{ref}/rows/{b['id']}", {"values": {scene["state"]["stage"]: scene["state"]["options"]["Done"]}}, method="PATCH")
    wait_for(lambda: {l["title"]: l["cards"] for l in lanes(bob)}.get("Done") == ["Shot B"])
    # back to the table for the next steps
    admin.click(f"{BLOCK} [data-testid=layout-table]")
    admin.wait_for_selector(f"{BLOCK} [data-testid=table-layout]", timeout=10000)


def test_other_layouts_cope_with_a_table_that_has_no_date_or_status_column(scene):
    admin = scene["admin"]
    errors = []
    admin.on("pageerror", lambda e: errors.append(str(e)))
    for layout, marker in (("list", "list-layout"), ("calendar", "calendar-layout"), ("gantt", "gantt-layout")):
        admin.click(f"{BLOCK} [data-testid=layout-{layout}]")
        admin.wait_for_selector(f"{BLOCK} [data-testid={marker}]", timeout=10000)
        admin.wait_for_timeout(300)
        assert admin.locator(f"{BLOCK}[data-state=ready]").count() == 1
    assert errors == []
    admin.click(f"{BLOCK} [data-testid=layout-table]")
    admin.wait_for_selector(f"{BLOCK} [data-testid=table-layout]", timeout=10000)


def test_every_layout_opens_on_a_table_with_only_a_title_column(scene, server, new_page):
    ref = server.api("/api/tables", {"name": "Bare", "space": f"p:{scene['project']}"})["ref"]
    server.api(f"/api/tables/{ref}/rows", {"values": {"name": "Only row"}})
    page = new_page(name="admin-bare")
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    login(page, server.base_url, ADMIN["username"], ADMIN["password"], goto="/")
    for layout, marker in (("board", "board-layout"), ("list", "list-layout"), ("calendar", "calendar-layout"),
                           ("gantt", "gantt-layout"), ("table", "table-layout")):
        view = server.api("/api/views", {"tableRef": ref, "name": layout, "layout": layout, "config": {"query": {}}})
        page.goto(f"{server.base_url}/dev/view/{view['id']}")
        page.wait_for_selector("[data-testid=view-shell]", timeout=20000)
        page.wait_for_timeout(600)
        assert page.locator("[data-testid=view-shell]").count() == 1
        assert page.locator("[role=alert]").count() == 0, layout
    assert errors == []


def test_a_row_opens_in_the_row_panel(scene, server):
    admin = scene["admin"]
    admin.click(f"{ROW}:has-text('Shot A') [aria-label='Open details']")
    admin.wait_for_selector("[data-testid=row-panel]", timeout=10000)
    assert "row=tbl_" in admin.url
    admin.wait_for_function("() => [...document.querySelectorAll('[data-testid=row-panel] input')].some(i => i.value === 'Shot A')",
                            timeout=10000)
    admin.click("[data-testid=row-panel] .cl-props__more")  # empty properties are collapsed until asked for
    props = admin.inner_text("[data-testid=row-panel] [data-testid=task-properties]")
    assert "Notes" in props and "Stage" in props
    admin.keyboard.press("Escape")
    admin.wait_for_selector("[data-testid=row-panel]", state="detached", timeout=5000)
    assert "row=" not in admin.url


def test_a_user_outside_the_project_gets_no_access(scene, server, new_page):
    ref = scene["state"]["ref"]
    dave_token = server.api("/api/auth/login", {"username": "dave", "password": "user-password-123"}, token="")["token"]
    for path, body in ((f"/api/tables/{ref}/schema", None), (f"/api/tables/{ref}/query", {}), (f"/api/tables/{ref}", None)):
        with pytest.raises(ApiError) as denied:
            server.api(path, body, token=dave_token)
        assert denied.value.status == 403
    with pytest.raises(ApiError) as denied:
        server.api(f"/api/tables/{ref}/rows", {"values": {"name": "no"}}, token=dave_token)
    assert denied.value.status == 403
    with pytest.raises(ApiError) as denied:
        server.api(f"/api/views/{scene['state']['view']}", token=dave_token)
    assert denied.value.status == 403
    # in the browser: the page itself is not readable either, and the table's rows never reach this user
    dave = new_page(name="dave")
    login(dave, server.base_url, "dave", goto=f"/dev/page/{scene['page']}")
    dave.wait_for_timeout(3000)
    assert dave.locator(ROW).count() == 0
    assert "Shot A" not in dave.content()
