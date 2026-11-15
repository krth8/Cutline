"""Page history (H2): automatic and named versions, retention, permissions, restoring into a live room."""

import base64
import time
from datetime import datetime, timedelta

import pytest
from pycrdt import Doc, XmlElement, XmlText

from api import pagehistory
from api.pagesync import extract_text, registry
from database.engine import execute, fetchone
from database.page_versions import db_create_version, db_list_versions
from database.utils import get_db

from conftest import auth
from test_pages import create, make_task, team  # noqa: F401  (team is a fixture)
from test_pagesync import Peer, connect_page, page, paragraph, snapshot  # noqa: F401  (fixtures)


# ---------- helpers ----------

def versions(client, token, page_id):
    res = client.get(f"/api/pages/{page_id}/versions", headers=auth(token))
    assert res.status_code == 200, res.text
    return res.json()


def state_text(version):
    doc = Doc()
    doc.apply_update(base64.b64decode(version["state"]))
    return extract_text(doc)


def get_version(client, token, page_id, vid):
    res = client.get(f"/api/pages/{page_id}/versions/{vid}", headers=auth(token))
    assert res.status_code == 200, res.text
    return res.json()


def save(client, token, page_id, name="Draft"):
    res = client.post(f"/api/pages/{page_id}/versions", json={"name": name}, headers=auth(token))
    assert res.status_code == 201, res.text
    return res.json()


def restore(client, token, page_id, vid):
    return client.post(f"/api/pages/{page_id}/versions/{vid}/restore", headers=auth(token))


def room_closed(page_id):
    """Wait until the server has handled the disconnect (the room is dropped after the last socket left)."""
    deadline = time.monotonic() + 5
    while page_id in registry.rooms and time.monotonic() < deadline:
        time.sleep(0.02)
    assert page_id not in registry.rooms


def user_id(client, token):
    return client.get("/api/auth/me", headers=auth(token)).json()["user"]["id"]


def type_text(peer, text):
    """Replace the page content of a peer by one paragraph."""
    def fn():
        while len(peer.frag.children):
            del peer.frag.children[0]
        paragraph(peer.frag, text)
    peer.edit(fn)


@pytest.fixture
def second_editor(make_user, grant, team):  # noqa: F811
    user = make_user()
    grant(team["project"], user["user"]["id"], can_tasks=True)
    return user


def shape(node):
    """The content of a node as plain data: tags, attributes, text runs with their marks."""
    if isinstance(node, XmlText):
        return ("text", [(run, dict(attrs) if attrs else None) for run, attrs in node.diff()])
    return (node.tag, sorted((k, v) for k, v in dict(node.attributes).items()), [shape(c) for c in node.children])


def build_rich(frag):
    def add(parent, tag, attrs=None):
        e = XmlElement(tag)
        parent.children.append(e)
        for k, v in (attrs or {}).items():
            e.attributes[k] = v
        return e

    add(frag, "heading", {"level": 2}).children.append(XmlText("Title"))
    p = add(frag, "paragraph")
    t = XmlText("plain bold and link")
    p.children.append(t)
    t.format(6, 10, {"bold": True})
    t.format(15, 19, {"link": {"href": "https://example.com", "target": "_blank"}})
    add(p, "mention", {"kind": "user", "id": "u-1", "label": "Anna"})
    outer = add(frag, "bulletList")
    item = add(outer, "listItem")
    add(item, "paragraph").children.append(XmlText("one"))
    inner_item = add(add(item, "bulletList"), "listItem")
    add(inner_item, "paragraph").children.append(XmlText("nested"))
    add(frag, "viewBlock", {"viewId": "view-123"})
    add(frag, "image", {"src": "/files/a.png", "alt": "A", "width": 300})
    add(frag, "paragraph")  # an empty paragraph


# ---------- migration ----------

def test_page_versions_table():
    with get_db() as conn:
        cols = {r[1] for r in execute(conn, "PRAGMA table_info(page_versions)").fetchall()}
    assert {"id", "page_id", "created_at", "created_by", "name", "kind", "state", "text_length", "excerpt",
            "editors"} <= cols


# ---------- automatic versions ----------

def test_automatic_version_only_when_changed_and_old_enough(client, connect_page, team, page, monkeypatch):
    with connect_page(team["member"], page) as ws:
        peer = Peer(ws)
        type_text(peer, "first")
        peer.sync()
        snapshot(client, page)
        listed = versions(client, team["member"], page)
        assert [v["kind"] for v in listed] == ["auto"]
        assert listed[0]["excerpt"] == "first" and listed[0]["name"] is None

        # changed, but the last automatic version is younger than the threshold: none
        type_text(peer, "second")
        peer.sync()
        snapshot(client, page)
        assert len(versions(client, team["member"], page)) == 1

        # nothing changed since the last snapshot: a snapshot with no rows takes nothing
        monkeypatch.setattr(pagehistory, "AUTO_VERSION_INTERVAL", timedelta(0))
        snapshot(client, page)
        assert len(versions(client, team["member"], page)) == 1

        # changed and old enough
        type_text(peer, "third")
        peer.sync()
        snapshot(client, page)
        listed = versions(client, team["member"], page)
        assert len(listed) == 2 and listed[0]["excerpt"] == "third"
        assert [e["id"] for e in listed[0]["editors"]] == [user_id(client, team["member"])]


def test_a_version_is_taken_when_the_last_editor_leaves(client, connect_page, team, page):
    with connect_page(team["member"], page) as ws:
        peer = Peer(ws)
        type_text(peer, "first")
        peer.sync()
        snapshot(client, page)  # first version
        type_text(peer, "second")
        peer.sync()
        snapshot(client, page)  # too young for another one
        assert len(versions(client, team["member"], page)) == 1
    room_closed(page)
    listed = versions(client, team["member"], page)
    assert len(listed) == 2 and listed[0]["excerpt"] == "second"


def test_no_version_when_nothing_changed_at_leave(client, connect_page, team, page):
    with connect_page(team["member"], page) as ws:
        Peer(ws)
    room_closed(page)
    assert versions(client, team["member"], page) == []


# ---------- named versions ----------

def test_named_version_contains_the_live_edits_not_yet_snapshotted(client, connect_page, team, page):
    with connect_page(team["member"], page) as ws:
        peer = Peer(ws)
        type_text(peer, "live only")
        peer.sync()
        created = save(client, team["member"], page, "  Before review  ")
        assert created["name"] == "Before review" and created["kind"] == "named"
        assert created["createdBy"]["id"] == user_id(client, team["member"])
        full = get_version(client, team["member"], page, created["id"])
        assert state_text(full) == "live only"
        assert versions(client, team["member"], page)[0]["id"] == created["id"]
    assert client.post(f"/api/pages/{page}/versions", json={"name": " "}, headers=auth(team["member"])).status_code == 400


def test_rename_protects_and_delete_only_named(client, connect_page, team, page):
    with connect_page(team["member"], page) as ws:
        type_text(Peer(ws), "x")
    room_closed(page)
    auto = versions(client, team["member"], page)[0]
    assert auto["kind"] == "auto"
    res = client.delete(f"/api/pages/{page}/versions/{auto['id']}", headers=auth(team["member"]))
    assert res.status_code == 400
    res = client.patch(f"/api/pages/{page}/versions/{auto['id']}", json={"name": "Keep"}, headers=auth(team["member"]))
    assert res.status_code == 200 and res.json()["name"] == "Keep"
    res = client.delete(f"/api/pages/{page}/versions/{auto['id']}", headers=auth(team["member"]))
    assert res.status_code == 204
    assert versions(client, team["member"], page) == []
    assert client.get(f"/api/pages/{page}/versions/{auto['id']}", headers=auth(team["member"])).status_code == 404


# ---------- permissions ----------

def test_permissions(client, team, page, share, second_editor):
    vid = save(client, team["member"], page, "V1")["id"]
    base = f"/api/pages/{page}/versions"

    for token in (team["member"], second_editor["token"]):
        assert client.get(base, headers=auth(token)).status_code == 200
    assert client.patch(f"{base}/{vid}", json={"name": "V1b"}, headers=auth(second_editor["token"])).status_code == 200

    # a reader (project access without task rights) reads but never writes
    reader = team["reviewer"]
    assert client.get(base, headers=auth(reader)).status_code == 200
    assert client.get(f"{base}/{vid}", headers=auth(reader)).status_code == 200
    assert client.post(base, json={"name": "x"}, headers=auth(reader)).status_code == 403
    assert client.patch(f"{base}/{vid}", json={"name": "x"}, headers=auth(reader)).status_code == 403
    assert client.delete(f"{base}/{vid}", headers=auth(reader)).status_code == 403
    assert restore(client, reader, page, vid).status_code == 403

    # an outsider and a guest never
    guest = share(team["project"])["token"]
    for token in (team["outsider"], guest):
        assert client.get(base, headers=auth(token)).status_code == 403
        assert client.get(f"{base}/{vid}", headers=auth(token)).status_code == 403
        assert client.post(base, json={"name": "x"}, headers=auth(token)).status_code == 403
        assert restore(client, token, page, vid).status_code == 403
    assert client.get(base).status_code == 401

    assert client.get("/api/pages/nope/versions", headers=auth(team["member"])).status_code == 404
    assert client.get(f"{base}/nope", headers=auth(team["member"])).status_code == 404


def test_personal_page_history_is_private(client, team, make_user):
    owner, other = make_user(), make_user()
    own = create(client, owner["token"], "me", "Mine")["id"]
    created = save(client, owner["token"], own, "Mine v1")
    base = f"/api/pages/{own}/versions"
    assert client.get(base, headers=auth(owner["token"])).status_code == 200
    for method, url, kw in (("get", base, {}), ("get", f"{base}/{created['id']}", {}),
                            ("post", base, {"json": {"name": "x"}}),
                            ("post", f"{base}/{created['id']}/restore", {})):
        assert getattr(client, method)(url, headers=auth(other["token"]), **kw).status_code == 403, url
        assert getattr(client, method)(url, headers=auth(team["member"]), **kw).status_code == 403, url


def test_task_pages_have_history(client, team):
    task_id = make_task(client, team["member"], team["project"])
    task_page = client.get(f"/api/tasks/{task_id}/page", headers=auth(team["member"])).json()["id"]
    created = save(client, team["member"], task_page, "Task v1")
    assert versions(client, team["member"], task_page)[0]["id"] == created["id"]
    assert client.get(f"/api/pages/{task_page}/versions", headers=auth(team["outsider"])).status_code == 403


# ---------- retention ----------

def test_retention_rule():
    at = datetime(2026, 6, 30, 12, 0)

    def row(i, delta):
        return {"id": i, "createdAt": (at - delta).isoformat()}

    rows = [
        row("a", timedelta(hours=1)), row("b", timedelta(hours=23)),                 # younger than 24 h: kept
        row("c", timedelta(days=2, hours=1)), row("d", timedelta(days=2, hours=5)),  # same day: newest kept
        row("e", timedelta(days=3)),                                                  # another day: kept
        row("f", timedelta(days=40)), row("g", timedelta(days=47)),                   # different weeks: both kept
        row("h", timedelta(days=47, hours=1)),                                        # same week as g: dropped
    ]
    rows.sort(key=lambda r: r["createdAt"], reverse=True)
    assert sorted(pagehistory.versions_to_thin(rows, at)) == ["d", "h"]


def test_retention_cap_and_named_versions_survive(client, team, page, monkeypatch):
    monkeypatch.setattr(pagehistory, "MAX_UNNAMED_VERSIONS", 3)
    state = Doc().get_update()
    named = db_create_version(page, state, "", "named", name="Keep me",
                              created_at=(datetime.now() - timedelta(days=100)).isoformat())
    for minutes in range(5):
        db_create_version(page, state, "", "auto", created_at=(datetime.now() - timedelta(minutes=minutes)).isoformat())
    client.portal.call(pagehistory.thin_versions, page)
    left = db_list_versions(page)
    assert len(left) == 4 and named["id"] in [v["id"] for v in left]
    assert [v["kind"] for v in left].count("auto") == 3


def test_a_named_automatic_version_is_not_thinned(client, team, page):
    state = Doc().get_update()
    noon = datetime.now().replace(hour=12, minute=0, second=0, microsecond=0) - timedelta(days=5)  # one calendar day
    keep = db_create_version(page, state, "", "auto", name="Named", created_at=(noon + timedelta(minutes=2)).isoformat())
    gone = db_create_version(page, state, "", "auto", created_at=noon.isoformat())
    newest = db_create_version(page, state, "", "auto", created_at=(noon + timedelta(minutes=1)).isoformat())
    client.portal.call(pagehistory.thin_versions, page)
    ids = [v["id"] for v in db_list_versions(page)]
    assert keep["id"] in ids and newest["id"] in ids and gone["id"] not in ids


# ---------- restore ----------

def test_restore_with_two_connected_peers(client, connect_page, team, page, second_editor, ticket):
    with connect_page(team["member"], page) as ws_a, \
            client.websocket_connect(f"/ws/pages/{page}?ticket={ticket(second_editor['token'])}") as ws_b:
        a, b = Peer(ws_a), Peer(ws_b)
        type_text(a, "old text")
        a.sync()
        b.sync()
        assert b.text() == "old text"
        named = save(client, team["member"], page, "Old")

        type_text(a, "newer text by A")
        a.sync()
        b.sync()
        b.edit(lambda: paragraph(b.frag, "and a paragraph by B"))
        a.sync()
        assert a.text() == b.text() and "newer" in a.text()

        res = restore(client, team["member"], page, named["id"])
        assert res.status_code == 200, res.text
        a.sync()
        b.sync()
        assert a.text() == b.text() == "old text"

        # sessions stay usable: later edits sync both ways
        a.edit(lambda: paragraph(a.frag, "after restore A"))
        b.sync()
        b.edit(lambda: paragraph(b.frag, "after restore B"))
        a.sync()
        assert a.text() == b.text() == "old text\nafter restore A\nafter restore B"

        before = next(v for v in versions(client, team["member"], page) if v["kind"] == "before_restore")
        assert state_text(get_version(client, team["member"], page, before["id"])) == \
            "newer text by A\nand a paragraph by B"

        # restoring twice in a row works, and the pre-restore state can be restored too
        assert restore(client, team["member"], page, named["id"]).status_code == 200
        assert restore(client, team["member"], page, named["id"]).status_code == 200
        a.sync()
        b.sync()
        assert a.text() == b.text() == "old text"
        assert restore(client, team["member"], page, before["id"]).status_code == 200
        a.sync()
        b.sync()
        assert a.text() == b.text() == "newer text by A\nand a paragraph by B"
    snapshot(client, page)
    with get_db() as conn:
        stored = fetchone(execute(conn, "SELECT text FROM pages WHERE id = ?", (page,)))["text"]
    assert stored == "newer text by A\nand a paragraph by B"


def test_restore_sends_a_page_changed_event(client, team, page, monkeypatch):
    sent = []

    async def fake_to_project(project_id, message):
        sent.append((project_id, message))

    import api.routes.pages as pages_routes
    monkeypatch.setattr(pages_routes.live, "to_project", fake_to_project)
    named = save(client, team["member"], page, "V")
    assert restore(client, team["member"], page, named["id"]).status_code == 200
    assert sent and sent[-1][1]["change"] == "restored" and sent[-1][1]["pageId"] == page


def test_restore_without_anyone_connected_and_of_an_archived_page(client, connect_page, team, page):
    with connect_page(team["member"], page) as ws:
        peer = Peer(ws)
        type_text(peer, "kept")
        peer.sync()
        named = save(client, team["member"], page, "K")
        type_text(peer, "changed")
        peer.sync()
    assert restore(client, team["member"], page, named["id"]).status_code == 200
    with connect_page(team["member"], page) as ws:
        assert Peer(ws).text() == "kept"
    client.patch(f"/api/pages/{page}", json={"archived": True}, headers=auth(team["member"]))
    assert restore(client, team["member"], page, named["id"]).status_code == 400


def test_rich_content_round_trips_exactly(client, connect_page, team, page, second_editor, ticket):
    with connect_page(team["member"], page) as ws_a, \
            client.websocket_connect(f"/ws/pages/{page}?ticket={ticket(second_editor['token'])}") as ws_b:
        a, b = Peer(ws_a), Peer(ws_b)
        a.edit(lambda: build_rich(a.frag))
        a.sync()
        b.sync()
        expected = [shape(c) for c in a.frag.children]
        flat = repr(expected)
        for needle in ("bold", "link", "viewBlock", "mention", "image", "bulletList"):
            assert needle in flat
        named = save(client, team["member"], page, "Rich")

        type_text(a, "something else entirely")
        a.sync()
        b.sync()
        assert restore(client, team["member"], page, named["id"]).status_code == 200
        a.sync()
        b.sync()
        assert [shape(c) for c in a.frag.children] == expected
        assert [shape(c) for c in b.frag.children] == expected

    # the stored copy, loaded fresh, has the same content
    snapshot(client, page)
    with connect_page(team["member"], page) as ws:
        fresh = Peer(ws)
        assert [shape(c) for c in fresh.frag.children] == expected
