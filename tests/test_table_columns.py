"""Custom columns (WP T2): column endpoints, values in tasks.custom_fields, query, retyping, events."""

import pytest

import database
from conftest import auth
from test_live import connect, watch, nothing_pending  # noqa: F401  (connect is a fixture)
from test_tables import api, table, stored  # noqa: F401  (fixtures)


@pytest.fixture
def project(make_project):
    return make_project("Columns")


@pytest.fixture
def ref(project):
    return f"tasks:{project}"


@pytest.fixture
def owner(make_user, project):
    u = make_user()
    database.db_grant_project_access(u["user"]["id"], project, can_review=True, can_tasks=True, is_owner=True)
    return u


@pytest.fixture
def member(make_user, grant, project):
    u = make_user()
    grant(project, u["user"]["id"], can_review=True, can_tasks=True)
    return u


@pytest.fixture
def cols(api, admin, ref):
    """cols.add(name, type, **extra) -> Column dict; cols.patch / cols.delete -> responses."""
    class Cols:
        def add(self, name, ctype, user=None, **extra):
            res = api("POST", f"/api/tables/{ref}/columns", user or admin, {"name": name, "type": ctype, **extra})
            assert res.status_code == 200, res.text
            return res.json()

        def post(self, body, user=None):
            return api("POST", f"/api/tables/{ref}/columns", user or admin, body)

        def patch(self, key, body, user=None):
            return api("PATCH", f"/api/tables/{ref}/columns/{key}", user or admin, body)

        def delete(self, key, user=None):
            return api("DELETE", f"/api/tables/{ref}/columns/{key}", user or admin)

        def schema(self):
            return {c["key"]: c for c in api("GET", f"/api/tables/{ref}/schema", admin).json()["columns"]}
    return Cols()


def custom(task_id):
    return stored(task_id).get("customFields") or {}


def opt(column, label):
    return next(o["value"] for o in column["options"] if o["label"] == label)


# ---------------------------------------------------------------- columns and schema

def test_create_column_returns_the_column_and_shows_in_the_schema(cols, ref, table, admin):
    col = cols.add("  Budget ", "number", config={"decimals": 2})
    assert col["key"].startswith("cf_") and len(col["key"]) > 4
    assert col == {"key": col["key"], "name": "Budget", "type": "number", "builtin": False,
                   "config": {"decimals": 2}}
    second = cols.add("Notes", "text")
    keys = [c["key"] for c in table(admin, ref).schema().json()["columns"]]
    assert keys[-2:] == [col["key"], second["key"]]  # after the builtin ones, in order
    assert keys.index("createdBy") < keys.index(col["key"])


def test_select_options_get_server_ids(cols):
    col = cols.add("Kind", "select", options=[{"label": "A", "color": "#111111"}, {"label": "B", "value": "mine"}])
    assert [o["label"] for o in col["options"]] == ["A", "B"]
    assert col["options"][0]["color"] == "#111111"
    assert all(o["value"].startswith("o_") for o in col["options"])  # a client value is not trusted on create


def test_every_supported_type_can_be_created(cols):
    for i, t in enumerate(["text", "longtext", "number", "checkbox", "date", "select", "multiselect", "url",
                           "person", "people"]):
        assert cols.add(f"C{i}", t)["type"] == t


def test_tasks_star_has_no_custom_columns_but_rows_carry_values(cols, ref, table, admin, project):
    col = cols.add("Cost", "number")
    row = table(admin, ref).add("R")
    assert table(admin, ref).update(row["id"], {col["key"]: 5}).status_code == 200
    schema = table(admin, "tasks:*").schema().json()
    assert col["key"] not in [c["key"] for c in schema["columns"]]
    rows = table(admin, "tasks:*").rows()
    mine = next(r for r in rows if r["id"] == row["id"])
    assert mine["values"][col["key"]] == 5
    assert mine["tableRef"] == ref


def test_star_and_unknown_refs(api, admin):
    assert api("POST", "/api/tables/tasks:*/columns", admin, {"name": "X", "type": "text"}).status_code == 400
    assert api("PATCH", "/api/tables/tasks:*/columns/cf_x", admin, {"name": "X"}).status_code == 400
    assert api("DELETE", "/api/tables/tasks:*/columns/cf_x", admin).status_code == 400
    assert api("POST", "/api/tables/nope/columns", admin, {"name": "X", "type": "text"}).status_code == 404
    assert api("POST", "/api/tables/tasks:missing/columns", admin, {"name": "X", "type": "text"}).status_code == 404


@pytest.mark.parametrize("body", [
    {"type": "text"}, {"name": "", "type": "text"}, {"name": "   ", "type": "text"}, {"name": "x" * 81, "type": "text"},
    {"name": "A", "type": "status"}, {"name": "A", "type": "formula"}, {"name": "A"}, {"name": 5, "type": "text"},
    {"name": "A", "type": "text", "options": [{"label": "x"}]},
    {"name": "A", "type": "select", "options": "nope"},
    {"name": "A", "type": "select", "options": [{"label": ""}]},
    {"name": "A", "type": "select", "options": [{"label": "x"}, {"label": "X"}]},
    {"name": "A", "type": "select", "options": [{"label": f"o{i}"} for i in range(201)]},
    {"name": "A", "type": "text", "config": [1]},
])
def test_invalid_column_definitions_are_400(cols, body):
    res = cols.post(body)
    assert res.status_code == 400, res.text
    assert res.json()["detail"]


def test_200_options_are_fine(cols):
    assert len(cols.add("Many", "select", options=[{"label": f"o{i}"} for i in range(200)])["options"]) == 200


def test_names_are_unique_case_insensitively(cols):
    cols.add("Budget", "number")
    assert cols.post({"name": "budget", "type": "text"}).status_code == 409
    other = cols.add("Other", "text")
    assert cols.patch(other["key"], {"name": " BUDGET "}).status_code == 409
    assert cols.patch(other["key"], {"name": "OTHER"}).status_code == 200  # its own name is fine
    assert cols.post({"name": "Status", "type": "text"}).status_code == 409  # a builtin column's name


def test_builtin_columns_cannot_be_changed_or_deleted(cols):
    for key in ("name", "status", "dueDate", "createdBy"):
        assert cols.patch(key, {"name": "Z"}).status_code == 400
        assert cols.patch(key, {"type": "text"}).status_code == 400
        assert cols.delete(key).status_code == 400
    assert cols.patch("cf_nope", {"name": "Z"}).status_code == 404
    assert cols.delete("cf_nope").status_code == 404


def test_patch_renames_reorders_and_changes_config(cols, ref, table, admin):
    a, b = cols.add("A", "text"), cols.add("B", "number")
    res = cols.patch(b["key"], {"name": "B2", "config": {"decimals": 1}, "sortOrder": -5})
    assert res.status_code == 200
    assert res.json() == {"key": b["key"], "name": "B2", "type": "number", "builtin": False, "config": {"decimals": 1}}
    keys = [c["key"] for c in table(admin, ref).schema().json()["columns"]]
    assert keys[-2:] == [b["key"], a["key"]]
    assert cols.patch(b["key"], {"sortOrder": "x"}).status_code == 400
    assert cols.patch(b["key"], {"type": "formula"}).status_code == 400
    assert cols.patch(b["key"], {"options": [{"label": "x"}]}).status_code == 400


# ---------------------------------------------------------------- permissions

def test_owner_and_admin_can_change_columns(cols, owner, admin):
    col = cols.add("Owned", "text", user=owner)
    assert cols.patch(col["key"], {"name": "Owned2"}, user=owner).status_code == 200
    assert cols.delete(col["key"], user=owner).status_code == 200
    assert cols.post({"name": "Admin", "type": "text"}, user=admin).status_code == 200


def test_others_cannot_change_columns(cols, member, make_user, grant, project, share, api, ref):
    col = cols.add("Guarded", "text")
    viewer = make_user("viewer")
    grant(project, viewer["user"]["id"], can_review=True, can_tasks=True)
    outsider = make_user()
    for user in (member, viewer, outsider):
        assert cols.post({"name": "No", "type": "text"}, user=user).status_code == 403
        assert cols.patch(col["key"], {"name": "No"}, user=user).status_code == 403
        assert cols.delete(col["key"], user=user).status_code == 403
    guest = share(project)
    assert cols.post({"name": "No", "type": "text"}, user=guest).status_code == 403
    assert api("POST", f"/api/tables/{ref}/columns", None, {"name": "No", "type": "text"}).status_code == 401
    assert api("PATCH", f"/api/tables/{ref}/columns/{col['key']}", None, {"name": "No"}).status_code == 401
    assert api("DELETE", f"/api/tables/{ref}/columns/{col['key']}", None).status_code == 401
    assert cols.schema()[col["key"]]["name"] == "Guarded"


def test_edit_schema_capability_matches(table, owner, member, ref):
    assert table(owner, ref).schema().json()["capabilities"]["editSchema"] is True
    assert table(member, ref).schema().json()["capabilities"]["editSchema"] is False


# ---------------------------------------------------------------- values per type

def test_text_values(cols, table, ref, admin):
    c = cols.add("T", "text")["key"]
    t = table(admin, ref)
    row = t.add("r")
    assert row["values"][c] is None  # missing means empty
    assert t.update(row["id"], {c: "hello"}).json()["values"][c] == "hello"
    assert custom(row["id"]) == {c: "hello"}
    assert t.update(row["id"], {c: 5}).status_code == 400
    assert t.update(row["id"], {c: "x" * 10_001}).status_code == 400
    assert t.update(row["id"], {c: "x" * 10_000}).status_code == 200
    assert t.update(row["id"], {c: ""}).json()["values"][c] is None
    assert custom(row["id"]) == {}  # empty values are not stored
    assert t.update(row["id"], {"cf_unknown": 1}).status_code == 400


def test_url_is_trimmed_and_longtext_is_text(cols, table, ref, admin):
    u, lt = cols.add("U", "url")["key"], cols.add("L", "longtext")["key"]
    t = table(admin, ref)
    row = t.add("r")
    assert t.update(row["id"], {u: "  https://example.com  "}).json()["values"][u] == "https://example.com"
    assert t.update(row["id"], {u: "x" * 2001}).status_code == 400
    assert t.update(row["id"], {lt: "a\nb"}).json()["values"][lt] == "a\nb"


def test_number_values(cols, table, ref, admin):
    c = cols.add("N", "number")["key"]
    t = table(admin, ref)
    row = t.add("r")
    assert t.update(row["id"], {c: 3.5}).json()["values"][c] == 3.5
    assert t.update(row["id"], {c: 0}).json()["values"][c] == 0  # zero is a value
    assert custom(row["id"]) == {c: 0}
    for bad in ("5", True, [1], {"a": 1}, float("1e999")):
        assert t.update(row["id"], {c: bad}).status_code in (400, 422), bad
    assert t.update(row["id"], {c: None}).json()["values"][c] is None


def test_checkbox_values(cols, table, ref, admin):
    c = cols.add("C", "checkbox")["key"]
    t = table(admin, ref)
    row = t.add("r")
    assert row["values"][c] is False
    assert t.update(row["id"], {c: True}).json()["values"][c] is True
    assert t.update(row["id"], {c: "yes"}).status_code == 400
    assert t.update(row["id"], {c: False}).json()["values"][c] is False
    assert custom(row["id"]) == {}


def test_date_values(cols, table, ref, admin):
    c = cols.add("D", "date")["key"]
    t = table(admin, ref)
    row = t.add("r")
    assert t.update(row["id"], {c: "2030-02-28"}).json()["values"][c] == "2030-02-28"
    for bad in ("2030-02-30", "2030-2-3", "30.01.2030", "2030-01-31T10:00:00", 20300101):
        assert t.update(row["id"], {c: bad}).status_code == 400, bad
    assert t.update(row["id"], {c: None}).json()["values"][c] is None


def test_select_values(cols, table, ref, admin):
    col = cols.add("S", "select", options=[{"label": "Red"}, {"label": "Blue"}])
    c, red = col["key"], opt(col, "Red")
    t = table(admin, ref)
    row = t.add("r")
    assert t.update(row["id"], {c: red}).json()["values"][c] == red
    assert t.update(row["id"], {c: "Red"}).status_code == 400  # a label is not a value
    assert t.update(row["id"], {c: ["x"]}).status_code == 400
    assert t.update(row["id"], {c: None}).json()["values"][c] is None


def test_multiselect_values(cols, table, ref, admin):
    col = cols.add("M", "multiselect", options=[{"label": "a"}, {"label": "b"}, {"label": "c"}])
    c, a, b = col["key"], opt(col, "a"), opt(col, "b")
    t = table(admin, ref)
    row = t.add("r")
    assert row["values"][c] == []
    assert t.update(row["id"], {c: [a, b, a]}).json()["values"][c] == [a, b]
    assert t.update(row["id"], {c: [a, "zzz"]}).status_code == 400
    assert t.update(row["id"], {c: a}).status_code == 400
    assert t.update(row["id"], {c: []}).json()["values"][c] == []
    assert custom(row["id"]) == {}


def test_person_and_people_values(cols, table, ref, admin, member, make_user):
    p, ps = cols.add("P", "person")["key"], cols.add("Ps", "people")["key"]
    outsider = make_user()
    t = table(admin, ref)
    row = t.add("r")
    uid = member["user"]["id"]
    assert t.update(row["id"], {p: uid, ps: [uid]}).json()["values"] == {**t.rows()[0]["values"], p: uid, ps: [uid]}
    assert t.update(row["id"], {p: outsider["user"]["id"]}).status_code == 400
    assert t.update(row["id"], {ps: [uid, outsider["user"]["id"]]}).status_code == 400
    assert t.update(row["id"], {p: "no-such-user"}).status_code == 400
    assert t.update(row["id"], {p: None, ps: None}).status_code == 200
    schema = cols.schema()
    assert any(o["value"] == uid for o in schema[p]["options"])  # people options like the builtin ones


def test_create_row_with_custom_values_and_via_star(cols, table, ref, admin, project):
    c = cols.add("N", "number")["key"]
    res = table(admin, ref).create({"name": "new", c: 7})
    assert res.status_code == 200, res.text
    assert custom(res.json()["id"]) == {c: 7}
    assert table(admin, ref).create({"name": "bad", c: "x"}).status_code == 400
    res = table(admin, "tasks:*").create({"name": "viastar", c: 8}, projectId=project)
    assert res.status_code == 200 and res.json()["values"][c] == 8


def test_update_keeps_other_custom_values(cols, table, ref, admin):
    a, b = cols.add("A", "text")["key"], cols.add("B", "number")["key"]
    t = table(admin, ref)
    row = t.add("r")
    t.update(row["id"], {a: "x"})
    t.update(row["id"], {b: 2, "name": "renamed"})
    assert custom(row["id"]) == {a: "x", b: 2}


def test_old_task_api_does_not_wipe_custom_values(cols, table, ref, admin, api):
    c = cols.add("A", "text")["key"]
    row = table(admin, ref).add("r")
    table(admin, ref).update(row["id"], {c: "keep"})
    res = api("PATCH", f"/api/tasks/{row['id']}", admin, {"name": "via old api", "priority": "high",
                                                           "description": "d", "dueDate": "2030-01-01"})
    assert res.status_code == 200, res.text
    assert custom(row["id"]) == {c: "keep"}
    got = table(admin, ref).rows()[0]
    assert got["values"]["name"] == "via old api" and got["values"][c] == "keep"
    assert api("GET", f"/api/tasks/{row['id']}", admin).json()["task"]["customFields"] == {c: "keep"}


def test_members_with_task_access_edit_custom_values(cols, table, ref, member):
    c = cols.add("A", "text")["key"]
    row = table(member, ref).add("r")
    assert table(member, ref).update(row["id"], {c: "mine"}).status_code == 200


# ---------------------------------------------------------------- query: filter, sort, group, summarise, search

def fill(table_, ref_, key, values):
    ids = []
    for i, v in enumerate(values):
        row = table_.add(f"row{i}")
        if v is not None:
            assert table_.update(row["id"], {key: v}).status_code == 200
        ids.append(row["id"])
    return ids


def test_text_query(cols, table, ref, admin):
    c = cols.add("T", "text")["key"]
    t = table(admin, ref)
    fill(t, ref, c, ["banana", "Apple", None, "cherry"])
    assert t.names({"filter": {"column": c, "op": "contains", "value": "AN"}}) == ["row0"]
    assert t.names({"filter": {"column": c, "op": "empty"}}) == ["row2"]
    assert t.names({"filter": {"column": c, "op": "eq", "value": "apple"}}) == ["row1"]
    assert t.names({"sort": [{"column": c, "dir": "asc"}]}) == ["row1", "row0", "row3", "row2"]
    assert t.names({"sort": [{"column": c, "dir": "desc"}]}) == ["row3", "row0", "row1", "row2"]
    res = t.query({"groupBy": c, "summaries": {c: "countFilled"}}).json()
    assert [g["key"] for g in res["groups"]] == ["Apple", "banana", "cherry", None] or len(res["groups"]) == 4
    assert res["summaries"][c] == 3
    assert t.names({"search": "cherr"}) == ["row3"]  # searched like the builtin text columns


def test_number_query(cols, table, ref, admin):
    c = cols.add("N", "number")["key"]
    t = table(admin, ref)
    fill(t, ref, c, [5, 1.5, None, 10, 5])
    assert t.names({"filter": {"column": c, "op": "gt", "value": 4}}) == ["row0", "row3", "row4"]
    assert t.names({"filter": {"column": c, "op": "between", "value": [1, 5]}}) == ["row0", "row1", "row4"]
    assert t.names({"filter": {"column": c, "op": "notEmpty"}}) == ["row0", "row1", "row3", "row4"]
    assert t.names({"sort": [{"column": c, "dir": "asc"}]}) == ["row1", "row0", "row4", "row3", "row2"]
    res = t.query({"summaries": {c: "sum"}, "groupBy": c}).json()
    assert res["summaries"][c] == 21.5
    assert [(g["key"], g["count"]) for g in res["groups"]] == [("1.5", 1), ("5", 2), ("10", 1), (None, 1)]
    stats = t.query({"summaries": {c: "max"}}).json()["summaries"]
    assert stats[c] == 10
    assert t.query({"summaries": {c: "avg"}}).json()["summaries"][c] == pytest.approx(21.5 / 4)


def test_checkbox_query(cols, table, ref, admin):
    c = cols.add("C", "checkbox")["key"]
    t = table(admin, ref)
    fill(t, ref, c, [True, None, True, False])
    assert t.names({"filter": {"column": c, "op": "eq", "value": True}}) == ["row0", "row2"]
    assert t.names({"filter": {"column": c, "op": "eq", "value": False}}) == ["row1", "row3"]
    res = t.query({"groupBy": c, "summaries": {c: "percentChecked"}}).json()
    assert [(g["key"], g["count"]) for g in res["groups"]] == [("false", 2), ("true", 2)]
    assert res["summaries"][c] == 50
    assert t.names({"sort": [{"column": c, "dir": "desc"}]})[:2] == ["row0", "row2"]


def test_date_query(cols, table, ref, admin):
    c = cols.add("D", "date")["key"]
    t = table(admin, ref)
    fill(t, ref, c, ["2030-03-01", "2030-01-15", None, "2030-03-01"])
    assert t.names({"filter": {"column": c, "op": "before", "value": "2030-03-01"}}) == ["row1"]
    assert t.names({"filter": {"column": c, "op": "between", "value": ["2030-01-01", "2030-03-01"]}}) == \
        ["row0", "row1", "row3"]
    assert t.names({"sort": [{"column": c, "dir": "asc"}]}) == ["row1", "row0", "row3", "row2"]
    res = t.query({"groupBy": c, "summaries": {c: "min"}}).json()
    assert [(g["key"], g["count"]) for g in res["groups"]] == [("2030-01-15", 1), ("2030-03-01", 2), (None, 1)]
    assert res["summaries"][c] == "2030-01-15"
    assert t.query({"summaries": {c: "countEmpty"}}).json()["summaries"][c] == 1


def test_select_query(cols, table, ref, admin):
    col = cols.add("S", "select", options=[{"label": "Low", "color": "#00ff00"}, {"label": "High"}])
    c, low, high = col["key"], opt(col, "Low"), opt(col, "High")
    t = table(admin, ref)
    fill(t, ref, c, [high, low, None, high])
    assert t.names({"filter": {"column": c, "op": "eq", "value": high}}) == ["row0", "row3"]
    assert t.names({"filter": {"column": c, "op": "in", "value": [low]}}) == ["row1"]
    assert t.names({"filter": {"column": c, "op": "nin", "value": [low]}}) == ["row0", "row2", "row3"]
    assert t.names({"sort": [{"column": c, "dir": "asc"}]}) == ["row1", "row0", "row3", "row2"]  # option order
    groups = t.query({"groupBy": c}).json()["groups"]
    assert [(g["key"], g["label"], g["count"]) for g in groups] == [
        (low, "Low", 1), (high, "High", 2), (None, "No value", 1)]
    assert groups[0]["color"] == "#00ff00"
    assert t.query({"summaries": {c: "countFilled"}}).json()["summaries"][c] == 3


def test_multiselect_query(cols, table, ref, admin):
    col = cols.add("M", "multiselect", options=[{"label": "a"}, {"label": "b"}])
    c, a, b = col["key"], opt(col, "a"), opt(col, "b")
    t = table(admin, ref)
    fill(t, ref, c, [[a], [a, b], None, [b]])
    assert t.names({"filter": {"column": c, "op": "contains", "value": b}}) == ["row1", "row3"]
    assert t.names({"filter": {"column": c, "op": "empty"}}) == ["row2"]
    groups = t.query({"groupBy": c}).json()["groups"]
    assert [(g["label"], g["count"]) for g in groups] == [("a", 2), ("b", 2), ("No value", 1)]


def test_url_and_longtext_query(cols, table, ref, admin):
    u, lt = cols.add("U", "url")["key"], cols.add("L", "longtext")["key"]
    t = table(admin, ref)
    fill(t, ref, u, ["https://b.example", "https://a.example"])
    assert t.names({"sort": [{"column": u, "dir": "asc"}]}) == ["row1", "row0"]
    assert t.names({"filter": {"column": u, "op": "contains", "value": "a.ex"}}) == ["row1"]
    assert t.query({"groupBy": lt}).status_code == 400  # as for the builtin long text


def test_person_and_people_query(cols, table, ref, admin, member):
    p, ps = cols.add("P", "person")["key"], cols.add("Ps", "people")["key"]
    me, other = admin["user"]["id"], member["user"]["id"]
    t = table(admin, ref)
    r0, r1, r2 = (t.add(n)["id"] for n in ("row0", "row1", "row2"))
    t.update(r0, {p: me, ps: [me, other]})
    t.update(r1, {p: other, ps: [other]})
    assert t.names({"filter": {"column": p, "op": "eq", "value": "@me"}}) == ["row0"]
    assert t.names({"filter": {"column": ps, "op": "contains", "value": other}}) == ["row0", "row1"]
    assert t.names({"filter": {"column": ps, "op": "empty"}}) == ["row2"]
    groups = t.query({"groupBy": p}).json()["groups"]
    assert {g["key"] for g in groups} == {me, other, None}
    assert len(t.rows({"sort": [{"column": p, "dir": "asc"}]})) == 3


def test_filters_combine_builtin_and_custom_columns(cols, table, ref, admin):
    c = cols.add("N", "number")["key"]
    t = table(admin, ref)
    ids = fill(t, ref, c, [1, 2, 3])
    t.update(ids[2], {"priority": "high"})
    query = {"filter": {"and": [{"column": c, "op": "gte", "value": 2}, {"column": "priority", "op": "eq", "value": "high"}]}}
    assert t.names(query) == ["row2"]


def test_tasks_star_cannot_query_custom_columns(cols, table, admin):
    c = cols.add("N", "number")["key"]
    res = table(admin, "tasks:*").query({"filter": {"column": c, "op": "gt", "value": 1}})
    assert res.status_code == 400  # unknown there: custom columns differ per project


def test_values_are_scoped_to_their_project(cols, table, ref, admin, make_project):
    c = cols.add("N", "number")["key"]
    other_ref = f"tasks:{make_project('Other')}"
    row = table(admin, other_ref).add("elsewhere")
    assert table(admin, other_ref).update(row["id"], {c: 1}).status_code == 400  # not a column of that project
    assert c not in table(admin, other_ref).rows()[0]["values"]


# ---------------------------------------------------------------- options

def test_renaming_an_option_keeps_the_values(cols, table, ref, admin):
    col = cols.add("S", "select", options=[{"label": "Open"}, {"label": "Done"}])
    c, open_, done = col["key"], opt(col, "Open"), opt(col, "Done")
    t = table(admin, ref)
    ids = fill(t, ref, c, [open_, done])
    res = cols.patch(c, {"options": [{"value": open_, "label": "Todo", "color": "#abcdef"}, {"value": done, "label": "Done"},
                                     {"label": "Extra"}]})
    assert res.status_code == 200, res.text
    options = res.json()["options"]
    assert [o["label"] for o in options] == ["Todo", "Done", "Extra"]
    assert options[0]["value"] == open_ and options[1]["value"] == done
    assert options[2]["value"] not in (open_, done)
    assert [r["values"][c] for r in t.rows()] == [open_, done]
    assert custom(ids[0]) == {c: open_}


def test_removing_an_option_clears_it_from_rows(cols, table, ref, admin, connect):
    col = cols.add("M", "multiselect", options=[{"label": "a"}, {"label": "b"}])
    c, a, b = col["key"], opt(col, "a"), opt(col, "b")
    s = cols.add("S", "select", options=[{"label": "x"}, {"label": "y"}])
    sk, x, y = s["key"], opt(s, "x"), opt(s, "y")
    t = table(admin, ref)
    r0, r1, r2 = (t.add(n)["id"] for n in ("r0", "r1", "r2"))
    t.update(r0, {c: [a, b], sk: x})
    t.update(r1, {c: [b], sk: y})
    t.update(r2, {c: [a]})
    with connect(admin["token"], "tab") as ws:
        watch(ws, ref.split(":")[1])
        assert cols.patch(c, {"options": [{"value": a, "label": "a"}]}).status_code == 200
        ws.receive_json()  # schema_changed
        event = ws.receive_json()
        assert event["type"] == "rows_changed" and event["change"] == "updated"
        assert set(event["ids"]) == {r0, r1}  # r2 did not use the removed option
    assert custom(r0) == {c: [a], sk: x} and custom(r1) == {sk: y} and custom(r2) == {c: [a]}
    assert cols.patch(sk, {"options": [{"value": x, "label": "x"}]}).status_code == 200
    assert custom(r1) == {} and custom(r0) == {c: [a], sk: x}
    assert table(admin, ref).update(r1, {sk: y}).status_code == 400  # the option is gone


# ---------------------------------------------------------------- retype

def retype(cols, table_, ref_, old_type, values, new_type, **extra):
    """Make a column of old_type, set one value per row, retype it. Returns (column, [new stored values])."""
    key_extra = extra.pop("create", {})
    col = cols.add(f"{old_type}->{new_type}", old_type, **key_extra)
    key = col["key"]
    ids = []
    for i, v in enumerate(values):
        row = table_.add(f"r{i}")
        if v is not None:
            assert table_.update(row["id"], {key: v}).status_code == 200, (old_type, v)
        ids.append(row["id"])
    res = cols.patch(key, {"type": new_type, **extra})
    assert res.status_code == 200, res.text
    return res.json(), [custom(i).get(key) for i in ids], key


@pytest.mark.parametrize("old,new", [("text", "longtext"), ("longtext", "url"), ("url", "text"), ("text", "url")])
def test_retype_between_text_kinds_keeps_values(cols, table, ref, admin, old, new):
    col, values, _ = retype(cols, table(admin, ref), ref, old, ["abc", None, "https://x.y"], new)
    assert col["type"] == new
    assert values == ["abc", None, "https://x.y"]


def test_retype_text_to_number(cols, table, ref, admin):
    _, values, _ = retype(cols, table(admin, ref), ref, "text", ["12", "1,5", " 3.25 ", "abc", "", None, "1e999", "nan"], "number")
    assert values == [12, 1.5, 3.25, None, None, None, None, None]


def test_retype_number_to_text(cols, table, ref, admin):
    _, values, _ = retype(cols, table(admin, ref), ref, "number", [3, 2.5, 0, None], "text")
    assert values == ["3", "2.5", "0", None]


def test_retype_text_to_date_and_back(cols, table, ref, admin):
    col, values, key = retype(cols, table(admin, ref), ref, "text",
                              ["2030-05-06", "2030-05-06T10:00:00", "6 May 2030", "2030-13-01"], "date")
    assert values == ["2030-05-06", "2030-05-06", None, None]
    assert cols.patch(key, {"type": "text"}).status_code == 200
    assert custom(table(admin, ref).rows()[0]["id"]).get(key) == "2030-05-06"


def test_retype_date_to_number_clears(cols, table, ref, admin):
    _, values, _ = retype(cols, table(admin, ref), ref, "date", ["2030-05-06"], "number")
    assert values == [None]


def test_retype_select_to_multiselect_and_back(cols, table, ref, admin):
    opts = {"create": {"options": [{"label": "a"}, {"label": "b"}]}}
    t = table(admin, ref)
    col = cols.add("S", "select", options=[{"label": "a"}, {"label": "b"}])
    key, a = col["key"], opt(col, "a")
    r0, r1 = t.add("r0")["id"], t.add("r1")["id"]
    t.update(r0, {key: a})
    res = cols.patch(key, {"type": "multiselect"})
    assert res.status_code == 200 and res.json()["options"] == col["options"]  # options carried over
    assert custom(r0) == {key: [a]} and custom(r1) == {}
    b = opt(col, "b")
    t.update(r1, {key: [b, a]})
    assert cols.patch(key, {"type": "select"}).status_code == 200
    assert custom(r0) == {key: a} and custom(r1) == {key: b}  # the first one
    del opts


def test_retype_text_to_select_creates_options(cols, table, ref, admin):
    col, values, key = retype(cols, table(admin, ref), ref, "text", ["Red", "blue", "red ", None, "Blue", ""], "select")
    labels = [o["label"] for o in col["options"]]
    assert labels == ["blue", "Red"] or labels == ["Blue", "Red"] or sorted(labels, key=str.casefold) == labels
    assert len(col["options"]) == 2  # distinct, case-insensitive, non-empty
    by_label = {o["label"].casefold(): o["value"] for o in col["options"]}
    assert values == [by_label["red"], by_label["blue"], by_label["red"], None, by_label["blue"], None]


def test_retype_text_to_multiselect_wraps(cols, table, ref, admin):
    _, values, key = retype(cols, table(admin, ref), ref, "text", ["Red", None], "multiselect")
    col = cols.schema()[key]
    assert values == [[col["options"][0]["value"]], None]


def test_retype_text_to_select_with_given_options_matches_labels(cols, table, ref, admin):
    col, values, _ = retype(cols, table(admin, ref), ref, "text", ["red", "green"], "select",
                            options=[{"label": "Red"}, {"label": "Blue"}])
    assert values == [opt(col, "Red"), None]  # no label match: cleared


def test_retype_text_to_select_with_too_many_values_is_400(cols, table, ref, admin, project):
    col = cols.add("Wide", "text")
    t = table(admin, ref)
    for i in range(201):
        t.update(t.add(f"r{i}")["id"], {col["key"]: f"v{i}"})
    res = cols.patch(col["key"], {"type": "select"})
    assert res.status_code == 400
    assert cols.schema()[col["key"]]["type"] == "text"  # nothing changed
    assert all(v for v in (custom(r["id"]).get(col["key"]) for r in t.rows()))


def test_retype_select_to_text_uses_labels(cols, table, ref, admin):
    t = table(admin, ref)
    col = cols.add("S", "select", options=[{"label": "Hello"}, {"label": "World"}])
    m = cols.add("M", "multiselect", options=[{"label": "a"}, {"label": "b"}])
    row = t.add("r")["id"]
    t.update(row, {col["key"]: opt(col, "Hello"), m["key"]: [opt(m, "a"), opt(m, "b")]})
    res = cols.patch(col["key"], {"type": "text"})
    assert res.status_code == 200 and "options" not in res.json()
    assert cols.patch(m["key"], {"type": "text"}).status_code == 200
    assert custom(row) == {col["key"]: "Hello", m["key"]: "a, b"}


def test_retype_anything_to_checkbox_is_non_empty(cols, table, ref, admin):
    _, values, _ = retype(cols, table(admin, ref), ref, "text", ["x", None, " "], "checkbox")
    assert values == [True, None, None]
    _, values, _ = retype(cols, table(admin, ref), ref, "number", [0, 4, None], "checkbox")
    assert values == [True, True, None]
    _, values, _ = retype(cols, table(admin, ref), ref, "date", ["2030-01-01", None], "checkbox")
    assert values == [True, None]


def test_retype_checkbox_to_text(cols, table, ref, admin):
    _, values, _ = retype(cols, table(admin, ref), ref, "checkbox", [True, False, None], "text")
    assert values == ["Yes", None, None]
    _, values, _ = retype(cols, table(admin, ref), ref, "checkbox", [True], "number")
    assert values == [None]


def test_retype_person_to_people_and_back(cols, table, ref, admin, member):
    uid = member["user"]["id"]
    t = table(admin, ref)
    col = cols.add("P", "person")
    row = t.add("r")["id"]
    t.update(row, {col["key"]: uid})
    assert cols.patch(col["key"], {"type": "people"}).status_code == 200
    assert custom(row) == {col["key"]: [uid]}
    assert cols.patch(col["key"], {"type": "person"}).status_code == 200
    assert custom(row) == {col["key"]: uid}
    assert cols.patch(col["key"], {"type": "text"}).status_code == 200
    assert custom(row) == {}


def test_retype_refreshes_memory_and_query(cols, table, ref, admin):
    t = table(admin, ref)
    col = cols.add("N", "text")
    row = t.add("r")["id"]
    t.update(row, {col["key"]: "42"})
    cols.patch(col["key"], {"type": "number"})
    assert t.rows()[0]["values"][col["key"]] == 42
    assert t.names({"filter": {"column": col["key"], "op": "gt", "value": 41}}) == ["r"]
    assert t.update(row, {col["key"]: "43"}).status_code == 400  # the new type applies to writes


def test_retype_only_touches_its_own_project(cols, table, ref, admin, make_project):
    col = cols.add("T", "text")
    other = table(admin, f"tasks:{make_project('Other')}").add("o")["id"]
    database.db_update_task(other, custom_fields={col["key"]: "stranger"})
    cols.patch(col["key"], {"type": "number"})
    assert custom(other) == {col["key"]: "stranger"}


# ---------------------------------------------------------------- delete

def test_deleting_a_column_removes_its_values(cols, table, ref, admin, api):
    a, b = cols.add("A", "text")["key"], cols.add("B", "number")["key"]
    t = table(admin, ref)
    r0, r1 = t.add("r0")["id"], t.add("r1")["id"]
    t.update(r0, {a: "x", b: 1})
    t.update(r1, {b: 2})
    assert cols.delete(a).status_code == 200
    assert custom(r0) == {b: 1} and custom(r1) == {b: 2}
    assert a not in cols.schema()
    assert a not in t.rows()[0]["values"]
    assert t.update(r0, {a: "again"}).status_code == 400
    assert cols.delete(a).status_code == 404
    assert cols.delete(b).status_code == 200
    assert custom(r0) == {} and custom(r1) == {}
    # a new column never inherits old values
    c = cols.add("A", "text")["key"]
    assert t.rows()[0]["values"][c] is None


# ---------------------------------------------------------------- live events

def test_schema_changed_events(client, cols, ref, project, admin, connect, make_user, grant):
    reviewer = make_user()
    grant(project, reviewer["user"]["id"], can_tasks=False)
    with connect(admin["token"], "writer") as writer, connect(admin["token"], "watcher") as watcher, \
            connect(reviewer["token"], "r") as without:
        watch(writer, project)
        watch(watcher, project)
        watch(without, project)
        h = {"X-Client-Id": "writer"}

        def call(method, path, body=None):
            return client.request(method, path, json=body, headers={**auth(admin["token"]), **h})

        col = call("POST", f"/api/tables/{ref}/columns", {"name": "E", "type": "text"}).json()
        assert watcher.receive_json() == {"type": "schema_changed", "tableRef": ref, "project": project}
        call("PATCH", f"/api/tables/{ref}/columns/{col['key']}", {"name": "E2"})
        assert watcher.receive_json()["type"] == "schema_changed"
        call("DELETE", f"/api/tables/{ref}/columns/{col['key']}")
        assert watcher.receive_json()["type"] == "schema_changed"
        assert nothing_pending(watcher)  # no rows changed: nothing had values
        assert nothing_pending(writer)  # never echoed to the originating tab
        assert nothing_pending(without)  # only people with task access


def test_delete_with_values_sends_rows_changed(cols, table, ref, project, admin, connect):
    c = cols.add("A", "text")["key"]
    row = table(admin, ref).add("r")["id"]
    table(admin, ref).update(row, {c: "x"})
    with connect(admin["token"], "watcher") as watcher:
        watch(watcher, project)
        cols.delete(c)
        assert watcher.receive_json()["type"] == "schema_changed"
        event = watcher.receive_json()
        assert event == {"type": "rows_changed", "tableRef": ref, "ids": [row], "change": "updated", "project": project}


def test_retype_sends_rows_changed_for_converted_rows(cols, table, ref, project, admin, connect):
    c = cols.add("A", "text")["key"]
    t = table(admin, ref)
    r0, r1 = t.add("r0")["id"], t.add("r1")["id"]
    t.update(r0, {c: "5"})
    with connect(admin["token"], "watcher") as watcher:
        watch(watcher, project)
        cols.patch(c, {"type": "number"})
        assert watcher.receive_json()["type"] == "schema_changed"
        event = watcher.receive_json()
        assert event["type"] == "rows_changed" and event["ids"] == [r0] and event["change"] == "updated"
        cols.patch(c, {"name": "Renamed"})
        assert watcher.receive_json()["type"] == "schema_changed"
        assert nothing_pending(watcher)
    del r1
