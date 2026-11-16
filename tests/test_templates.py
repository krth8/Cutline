"""Duplicating pages, templates (saved and built-in) and copying a project's setup (WP H4)."""

import os

import pytest
from pycrdt import Doc, XmlElement, XmlFragment, XmlText

from api import builtin_templates
from api.pagesync import extract_text, registry
from conftest import auth
from database.pages import db_get_page, db_load_page_state, db_write_page_snapshot
from test_page_files import png_bytes, upload
from test_pages import create, tree
from test_pagesync import Peer, connect_page, paragraph, snapshot  # noqa: F401  (connect_page is a fixture)


# ---------- helpers ----------

def put_doc(page_id, build):
    """Store a document built by `build(fragment)` as the page's content."""
    doc = Doc()
    build(doc.get("default", type=XmlFragment))
    db_write_page_snapshot(page_id, doc.get_update(), extract_text(doc), 0)


def read_doc(page_id):
    snap, rows = db_load_page_state(page_id)
    doc = Doc()
    for data in ([snap] if snap else []) + [d for _i, d in rows]:
        doc.apply_update(data)
    return doc


def nodes(page_id, tag):
    """Attribute dicts of every element with this tag in the page's document."""
    found = []

    def walk(parent):
        for child in parent.children:
            if isinstance(child, XmlElement):
                if child.tag == tag:
                    found.append(dict(child.attributes))
                walk(child)
    walk(read_doc(page_id).get("default", type=XmlFragment))
    return found


def text_of(page_id):
    return extract_text(read_doc(page_id))


def text_block(frag, text):
    block = XmlElement("paragraph")
    frag.children.append(block)
    block.children.append(XmlText(text))


def add_view(client, token, page_id, ref, name="V", layout="table", config=None):
    res = client.post("/api/views", json={"tableRef": ref, "name": name, "layout": layout, "config": config or {},
                                          "ownerPageId": page_id}, headers=auth(token))
    assert res.status_code == 200, res.text
    return res.json()["id"]


def get_view(client, token, view_id):
    res = client.get(f"/api/views/{view_id}", headers=auth(token))
    assert res.status_code == 200, res.text
    return res.json()


def duplicate(client, token, page_id, **body):
    return client.post(f"/api/pages/{page_id}/duplicate", json=body, headers=auth(token))


def ok(res):
    assert res.status_code == 200, res.text
    return res.json()


def add_column(client, token, ref, name, col_type="text"):
    return ok(client.post(f"/api/tables/{ref}/columns", json={"name": name, "type": col_type}, headers=auth(token)))["key"]


def make_table(client, token, space, name="Tbl", columns=None):
    return ok(client.post("/api/tables", json={"name": name, "space": space, "columns": columns or []},
                          headers=auth(token)))["ref"]


def own_views(client, token, page_id):
    listed = ok(client.get("/api/views", params={"ownerPageId": page_id}, headers=auth(token)))["views"]
    return [get_view(client, token, v["id"]) for v in sorted(listed, key=lambda v: v["name"])]


@pytest.fixture
def world(client, admin, make_project, make_user, grant):
    """Alpha and Beta; a edits Alpha, b edits both, reader has no task access in Alpha, viewer has the viewer role."""
    pa, pb = make_project("Alpha"), make_project("Beta")
    a, b, reader, viewer, outsider = make_user(), make_user(), make_user(), make_user("viewer"), make_user()
    grant(pa, a["user"]["id"], can_tasks=True)
    grant(pa, b["user"]["id"], can_tasks=True)
    grant(pb, b["user"]["id"], can_tasks=True)
    grant(pa, reader["user"]["id"], can_tasks=False)
    grant(pa, viewer["user"]["id"], can_tasks=True)
    return {"pa": pa, "pb": pb, "sa": f"p:{pa}", "sb": f"p:{pb}", "a": a["token"], "b": b["token"],
            "reader": reader["token"], "viewer": viewer["token"], "outsider": outsider["token"],
            "admin": admin["token"]}


# ---------- duplicate: structure ----------

def test_duplicate_copies_the_tree_with_titles_and_icons(client, world):
    a = world["a"]
    root = create(client, a, world["sa"], "Plan")
    child = create(client, a, world["sa"], "Child", parent=root["id"])
    grand = create(client, a, world["sa"], "Grand", parent=child["id"])
    after = create(client, a, world["sa"], "After")
    client.patch(f"/api/pages/{child['id']}", json={"icon": "X"}, headers=auth(a))

    body = ok(duplicate(client, a, root["id"]))
    assert body["title"] == "Plan (copy)" and body["space"] == world["sa"] and body["parentId"] is None
    assert len(body["pageIds"]) == 3 and root["id"] not in body["pageIds"]
    # right after the original, before the page that followed it
    assert root["sortOrder"] < body["sortOrder"] < after["sortOrder"]

    rows = {r["id"]: r for r in tree(client, a, world["sa"])}
    new_child = next(r for r in rows.values() if r["title"] == "Child" and r["id"] != child["id"])
    new_grand = next(r for r in rows.values() if r["title"] == "Grand" and r["id"] != grand["id"])
    assert new_child["parentId"] == body["id"] and new_child["icon"] == "X"
    assert new_grand["parentId"] == new_child["id"]
    assert rows[child["id"]]["parentId"] == root["id"]  # the original is untouched


def test_duplicate_options_title_without_subpages_and_parent(client, world):
    a = world["a"]
    root = create(client, a, world["sa"], "Plan")
    create(client, a, world["sa"], "Child", parent=root["id"])
    target = create(client, a, world["sa"], "Target")
    body = ok(duplicate(client, a, root["id"], title="Fresh", withSubpages=False, parentId=target["id"]))
    assert body["title"] == "Fresh" and body["parentId"] == target["id"] and len(body["pageIds"]) == 1
    assert [r["title"] for r in tree(client, a, world["sa"]) if r["parentId"] == body["id"]] == []
    assert duplicate(client, a, root["id"], withSubpages="yes").status_code == 400
    assert duplicate(client, a, root["id"], parentId="nope").status_code == 400
    assert duplicate(client, a, "no-such-page").status_code == 404


def test_archived_sub_pages_are_not_copied_and_an_archived_page_cannot_be_copied(client, world):
    a = world["a"]
    root = create(client, a, world["sa"], "Plan")
    old = create(client, a, world["sa"], "Old", parent=root["id"])
    client.patch(f"/api/pages/{old['id']}", json={"archived": True}, headers=auth(a))
    body = ok(duplicate(client, a, root["id"]))
    assert len(body["pageIds"]) == 1
    client.patch(f"/api/pages/{root['id']}", json={"archived": True}, headers=auth(a))
    assert duplicate(client, a, root["id"]).status_code == 400


def test_content_is_equal_and_independent(client, world):
    a = world["a"]
    page = create(client, a, world["sa"], "Doc")
    put_doc(page["id"], lambda f: (text_block(f, "Hello world"), text_block(f, "Second")))
    copy = ok(duplicate(client, a, page["id"]))
    assert text_of(copy["id"]) == text_of(page["id"]) == "Hello world\nSecond"
    put_doc(page["id"], lambda f: text_block(f, "Changed"))
    assert text_of(copy["id"]) == "Hello world\nSecond"


def test_live_room_content_is_included(client, world, connect_page):
    a = world["a"]
    page = create(client, a, world["sa"], "Live")
    with connect_page(a, page["id"]) as ws:
        peer = Peer(ws)
        peer.edit(lambda: paragraph(peer.frag, "typed just now"))
        peer.sync()
        copy = ok(duplicate(client, a, page["id"]))  # nothing was snapshotted yet
    assert "typed just now" in text_of(copy["id"])


# ---------- duplicate: views ----------

def test_owned_views_are_copied_and_the_document_points_at_the_copies(client, world):
    a = world["a"]
    page = create(client, a, world["sa"], "Boards")
    mine = add_view(client, a, page["id"], f"tasks:{world['pa']}", "My board", "board",
                    {"query": {"filter": {"column": "status", "op": "eq", "value": "x"}}, "board": {"groupBy": "status"}})
    other_page = create(client, a, world["sa"], "Other")
    foreign = add_view(client, a, other_page["id"], f"tasks:{world['pa']}", "Foreign", "table")

    def build(f):
        text_block(f, "intro")
        for view_id in (mine, foreign):
            f.children.append(XmlElement("viewBlock", {"viewId": view_id}))
        f.children.append(XmlElement("summaryInline", {"viewId": mine, "fn": "count"}))
        f.children.append(XmlElement("chart", {"viewId": mine}))
    put_doc(page["id"], build)

    copy = ok(duplicate(client, a, page["id"]))
    views = own_views(client, a, copy["id"])
    assert len(views) == 1 and views[0]["id"] != mine
    assert views[0]["name"] == "My board" and views[0]["layout"] == "board"
    assert views[0]["config"] == get_view(client, a, mine)["config"]
    ids = [n["viewId"] for n in nodes(copy["id"], "viewBlock")]
    assert ids == [views[0]["id"], foreign]  # owned: rewritten; not owned: kept
    assert nodes(copy["id"], "summaryInline")[0]["viewId"] == views[0]["id"]
    assert nodes(copy["id"], "chart")[0]["viewId"] == views[0]["id"]
    # editing the copy's view does not touch the original's
    res = client.patch(f"/api/views/{views[0]['id']}", json={"config": {"query": {}}}, headers=auth(a))
    assert res.status_code == 200, res.text
    assert get_view(client, a, mine)["config"]["board"] == {"groupBy": "status"}
    assert [v["id"] for v in own_views(client, a, page["id"])] == [mine]


def test_task_views_follow_the_destination_project(client, world):
    a, b = world["a"], world["b"]
    key_a = add_column(client, world["admin"], f"tasks:{world['pa']}", "Only in Alpha")
    key_b = add_column(client, world["admin"], f"tasks:{world['pb']}", "In Beta")
    page = create(client, b, world["sa"], "Tasks view")
    config = {"query": {"filter": {"and": [{"column": key_a, "op": "contains", "value": "x"},
                                          {"column": "status", "op": "eq", "value": "s"}]},
                        "sort": [{"column": key_a, "dir": "asc"}, {"column": key_b, "dir": "asc"}]},
              "columns": [{"key": "name"}, {"key": key_a}, {"key": key_b}]}
    add_view(client, b, page["id"], f"tasks:{world['pa']}", "T", "table", config)

    into_beta = ok(duplicate(client, b, page["id"], space=world["sb"]))
    view = own_views(client, b, into_beta["id"])[0]
    assert view["tableRef"] == f"tasks:{world['pb']}"
    assert [c["key"] for c in view["config"]["columns"]] == ["name", key_b]
    assert view["config"]["query"]["filter"] == {"and": [{"column": "status", "op": "eq", "value": "s"}]}
    assert view["config"]["query"]["sort"] == [{"column": key_b, "dir": "asc"}]

    into_me = ok(duplicate(client, b, page["id"], space="me"))
    view = own_views(client, b, into_me["id"])[0]
    assert view["tableRef"] == "tasks:*"
    assert [c["key"] for c in view["config"]["columns"]] == ["name"]
    flt = view["config"]["query"]["filter"]
    assert {"column": "assignees", "op": "in", "value": ["@me"]} in flt["and"]

    same = ok(duplicate(client, b, page["id"]))  # same space: unchanged
    assert own_views(client, b, same["id"])[0]["tableRef"] == f"tasks:{world['pa']}"

    # a personal page with a tasks:* view copied into a project reads that project's tasks
    mine = create(client, b, "me", "Mine")
    add_view(client, b, mine["id"], "tasks:*", "All", "list", {"query": {}})
    out = ok(duplicate(client, b, mine["id"], space=world["sb"]))
    assert own_views(client, b, out["id"])[0]["tableRef"] == f"tasks:{world['pb']}"


def test_own_custom_table_is_copied_empty_and_shared_ones_are_not(client, world):
    a = world["a"]
    page = create(client, a, world["sa"], "Shots")
    own = make_table(client, a, world["sa"], "Own", [{"name": "Note", "type": "text"}])
    shared = make_table(client, a, world["sa"], "Shared", [{"name": "Z", "type": "text"}])
    ok(client.post(f"/api/tables/{own}/rows", json={"values": {"name": "row 1"}}, headers=auth(a)))
    own_view = add_view(client, a, page["id"], own, "Own view")
    shared_view = add_view(client, a, page["id"], shared, "Shared view")
    other = create(client, a, world["sa"], "Other")
    add_view(client, a, other["id"], shared, "Elsewhere")  # a second page uses the shared table

    copy = ok(duplicate(client, a, page["id"]))
    views = {v["name"]: v for v in own_views(client, a, copy["id"])}
    new_ref = views["Own view"]["tableRef"]
    assert new_ref != own and new_ref.startswith("tbl_")
    assert views["Shared view"]["tableRef"] == shared  # kept
    schema = ok(client.get(f"/api/tables/{new_ref}/schema", headers=auth(a)))
    old_schema = ok(client.get(f"/api/tables/{own}/schema", headers=auth(a)))
    assert [c["key"] for c in schema["columns"]] == [c["key"] for c in old_schema["columns"]]
    assert ok(client.post(f"/api/tables/{new_ref}/query", json={}, headers=auth(a)))["total"] == 0
    assert ok(client.post(f"/api/tables/{own}/query", json={}, headers=auth(a)))["total"] == 1
    assert own_view and shared_view


def test_custom_table_copied_to_another_space_belongs_to_it(client, world):
    b = world["b"]
    page = create(client, b, world["sa"], "Shots")
    table = make_table(client, b, world["sa"], "Own", [{"name": "Note", "type": "text"}])
    add_view(client, b, page["id"], table, "Own view")
    copy = ok(duplicate(client, b, page["id"], space="me"))
    ref = own_views(client, b, copy["id"])[0]["tableRef"]
    assert ref != table
    assert ok(client.get(f"/api/tables/{ref}/schema", headers=auth(b)))["space"] == {"type": "personal"}


# ---------- duplicate: files ----------

def test_files_are_copied_and_reachable_with_the_right_permissions(client, world):
    a = world["a"]
    page = create(client, a, world["sa"], "Pictures")
    up = ok(upload(client, a, page["id"], png_bytes()))
    other = ok(upload(client, a, page["id"], b"%PDF-1.4 hello", name="doc.pdf", ctype="application/pdf"))

    def build(f):
        f.children.append(XmlElement("image", {"src": up["url"], "fileId": up["id"], "alt": "pic"}))
        f.children.append(XmlElement("file", {"url": other["url"], "fileId": other["id"], "name": "doc.pdf"}))
    put_doc(page["id"], build)

    copy = ok(duplicate(client, a, page["id"]))
    image, = nodes(copy["id"], "image")
    attachment, = nodes(copy["id"], "file")
    assert image["fileId"] != up["id"] and image["src"] == f"/api/pages/{copy['id']}/files/{image['fileId']}"
    assert attachment["url"] == f"/api/pages/{copy['id']}/files/{attachment['fileId']}"
    assert image["alt"] == "pic"

    got = client.get(image["src"], headers=auth(a))
    assert got.status_code == 200 and got.content == client.get(up["url"], headers=auth(a)).content
    assert client.get(attachment["url"], headers=auth(world["b"])).status_code == 200  # b reads Alpha
    assert client.get(image["src"], headers=auth(world["outsider"])).status_code == 403
    # the original's file cannot be fetched through the copy and vice versa
    assert client.get(f"/api/pages/{copy['id']}/files/{up['id']}", headers=auth(a)).status_code == 404

    # the copy keeps its files when the original is deleted for good
    client.patch(f"/api/pages/{page['id']}", json={"archived": True}, headers=auth(a))
    assert client.delete(f"/api/pages/{page['id']}", headers=auth(a)).status_code == 200
    assert client.get(image["src"], headers=auth(a)).status_code == 200

    # into the personal space: private to the owner
    mine = ok(duplicate(client, a, copy["id"], space="me"))
    moved, = nodes(mine["id"], "image")
    assert client.get(moved["src"], headers=auth(a)).status_code == 200
    assert client.get(moved["src"], headers=auth(world["b"])).status_code == 403


def test_mentions_clip_embeds_and_page_lists_are_kept(client, world):
    a = world["a"]
    page = create(client, a, world["sa"], "Refs")

    def build(f):
        f.children.append(XmlElement("mention", {"kind": "task", "id": "t1", "label": "Task"}))
        f.children.append(XmlElement("clipEmbed", {"projectId": world["pa"], "baseName": "clip"}))
        f.children.append(XmlElement("pageList", {"scope": "all", "limit": 5}))
    put_doc(page["id"], build)
    copy = ok(duplicate(client, a, page["id"]))
    assert nodes(copy["id"], "mention") == [{"kind": "task", "id": "t1", "label": "Task"}]
    assert nodes(copy["id"], "clipEmbed")[0]["baseName"] == "clip"
    assert nodes(copy["id"], "pageList")[0]["scope"] == "all"


# ---------- duplicate: permissions ----------

def test_duplicate_permissions(client, world, share):
    a = world["a"]
    team_page = create(client, a, world["sa"], "Team")
    mine = create(client, a, "me", "Mine")
    assert duplicate(client, a, team_page["id"]).status_code == 200
    assert duplicate(client, world["b"], team_page["id"], space="me").status_code == 200  # reads Alpha, owns "me"
    assert duplicate(client, world["reader"], team_page["id"]).status_code == 403  # no task access: no create rights
    assert duplicate(client, world["reader"], team_page["id"], space="me").status_code == 200  # may read, copy it home
    assert duplicate(client, world["viewer"], team_page["id"]).status_code == 403  # viewer role
    assert duplicate(client, world["outsider"], team_page["id"]).status_code == 403
    assert duplicate(client, world["outsider"], team_page["id"], space="me").status_code == 403  # cannot read it
    assert duplicate(client, world["b"], mine["id"]).status_code == 403  # someone else's personal page
    assert duplicate(client, world["admin"], mine["id"]).status_code == 403
    assert duplicate(client, a, team_page["id"], space=world["sb"]).status_code == 403  # a cannot create in Beta
    guest = share(world["pa"])["token"]
    assert duplicate(client, guest, team_page["id"]).status_code == 403
    assert duplicate(client, guest, team_page["id"], space="me").status_code == 403
    assert save_template(client, guest, team_page["id"]).status_code == 403
    assert client.get("/api/templates", headers=auth(guest)).status_code == 403
    assert client.post(f"/api/pages/{team_page['id']}/duplicate", json={}).status_code == 401


def test_the_tasks_page_is_copied_as_an_ordinary_page(client, world):
    a = world["a"]
    rows = ok(client.get(f"/api/spaces/{world['sa']}/pages", headers=auth(a)))
    system = next(r for r in rows if r["system"] == "tasks")
    copy = ok(duplicate(client, a, system["id"]))
    assert copy["system"] is None and copy["title"] == "Tasks (copy)"
    assert len(own_views(client, a, copy["id"])) == 1
    assert [r for r in ok(client.get(f"/api/spaces/{world['sa']}/pages", headers=auth(a))) if r["system"]] == [system | {}] or \
        len([r for r in ok(client.get(f"/api/spaces/{world['sa']}/pages", headers=auth(a))) if r["system"] == "tasks"]) == 1


# ---------- templates ----------

def save_template(client, token, page_id, name="T", scope="personal", description=""):
    return client.post("/api/templates", json={"pageId": page_id, "name": name, "scope": scope,
                                               "description": description}, headers=auth(token))


def use_template(client, token, template_id, **body):
    return client.post(f"/api/templates/{template_id}/use", json=body, headers=auth(token))


def listing(client, token):
    return {t["id"]: t for t in ok(client.get("/api/templates", headers=auth(token)))["templates"]}


def test_a_template_is_frozen_and_can_be_used_again(client, world):
    a = world["a"]
    page = create(client, a, world["sa"], "Source")
    sub = create(client, a, world["sa"], "Sub", parent=page["id"])
    put_doc(page["id"], lambda f: text_block(f, "original text"))
    up = ok(upload(client, a, page["id"], png_bytes()))
    view = add_view(client, a, page["id"], f"tasks:{world['pa']}", "Board", "board")

    def build(f):
        text_block(f, "original text")
        f.children.append(XmlElement("image", {"src": up["url"], "fileId": up["id"]}))
        f.children.append(XmlElement("viewBlock", {"viewId": view}))
    put_doc(page["id"], build)
    saved = ok(save_template(client, a, page["id"], "My template", description="Used for tests"))
    assert saved["scope"] == "personal" and saved["pageCount"] == 2 and saved["canDelete"]

    # later edits and even deleting the source do not change the template
    put_doc(page["id"], lambda f: text_block(f, "edited later"))
    client.patch(f"/api/pages/{page['id']}", json={"archived": True}, headers=auth(a))
    client.delete(f"/api/pages/{page['id']}", headers=auth(a))

    used = ok(use_template(client, a, saved["id"], space=world["sa"]))
    assert used["title"] == "Source" and len(used["pageIds"]) == 2 and sub["id"] not in used["pageIds"]
    assert "original text" in text_of(used["id"])
    image, = nodes(used["id"], "image")
    assert client.get(image["src"], headers=auth(a)).status_code == 200
    new_view = own_views(client, a, used["id"])[0]
    assert nodes(used["id"], "viewBlock")[0]["viewId"] == new_view["id"] != view
    second = ok(use_template(client, a, saved["id"], space=world["sa"], title="Again"))
    assert second["title"] == "Again" and second["id"] != used["id"]


def test_template_into_another_project_shows_that_projects_tasks(client, world):
    b = world["b"]
    page = create(client, b, world["sa"], "Board page")
    view = add_view(client, b, page["id"], f"tasks:{world['pa']}", "Board", "board", {"query": {}})
    put_doc(page["id"], lambda f: f.children.append(XmlElement("viewBlock", {"viewId": view})))
    saved = ok(save_template(client, b, page["id"], "Board"))
    into_beta = ok(use_template(client, b, saved["id"], space=world["sb"]))
    assert own_views(client, b, into_beta["id"])[0]["tableRef"] == f"tasks:{world['pb']}"
    into_me = ok(use_template(client, b, saved["id"], space="me"))
    assert own_views(client, b, into_me["id"])[0]["tableRef"] == "tasks:*"
    # a's templates need create rights in the target
    assert use_template(client, b, saved["id"], space="p:nope").status_code == 404
    mine = ok(save_template(client, world["a"], create(client, world["a"], world["sa"], "X")["id"], "A's"))
    assert use_template(client, world["a"], mine["id"], space=world["sb"]).status_code == 403


def test_template_scopes_and_who_may_delete(client, world):
    a, b = world["a"], world["b"]
    page = create(client, a, world["sa"], "Src")
    personal = ok(save_template(client, a, page["id"], "Mine only"))
    assert save_template(client, a, page["id"], "Nope", scope="workspace").status_code == 403  # admins only
    shared = ok(save_template(client, world["admin"], create(client, world["admin"], "me", "Adm")["id"], "For all",
                              scope="workspace"))
    assert client.post('/api/templates', json={'pageId': page['id'], 'name': ''}, headers=auth(a)).status_code == 400
    assert save_template(client, a, page["id"], "x", scope="everyone").status_code == 400
    assert save_template(client, b, page["id"], "x").status_code == 200  # b reads Alpha, may save a copy
    assert save_template(client, world["outsider"], page["id"], "x").status_code == 403

    assert personal["id"] in listing(client, a) and personal["id"] not in listing(client, b)
    assert shared["id"] in listing(client, a) and shared["id"] in listing(client, b)
    assert listing(client, a)[shared["id"]]["scope"] == "workspace" and not listing(client, a)[shared["id"]]["canDelete"]
    assert listing(client, world["admin"])[shared["id"]]["canDelete"]

    assert use_template(client, b, personal["id"], space="me").status_code == 404  # not visible
    assert client.delete(f"/api/templates/{personal['id']}", headers=auth(b)).status_code == 404
    assert client.delete(f"/api/templates/{personal['id']}", headers=auth(world["admin"])).status_code == 404
    assert client.delete(f"/api/templates/{shared['id']}", headers=auth(a)).status_code == 403
    assert use_template(client, b, shared["id"], space="me").status_code == 200
    assert client.delete(f"/api/templates/{shared['id']}", headers=auth(world["admin"])).status_code == 200
    assert client.delete(f"/api/templates/{personal['id']}", headers=auth(a)).status_code == 200
    assert personal["id"] not in listing(client, a) and shared["id"] not in listing(client, b)
    assert client.delete("/api/templates/builtin:blank", headers=auth(world["admin"])).status_code == 400
    assert client.get("/api/templates").status_code == 401


def test_a_template_of_the_tasks_page_has_no_system_key(client, world):
    a = world["a"]
    system = next(r for r in ok(client.get(f"/api/spaces/{world['sa']}/pages", headers=auth(a))) if r["system"])
    saved = ok(save_template(client, a, system["id"], "Tasks"))
    used = ok(use_template(client, a, saved["id"], space=world["sa"]))
    assert used["system"] is None


# ---------- built-in templates ----------

def test_builtins_are_listed_and_cannot_be_deleted(client, world):
    items = listing(client, world["a"])
    for template in builtin_templates.BUILTIN:
        entry = items[template["id"]]
        assert entry["scope"] == "builtin" and entry["canDelete"] is False and entry["name"] == template["name"]
    assert {"Blank page", "Meeting notes", "Project brief", "Shot list", "Weekly plan"} <= {t["name"] for t in items.values()}


@pytest.mark.parametrize("builtin", [t["id"] for t in builtin_templates.BUILTIN])
@pytest.mark.parametrize("where", ["project", "me"])
def test_every_builtin_opens_with_its_views(client, world, builtin, where):
    a = world["a"]
    space = world["sa"] if where == "project" else "me"
    made = ok(use_template(client, a, builtin, space=space))
    assert made["space"] == space and client.get(f"/api/pages/{made['id']}", headers=auth(a)).status_code == 200
    views = own_views(client, a, made["id"])
    block_ids = [n["viewId"] for n in nodes(made["id"], "viewBlock")]
    assert sorted(block_ids) == sorted(v["id"] for v in views)  # every block has its view
    for view in views:  # and each view can be queried
        res = client.post(f"/api/tables/{view['tableRef']}/query", json=view["config"]["query"], headers=auth(a))
        assert res.status_code == 200, res.text
        if view["tableRef"].startswith("tasks:") and where == "project":
            assert view["tableRef"] == f"tasks:{world['pa']}"
        if view["tableRef"].startswith("tasks:") and where == "me":
            assert view["tableRef"] == "tasks:*"
    if builtin != "builtin:blank":
        assert text_of(made["id"])
    if builtin == "builtin:meeting-notes":
        assert [h for h in text_of(made["id"]).split("\n") if h in ("Attendees", "Agenda", "Notes", "Action items")] == \
            ["Attendees", "Agenda", "Notes", "Action items"]
    if builtin == "builtin:project-brief":
        assert [v["layout"] for v in views] == ["gantt"]
    if builtin == "builtin:shot-list":
        ref = views[0]["tableRef"]
        assert ref.startswith("tbl_")
        schema = ok(client.get(f"/api/tables/{ref}/schema", headers=auth(a)))
        assert [(c["name"], c["type"]) for c in schema["columns"] if not c.get("builtin")] == [
            ("Description", "text"), ("Status", "select"), ("Assignee", "person"),
            ("Due date", "date")]


def test_builtin_title_parent_and_permissions(client, world):
    a = world["a"]
    parent = create(client, a, world["sa"], "Folder")
    made = ok(use_template(client, a, "builtin:meeting-notes", space=world["sa"], parentId=parent["id"], title="Standup"))
    assert made["title"] == "Standup" and made["parentId"] == parent["id"]
    assert use_template(client, a, "builtin:meeting-notes", space=world["sa"], parentId="nope").status_code == 400
    assert use_template(client, world["reader"], "builtin:blank", space=world["sa"]).status_code == 403
    assert use_template(client, world["outsider"], "builtin:blank", space=world["sa"]).status_code == 403
    assert use_template(client, a, "builtin:nope", space="me").status_code == 404
    assert use_template(client, a, "builtin:blank").status_code == 400


# ---------- project setup copy ----------

def copy_setup(client, token, project_id, source):
    return client.post(f"/api/projects/{project_id}/copy-setup", json={"from": source}, headers=auth(token))


def test_copy_setup_copies_pages_columns_tables_and_task_views_but_no_tasks(client, world, make_project, admin):
    src = world["pa"]
    a = world["a"]
    key = add_column(client, world["admin"], f"tasks:{src}", "Budget", "number")
    root = create(client, a, world["sa"], "Handbook")
    create(client, a, world["sa"], "Chapter", parent=root["id"])
    table = make_table(client, a, world["sa"], "Locations", [{"name": "Place", "type": "text"}])
    ok(client.post(f"/api/tables/{table}/rows", json={"values": {"name": "Oslo"}}, headers=auth(a)))
    add_view(client, a, root["id"], table, "Places")
    tasks_page = next(r for r in ok(client.get(f"/api/spaces/{world['sa']}/pages", headers=auth(a))) if r["system"])
    tview = own_views(client, a, tasks_page["id"])[0]
    client.patch(f"/api/views/{tview['id']}", json={"config": {"query": {"parentId": None}, "columns": [{"key": key}]}},
                 headers=auth(a))
    ok(client.post(f"/api/projects/{src}/tasks", json={"name": "A real task"}, headers=auth(a)))

    target = make_project("Fresh")
    res = ok(copy_setup(client, world["admin"], target, src))
    assert res["pages"] == 2 and res["columns"] == 1 and res["tables"] == 1

    space = f"p:{target}"
    rows = ok(client.get(f"/api/spaces/{space}/pages", headers=auth(world["admin"])))
    assert sorted(r["title"] for r in rows) == ["Chapter", "Handbook", "Tasks"]
    assert len([r for r in rows if r["system"] == "tasks"]) == 1
    # the columns exist in the new project and the Tasks view uses them
    cols = ok(client.get(f"/api/tables/tasks:{target}/schema", headers=auth(world["admin"])))["columns"]
    assert any(c["key"] == key and c["name"] == "Budget" for c in cols)
    new_tasks_page = next(r for r in rows if r["system"])
    view, = own_views(client, world["admin"], new_tasks_page["id"])
    assert view["tableRef"] == f"tasks:{target}" and view["config"]["columns"] == [{"key": key}]
    assert [n["viewId"] for n in nodes(new_tasks_page["id"], "viewBlock")] == [view["id"]]
    # a table with the same columns but no rows
    handbook = next(r for r in rows if r["title"] == "Handbook")
    place, = own_views(client, world["admin"], handbook["id"])
    assert place["tableRef"] != table
    schema = ok(client.get(f"/api/tables/{place['tableRef']}/schema", headers=auth(world["admin"])))
    assert any(c["name"] == "Place" for c in schema["columns"])
    assert ok(client.post(f"/api/tables/{place['tableRef']}/query", json={}, headers=auth(world["admin"])))["total"] == 0
    # never tasks or members
    assert ok(client.post(f"/api/tables/tasks:{target}/query", json={}, headers=auth(world["admin"])))["total"] == 0
    access = ok(client.get(f"/api/projects/{target}/access", headers=auth(world["admin"])))["access"]
    assert [m["username"] for m in access] == ["admin"]  # only the creator; the source's members are not copied
    # the source is unchanged
    assert ok(client.post(f"/api/tables/tasks:{src}/query", json={}, headers=auth(a)))["total"] == 1
    assert len(ok(client.get(f"/api/spaces/{world['sa']}/pages", headers=auth(a)))) == 3


def test_copy_setup_rules(client, world, make_project, make_user, grant):
    src = world["pa"]
    target = make_project("Target")
    maker = make_user()
    grant(target, maker["user"]["id"], can_tasks=True)  # member but not owner
    assert copy_setup(client, maker["token"], target, src).status_code == 403
    assert copy_setup(client, world["admin"], target, target).status_code == 400
    assert copy_setup(client, world["admin"], target, "nope").status_code == 404
    assert client.post(f"/api/projects/{target}/copy-setup", json={}, headers=auth(world["admin"])).status_code == 400
    ok(copy_setup(client, world["admin"], target, src))
    create(client, world["admin"], f"p:{target}", "Mine now")
    assert copy_setup(client, world["admin"], target, src).status_code == 409  # not a new project any more
    # a project nobody gave you access to cannot be a source
    other = make_project("Closed")
    owner = make_user()
    mine = make_project("Mine", token=owner["token"])
    assert copy_setup(client, owner["token"], mine, other).status_code == 403


# ---------- relation columns ----------

def test_relation_columns_follow_the_copied_tables_and_are_dropped_where_invalid(client, world):
    b = world["b"]
    page = create(client, b, world["sa"], "Rel")
    people = make_table(client, world["admin"], world["sa"], "People", [{"name": "Who", "type": "text"}])
    work = make_table(client, world["admin"], world["sa"], "Work", [{"name": "Note", "type": "text"}])
    ok(client.post(f"/api/tables/{work}/columns", json={"name": "Owner", "type": "relation",
                   "config": {"target": people}}, headers=auth(world["admin"])))
    ok(client.post(f"/api/tables/{work}/columns", json={"name": "Tasks", "type": "relation",
                   "config": {"target": f"tasks:{world['pa']}"}}, headers=auth(world["admin"])))
    add_view(client, b, page["id"], people, "People")
    add_view(client, b, page["id"], work, "Work")

    def relations(ref):
        return {c["name"]: c["config"]["target"] for c in
                ok(client.get(f"/api/tables/{ref}/schema", headers=auth(b)))["columns"] if c["type"] == "relation"}

    # same project: both relations stay, the table target points at the copied table
    copy = ok(duplicate(client, b, page["id"]))
    views = {v["name"]: v for v in own_views(client, b, copy["id"])}
    assert relations(views["Work"]["tableRef"]) == {"Owner": views["People"]["tableRef"],
                                                    "Tasks": f"tasks:{world['pa']}"}
    # another project: the tasks relation is invalid there and is dropped
    other = ok(duplicate(client, b, page["id"], space=world["sb"]))
    views = {v["name"]: v for v in own_views(client, b, other["id"])}
    assert relations(views["Work"]["tableRef"]) == {"Owner": views["People"]["tableRef"]}
    # personal space: tasks of a project the user can use stay
    mine = ok(duplicate(client, b, page["id"], space="me"))
    views = {v["name"]: v for v in own_views(client, b, mine["id"])}
    assert relations(views["Work"]["tableRef"]) == {"Owner": views["People"]["tableRef"],
                                                    "Tasks": f"tasks:{world['pa']}"}
