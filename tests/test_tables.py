"""The table API over HTTP, for the tasks source (tasks:<projectId> and tasks:*)."""

import pytest

import database
from api.state import tasks as task_cache

from conftest import auth
from test_live import connect, watch, nothing_pending  # noqa: F401  (connect is a fixture)


@pytest.fixture
def project(make_project):
    return make_project("Tables")


@pytest.fixture
def editor(make_user, grant, project):
    u = make_user()
    grant(project, u["user"]["id"], can_review=True, can_tasks=True)
    return u


@pytest.fixture
def api(client):
    def call(method, path, user, json=None, headers=None):
        h = auth(user["token"]) if user else {}
        return client.request(method, path, json=json, headers={**h, **(headers or {})})
    return call


@pytest.fixture
def table(api):
    """table(user, ref).query(...) / .create(...) helpers around the HTTP calls."""
    class Table:
        def __init__(self, user, ref):
            self.user, self.ref = user, ref

        def schema(self):
            return api("GET", f"/api/tables/{self.ref}/schema", self.user)

        def query(self, query=None):
            return api("POST", f"/api/tables/{self.ref}/query", self.user, query or {})

        def rows(self, query=None):
            res = self.query(query)
            assert res.status_code == 200, res.text
            return res.json()["rows"]

        def names(self, query=None):
            return [r["values"]["name"] for r in self.rows(query)]

        def create(self, values, **extra):
            return api("POST", f"/api/tables/{self.ref}/rows", self.user, {"values": values, **extra})

        def add(self, name, **extra):
            res = self.create({"name": name}, **extra)
            assert res.status_code == 200, res.text
            return res.json()

        def update(self, row_id, values):
            return api("PATCH", f"/api/tables/{self.ref}/rows/{row_id}", self.user, {"values": values})

        def delete(self, row_id):
            return api("DELETE", f"/api/tables/{self.ref}/rows/{row_id}", self.user)

        def reorder(self, ids, before=None):
            body = {"ids": ids, **({"before": before} if before else {})}
            return api("POST", f"/api/tables/{self.ref}/rows/reorder", self.user, body)
    return lambda user, ref: Table(user, ref)


def stored(task_id):
    task = database.db_get_task(task_id)
    assert task is not None
    return task


# ---------------------------------------------------------------- schema

def test_schema_has_the_builtin_columns(table, admin, project):
    res = table(admin, f"tasks:{project}").schema()
    assert res.status_code == 200, res.text
    schema = res.json()
    assert schema["ref"] == f"tasks:{project}"
    assert schema["titleColumn"] == "name"
    assert schema["capabilities"] == {"create": True, "delete": True, "hierarchy": True, "editSchema": True}
    cols = {c["key"]: c for c in schema["columns"]}
    assert [c["key"] for c in schema["columns"]] == [
        "name", "status", "assignees", "priority", "stage", "dueDate", "section", "clip",
        "description", "createdAt", "createdBy"]
    assert {k: c["type"] for k, c in cols.items()} == {
        "name": "text", "status": "status", "assignees": "people", "priority": "priority", "stage": "select",
        "dueDate": "date", "section": "select", "clip": "clip", "description": "longtext",
        "createdAt": "date", "createdBy": "person"}
    assert all(c["builtin"] for c in cols.values())
    assert {k for k, c in cols.items() if c.get("readonly")} == {"clip", "createdAt", "createdBy"}


def test_schema_options(table, admin, editor, project, api):
    status = database.db_create_status("Schema status", "#123456")
    section = api("POST", f"/api/projects/{project}/sections", admin, {"name": "Sec", "color": "#abcdef"}).json()
    api("POST", f"/api/projects/{project}/tasks", admin, {"name": "t", "stageTag": "Zzz"})
    cols = {c["key"]: c for c in table(admin, f"tasks:{project}").schema().json()["columns"]}

    assert {"value": status["id"], "label": "Schema status", "color": "#123456"} in cols["status"]["options"]
    assert [o["value"] for o in cols["priority"]["options"]] == ["low", "medium", "high"]
    assert cols["priority"]["options"][2]["color"]
    stages = [o["value"] for o in cols["stage"]["options"]]
    assert stages[0] == "Zzz" and "Previz" in stages
    assert cols["section"]["options"] == [{"value": section["id"], "label": "Sec", "color": "#abcdef"}]
    people = {o["value"]: o["label"] for o in cols["assignees"]["options"]}
    assert people[editor["user"]["id"]] == editor["user"]["username"]


def test_priority_options_follow_the_active_preset(table, admin, make_project):
    pid = make_project("Preset")
    database.db_set_setting("priorityPreset", "urgency", scope="project", scope_id=pid)
    cols = {c["key"]: c for c in table(admin, f"tasks:{pid}").schema().json()["columns"]}
    assert [o["value"] for o in cols["priority"]["options"]] == ["none", "normal", "urgent", "critical"]
    assert cols["priority"]["options"][0]["label"] == "None"


def test_all_tasks_schema_adds_a_project_column(table, admin, project):
    schema = table(admin, "tasks:*").schema().json()
    cols = {c["key"]: c for c in schema["columns"]}
    assert cols["project"]["type"] == "select" and cols["project"]["readonly"]
    assert {"value": project, "label": "Tables"} in cols["project"]["options"]
    assert schema["capabilities"]["editSchema"] is False


def test_edit_schema_capability_is_for_owners_and_admins(table, editor, make_user, grant, project):
    assert table(editor, f"tasks:{project}").schema().json()["capabilities"]["editSchema"] is False
    owner = make_user()
    database.db_grant_project_access(owner["user"]["id"], project, can_review=True, can_tasks=True, is_owner=True) \
        if "is_owner" in database.db_grant_project_access.__code__.co_varnames else None
    if "is_owner" in database.db_grant_project_access.__code__.co_varnames:
        assert table(owner, f"tasks:{project}").schema().json()["capabilities"]["editSchema"] is True


# ---------------------------------------------------------------- refs and routing

@pytest.mark.parametrize("ref", ["nope", "tbl_123", "tasks:", "tasks:a b", "tasks:**", "tasks:a:b"])
def test_unknown_or_malformed_refs_are_404(api, admin, ref):
    assert api("GET", f"/api/tables/{ref}/schema", admin).status_code == 404
    assert api("POST", f"/api/tables/{ref}/query", admin, {}).status_code == 404
    assert api("POST", f"/api/tables/{ref}/rows", admin, {"values": {"name": "x"}}).status_code == 404


def test_unknown_project_is_404(api, admin):
    assert api("GET", "/api/tables/tasks:doesnotexist/schema", admin).status_code == 404


def test_refs_work_plain_and_url_encoded(api, admin, project):
    assert api("GET", f"/api/tables/tasks:{project}/schema", admin).status_code == 200
    assert api("GET", f"/api/tables/tasks%3A{project}/schema", admin).status_code == 200
    assert api("GET", "/api/tables/tasks:*/schema", admin).status_code == 200
    assert api("GET", "/api/tables/tasks%3A%2A/schema", admin).status_code == 200
    assert api("POST", "/api/tables/tasks:*/query", admin, {}).status_code == 200
    assert api("POST", "/api/tables/tasks%3A%2A/query", admin, {}).status_code == 200


# ---------------------------------------------------------------- rows and query

def test_row_shape(table, admin, editor, project):
    t = table(admin, f"tasks:{project}")
    status = database.db_create_status("Shape", "#010203")
    parent = t.create({"name": "Parent", "description": "Long text", "priority": "high", "dueDate": "2030-01-02"}).json()
    res = t.create({"name": "Child", "status": status["id"], "assignees": [editor["user"]["id"]], "stage": "Layout"},
                   parentId=parent["id"])
    assert res.status_code == 200, res.text
    child = res.json()
    assert child["tableRef"] == f"tasks:{project}"
    assert child["parentId"] == parent["id"] and child["childCount"] == 0 and child["canEdit"] is True
    assert child["values"] == {
        "name": "Child", "status": status["id"], "assignees": [editor["user"]["id"]], "priority": "medium",
        "stage": "Layout", "dueDate": None, "section": None, "clip": None, "description": None,
        "createdAt": child["values"]["createdAt"], "createdBy": admin["user"]["id"]}
    root = next(r for r in t.rows({"parentId": None}) if r["id"] == parent["id"])
    assert root["childCount"] == 1
    assert root["values"]["description"] == "Long text" and root["values"]["dueDate"] == "2030-01-02"


def test_clip_value_is_id_and_name(table, admin, project, api):
    from test_tasks import add_clip
    clip_id = add_clip(project, "tbl_clip")
    task = api("POST", f"/api/projects/{project}/tasks", admin, {"name": "With clip", "clipId": clip_id}).json()["task"]
    row = next(r for r in table(admin, f"tasks:{project}").rows() if r["id"] == task["id"])
    assert row["values"]["clip"] == {"id": clip_id, "name": "tbl_clip"}
    res = table(admin, f"tasks:{project}").query({"filter": {"column": "clip", "op": "notEmpty"}})
    assert [r["id"] for r in res.json()["rows"]] == [task["id"]]


def test_query_filter_sort_page_over_http(table, admin, project):
    t = table(admin, f"tasks:{project}")
    for name, prio, due in [("B task", "low", "2030-03-01"), ("A task", "high", "2030-01-01"),
                            ("C task", "high", None), ("Other", "medium", "2030-02-01")]:
        assert t.create({"name": name, "priority": prio, "dueDate": due}).status_code == 200
    res = t.query({"filter": {"column": "name", "op": "contains", "value": "task"},
                   "sort": [{"column": "priority", "dir": "desc"}, {"column": "name", "dir": "asc"}], "limit": 2})
    body = res.json()
    assert [r["values"]["name"] for r in body["rows"]] == ["A task", "C task"]
    assert body["total"] == 3
    assert t.names({"sort": [{"column": "dueDate"}]}) == ["A task", "Other", "B task", "C task"]
    assert t.names({"filter": {"column": "dueDate", "op": "between", "value": ["2030-01-15", "2030-12-31"]}}) == \
        ["B task", "Other"] or set(t.names({"filter": {"column": "dueDate", "op": "between",
                                                       "value": ["2030-01-15", "2030-12-31"]}})) == {"B task", "Other"}
    assert t.names({"search": "OTHER"}) == ["Other"]


def test_query_groups_and_summaries_over_http(table, admin, project):
    t = table(admin, f"tasks:{project}")
    for name, prio in [("a", "high"), ("b", "high"), ("c", "low")]:
        t.create({"name": name, "priority": prio})
    body = t.query({"groupBy": "priority", "summaries": {"name": "count", "dueDate": "countEmpty"}}).json()
    groups = {g["key"]: g for g in body["groups"]}
    assert [g["key"] for g in body["groups"]] == ["low", "medium", "high"]
    assert groups["high"]["count"] == 2 and groups["high"]["label"] == "High" and groups["high"]["color"]
    assert groups["high"]["summaries"] == {"name": 2, "dueDate": 2}
    assert body["summaries"] == {"name": 3, "dueDate": 3}


def test_at_me_over_http(table, admin, editor, project):
    t = table(editor, f"tasks:{project}")
    t.create({"name": "Mine", "assignees": [editor["user"]["id"]]})
    t.create({"name": "Theirs", "assignees": [admin["user"]["id"]]})
    t.create({"name": "Nobody"})
    assert t.names({"filter": {"column": "assignees", "op": "contains", "value": "@me"}}) == ["Mine"]
    assert table(admin, f"tasks:{project}").names(
        {"filter": {"column": "assignees", "op": "in", "value": ["@me"]}}) == ["Theirs"]


def test_hierarchy(table, admin, project):
    t = table(admin, f"tasks:{project}")
    a, b = t.add("Root A"), t.add("Root B")
    c1 = t.add("Child 1", parentId=a["id"])
    c2 = t.add("Child 2", parentId=a["id"])
    t.add("Grandchild", parentId=c1["id"])
    assert t.names({"parentId": None}) == ["Root A", "Root B"]
    assert t.names({"parentId": a["id"]}) == ["Child 1", "Child 2"]
    assert t.names({"parentId": c1["id"]}) == ["Grandchild"]
    assert t.names({"parentId": b["id"]}) == []
    assert set(t.names()) == {"Root A", "Root B", "Child 1", "Child 2", "Grandchild"}  # omitted = flat
    assert {r["id"]: r["childCount"] for r in t.rows()}[a["id"]] == 2
    assert c2["parentId"] == a["id"]


def test_rows_follow_the_task_order_by_default(table, admin, project):
    t = table(admin, f"tasks:{project}")
    ids = [t.add(n)["id"] for n in ("one", "two", "three")]
    assert t.names() == ["one", "two", "three"]
    assert t.reorder([ids[2], ids[0]]).status_code == 200
    assert t.names() == ["two", "three", "one"]


def test_invalid_queries_are_400_with_a_message(table, admin, project):
    t = table(admin, f"tasks:{project}")
    for bad in [{"filter": {"column": "nope", "op": "eq", "value": 1}},
                {"filter": {"column": "name", "op": "lt", "value": "a"}},
                {"filter": {"column": "dueDate", "op": "before", "value": "soon"}},
                {"sort": [{"column": "nope"}]}, {"groupBy": "nope"}, {"summaries": {"name": "sum"}},
                {"limit": -3}, {"bogus": 1}]:
        res = t.query(bad)
        assert res.status_code == 400, bad
        assert res.json()["detail"], bad
    assert "Unknown column 'nope'" in t.query({"filter": {"column": "nope", "op": "eq", "value": 1}}).json()["detail"]


def test_empty_query_body_is_fine(api, admin, project):
    assert api("POST", f"/api/tables/tasks:{project}/query", admin).status_code == 200


# ---------------------------------------------------------------- writes

def test_create_update_delete_are_in_the_database(table, admin, editor, project, api):
    t = table(admin, f"tasks:{project}")
    status = database.db_create_status("Writes", "#aaaaaa")
    section = api("POST", f"/api/projects/{project}/sections", admin, {"name": "Sec"}).json()
    row = t.add("Created")
    assert stored(row["id"])["name"] == "Created" and stored(row["id"])["createdBy"] == admin["user"]["id"]

    res = t.update(row["id"], {"name": "Renamed", "status": status["id"], "assignees": [editor["user"]["id"]],
                               "priority": "high", "stage": "Lighting", "dueDate": "2030-05-06",
                               "section": section["id"], "description": "Desc"})
    assert res.status_code == 200, res.text
    out = res.json()
    assert out["values"]["name"] == "Renamed" and out["values"]["assignees"] == [editor["user"]["id"]]
    db = stored(row["id"])
    assert (db["name"], db["statusId"], db["priority"], db["stageTag"], db["dueDate"], db["sectionId"],
            db["description"]) == ("Renamed", status["id"], "high", "Lighting", "2030-05-06", section["id"], "Desc")
    assert [a["id"] for a in db["assignees"]] == [editor["user"]["id"]]
    assert task_cache[row["id"]]["name"] == "Renamed"  # the in-memory copy follows

    res = t.update(row["id"], {"status": None, "assignees": [], "dueDate": None, "section": None, "stage": ""})
    assert res.status_code == 200, res.text
    db = stored(row["id"])
    assert db["statusId"] is None and db["assignees"] == [] and db["dueDate"] is None
    assert db["sectionId"] is None and db["stageTag"] is None

    parent = t.add("P")
    child = t.add("C", parentId=parent["id"])
    assert t.delete(parent["id"]).status_code == 200
    assert database.db_get_task(parent["id"]) is None and database.db_get_task(child["id"]) is None
    assert parent["id"] not in task_cache and child["id"] not in task_cache


def test_create_in_all_tasks_needs_a_project(table, admin, project):
    t = table(admin, "tasks:*")
    res = t.create({"name": "Nowhere"})
    assert res.status_code == 400 and "projectId" in res.json()["detail"]
    row = t.add("Somewhere", projectId=project)
    assert row["tableRef"] == f"tasks:{project}" and row["values"]["project"] == project
    assert stored(row["id"])["projectId"] == project
    assert t.create({"name": "x"}, projectId="nope").status_code == 404


def test_project_id_must_match_a_project_table(table, admin, project, make_project):
    other = make_project("Other")
    assert table(admin, f"tasks:{project}").create({"name": "x"}, projectId=other).status_code == 400
    assert table(admin, f"tasks:{project}").create({"name": "x"}, projectId=project).status_code == 200


def test_invalid_values_are_400(table, admin, project, make_project, api):
    t = table(admin, f"tasks:{project}")
    row = t.add("Valid")
    other_section = api("POST", f"/api/projects/{make_project('Elsewhere')}/sections", admin, {"name": "Foreign"}).json()
    cases = [
        {"nope": 1}, {"clip": 1}, {"createdAt": "2030-01-01"}, {"createdBy": "x"}, {"project": project},
        {"name": ""}, {"name": None}, {"name": 5},
        {"status": "no-such-status"}, {"assignees": ["no-such-user"]}, {"assignees": "x"}, {"assignees": [1]},
        {"dueDate": "31/01/2030"}, {"dueDate": 5}, {"section": "nope"}, {"section": other_section["id"]},
        {"description": 5}, {"priority": 3},
    ]
    for values in cases:
        assert t.update(row["id"], values).status_code == 400, values
        assert t.create({"name": "x", **values} if "name" not in values else values).status_code == 400, values
    assert t.create("not an object").status_code == 400
    assert stored(row["id"])["name"] == "Valid"


def test_a_bad_value_changes_nothing(table, admin, project):
    t = table(admin, f"tasks:{project}")
    row = t.add("Atomic")
    assert t.update(row["id"], {"name": "Changed", "dueDate": "bad"}).status_code == 400
    assert stored(row["id"])["name"] == "Atomic"


def test_parent_must_be_in_the_same_project(table, admin, project, make_project):
    other = table(admin, f"tasks:{make_project('Foreign parent')}").add("Elsewhere")
    assert table(admin, f"tasks:{project}").create({"name": "x"}, parentId=other["id"]).status_code == 400


def test_unknown_rows_are_404(table, admin, project):
    t = table(admin, f"tasks:{project}")
    assert t.update("nope", {"name": "x"}).status_code == 404
    assert t.delete("nope").status_code == 404


def test_a_row_of_another_project_is_not_reachable_through_this_table(table, admin, project, make_project):
    other = make_project("Else")
    row = table(admin, f"tasks:{other}").add("Not here")
    t = table(admin, f"tasks:{project}")
    assert t.update(row["id"], {"name": "x"}).status_code == 404
    assert t.delete(row["id"]).status_code == 404
    assert t.reorder([row["id"]]).status_code == 404
    # but through tasks:* it is a normal row
    assert table(admin, "tasks:*").update(row["id"], {"name": "Via all"}).status_code == 200
    assert stored(row["id"])["name"] == "Via all"


# ---------------------------------------------------------------- reorder

def test_reorder_moves_rows_to_the_end_or_before_another(table, admin, project):
    t = table(admin, f"tasks:{project}")
    ids = {n: t.add(n)["id"] for n in "ABCDE"}
    assert t.reorder([ids["B"]]).status_code == 200
    assert t.names() == ["A", "C", "D", "E", "B"]
    assert t.reorder([ids["E"], ids["D"]], before=ids["A"]).status_code == 200
    assert t.names() == ["E", "D", "A", "C", "B"]
    # saved: read back from the database
    order = sorted(ids.values(), key=lambda i: stored(i)["sortOrder"])
    assert order == [ids[n] for n in "EDACB"]
    assert t.reorder([ids["A"]], before=ids["A"]).status_code == 400
    assert t.reorder([ids["A"]], before="nope").status_code == 400


def test_reorder_works_among_siblings_only(table, admin, project):
    t = table(admin, f"tasks:{project}")
    root = t.add("Root")
    c1, c2, c3 = (t.add(n, parentId=root["id"])["id"] for n in ("c1", "c2", "c3"))
    assert t.reorder([c3], before=c1).status_code == 200
    assert t.names({"parentId": root["id"]}) == ["c3", "c1", "c2"]
    assert t.reorder([root["id"], c1]).status_code == 400  # different parents
    assert t.reorder([]).status_code == 400
    assert t.reorder([5]).status_code == 400
    assert t.reorder([c2], before=root["id"]).status_code == 400  # not a sibling


# ---------------------------------------------------------------- permissions

def test_anonymous_gets_401(api, project):
    for method, path, body in [("GET", f"/api/tables/tasks:{project}/schema", None),
                               ("POST", f"/api/tables/tasks:{project}/query", {}),
                               ("POST", "/api/tables/tasks:*/query", {}),
                               ("POST", f"/api/tables/tasks:{project}/rows", {"values": {"name": "x"}}),
                               ("PATCH", f"/api/tables/tasks:{project}/rows/x", {"values": {}}),
                               ("DELETE", f"/api/tables/tasks:{project}/rows/x", None),
                               ("POST", f"/api/tables/tasks:{project}/rows/reorder", {"ids": ["x"]})]:
        assert api(method, path, None, body).status_code == 401, path


def test_guests_get_403(api, share, table, admin, project):
    guest = share(project)
    t_proj, t_all = table(guest, f"tasks:{project}"), table(guest, "tasks:*")
    assert t_proj.schema().status_code == 403 and t_proj.query().status_code == 403
    assert t_all.schema().status_code == 403 and t_all.query().status_code == 403
    assert t_proj.create({"name": "x"}).status_code == 403
    row = table(admin, f"tasks:{project}").add("Guarded")
    assert t_proj.update(row["id"], {"name": "x"}).status_code == 403
    assert t_proj.delete(row["id"]).status_code == 403
    assert stored(row["id"])["name"] == "Guarded"


def test_no_task_access_is_403_for_a_project_table(table, admin, make_user, grant, project):
    reviewer = make_user()
    grant(project, reviewer["user"]["id"], can_review=True, can_tasks=False)
    outsider = make_user()
    row = table(admin, f"tasks:{project}").add("Private")
    for user in (reviewer, outsider):
        t = table(user, f"tasks:{project}")
        assert t.schema().status_code == 403
        assert t.query().status_code == 403
        assert t.create({"name": "x"}).status_code == 403
        assert t.update(row["id"], {"name": "x"}).status_code == 403
        assert t.delete(row["id"]).status_code == 403
        assert t.reorder([row["id"]]).status_code == 403
    assert stored(row["id"])["name"] == "Private"


def test_viewers_read_but_cannot_edit(table, admin, make_user, grant, project):
    viewer = make_user("viewer")
    grant(project, viewer["user"]["id"], can_review=True, can_tasks=True)
    row = table(admin, f"tasks:{project}").add("Read only")
    t = table(viewer, f"tasks:{project}")
    rows = t.rows()
    assert [r["id"] for r in rows] == [row["id"]] and rows[0]["canEdit"] is False
    assert t.update(row["id"], {"name": "x"}).status_code == 403
    assert t.delete(row["id"]).status_code == 403
    assert t.create({"name": "x"}).status_code == 403
    assert t.reorder([row["id"]]).status_code == 403
    assert stored(row["id"])["name"] == "Read only"


def test_editors_with_task_access_can_edit(table, editor, project):
    t = table(editor, f"tasks:{project}")
    row = t.add("Mine")
    assert row["canEdit"] is True
    assert t.update(row["id"], {"name": "Changed"}).status_code == 200
    assert t.delete(row["id"]).status_code == 200


def test_all_tasks_only_contains_projects_with_task_access(table, admin, make_user, grant, make_project):
    user = make_user()
    mine, review_only, hidden = make_project("Mine"), make_project("Review only"), make_project("Hidden")
    grant(mine, user["user"]["id"], can_review=True, can_tasks=True)
    grant(review_only, user["user"]["id"], can_review=True, can_tasks=False)
    for pid, name in [(mine, "visible"), (review_only, "no task access"), (hidden, "no access")]:
        table(admin, f"tasks:{pid}").add(name)

    t = table(user, "tasks:*")
    rows = t.rows()
    assert [r["values"]["name"] for r in rows] == ["visible"]
    assert rows[0]["tableRef"] == f"tasks:{mine}" and rows[0]["values"]["project"] == mine and rows[0]["canEdit"]
    assert t.query({"search": "access"}).json()["total"] == 0
    project_column = next(c for c in t.schema().json()["columns"] if c["key"] == "project")
    assert [o["value"] for o in project_column["options"]] == [mine]
    # the project column is a normal filter and group column
    assert t.names({"filter": {"column": "project", "op": "eq", "value": hidden}}) == []
    groups = t.query({"groupBy": "project"}).json()["groups"]
    assert [(g["key"], g["count"]) for g in groups] == [(mine, 1)]

    names = {r["values"]["name"] for r in table(admin, "tasks:*").rows()}
    assert {"visible", "no task access", "no access"} <= names  # admins see every project


def test_all_tasks_rows_of_other_projects_cannot_be_touched(table, admin, make_user, grant, make_project):
    user = make_user()
    mine, theirs = make_project("Mine2"), make_project("Theirs2")
    grant(mine, user["user"]["id"], can_review=True, can_tasks=True)
    secret = table(admin, f"tasks:{theirs}").add("Secret")
    t = table(user, "tasks:*")
    assert t.update(secret["id"], {"name": "x"}).status_code == 404
    assert t.delete(secret["id"]).status_code == 404
    assert t.reorder([secret["id"]]).status_code == 404
    assert t.create({"name": "x"}, projectId=theirs).status_code == 403
    assert stored(secret["id"])["name"] == "Secret"
    assert t.add("Fine", projectId=mine)["tableRef"] == f"tasks:{mine}"


def test_all_tasks_canEdit_is_per_project(table, admin, make_user, grant, make_project):
    user = make_user("viewer")
    a, b = make_project("A"), make_project("B")
    grant(a, user["user"]["id"], can_review=True, can_tasks=True)
    grant(b, user["user"]["id"], can_review=True, can_tasks=True)
    table(admin, f"tasks:{a}").add("in a")
    rows = table(user, "tasks:*").rows()
    assert rows and all(r["canEdit"] is False for r in rows)


def test_people_options_do_not_leak_other_projects_members(table, admin, make_user, grant, make_project):
    user, stranger = make_user(), make_user()
    mine, other = make_project("Mine3"), make_project("Other3")
    grant(mine, user["user"]["id"], can_review=True, can_tasks=True)
    grant(other, stranger["user"]["id"], can_review=True, can_tasks=True)
    cols = {c["key"]: c for c in table(user, "tasks:*").schema().json()["columns"]}
    assert stranger["user"]["id"] not in {o["value"] for o in cols["assignees"]["options"]}


# ---------------------------------------------------------------- live events

def next_event(ws, kind):
    event = ws.receive_json()
    assert event["type"] == kind, event
    return event


def test_rows_changed_events_for_table_api_changes(client, admin, project, connect, table):
    with connect(admin["token"], "writer") as writer, connect(admin["token"], "watcher") as watcher:
        watch(writer, project)
        watch(watcher, project)
        h = {"X-Client-Id": "writer"}
        ref = f"tasks:{project}"

        res = client.post(f"/api/tables/{ref}/rows", json={"values": {"name": "Live"}}, headers={**auth(admin["token"]), **h})
        row = res.json()
        created = next_event(watcher, "task_created")
        assert created["task"]["id"] == row["id"]
        assert next_event(watcher, "rows_changed") == {
            "type": "rows_changed", "tableRef": ref, "ids": [row["id"]], "change": "created", "project": project}
        assert nothing_pending(writer)  # never echoed to the tab that made the change

        client.patch(f"/api/tables/{ref}/rows/{row['id']}", json={"values": {"name": "Live 2"}},
                     headers={**auth(admin["token"]), **h})
        assert next_event(watcher, "task_updated")["task"]["name"] == "Live 2"
        assert next_event(watcher, "rows_changed")["change"] == "updated"

        other = client.post(f"/api/tables/{ref}/rows", json={"values": {"name": "Second"}},
                            headers={**auth(admin["token"]), **h}).json()
        next_event(watcher, "task_created"), next_event(watcher, "rows_changed")
        client.post(f"/api/tables/{ref}/rows/reorder", json={"ids": [other["id"]], "before": row["id"]},
                    headers={**auth(admin["token"]), **h})
        assert next_event(watcher, "tasks_reordered")
        event = next_event(watcher, "rows_changed")
        assert event["change"] == "reordered" and set(event["ids"]) == {row["id"], other["id"]}

        child = client.post(f"/api/tables/{ref}/rows", json={"values": {"name": "Kid"}, "parentId": row["id"]},
                            headers={**auth(admin["token"]), **h}).json()
        next_event(watcher, "task_created"), next_event(watcher, "rows_changed")
        client.delete(f"/api/tables/{ref}/rows/{row['id']}", headers={**auth(admin["token"]), **h})
        assert next_event(watcher, "task_deleted")["taskId"] == row["id"]
        event = next_event(watcher, "rows_changed")
        assert event["change"] == "deleted" and set(event["ids"]) == {row["id"], child["id"]}
        assert nothing_pending(writer)


def test_rows_changed_is_also_sent_for_the_old_task_api(client, admin, project, connect):
    with connect(admin["token"], "writer") as writer, connect(admin["token"], "watcher") as watcher:
        watch(writer, project)
        watch(watcher, project)
        h = {**auth(admin["token"]), "X-Client-Id": "writer"}
        task = client.post(f"/api/projects/{project}/tasks", json={"name": "Old"}, headers=h).json()["task"]
        next_event(watcher, "task_created")
        assert next_event(watcher, "rows_changed")["ids"] == [task["id"]]
        client.patch(f"/api/tasks/{task['id']}", json={"name": "Old 2"}, headers=h)
        next_event(watcher, "task_updated")
        assert next_event(watcher, "rows_changed")["change"] == "updated"
        client.post(f"/api/projects/{project}/tasks/reorder", json={"taskIds": [task["id"]]}, headers=h)
        next_event(watcher, "tasks_reordered")
        assert next_event(watcher, "rows_changed")["change"] == "reordered"
        client.delete(f"/api/tasks/{task['id']}", headers=h)
        next_event(watcher, "task_deleted")
        event = next_event(watcher, "rows_changed")
        assert event == {"type": "rows_changed", "tableRef": f"tasks:{project}", "ids": [task["id"]],
                         "change": "deleted", "project": project}


def test_rows_changed_only_reaches_people_with_task_access(client, admin, project, make_user, grant, connect):
    tasker, reviewer = make_user(), make_user()
    grant(project, tasker["user"]["id"], can_tasks=True)
    grant(project, reviewer["user"]["id"], can_tasks=False)
    with connect(tasker["token"], "t") as with_tasks, connect(reviewer["token"], "r") as without:
        watch(with_tasks, project)
        watch(without, project)
        client.post(f"/api/tables/tasks:{project}/rows", json={"values": {"name": "Quiet"}}, headers=auth(admin["token"]))
        next_event(with_tasks, "task_created")
        next_event(with_tasks, "rows_changed")
        assert nothing_pending(without)


# ---------------------------------------------------------------- equivalence with the old task API

SAME_EDIT = [
    ("name", "Renamed"), ("priority", "high"), ("dueDate", "2030-04-05"), ("stage", "FX"),
    ("description", "Same text"),
]


def comparable(task_id):
    task = stored(task_id)
    for key in ("id", "createdAt", "sortOrder"):
        task.pop(key)
    return task


def test_the_same_edit_gives_the_same_stored_task(table, api, admin, editor, project):
    status = database.db_create_status("Equal", "#654321")
    section = api("POST", f"/api/projects/{project}/sections", admin, {"name": "Equal"}).json()
    t = table(admin, f"tasks:{project}")

    via_table, via_old = t.add("Start"), api("POST", f"/api/projects/{project}/tasks", admin, {"name": "Start"}).json()["task"]
    assert comparable(via_table["id"]) == comparable(via_old["id"])

    t.update(via_table["id"], {"name": "Edited", "status": status["id"], "assignees": [editor["user"]["id"]],
                               "priority": "high", "stage": "FX", "dueDate": "2030-04-05", "section": section["id"],
                               "description": "Same text"})
    api("PATCH", f"/api/tasks/{via_old['id']}", admin,
        {"name": "Edited", "statusId": status["id"], "assigneeIds": [editor["user"]["id"]], "priority": "high",
         "stageTag": "FX", "dueDate": "2030-04-05", "sectionId": section["id"], "description": "Same text"})
    assert comparable(via_table["id"]) == comparable(via_old["id"])
    assert task_cache[via_table["id"]]["assignees"] == task_cache[via_old["id"]]["assignees"]

    # clearing values
    t.update(via_table["id"], {"status": None, "assignees": [], "dueDate": None, "section": None})
    api("PATCH", f"/api/tasks/{via_old['id']}", admin,
        {"statusId": None, "assigneeIds": [], "dueDate": None, "sectionId": None})
    assert comparable(via_table["id"]) == comparable(via_old["id"])


def test_creating_with_values_gives_the_same_stored_task(table, api, admin, editor, project):
    status = database.db_create_status("Equal create", "#222222")
    t = table(admin, f"tasks:{project}")
    new = t.create({"name": "Full", "status": status["id"], "assignees": [editor["user"]["id"]], "priority": "low",
                    "stage": "Layout", "dueDate": "2030-07-08", "description": "d"}).json()
    old = api("POST", f"/api/projects/{project}/tasks", admin,
              {"name": "Full", "statusId": status["id"], "assigneeIds": [editor["user"]["id"]], "priority": "low",
               "stageTag": "Layout", "dueDate": "2030-07-08", "description": "d"}).json()["task"]
    assert comparable(new["id"]) == comparable(old["id"])
    # the in-memory copies agree too (what the old list endpoint serves)
    a, b = dict(task_cache[new["id"]]), dict(task_cache[old["id"]])
    for key in ("id", "createdAt", "sortOrder"):
        a.pop(key), b.pop(key)
    assert a == b


def test_delete_and_reorder_match_the_old_api(table, api, admin, project):
    t = table(admin, f"tasks:{project}")
    ids = [t.add(n)["id"] for n in "XYZ"]
    t.reorder([ids[2], ids[1], ids[0]])  # all rows moved: they take the order Z, Y, X
    new_order = {i: stored(i)["sortOrder"] for i in ids}
    api("POST", f"/api/projects/{project}/tasks/reorder", admin, {"taskIds": list(reversed(ids))})
    assert {i: stored(i)["sortOrder"] for i in ids} == new_order
    parent_row = t.add("Gone")
    t.add("Gone child", parentId=parent_row["id"])
    old = api("POST", f"/api/projects/{project}/tasks", admin, {"name": "Gone old"}).json()["task"]
    api("POST", f"/api/projects/{project}/tasks", admin, {"name": "kid", "parentId": old["id"]})
    t.delete(parent_row["id"])
    api("DELETE", f"/api/tasks/{old['id']}", admin)
    assert database.db_get_task(parent_row["id"]) is None and database.db_get_task(old["id"]) is None
    assert not [x for x in task_cache.values() if x["name"] in ("Gone child", "kid")]
