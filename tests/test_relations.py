"""Relation columns (WP C3): columns on task tables and custom tables, target rules, validation on write,
labels resolved for the reader, deleted and restored targets, the query engine, retyping, deleted target
tables, the mirror column and live events."""

from types import SimpleNamespace

import pytest

import database
from api.state import tasks as task_cache
from api.tables import relations
from conftest import auth
from test_live import connect, nothing_pending, watch  # noqa: F401  (connect is a fixture)
from test_tables import api, table  # noqa: F401  (fixtures)


@pytest.fixture
def project(make_project):
    return make_project("Relations")


@pytest.fixture
def other_project(make_project):
    return make_project("Elsewhere")


@pytest.fixture
def member(make_user, grant, project):
    u = make_user()
    grant(project, u["user"]["id"], can_review=True, can_tasks=True)
    return u


@pytest.fixture
def reviewer(make_user, grant, project):
    u = make_user()
    grant(project, u["user"]["id"], can_review=True, can_tasks=False)
    return u


@pytest.fixture
def make_table(api):
    def _make(user, space, name="Shots"):
        res = api("POST", "/api/tables", user, {"name": name, "space": space})
        assert res.status_code == 200, res.text
        return res.json()["ref"]
    return _make


@pytest.fixture
def add_column(api):
    def _add(user, ref, name, target, **config):
        return api("POST", f"/api/tables/{ref}/columns", user,
                   {"name": name, "type": "relation", "config": {"target": target, **config}})
    return _add


@pytest.fixture
def setup(project, admin, make_table, add_column, table):
    """A project table "Shots" with a relation column "Tasks" to the project's tasks, plus three tasks."""
    shots = make_table(admin, f"p:{project}")
    tasks_ref = f"tasks:{project}"
    res = add_column(admin, shots, "Tasks", tasks_ref)
    assert res.status_code == 200, res.text
    t = table(admin, tasks_ref)
    a, b, c = [t.add(n)["id"] for n in ("Alpha", "Bravo", "Charlie")]
    return SimpleNamespace(shots=shots, tasks_ref=tasks_ref, key=res.json()["key"], t=t, a=a, b=b, c=c,
                           s=table(admin, shots))


def link(setup, ids, name="Shot", key=None):
    """Create a row of Shots linking the given ids; returns the row."""
    res = setup.s.create({"name": name, setup.key if key is None else key: ids})
    assert res.status_code == 200, res.text
    return res.json()


def drain(ws):
    """Every event waiting on the socket."""
    ws.send_json({"type": "ping"})
    events = []
    while True:
        message = ws.receive_json()
        if message == {"type": "pong"}:
            return events
        events.append(message)


def ids_of(value):
    return [v["id"] for v in value]


# ---------------------------------------------------------------- creating the column

def test_relation_column_on_a_task_table_and_a_custom_table(setup, api, admin, project):
    schema = api("GET", f"/api/tables/tasks:{project}/schema", admin).json()
    assert [c["type"] for c in schema["columns"] if not c["builtin"]] == []  # tasks have no relation yet
    res = api("POST", f"/api/tables/tasks:{project}/columns", admin,
              {"name": "Shot", "type": "relation", "config": {"target": setup.shots}})
    assert res.status_code == 200, res.text
    column = res.json()
    assert column["type"] == "relation" and column["builtin"] is False
    assert column["config"] == {"target": setup.shots, "multiple": True, "twoWay": False}
    shots_schema = api("GET", f"/api/tables/{setup.shots}/schema", admin).json()
    own = next(c for c in shots_schema["columns"] if c["key"] == setup.key)
    assert own["config"]["target"] == f"tasks:{project}"
    assert own["config"]["targetName"] == "Relations tasks"


def test_config_needs_a_target_and_knows_only_its_keys(setup, api, admin, add_column, project):
    for config in (None, {}, {"target": 5}, {"target": "nonsense"}, {"target": "tbl_missing"},
                   {"target": "tasks:*"}, {"target": "tasks:nope"}):
        res = api("POST", f"/api/tables/{setup.shots}/columns", admin,
                  {"name": "Bad", "type": "relation", **({"config": config} if config is not None else {})})
        assert res.status_code == 400, (config, res.text)
    assert add_column(admin, setup.shots, "Bad", setup.tasks_ref, colour="red").status_code == 400
    assert add_column(admin, setup.shots, "Bad", setup.tasks_ref, multiple="yes").status_code == 400


def test_starter_columns_cannot_be_relations(api, admin, project):
    res = api("POST", "/api/tables", admin, {"name": "T", "space": f"p:{project}",
                                              "columns": [{"name": "R", "type": "relation"}]})
    assert res.status_code == 400


def test_a_table_may_relate_to_itself(setup, add_column, admin):
    res = add_column(admin, setup.shots, "Parent", setup.shots)
    assert res.status_code == 200, res.text
    key = res.json()["key"]
    first = setup.s.add("First")
    second = setup.s.create({"name": "Second", key: [first["id"]]}).json()
    assert second["values"][key] == [{"id": first["id"], "label": "First"}]


# ---------------------------------------------------------------- target rules

def test_target_rules_for_every_space_combination(api, admin, member, make_user, project, other_project,
                                                  make_table, add_column, grant):
    other_shots = make_table(admin, f"p:{other_project}", "Other shots")
    shots = make_table(admin, f"p:{project}")
    mine = make_table(member, "me", "Mine")
    mine_too = make_table(member, "me", "Mine too")
    stranger = make_user()
    theirs = make_table(stranger, "me", "Theirs")

    def ok(res):
        assert res.status_code == 200, res.text

    def refused(res):
        assert res.status_code == 400, res.text

    # a project table: its own tasks and tables
    ok(add_column(admin, shots, "t", f"tasks:{project}"))
    ok(add_column(admin, shots, "s", shots))
    refused(add_column(admin, shots, "o", f"tasks:{other_project}"))
    refused(add_column(admin, shots, "x", other_shots))
    refused(add_column(admin, shots, "p", mine))
    # the tasks of a project: the same
    for target in (shots, f"tasks:{project}"):
        ok(api("POST", f"/api/tables/tasks:{project}/columns", admin,
               {"name": f"to {target}", "type": "relation", "config": {"target": target}}))
    refused(api("POST", f"/api/tables/tasks:{project}/columns", admin,
                {"name": "personal", "type": "relation", "config": {"target": mine}}))
    refused(api("POST", f"/api/tables/tasks:{project}/columns", admin,
                {"name": "other", "type": "relation", "config": {"target": other_shots}}))
    # a personal table: own personal tables, and tasks of projects the owner has task access to
    ok(add_column(member, mine, "m", mine_too))
    ok(add_column(member, mine, "self", mine))
    ok(add_column(member, mine, "tasks", f"tasks:{project}"))
    refused(add_column(member, mine, "no access", f"tasks:{other_project}"))
    refused(add_column(member, mine, "someone else's", theirs))
    refused(add_column(member, mine, "project table", shots))  # project tables are not offered to personal ones
    # project access without task access is not enough
    reviewer = make_user()
    grant(project, reviewer["user"]["id"], can_review=True, can_tasks=False)
    quiet = make_table(reviewer, "me", "Quiet")
    refused(add_column(reviewer, quiet, "t", f"tasks:{project}"))


# ---------------------------------------------------------------- writing and reading values

def test_value_has_ids_and_labels_and_is_stored_as_ids(setup, project):
    row = link(setup, [setup.a, setup.b])
    assert row["values"][setup.key] == [{"id": setup.a, "label": "Alpha"}, {"id": setup.b, "label": "Bravo"}]
    assert database.custom_tables.db_get_custom_row(setup.shots, row["id"])["values"][setup.key] == [setup.a, setup.b]
    again = setup.s.rows()[0]
    assert again["values"][setup.key] == row["values"][setup.key]


def test_a_row_without_links_has_an_empty_list(setup):
    row = setup.s.add("Alone")
    assert row["values"][setup.key] == []


def test_write_accepts_label_objects_and_removes_duplicates(setup):
    row = link(setup, [{"id": setup.a, "label": "x"}, setup.b, setup.a, setup.b])
    assert ids_of(row["values"][setup.key]) == [setup.a, setup.b]


def test_unknown_ids_are_a_400_and_nothing_is_saved(setup):
    assert setup.s.create({"name": "x", setup.key: ["nope"]}).status_code == 400
    row = link(setup, [setup.a])
    assert setup.s.update(row["id"], {setup.key: [setup.a, "nope"]}).status_code == 400
    assert ids_of(setup.s.rows()[0]["values"][setup.key]) == [setup.a]
    assert setup.s.update(row["id"], {setup.key: [3]}).status_code == 400


def test_a_task_of_another_project_cannot_be_linked(setup, admin, table, other_project):
    foreign = table(admin, f"tasks:{other_project}").add("Foreign")["id"]
    assert setup.s.create({"name": "x", setup.key: [foreign]}).status_code == 400


def test_a_single_link_column_keeps_at_most_one(setup, api, admin, add_column):
    single = add_column(admin, setup.shots, "One", setup.tasks_ref, multiple=False).json()["key"]
    row = setup.s.create({"name": "x", single: [setup.a, setup.b]}).json()
    assert ids_of(row["values"][single]) == [setup.a]
    row = setup.s.update(row["id"], {single: [setup.c]}).json()
    assert ids_of(row["values"][single]) == [setup.c]
    row = setup.s.update(row["id"], {single: []}).json()
    assert row["values"][single] == []


def test_switching_to_a_single_link_keeps_the_first(setup, api):
    row = link(setup, [setup.b, setup.a])
    res = api("PATCH", f"/api/tables/{setup.shots}/columns/{setup.key}", setup.s.user, {"config": {"multiple": False}})
    assert res.status_code == 200 and res.json()["config"]["multiple"] is False
    assert ids_of(setup.s.rows()[0]["values"][setup.key]) == [setup.b]
    assert row["id"]


def test_relation_values_on_task_rows(setup, api, admin, table, add_column, project):
    shots_rows = [setup.s.add("Row 1")["id"], setup.s.add("Row 2")["id"]]
    key = api("POST", f"/api/tables/{setup.tasks_ref}/columns", admin,
              {"name": "Shots", "type": "relation", "config": {"target": setup.shots}}).json()["key"]
    task = table(admin, setup.tasks_ref).update(setup.a, {key: shots_rows})
    assert task.status_code == 200, task.text
    assert task.json()["values"][key] == [{"id": shots_rows[0], "label": "Row 1"},
                                          {"id": shots_rows[1], "label": "Row 2"}]
    assert database.db_get_task(setup.a)["customFields"][key] == shots_rows
    assert table(admin, setup.tasks_ref).update(setup.a, {key: ["nope"]}).status_code == 400


def test_a_renamed_row_shows_its_new_title(setup, table, admin):
    link(setup, [setup.a])
    table(admin, setup.tasks_ref).update(setup.a, {"name": "Alpha 2"})
    assert setup.s.rows()[0]["values"][setup.key][0]["label"] == "Alpha 2"


def test_links_to_custom_rows_of_the_same_table_kind(setup, make_table, add_column, admin, project, api):
    other = make_table(admin, f"p:{project}", "Assets")
    key = add_column(admin, setup.shots, "Assets", other).json()["key"]
    asset = api("POST", f"/api/tables/{other}/rows", admin, {"values": {"name": "Hero rig"}}).json()
    row = setup.s.create({"name": "x", key: [asset["id"]]}).json()
    assert row["values"][key] == [{"id": asset["id"], "label": "Hero rig"}]
    unnamed = api("POST", f"/api/tables/{other}/rows", admin, {"values": {}}).json()
    row = setup.s.update(row["id"], {key: [asset["id"], unnamed["id"]]}).json()
    assert row["values"][key][1]["label"] == "Untitled"


# ---------------------------------------------------------------- permissions on read

def test_hidden_rows_are_dropped_for_this_reader_and_titles_do_not_leak(
        api, admin, member, make_table, add_column, project, other_project, table, grant):
    """A personal table links to tasks of two projects; when the owner loses one project, those links vanish."""
    mine = make_table(member, "me", "Mine")
    key_a = add_column(member, mine, "A", f"tasks:{project}").json()["key"]
    keep = table(admin, f"tasks:{project}").add("Kept")["id"]
    grant(other_project, member["user"]["id"], can_review=True, can_tasks=True)
    key_b = add_column(member, mine, "B", f"tasks:{other_project}").json()["key"]
    secret = table(admin, f"tasks:{other_project}").add("Secret title")["id"]
    created = api("POST", f"/api/tables/{mine}/rows", member,
                  {"values": {"name": "r", key_a: [keep], key_b: [secret]}}).json()
    assert created["values"][key_b] == [{"id": secret, "label": "Secret title"}]
    database.db_revoke_project_access(member["user"]["id"], other_project)
    row = api("POST", f"/api/tables/{mine}/query", member, {}).json()["rows"][0]
    assert row["values"][key_a] == [{"id": keep, "label": "Kept"}]
    assert row["values"][key_b] == []
    assert "Secret title" not in api("POST", f"/api/tables/{mine}/query", member, {}).text
    # the stored link survives: access back, link back
    grant(other_project, member["user"]["id"], can_review=True, can_tasks=True)
    row = api("POST", f"/api/tables/{mine}/query", member, {}).json()["rows"][0]
    assert ids_of(row["values"][key_b]) == [secret]


def test_labels_differ_per_reader(project, other_project, admin, member, make_user, grant, table):
    """The label lookup itself: two principals with different access see different rows."""
    other = table(admin, f"tasks:{other_project}").add("Only for some")["id"]
    mine = table(admin, f"tasks:{project}").add("For members")["id"]
    first = {"id": member["user"]["id"], "role": "editor"}
    second = make_user()
    grant(other_project, second["user"]["id"], can_review=True, can_tasks=True)
    second_principal = {"id": second["user"]["id"], "role": "editor"}
    assert relations.row_labels(first, f"tasks:{project}", [mine]) == {mine: "For members"}
    assert relations.row_labels(first, f"tasks:{other_project}", [other]) == {}
    assert relations.row_labels(second_principal, f"tasks:{other_project}", [other]) == {other: "Only for some"}
    assert relations.row_labels(second_principal, f"tasks:{project}", [mine]) == {}


def test_editing_keeps_links_the_writer_cannot_see(setup, member, api, admin, grant):
    """A link to a row that is hidden from the writer is kept when the writer edits the other links."""
    row = link(setup, [setup.a, setup.b])
    hidden = task_cache.pop(setup.b)  # as if the task was in the trash: not readable by anyone
    try:
        shown = setup.s.rows()[0]["values"][setup.key]
        assert ids_of(shown) == [setup.a]
        saved = setup.s.update(row["id"], {setup.key: [setup.a, setup.c]}).json()
        assert ids_of(saved["values"][setup.key]) == [setup.a, setup.c]
        stored = database.custom_tables.db_get_custom_row(setup.shots, row["id"])["values"][setup.key]
        assert stored == [setup.a, setup.c, setup.b]
    finally:
        task_cache[setup.b] = hidden


def test_a_reader_without_task_access_cannot_read_the_table_at_all(setup, reviewer, api):
    assert api("POST", f"/api/tables/{setup.shots}/query", reviewer, {}).status_code == 403


# ---------------------------------------------------------------- deleted and restored targets

def test_deleted_tasks_disappear_and_a_restored_task_is_linked_again(setup, table, api, admin):
    row = link(setup, [setup.a, setup.b])
    assert table(admin, setup.tasks_ref).delete(setup.a).status_code == 200
    assert ids_of(setup.s.rows()[0]["values"][setup.key]) == [setup.b]
    # the stored value is untouched
    assert database.custom_tables.db_get_custom_row(setup.shots, row["id"])["values"][setup.key] == [setup.a, setup.b]
    assert api("POST", f"/api/tables/{setup.tasks_ref}/rows/{setup.a}/restore", admin).status_code == 200
    assert ids_of(setup.s.rows()[0]["values"][setup.key]) == [setup.a, setup.b]


def test_a_deleted_task_cannot_be_linked(setup, table, admin):
    table(admin, setup.tasks_ref).delete(setup.c)
    assert setup.s.create({"name": "x", setup.key: [setup.c]}).status_code == 400


def test_deleted_custom_rows_disappear(setup, make_table, add_column, admin, project, api):
    other = make_table(admin, f"p:{project}", "Assets")
    key = add_column(admin, setup.shots, "Assets", other).json()["key"]
    asset = api("POST", f"/api/tables/{other}/rows", admin, {"values": {"name": "Rig"}}).json()["id"]
    setup.s.create({"name": "x", key: [asset]})
    api("DELETE", f"/api/tables/{other}/rows/{asset}", admin)
    assert setup.s.rows()[0]["values"][key] == []


# ---------------------------------------------------------------- the query engine

@pytest.fixture
def linked(setup):
    """Four shots: S1 -> Alpha, S2 -> Bravo + Alpha, S3 -> Charlie, S4 -> nothing."""
    rows = {"S1": link(setup, [setup.a], "S1"), "S2": link(setup, [setup.b, setup.a], "S2"),
            "S3": link(setup, [setup.c], "S3"), "S4": link(setup, [], "S4")}
    return rows


def test_filter_contains_empty_and_not_empty(setup, linked):
    key = setup.key
    names = lambda f: setup.s.names({"filter": f})  # noqa: E731
    assert names({"column": key, "op": "contains", "value": setup.a}) == ["S1", "S2"]
    assert names({"column": key, "op": "contains", "value": setup.c}) == ["S3"]
    assert names({"column": key, "op": "empty"}) == ["S4"]
    assert names({"column": key, "op": "notEmpty"}) == ["S1", "S2", "S3"]
    assert names({"column": key, "op": "in", "value": [setup.b, setup.c]}) == ["S2", "S3"]
    assert names({"column": key, "op": "contains", "value": "nothing"}) == []
    assert setup.s.query({"filter": {"column": key, "op": "contains", "value": 5.5}}).status_code == 400
    assert setup.s.query({"filter": {"column": key, "op": "lt", "value": "x"}}).status_code == 400


def test_sort_by_the_first_linked_title(setup, linked):
    assert setup.s.names({"sort": [{"column": setup.key, "dir": "asc"}]}) == ["S1", "S2", "S3", "S4"]
    # S2's first link is Bravo, so it sorts after S1 (Alpha) but before S3 (Charlie); empty is always last
    assert setup.s.names({"sort": [{"column": setup.key, "dir": "desc"}]}) == ["S3", "S2", "S1", "S4"]


def test_group_by_linked_row_lists_a_row_in_every_group(setup, linked):
    result = setup.s.query({"groupBy": setup.key}).json()
    groups = {g["label"]: g for g in result["groups"]}
    assert [g["label"] for g in result["groups"]] == ["Alpha", "Bravo", "Charlie", "No value"]
    assert groups["Alpha"]["key"] == setup.a and groups["Alpha"]["count"] == 2  # S1 and S2
    assert groups["Bravo"]["count"] == 1 and groups["Charlie"]["count"] == 1
    assert groups["No value"]["key"] is None and groups["No value"]["count"] == 1
    assert len(result["rows"]) == 4  # each row once in the list, like a multiselect


def test_summaries(setup, linked):
    result = setup.s.query({"summaries": {setup.key: "count"}}).json()
    assert result["summaries"][setup.key] == 4
    for fn, expected in (("countFilled", 3), ("countEmpty", 1)):
        assert setup.s.query({"summaries": {setup.key: fn}}).json()["summaries"][setup.key] == expected
    assert setup.s.query({"summaries": {setup.key: "sum"}}).status_code == 400
    grouped = setup.s.query({"groupBy": setup.key, "summaries": {setup.key: "countFilled"}}).json()
    assert [g["summaries"][setup.key] for g in grouped["groups"]] == [2, 1, 1, 0]


def test_search_matches_linked_titles(setup, linked):
    assert setup.s.names({"search": "bravo"}) == ["S2"]
    assert setup.s.names({"search": "charl"}) == ["S3"]
    assert setup.s.names({"search": "S4"}) == ["S4"]


def test_query_of_tasks_with_a_relation_column(setup, api, admin, table):
    key = api("POST", f"/api/tables/{setup.tasks_ref}/columns", admin,
              {"name": "Shots", "type": "relation", "config": {"target": setup.shots}}).json()["key"]
    shot = setup.s.add("Shot 1")["id"]
    table(admin, setup.tasks_ref).update(setup.b, {key: [shot]})
    t = table(admin, setup.tasks_ref)
    assert t.names({"filter": {"column": key, "op": "contains", "value": shot}}) == ["Bravo"]
    assert t.names({"filter": {"column": key, "op": "empty"}}) == ["Alpha", "Charlie"]
    all_rows = table(admin, "tasks:*")
    assert "Bravo" in all_rows.names({"search": "bravo"})


# ---------------------------------------------------------------- retyping

def test_retype_into_a_relation_clears_the_values(setup, api, admin, make_table, project):
    text = api("POST", f"/api/tables/{setup.shots}/columns", admin, {"name": "Notes", "type": "text"}).json()["key"]
    row = setup.s.create({"name": "x", text: "hello"}).json()
    # no config: refused
    assert api("PATCH", f"/api/tables/{setup.shots}/columns/{text}", admin, {"type": "relation"}).status_code == 400
    res = api("PATCH", f"/api/tables/{setup.shots}/columns/{text}", admin,
              {"type": "relation", "config": {"target": setup.tasks_ref}})
    assert res.status_code == 200, res.text
    assert res.json()["type"] == "relation"
    assert setup.s.rows()[0]["values"][text] == []
    assert text not in database.custom_tables.db_get_custom_row(setup.shots, row["id"])["values"]


def test_retype_to_text_gives_the_titles(setup, api, admin):
    row = link(setup, [setup.a, setup.b])
    link(setup, [], "Empty")
    res = api("PATCH", f"/api/tables/{setup.shots}/columns/{setup.key}", admin, {"type": "text"})
    assert res.status_code == 200, res.text
    assert res.json()["type"] == "text" and "config" not in res.json()
    rows = {r["values"]["name"]: r["values"][setup.key] for r in setup.s.rows()}
    assert rows == {"Shot": "Alpha, Bravo", "Empty": None}
    assert row["id"]


def test_retype_to_text_only_uses_titles_the_editor_can_read(setup, api, admin, make_user, grant):
    link(setup, [setup.a, setup.b])
    hidden = task_cache.pop(setup.b)  # not readable: as if in the trash
    try:
        api("PATCH", f"/api/tables/{setup.shots}/columns/{setup.key}", admin, {"type": "text"})
    finally:
        task_cache[setup.b] = hidden
    assert setup.s.rows()[0]["values"][setup.key] == "Alpha"


def test_changing_the_target_clears_the_values(setup, api, admin, make_table, project):
    link(setup, [setup.a])
    other = make_table(admin, f"p:{project}", "Assets")
    res = api("PATCH", f"/api/tables/{setup.shots}/columns/{setup.key}", admin, {"config": {"target": other}})
    assert res.status_code == 200, res.text
    assert res.json()["config"]["target"] == other
    assert setup.s.rows()[0]["values"][setup.key] == []
    assert setup.key not in database.custom_tables.db_get_custom_row(setup.shots, setup.s.rows()[0]["id"])["values"]


def test_changing_a_flag_keeps_the_values(setup, api, admin):
    link(setup, [setup.a])
    res = api("PATCH", f"/api/tables/{setup.shots}/columns/{setup.key}", admin, {"config": {"twoWay": True}})
    assert res.status_code == 200 and res.json()["config"]["target"] == setup.tasks_ref
    assert ids_of(setup.s.rows()[0]["values"][setup.key]) == [setup.a]


def test_deleting_the_column_removes_the_values(setup, api, admin):
    row = link(setup, [setup.a])
    assert api("DELETE", f"/api/tables/{setup.shots}/columns/{setup.key}", admin).status_code == 200
    assert setup.key not in database.custom_tables.db_get_custom_row(setup.shots, row["id"])["values"]


# ---------------------------------------------------------------- a deleted target table

def test_deleting_the_target_table_leaves_an_empty_column_marked_deleted(setup, api, admin, make_table, add_column, project):
    assets = make_table(admin, f"p:{project}", "Assets")
    key = add_column(admin, setup.shots, "Assets", assets).json()["key"]
    asset = api("POST", f"/api/tables/{assets}/rows", admin, {"values": {"name": "Rig"}}).json()["id"]
    row = setup.s.create({"name": "x", key: [asset]}).json()
    assert api("DELETE", f"/api/tables/{assets}", admin).status_code == 200
    schema = {c["key"]: c for c in api("GET", f"/api/tables/{setup.shots}/schema", admin).json()["columns"]}
    assert schema[key]["config"]["targetDeleted"] is True and "targetName" not in schema[key]["config"]
    assert "targetDeleted" not in schema[setup.key]["config"]
    rows = setup.s.rows({"filter": {"column": key, "op": "notEmpty"}})
    assert rows == []
    rows = setup.s.rows({"groupBy": key, "sort": [{"column": key, "dir": "asc"}], "search": "x"})
    assert rows[0]["values"][key] == []
    # writing to it is refused; the column can still be deleted or retyped
    assert setup.s.update(row["id"], {key: [asset]}).status_code == 400
    assert api("PATCH", f"/api/tables/{setup.shots}/columns/{key}", admin, {"type": "text"}).status_code == 200


# ---------------------------------------------------------------- the mirror column

def test_two_way_adds_a_read_only_mirror_to_the_target(setup, api, admin, add_column):
    schema = api("GET", f"/api/tables/{setup.tasks_ref}/schema", admin).json()
    assert not [c for c in schema["columns"] if c["type"] == "relation"]
    api("PATCH", f"/api/tables/{setup.shots}/columns/{setup.key}", admin, {"config": {"twoWay": True}})
    s1 = link(setup, [setup.a], "S1")
    s2 = link(setup, [setup.a, setup.b], "S2")
    schema = api("GET", f"/api/tables/{setup.tasks_ref}/schema", admin).json()
    mirrors = [c for c in schema["columns"] if c["type"] == "relation"]
    assert len(mirrors) == 1
    mirror = mirrors[0]
    assert mirror["readonly"] is True and mirror["builtin"] is True
    assert mirror["config"]["target"] == setup.shots and mirror["config"]["mirrorOf"]["key"] == setup.key
    assert mirror["name"].startswith("Tasks (")
    result = api("POST", f"/api/tables/{setup.tasks_ref}/query", admin, {}).json()["rows"]
    by_name = {r["values"]["name"]: r["values"][mirror["key"]] for r in result}
    assert by_name["Alpha"] == [{"id": s1["id"], "label": "S1"}, {"id": s2["id"], "label": "S2"}]
    assert by_name["Bravo"] == [{"id": s2["id"], "label": "S2"}]
    assert by_name["Charlie"] == []
    # the engine treats it like any relation column
    found = api("POST", f"/api/tables/{setup.tasks_ref}/query", admin,
                {"filter": {"column": mirror["key"], "op": "contains", "value": s2["id"]}}).json()["rows"]
    assert [r["values"]["name"] for r in found] == ["Alpha", "Bravo"]
    # it cannot be written, retyped or deleted, and it is not stored
    task = api("PATCH", f"/api/tables/{setup.tasks_ref}/rows/{setup.c}", admin, {"values": {mirror["key"]: [s1["id"]]}})
    assert task.status_code == 400
    assert api("DELETE", f"/api/tables/{setup.tasks_ref}/columns/{mirror['key']}", admin).status_code in (400, 404)
    assert mirror["key"] not in (database.db_get_task(setup.a).get("customFields") or {})
    # turning two-way off removes it
    api("PATCH", f"/api/tables/{setup.shots}/columns/{setup.key}", admin, {"config": {"twoWay": False}})
    schema = api("GET", f"/api/tables/{setup.tasks_ref}/schema", admin).json()
    assert not [c for c in schema["columns"] if c["type"] == "relation"]


def test_mirror_follows_link_changes_and_a_self_relation_has_one(setup, api, admin, add_column):
    key = add_column(admin, setup.shots, "Parent", setup.shots, twoWay=True).json()["key"]
    parent = setup.s.add("Parent")["id"]
    child = setup.s.create({"name": "Child", key: [parent]}).json()
    schema = api("GET", f"/api/tables/{setup.shots}/schema", admin).json()
    mirror = next(c for c in schema["columns"] if c.get("config", {}).get("mirrorOf", {}).get("key") == key)
    rows = {r["values"]["name"]: r["values"][mirror["key"]] for r in setup.s.rows()}
    assert rows["Parent"] == [{"id": child["id"], "label": "Child"}]
    setup.s.update(child["id"], {key: []})
    rows = {r["values"]["name"]: r["values"][mirror["key"]] for r in setup.s.rows()}
    assert rows["Parent"] == []


def test_mirror_of_a_personal_table_is_only_shown_to_its_owner(api, admin, member, make_table, add_column, project, table):
    mine = make_table(member, "me", "Mine")
    key = add_column(member, mine, "Tasks", f"tasks:{project}", twoWay=True).json()["key"]
    task = table(admin, f"tasks:{project}").add("Shared task")["id"]
    api("POST", f"/api/tables/{mine}/rows", member, {"values": {"name": "Private note", key: [task]}})
    mirrors = lambda user: [c for c in api("GET", f"/api/tables/tasks:{project}/schema", user).json()["columns"]  # noqa: E731
                            if c["type"] == "relation"]
    assert len(mirrors(member)) == 1
    assert mirrors(admin) == []
    rows = api("POST", f"/api/tables/tasks:{project}/query", admin, {}).json()["rows"]
    assert "Private note" not in str(rows)
    mine_rows = api("POST", f"/api/tables/tasks:{project}/query", member, {}).json()["rows"]
    assert "Private note" in str(mine_rows)


# ---------------------------------------------------------------- live events

def test_target_changes_arrive_as_rows_changed_and_a_deleted_target_table_as_schema_changed(
        setup, api, admin, member, connect, make_table, add_column, project, table):
    assets = make_table(admin, f"p:{project}", "Assets")
    key = add_column(admin, setup.shots, "Assets", assets).json()["key"]
    with connect(member["token"], "watcher") as watcher:
        assert watch(watcher, project) == [project]
        api("PATCH", f"/api/tables/{setup.tasks_ref}/rows/{setup.a}", admin, {"values": {"name": "Alpha renamed"}},
            headers={"X-Client-Id": "writer"})
        events = drain(watcher)
        assert any(e["type"] == "rows_changed" and e["tableRef"] == setup.tasks_ref and e["ids"] == [setup.a]
                   for e in events)
        api("DELETE", f"/api/tables/{assets}", admin, headers={"X-Client-Id": "writer"})
        events = drain(watcher)
        refs = [e["tableRef"] for e in events if e["type"] == "schema_changed"]
        assert assets in refs and setup.shots in refs
    assert key
