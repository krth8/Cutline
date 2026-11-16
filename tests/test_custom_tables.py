"""Custom tables (WP C1): table CRUD, permissions in both space kinds, rows, columns of every type
through filter / sort / group / summarise, retyping, live events and views on custom tables."""

import pytest

import database
from conftest import auth
from test_live import connect, nothing_pending, watch  # noqa: F401  (connect is a fixture)
from test_tables import api, table  # noqa: F401  (fixtures)


@pytest.fixture
def project(make_project):
    return make_project("Custom tables")


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
def viewer(make_user, grant, project):
    u = make_user("viewer")
    grant(project, u["user"]["id"], can_review=True, can_tasks=True)
    return u


@pytest.fixture
def reviewer(make_user, grant, project):
    """Access to the project but not to its tasks."""
    u = make_user()
    grant(project, u["user"]["id"], can_review=True, can_tasks=False)
    return u


@pytest.fixture
def outsider(make_user):
    return make_user()


@pytest.fixture
def make_table(api):
    def _make(user, space, name="Shots", columns=None):
        body = {"name": name, "space": space, **({"columns": columns} if columns is not None else {})}
        res = api("POST", "/api/tables", user, body)
        assert res.status_code == 200, res.text
        return res.json()
    return _make


@pytest.fixture
def ref(make_table, admin, project):
    return make_table(admin, f"p:{project}")["ref"]


@pytest.fixture
def cols(api, admin, ref):
    """cols.add(name, type, **extra) -> Column; cols.patch / cols.delete -> responses."""
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

        def schema(self, user=None):
            res = api("GET", f"/api/tables/{ref}/schema", user or admin)
            return {c["key"]: c for c in res.json()["columns"]}
    return Cols()


def opt(column, label):
    return next(o["value"] for o in column["options"] if o["label"] == label)


def stored_values(table_id, row_id):
    return database.custom_tables.db_get_custom_row(table_id, row_id)["values"]


# ---------------------------------------------------------------- table CRUD

def test_create_table_in_a_project_returns_the_ref(api, member, project):
    res = api("POST", "/api/tables", member, {"name": "  Shots  ", "space": f"p:{project}"})
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["ref"] == body["id"] and body["ref"].startswith("tbl_")
    assert body["name"] == "Shots" and body["space"] == f"p:{project}"
    assert body["spaceType"] == "project" and body["projectId"] == project
    assert body["canEdit"] is True and body["canEditSchema"] is False  # a member edits rows, not columns


def test_create_table_with_starter_columns(api, make_table, admin, project):
    created = make_table(admin, f"p:{project}", columns=[
        {"name": "Notes", "type": "text"},
        {"name": "Kind", "type": "select", "options": [{"label": "A"}, {"label": "B"}]},
    ])
    schema = api("GET", f"/api/tables/{created['ref']}/schema", admin).json()
    assert [c["name"] for c in schema["columns"]] == ["Name", "Notes", "Kind", "Created", "Created by"]
    assert [o["label"] for o in schema["columns"][2]["options"]] == ["A", "B"]


@pytest.mark.parametrize("body", [
    {"space": "me"}, {"name": "", "space": "me"}, {"name": "  ", "space": "me"}, {"name": 5, "space": "me"},
    {"name": "x", "space": "nowhere"}, {"name": "x"}, {"name": "x", "space": "p:"},
    {"name": "x", "space": "me", "columns": "no"},
    {"name": "x", "space": "me", "columns": [{"name": "A", "type": "status"}]},
])
def test_invalid_create_requests_are_400(api, admin, body):
    res = api("POST", "/api/tables", admin, body)
    assert res.status_code == 400, res.text


def test_duplicate_or_reserved_starter_column_names_are_409(api, admin):
    for columns in ([{"name": "A", "type": "text"}, {"name": "a", "type": "text"}], [{"name": "Name", "type": "text"}]):
        assert api("POST", "/api/tables", admin, {"name": "x", "space": "me", "columns": columns}).status_code == 409


def test_create_in_an_unknown_project_is_404(api, admin):
    assert api("POST", "/api/tables", admin, {"name": "x", "space": "p:nope"}).status_code == 404


def test_who_may_create_a_project_table(api, project, viewer, reviewer, outsider, share, owner, admin):
    body = {"name": "T", "space": f"p:{project}"}
    for user in (owner, admin):
        assert api("POST", "/api/tables", user, body).status_code == 200
    for user in (viewer, reviewer, outsider):
        assert api("POST", "/api/tables", user, body).status_code == 403
    assert api("POST", "/api/tables", share(project), body).status_code == 403
    assert api("POST", "/api/tables", None, body).status_code == 401


def test_list_tables_of_a_space(api, make_table, admin, member, viewer, reviewer, outsider, project, share):
    a = make_table(admin, f"p:{project}", "A")
    b = make_table(admin, f"p:{project}", "B")
    mine = make_table(member, "me", "Mine")
    res = api("GET", f"/api/tables?space=p:{project}", member)
    assert res.status_code == 200
    # Two tables made in the same clock tick have no defined order between them
    assert sorted(t["name"] for t in res.json()["tables"]) == ["A", "B"]
    assert {t["ref"] for t in res.json()["tables"]} == {a["ref"], b["ref"]}
    assert api("GET", f"/api/tables?space=p:{project}", viewer).status_code == 200
    assert api("GET", f"/api/tables?space=p:{project}", reviewer).status_code == 403
    assert api("GET", f"/api/tables?space=p:{project}", outsider).status_code == 403
    assert api("GET", f"/api/tables?space=p:{project}", share(project)).status_code == 403
    assert api("GET", "/api/tables?space=p:nope", admin).status_code == 404
    assert api("GET", "/api/tables?space=zzz", admin).status_code == 400
    # the personal list is the caller's own
    assert [t["ref"] for t in api("GET", "/api/tables?space=me", member).json()["tables"]] == [mine["ref"]]
    assert api("GET", "/api/tables?space=me", admin).json()["tables"] == []


def test_table_info_counts_what_deleting_would_remove(api, ref, admin, table):
    table(admin, ref).add("r1")
    table(admin, ref).add("r2")
    api("POST", "/api/views", admin, {"tableRef": ref, "layout": "table"})
    info = api("GET", f"/api/tables/{ref}", admin).json()
    assert info["rowCount"] == 2 and info["viewCount"] == 1 and info["name"] == "Shots"
    assert api("GET", "/api/tables/tasks:x", admin).status_code == 404  # only custom tables have info


def test_rename_and_delete_need_the_schema_right(api, ref, owner, member, viewer, outsider, reviewer, admin, share, project):
    for user in (member, viewer):
        assert api("PATCH", f"/api/tables/{ref}", user, {"name": "No"}).status_code == 403
        assert api("DELETE", f"/api/tables/{ref}", user).status_code == 403
    for user in (outsider, reviewer):
        assert api("PATCH", f"/api/tables/{ref}", user, {"name": "No"}).status_code == 403
        assert api("DELETE", f"/api/tables/{ref}", user).status_code == 403
    assert api("PATCH", f"/api/tables/{ref}", share(project), {"name": "No"}).status_code == 403
    assert api("PATCH", f"/api/tables/{ref}", None, {"name": "No"}).status_code == 401
    assert api("PATCH", f"/api/tables/{ref}", owner, {"name": "  Renamed "}).json()["name"] == "Renamed"
    assert api("PATCH", f"/api/tables/{ref}", owner, {"name": ""}).status_code == 400
    assert api("GET", f"/api/tables/{ref}/schema", admin).json()["name"] == "Renamed"
    assert api("DELETE", f"/api/tables/{ref}", owner).json()["success"] is True
    assert api("GET", f"/api/tables/{ref}/schema", admin).status_code == 404
    assert api("DELETE", f"/api/tables/{ref}", admin).status_code == 404


def test_deleting_a_table_removes_rows_columns_and_views(api, ref, admin, table, cols):
    col = cols.add("Cost", "number")
    row = table(admin, ref).add("r")
    view = api("POST", "/api/views", admin, {"tableRef": ref, "layout": "board"}).json()
    other = api("POST", "/api/views", admin, {"tableRef": "tasks:*", "layout": "table"}).json()
    res = api("DELETE", f"/api/tables/{ref}", admin)
    assert res.json() == {"success": True, "deletedViews": 1}
    assert database.custom_tables.db_get_custom_row(ref, row["id"]) is None
    assert database.custom_tables.db_list_custom_rows(ref) == []
    assert database.table_columns.db_list_table_columns(ref) == []
    assert api("GET", f"/api/views/{view['id']}", admin).status_code == 404
    assert api("GET", f"/api/views/{other['id']}", admin).status_code == 200  # other views stay
    assert col["key"].startswith("cf_")


def test_deleting_the_project_removes_its_tables(api, make_project, make_table, admin):
    pid = make_project("Doomed")
    ref = make_table(admin, f"p:{pid}")["ref"]
    assert api("DELETE", f"/api/projects/{pid}", admin).status_code == 200
    assert database.custom_tables.db_get_custom_table(ref) is None


def test_non_custom_refs_have_no_table_endpoints(api, admin, project):
    assert api("PATCH", f"/api/tables/tasks:{project}", admin, {"name": "x"}).status_code == 404
    assert api("DELETE", f"/api/tables/tasks:{project}", admin).status_code == 404
    assert api("GET", "/api/tables/tbl_nothere/schema", admin).status_code == 404


# ---------------------------------------------------------------- permissions: project tables

def test_project_table_read_and_edit_rules(table, api, ref, owner, member, viewer, reviewer, outsider, admin, share, project):
    row = table(member, ref).add("by member")
    for user in (owner, member, viewer, admin):
        assert table(user, ref).schema().status_code == 200
        assert [r["id"] for r in table(user, ref).rows()] == [row["id"]]
        assert api("GET", f"/api/tables/{ref}/rows/{row['id']}", user).status_code == 200
    # editing needs the page / task right: not for viewers
    for user in (owner, member, admin):
        assert table(user, ref).update(row["id"], {"name": "x"}).status_code == 200
    assert table(viewer, ref).update(row["id"], {"name": "no"}).status_code == 403
    assert table(viewer, ref).create({"name": "no"}).status_code == 403
    assert table(viewer, ref).delete(row["id"]).status_code == 403
    assert table(viewer, ref).reorder([row["id"]]).status_code == 403
    assert table(viewer, ref).rows()[0]["canEdit"] is False
    # no task access on the project / no access: nothing
    guest = share(project)
    for user in (reviewer, outsider, guest):
        assert table(user, ref).schema().status_code == 403
        assert table(user, ref).query().status_code == 403
        assert table(user, ref).create({"name": "no"}).status_code == 403
        assert api("GET", f"/api/tables/{ref}/rows/{row['id']}", user).status_code == 403
    assert api("POST", f"/api/tables/{ref}/query", None, {}).status_code == 401


def test_schema_capabilities_follow_the_rules(table, ref, owner, member, viewer, admin):
    caps = lambda u: table(u, ref).schema().json()["capabilities"]  # noqa: E731
    assert caps(owner) == {"create": True, "delete": True, "hierarchy": False, "editSchema": True}
    assert caps(admin)["editSchema"] is True
    assert caps(member) == {"create": True, "delete": True, "hierarchy": False, "editSchema": False}
    assert caps(viewer) == {"create": False, "delete": False, "hierarchy": False, "editSchema": False}


def test_schema_shape_and_space(table, ref, admin, project):
    schema = table(admin, ref).schema().json()
    assert schema["ref"] == ref and schema["titleColumn"] == "name"
    assert schema["space"] == {"type": "project", "projectId": project}
    keys = [c["key"] for c in schema["columns"]]
    assert keys == ["name", "createdAt", "createdBy"]
    by_key = {c["key"]: c for c in schema["columns"]}
    assert by_key["name"] == {"key": "name", "name": "Name", "type": "text", "builtin": True}
    assert by_key["createdAt"]["readonly"] and by_key["createdBy"]["readonly"]


def test_column_changes_are_for_owner_and_admin(cols, owner, admin, member, viewer, outsider, reviewer, share, project):
    col = cols.add("Owned", "text", user=owner)
    assert cols.patch(col["key"], {"name": "Owned2"}, user=owner).status_code == 200
    assert cols.delete(col["key"], user=owner).status_code == 200
    assert cols.post({"name": "Admin", "type": "text"}, user=admin).status_code == 200
    keep = cols.add("Guarded", "text")
    for user in (member, viewer, outsider, reviewer, share(project)):
        assert cols.post({"name": "No", "type": "text"}, user=user).status_code == 403
        assert cols.patch(keep["key"], {"name": "No"}, user=user).status_code == 403
        assert cols.delete(keep["key"], user=user).status_code == 403
    assert cols.schema()[keep["key"]]["name"] == "Guarded"


def test_builtin_columns_are_fixed(cols):
    for key in ("name", "createdAt", "createdBy"):
        assert cols.patch(key, {"name": "Z"}).status_code == 400
        assert cols.patch(key, {"type": "number"}).status_code == 400
        assert cols.delete(key).status_code == 400
    assert cols.patch("cf_nope", {"name": "Z"}).status_code == 404
    for name in ("Name", "created", "Created By"):
        assert cols.post({"name": name, "type": "text"}).status_code == 409
    # the names of the task columns are free in a custom table
    assert cols.add("Status", "text")["name"] == "Status"


def test_status_priority_and_clip_columns_are_not_offered(cols):
    for t in ("status", "priority", "clip", "relation", "formula"):
        assert cols.post({"name": "X", "type": t}).status_code == 400


# ---------------------------------------------------------------- permissions: personal tables

def test_personal_table_is_private_to_its_owner_even_from_admins(api, table, make_table, member, outsider, admin, share, project):
    mine = make_table(member, "me", "Private")
    ref = mine["ref"]
    assert mine["space"] == "me" and mine["spaceType"] == "personal" and mine["projectId"] is None
    assert mine["canEdit"] and mine["canEditSchema"]
    row = table(member, ref).add("secret")
    assert table(member, ref).schema().json()["space"] == {"type": "personal"}
    assert table(member, ref).schema().json()["capabilities"]["editSchema"] is True
    for user in (outsider, admin, share(project)):
        assert table(user, ref).schema().status_code in (403, 404)
        assert table(user, ref).query().status_code in (403, 404)
        assert table(user, ref).create({"name": "x"}).status_code in (403, 404)
        assert table(user, ref).update(row["id"], {"name": "x"}).status_code in (403, 404)
        assert table(user, ref).delete(row["id"]).status_code in (403, 404)
        assert api("POST", f"/api/tables/{ref}/columns", user, {"name": "X", "type": "text"}).status_code in (403, 404)
        assert api("PATCH", f"/api/tables/{ref}", user, {"name": "x"}).status_code in (403, 404)
        assert api("DELETE", f"/api/tables/{ref}", user).status_code in (403, 404)
        assert api("GET", f"/api/tables/{ref}", user).status_code in (403, 404)
    # a stranger cannot even tell the table exists
    assert table(outsider, ref).query().status_code == table(outsider, "tbl_missing").query().status_code == 404
    assert table(admin, ref).query().status_code == 404
    assert [r["values"]["name"] for r in table(member, ref).rows()] == ["secret"]


def test_personal_table_columns_and_person_values(api, make_table, member, outsider):
    ref = make_table(member, "me")["ref"]
    col = api("POST", f"/api/tables/{ref}/columns", member, {"name": "Who", "type": "person"}).json()
    row = api("POST", f"/api/tables/{ref}/rows", member, {"values": {"name": "r"}}).json()
    patch = lambda uid: api("PATCH", f"/api/tables/{ref}/rows/{row['id']}", member, {"values": {col["key"]: uid}})  # noqa: E731
    assert patch(member["user"]["id"]).status_code == 200
    assert patch(outsider["user"]["id"]).status_code == 400  # only the owner is a person of a personal table
    schema = api("GET", f"/api/tables/{ref}/schema", member).json()
    assert [o["value"] for o in schema["columns"][1]["options"]] == [member["user"]["id"]]


def test_views_on_custom_tables_follow_the_table(api, make_table, ref, owner, member, viewer, outsider, reviewer, admin, share, project):
    made = api("POST", "/api/views", member, {"tableRef": ref, "name": "V", "layout": "table"})
    assert made.status_code == 200, made.text
    vid = made.json()["id"]
    assert made.json()["canEdit"] is True
    assert api("GET", f"/api/views/{vid}", viewer).json()["canEdit"] is False
    assert api("PATCH", f"/api/views/{vid}", viewer, {"name": "x"}).status_code == 403
    assert api("PATCH", f"/api/views/{vid}", owner, {"name": "x"}).status_code == 200
    for user in (outsider, reviewer, share(project)):
        assert api("GET", f"/api/views/{vid}", user).status_code == 403
        assert api("POST", "/api/views", user, {"tableRef": ref, "layout": "table"}).status_code in (401, 403, 404)
    # the picker list only shows views whose table the caller may read
    listed = lambda u: [v["id"] for v in api("GET", "/api/views", u).json()["views"]]  # noqa: E731
    assert vid in listed(viewer) and vid not in listed(reviewer) and vid not in listed(outsider)
    assert api("DELETE", f"/api/views/{vid}", viewer).status_code == 403
    assert api("DELETE", f"/api/views/{vid}", member).status_code == 200


def test_views_on_a_personal_table_are_private(api, make_table, member, outsider, admin):
    ref = make_table(member, "me")["ref"]
    vid = api("POST", "/api/views", member, {"tableRef": ref, "layout": "table"}).json()["id"]
    for user in (outsider, admin):
        assert api("GET", f"/api/views/{vid}", user).status_code == 403
        assert api("PATCH", f"/api/views/{vid}", user, {"name": "x"}).status_code == 403
        assert api("POST", "/api/views", user, {"tableRef": ref, "layout": "table"}).status_code == 404
        assert vid not in [v["id"] for v in api("GET", "/api/views", user).json()["views"]]
    assert vid in [v["id"] for v in api("GET", "/api/views", member).json()["views"]]


def test_a_view_owned_by_a_page_cannot_point_at_an_unreadable_table(api, make_table, member, outsider, make_project, admin):
    page = api("POST", "/api/spaces/me/pages", outsider, {"title": "P"}).json()
    ref = make_table(member, "me")["ref"]
    res = api("POST", "/api/views", outsider, {"tableRef": ref, "layout": "table", "ownerPageId": page["id"]})
    assert res.status_code == 404


# ---------------------------------------------------------------- rows

def test_create_update_delete_rows(table, ref, member, admin):
    t = table(member, ref)
    row = t.add("first")
    assert row["tableRef"] == ref and row["canEdit"] is True and row.get("parentId") is None
    assert row["values"]["name"] == "first"
    assert row["values"]["createdBy"] == member["user"]["id"] and row["values"]["createdAt"]
    assert t.update(row["id"], {"name": "renamed"}).json()["values"]["name"] == "renamed"
    assert stored_values(ref, row["id"]) == {"name": "renamed"}
    assert table(admin, ref).update(row["id"], {"name": "by admin"}).status_code == 200
    assert t.rows()[0]["values"]["createdBy"] == member["user"]["id"]  # editing does not change the author
    assert t.delete(row["id"]).status_code == 200
    assert t.rows() == []
    assert t.delete(row["id"]).status_code == 404
    assert t.update(row["id"], {"name": "x"}).status_code == 404
    assert t.update("nope", {"name": "x"}).status_code == 404


def test_row_values_are_validated(table, ref, admin, cols):
    c = cols.add("N", "number")["key"]
    t = table(admin, ref)
    row = t.add("r")
    for bad in ({"createdAt": "2030-01-01"}, {"createdBy": "x"}, {"nope": 1}, {"name": 5}, {"name": ["a"]},
                {c: "text"}, {"cf_unknown": 1}):
        assert t.update(row["id"], bad).status_code == 400, bad
    assert t.update(row["id"], {"name": None}).json()["values"]["name"] == ""
    assert t.create({"name": "x" * 10_001}).status_code == 400
    assert t.create("nope").status_code in (400, 422)
    assert t.create({}).json()["values"]["name"] == ""  # a row can start without a name


def test_a_row_cannot_have_a_parent(table, ref, admin, api):
    t = table(admin, ref)
    row = t.add("r")
    assert t.create({"name": "child"}, parentId=row["id"]).status_code == 400
    assert api("PATCH", f"/api/tables/{ref}/rows/{row['id']}", admin, {"parentId": row["id"]}).status_code == 400
    assert api("PATCH", f"/api/tables/{ref}/rows/{row['id']}", admin, {"parentId": None, "values": {}}).status_code == 200
    assert table(admin, ref).schema().json()["capabilities"]["hierarchy"] is False


def test_rows_stay_in_creation_order_and_can_be_reordered(table, ref, admin):
    t = table(admin, ref)
    a, b, c = (t.add(n)["id"] for n in "abc")
    assert t.names() == ["a", "b", "c"]
    assert t.reorder([c], before=a).status_code == 200
    assert t.names() == ["c", "a", "b"]
    assert t.reorder([a, c]).status_code == 200  # no `before`: to the end
    assert t.names() == ["b", "a", "c"]
    assert t.reorder([b, c], before=a).status_code == 200
    assert t.names() == ["b", "c", "a"]
    assert t.reorder([a], before=a).status_code == 400
    assert t.reorder([a], before="zzz").status_code == 400
    assert t.reorder(["zzz"]).status_code == 404
    assert t.reorder([]).status_code == 400
    assert t.add("d")["id"] in [r["id"] for r in t.rows()][-1:]  # new rows go last


def test_query_the_title_column(table, ref, admin):
    t = table(admin, ref)
    for n in ("Zebra", "apple", "Mango"):
        t.add(n)
    assert t.names({"sort": [{"column": "name", "dir": "asc"}]}) == ["apple", "Mango", "Zebra"]
    assert t.names({"filter": {"column": "name", "op": "contains", "value": "an"}}) == ["Mango"]
    assert t.names({"search": "zeb"}) == ["Zebra"]
    assert t.names({"limit": 2, "offset": 1}) == ["apple", "Mango"]
    assert t.query({"limit": 2}).json()["total"] == 3
    assert t.query({"filter": {"column": "nope", "op": "eq", "value": 1}}).status_code == 400
    assert t.query({"summaries": {"name": "count"}}).json()["summaries"] == {"name": 3}


# ---------------------------------------------------------------- columns of every type

def _spec(kind, ctx):
    """For one column type: options to create it with, two values A and B, and what the engine must answer."""
    m, o = ctx["member"], ctx["owner"]
    pick = lambda col, label: next(x["value"] for x in col["options"] if x["label"] == label)  # noqa: E731
    return {
        "text": dict(a="alpha", b="beta", flt=("contains", "alp", ["A"]), asc=["A", "B"],
                     groups={"alpha": 1, "beta": 1}, summary=("countFilled", 2)),
        "longtext": dict(a="one\nline", b="two", flt=("contains", "line", ["A"]), asc=["A", "B"],
                         groups=None, summary=("countFilled", 2)),
        "url": dict(a="https://a.example", b="https://b.example", flt=("contains", "b.example", ["B"]), asc=["A", "B"],
                    groups={"https://a.example": 1, "https://b.example": 1}, summary=("countEmpty", 1)),
        "number": dict(a=1, b=5.5, flt=("gt", 2, ["B"]), asc=["A", "B"], groups={"1": 1, "5.5": 1},
                       summary=("sum", 6.5)),
        "checkbox": dict(a=True, b=False, flt=("eq", True, ["A"]), asc=None, groups=None,
                         summary=("percentChecked", 33.3)),
        "date": dict(a="2030-01-01", b="2030-02-01", flt=("after", "2030-01-15", ["B"]), asc=["A", "B"],
                     groups={"2030-01-01": 1, "2030-02-01": 1}, summary=("max", "2030-02-01")),
        "select": dict(opts=[{"label": "Red"}, {"label": "Blue"}], a=lambda c: pick(c, "Red"),
                       b=lambda c: pick(c, "Blue"), flt=("eq", lambda c: pick(c, "Red"), ["A"]), asc=None,
                       groups={"Red": 1, "Blue": 1}, summary=("countFilled", 2)),
        "multiselect": dict(opts=[{"label": "x"}, {"label": "y"}], a=lambda c: [pick(c, "x"), pick(c, "y")],
                            b=lambda c: [pick(c, "y")], flt=("contains", lambda c: pick(c, "x"), ["A"]), asc=None,
                            groups={"x": 1, "y": 2}, summary=("countFilled", 2)),
        "person": dict(a=m["user"]["id"], b=o["user"]["id"], flt=("eq", m["user"]["id"], ["A"]), asc=None,
                       groups={m["user"]["username"]: 1, o["user"]["username"]: 1}, summary=("countFilled", 2)),
        "people": dict(a=[m["user"]["id"]], b=[o["user"]["id"], m["user"]["id"]],
                       flt=("contains", o["user"]["id"], ["B"]), asc=None,
                       groups={m["user"]["username"]: 2, o["user"]["username"]: 1}, summary=("countFilled", 2)),
    }[kind]


TYPES = ["text", "longtext", "url", "number", "checkbox", "date", "select", "multiselect", "person", "people"]


@pytest.mark.parametrize("kind", TYPES)
def test_column_type_through_create_filter_sort_group_summarise(kind, cols, table, ref, admin, member, owner):
    spec = _spec(kind, {"member": member, "owner": owner})
    extra = {"options": spec["opts"]} if "opts" in spec else {}
    col = cols.add("Col", kind, **extra)
    key = col["key"]
    resolve = lambda v: v(col) if callable(v) else v  # noqa: E731
    t = table(admin, ref)
    a = t.create({"name": "A", key: resolve(spec["a"])})
    assert a.status_code == 200, a.text
    b = t.create({"name": "B", key: resolve(spec["b"])})
    assert b.status_code == 200, b.text
    t.add("C")  # empty
    assert stored_values(ref, a.json()["id"])[key] == resolve(spec["a"])  # stored under the column key

    by_name = {r["values"]["name"]: r["values"][key] for r in t.rows()}
    assert by_name["A"] == resolve(spec["a"]) and by_name["B"] == resolve(spec["b"])
    assert by_name["C"] == {"checkbox": False, "multiselect": [], "people": []}.get(kind)  # the empty value

    # filter
    op, value, expected = spec["flt"]
    names = t.names({"filter": {"column": key, "op": op, "value": resolve(value)}})
    assert names == expected
    if kind == "checkbox":  # a checkbox has no "empty": unchecked is False
        assert sorted(t.names({"filter": {"column": key, "op": "neq", "value": True}})) == ["B", "C"]
    else:
        assert t.names({"filter": {"column": key, "op": "empty"}}) == ["C"]
        assert sorted(t.names({"filter": {"column": key, "op": "notEmpty"}})) == ["A", "B"]

    # sort (among the filled rows; multi-value and person columns sort by label, not asserted here)
    if spec["asc"]:
        asc = t.names({"filter": {"column": key, "op": "notEmpty"}, "sort": [{"column": key, "dir": "asc"}]})
        assert asc == [{"A": "A", "B": "B"}[x] for x in spec["asc"]]
        desc = t.names({"filter": {"column": key, "op": "notEmpty"}, "sort": [{"column": key, "dir": "desc"}]})
        assert desc == list(reversed(asc))
    else:
        assert t.query({"sort": [{"column": key, "dir": "asc"}]}).status_code == 200

    # group
    res = t.query({"groupBy": key})
    if spec["groups"] is None:
        assert res.status_code in (200, 400)  # long text cannot be grouped
        if kind == "longtext":
            assert res.status_code == 400
    else:
        assert res.status_code == 200, res.text
        got = {g["label"]: g["count"] for g in res.json()["groups"] if g["key"] is not None}
        if kind in ("select", "multiselect", "person", "people"):
            assert got == spec["groups"]
        elif kind == "checkbox":
            assert sum(got.values()) == 3
        else:
            assert {str(k): v for k, v in got.items()} == {str(k): v for k, v in spec["groups"].items()}

    # summarise
    fn, expected = spec["summary"]
    summary = t.query({"summaries": {key: fn}}).json()["summaries"][key]
    assert summary == pytest.approx(expected, abs=0.1) if isinstance(expected, float) else summary == expected


def test_invalid_values_per_type(cols, table, ref, admin, outsider):
    t = table(admin, ref)
    row = t.add("r")
    number, text, check = cols.add("N", "number")["key"], cols.add("T", "text")["key"], cols.add("C", "checkbox")["key"]
    date, url = cols.add("D", "date")["key"], cols.add("U", "url")["key"]
    sel = cols.add("S", "select", options=[{"label": "a"}])
    multi = cols.add("M", "multiselect", options=[{"label": "a"}])
    person, people = cols.add("P", "person")["key"], cols.add("Ps", "people")["key"]
    bad = [
        {number: "5"}, {number: True}, {text: 5}, {text: "x" * 10_001}, {check: "yes"}, {date: "2030-02-30"},
        {date: "2030-01-31T10:00:00"}, {url: "x" * 2001}, {sel["key"]: "a"}, {sel["key"]: ["x"]},
        {multi["key"]: "a"}, {multi["key"]: ["zzz"]}, {person: outsider["user"]["id"]}, {person: "nobody"},
        {people: [outsider["user"]["id"]]}, {people: "x"},
    ]
    for body in bad:
        assert t.update(row["id"], body).status_code == 400, body
    # empty values are not stored
    assert t.update(row["id"], {text: "x"}).status_code == 200
    assert t.update(row["id"], {text: ""}).json()["values"][text] is None
    assert t.update(row["id"], {check: True}).json()["values"][check] is True
    assert t.update(row["id"], {check: False}).json()["values"][check] is False
    assert stored_values(ref, row["id"]) == {"name": "r"}
    assert t.update(row["id"], {sel["key"]: opt(sel, "a")}).status_code == 200


def test_update_keeps_other_values(cols, table, ref, admin):
    a, b = cols.add("A", "text")["key"], cols.add("B", "number")["key"]
    t = table(admin, ref)
    row = t.add("r")
    t.update(row["id"], {a: "x"})
    t.update(row["id"], {b: 2, "name": "renamed"})
    assert stored_values(ref, row["id"]) == {"name": "renamed", a: "x", b: 2}


def test_select_options_get_server_ids(cols):
    col = cols.add("Kind", "select", options=[{"label": "A", "color": "#111111"}, {"label": "B", "value": "mine"}])
    assert [o["label"] for o in col["options"]] == ["A", "B"]
    assert all(o["value"].startswith("o_") for o in col["options"])


def test_people_columns_offer_the_members(cols, member, owner, reviewer, outsider):
    col = cols.add("P", "person")
    values = {o["value"] for o in cols.schema()[col["key"]]["options"]}
    assert member["user"]["id"] in values and owner["user"]["id"] in values
    assert reviewer["user"]["id"] not in values and outsider["user"]["id"] not in values


# ---------------------------------------------------------------- retype, reorder, delete

def test_retype_converts_values(cols, table, ref, admin):
    col = cols.add("V", "text")
    key = col["key"]
    t = table(admin, ref)
    ids = {}
    for name, value in (("n1", "12"), ("n2", "3,5"), ("n3", "words"), ("n4", None)):
        ids[name] = t.create({"name": name, **({key: value} if value else {})}).json()["id"]
    res = cols.patch(key, {"type": "number"})
    assert res.status_code == 200 and res.json()["type"] == "number"
    assert stored_values(ref, ids["n1"])[key] == 12
    assert stored_values(ref, ids["n2"])[key] == 3.5
    assert key not in stored_values(ref, ids["n3"])  # not a number: cleared
    # text -> select makes options out of the distinct values
    cols.patch(key, {"type": "text"})
    t.update(ids["n3"], {key: "Red"})
    t.update(ids["n4"], {key: "red"})
    res = cols.patch(key, {"type": "select"})
    assert [o["label"] for o in res.json()["options"]] == ["12", "3.5", "Red"] or len(res.json()["options"]) >= 3
    rows = {r["id"]: r["values"][key] for r in t.rows()}
    assert rows[ids["n3"]] == rows[ids["n4"]]  # the same option for "Red" and "red"
    # to checkbox: anything filled is checked
    cols.patch(key, {"type": "checkbox"})
    assert t.rows()[0]["values"][key] is True
    assert cols.patch(key, {"type": "status"}).status_code == 400


def test_changing_options_clears_removed_ones(cols, table, ref, admin):
    col = cols.add("K", "select", options=[{"label": "a"}, {"label": "b"}])
    a, b = opt(col, "a"), opt(col, "b")
    t = table(admin, ref)
    r1, r2 = t.create({"name": "1", col["key"]: a}).json()["id"], t.create({"name": "2", col["key"]: b}).json()["id"]
    res = cols.patch(col["key"], {"options": [{"label": "a2", "value": a}]})
    assert res.status_code == 200
    rows = {r["id"]: r["values"][col["key"]] for r in t.rows()}
    assert rows == {r1: a, r2: None}


def test_column_order_follows_sort_order(cols, table, admin, ref):
    a, b = cols.add("A", "text"), cols.add("B", "number")
    assert cols.patch(b["key"], {"sortOrder": -5, "name": "B2"}).status_code == 200
    keys = [c["key"] for c in table(admin, ref).schema().json()["columns"]]
    assert keys == ["name", b["key"], a["key"], "createdAt", "createdBy"]


def test_delete_column_removes_its_values(cols, table, ref, admin):
    a, b = cols.add("A", "text")["key"], cols.add("B", "number")["key"]
    t = table(admin, ref)
    row = t.create({"name": "r", a: "x", b: 1}).json()
    assert cols.delete(a).status_code == 200
    assert stored_values(ref, row["id"]) == {"name": "r", b: 1}
    assert a not in cols.schema()
    assert t.update(row["id"], {a: "again"}).status_code == 400
    assert cols.delete(a).status_code == 404


def test_columns_of_two_tables_are_separate(api, make_table, admin, project, cols, ref):
    other = make_table(admin, f"p:{project}", "Other")["ref"]
    cols.add("Mine", "text")
    assert [c["name"] for c in api("GET", f"/api/tables/{other}/schema", admin).json()["columns"]] == \
        ["Name", "Created", "Created by"]


def test_tasks_tables_are_unaffected(api, admin, project, cols):
    cols.add("OnlyCustom", "text")
    schema = api("GET", f"/api/tables/tasks:{project}/schema", admin).json()
    assert "OnlyCustom" not in [c["name"] for c in schema["columns"]]
    assert "space" not in schema


# ---------------------------------------------------------------- live events

def test_row_events_reach_project_watchers_but_not_the_origin(table, ref, project, admin, member, outsider, reviewer, connect, api):
    with connect(admin["token"], "writer") as writer, connect(member["token"], "watcher") as watcher, \
            connect(reviewer["token"], "norights") as without, connect(outsider["token"], "away") as away:
        assert watch(writer, project) == [project]
        assert watch(watcher, project) == [project]
        assert watch(without, project) == [project]  # watches the project, but has no task access
        headers = {"X-Client-Id": "writer"}
        res = api("POST", f"/api/tables/{ref}/rows", admin, {"values": {"name": "r"}}, headers=headers)
        row_id = res.json()["id"]
        event = watcher.receive_json()
        assert event == {"type": "rows_changed", "tableRef": ref, "ids": [row_id], "change": "created", "project": project}
        api("PATCH", f"/api/tables/{ref}/rows/{row_id}", admin, {"values": {"name": "x"}}, headers=headers)
        assert watcher.receive_json()["change"] == "updated"
        api("POST", f"/api/tables/{ref}/rows/reorder", admin, {"ids": [row_id]}, headers=headers)
        assert watcher.receive_json()["change"] == "reordered"
        api("DELETE", f"/api/tables/{ref}/rows/{row_id}", admin, headers=headers)
        assert watcher.receive_json()["change"] == "deleted"
        for ws in (writer, without, away):
            assert nothing_pending(ws)


def test_schema_events_for_columns_rename_and_delete(api, ref, project, admin, member, reviewer, connect, table):
    with connect(admin["token"], "writer") as writer, connect(member["token"], "watcher") as watcher, \
            connect(reviewer["token"], "norights") as without:
        for ws in (writer, watcher, without):
            watch(ws, project)
        headers = {"X-Client-Id": "writer"}
        col = api("POST", f"/api/tables/{ref}/columns", admin, {"name": "A", "type": "text"}, headers=headers).json()
        assert watcher.receive_json() == {"type": "schema_changed", "tableRef": ref, "project": project}
        row = api("POST", f"/api/tables/{ref}/rows", admin, {"values": {"name": "r"}}, headers=headers).json()
        assert watcher.receive_json()["type"] == "rows_changed"
        api("PATCH", f"/api/tables/{ref}/rows/{row['id']}", admin, {"values": {col["key"]: "v"}}, headers=headers)
        assert watcher.receive_json()["type"] == "rows_changed"
        # deleting a column that has values: schema and the changed rows
        api("DELETE", f"/api/tables/{ref}/columns/{col['key']}", admin, headers=headers)
        assert watcher.receive_json()["type"] == "schema_changed"
        assert watcher.receive_json() == {"type": "rows_changed", "tableRef": ref, "ids": [row["id"]],
                                          "change": "updated", "project": project}
        api("PATCH", f"/api/tables/{ref}", admin, {"name": "New name"}, headers=headers)
        assert watcher.receive_json()["type"] == "schema_changed"
        for ws in (writer, without):
            assert nothing_pending(ws)


def test_deleting_a_table_tells_its_viewers(api, ref, project, admin, member, connect):
    vid = api("POST", "/api/views", admin, {"tableRef": ref, "layout": "table"}).json()["id"]
    with connect(member["token"], "watcher") as watcher:
        watch(watcher, project)
        api("DELETE", f"/api/tables/{ref}", admin, headers={"X-Client-Id": "writer"})
        seen = [watcher.receive_json(), watcher.receive_json()]
        assert {"type": "schema_changed", "tableRef": ref, "project": project} in seen
        assert {"type": "view_changed", "viewId": vid, "project": project} in seen


def test_personal_table_events_go_to_the_owner_tabs_only(api, make_table, member, admin, connect, table, project):
    ref = make_table(member, "me")["ref"]
    with connect(member["token"], "writer") as writer, connect(member["token"], "second") as second, \
            connect(admin["token"], "admin") as other:
        watch(other, project)  # watching a project does not matter for a personal table
        headers = {"X-Client-Id": "writer"}
        res = api("POST", f"/api/tables/{ref}/rows", member, {"values": {"name": "r"}}, headers=headers)
        event = second.receive_json()
        assert event == {"type": "rows_changed", "tableRef": ref, "ids": [res.json()["id"]], "change": "created",
                         "project": None}
        api("POST", f"/api/tables/{ref}/columns", member, {"name": "A", "type": "text"}, headers=headers)
        assert second.receive_json() == {"type": "schema_changed", "tableRef": ref, "project": None}
        assert nothing_pending(writer) and nothing_pending(other)


def test_events_are_not_sent_for_rejected_changes(api, ref, project, viewer, admin, connect, table):
    with connect(admin["token"], "watcher") as watcher:
        watch(watcher, project)
        assert table(viewer, ref).create({"name": "no"}).status_code == 403
        assert table(admin, ref).update("nope", {"name": "x"}).status_code == 404
        assert nothing_pending(watcher)
