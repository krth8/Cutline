"""Mentions: the @ menu search, page_refs at snapshot, backlinks, notifications, resolving chips."""

import pytest
from pycrdt import XmlElement, XmlText

from api.pagesync import registry
from api.state import projects
from database.engine import execute, fetchall
from database.mentions import db_get_page_refs
from database.utils import get_db

from conftest import auth
from test_pagesync import Peer, connect_page, snapshot  # noqa: F401  (connect_page is a fixture)
from test_pages import create, make_task, team  # noqa: F401  (team is a fixture)


def add_mentions(peer, *items):
    """Append a paragraph that holds one mention node per (kind, id)."""
    def edit():
        p = XmlElement("paragraph")
        peer.frag.children.append(p)
        p.children.append(XmlText("see "))
        for kind, target_id in items:
            p.children.append(XmlElement("mention", {"kind": kind, "id": target_id, "label": "x"}))
    peer.edit(edit)
    peer.sync()


def clear(peer):
    peer.edit(lambda: peer.frag.children.__delitem__(slice(0, len(peer.frag.children))))
    peer.sync()


def notes(client, token):
    res = client.get("/api/notifications", headers=auth(token))
    return [n for n in res.json()["notifications"] if n["type"] == "mention"]


@pytest.fixture
def scene(client, team, make_user, grant):
    """A project page, an author (editor of the project), a second member, and a task."""
    author, other = make_user(), make_user()
    grant(team["project"], author["user"]["id"], can_tasks=True)
    grant(team["project"], other["user"]["id"], can_tasks=True)
    page = create(client, author["token"], team["space"], "Plan")["id"]
    return {**team, "author": author["token"], "author_id": author["user"]["id"], "other": other["token"],
            "other_id": other["user"]["id"], "page": page,
            "task": make_task(client, author["token"], team["project"], "Write script")}


# ---------- search ----------

def search(client, token, q="", space="me"):
    return client.get("/api/mentions/search", params={"q": q, "space": space}, headers=auth(token))


def test_search_finds_the_four_kinds_and_respects_access(client, scene):
    projects[scene["project"]].setdefault("clips", {})["shot_010"] = {"versions": [], "activeVersion": 1}
    page = create(client, scene["author"], scene["space"], "Shot list")["id"]
    res = search(client, scene["author"], "s", scene["space"])
    assert res.status_code == 200, res.text
    body = res.json()
    assert [t["id"] for t in body["tasks"]] == [scene["task"]]
    assert [c["id"] for c in body["clips"]] == [f"{scene['project']}:shot_010"]
    assert page in [p["id"] for p in body["pages"]]
    people = search(client, scene["author"], "", scene["space"]).json()["people"]
    assert people and all("label" in p and "id" in p for p in people)

    # the outsider sees nothing of the project
    outsider = search(client, scene["outsider"], "s", "me").json()
    assert outsider["tasks"] == [] and outsider["clips"] == [] and page not in [p["id"] for p in outsider["pages"]]
    assert search(client, scene["outsider"], "s", scene["space"]).status_code == 403


def test_task_and_clip_access_levels(client, scene):
    projects[scene["project"]].setdefault("clips", {})["reel_a"] = {"versions": [], "activeVersion": 1}
    # the reviewer has review access but no task access: clips yes, tasks no
    res = search(client, scene["reviewer"], "", scene["space"]).json()
    assert res["tasks"] == [] and "reel_a" in [c["label"] for c in res["clips"]]


def test_people_of_a_project_space_are_its_members(client, scene, make_user):
    stranger = make_user()
    ids = [p["id"] for p in search(client, scene["author"], "", scene["space"]).json()["people"]]
    assert scene["other_id"] in ids and stranger["user"]["id"] not in ids


def test_people_for_a_personal_page_are_those_sharing_a_project(client, scene, make_user):
    stranger = make_user()
    ids = [p["id"] for p in search(client, scene["author"], "", "me").json()["people"]]
    assert scene["other_id"] in ids and stranger["user"]["id"] not in ids


def test_search_is_capped_and_filtered_by_the_query(client, scene):
    for i in range(10):
        make_task(client, scene["author"], scene["project"], f"Capped {i}")
    assert len(search(client, scene["author"], "capped", scene["space"]).json()["tasks"]) == 8
    assert search(client, scene["author"], "capped 3", scene["space"]).json()["tasks"][0]["label"] == "Capped 3"


def test_personal_pages_are_found_only_by_their_owner(client, scene):
    mine = create(client, scene["author"], "me", "Secret diary")["id"]
    assert mine in [p["id"] for p in search(client, scene["author"], "diary").json()["pages"]]
    assert mine not in [p["id"] for p in search(client, scene["other"], "diary").json()["pages"]]


def test_guests_and_anonymous_are_refused(client, scene, share):
    guest = share(scene["project"])["token"]
    assert search(client, guest, "", scene["space"]).status_code == 403
    assert client.get("/api/mentions/search").status_code == 401
    assert client.get("/api/backlinks", params={"kind": "task", "id": "x"}, headers=auth(guest)).status_code == 403
    assert client.post("/api/mentions/resolve", json={"items": []}, headers=auth(guest)).status_code == 403


# ---------- page_refs ----------

def test_refs_are_written_at_snapshot_and_replaced_as_a_set(client, connect_page, scene):
    page = scene["page"]
    with connect_page(scene["author"], page) as ws:
        peer = Peer(ws)
        add_mentions(peer, ("task", scene["task"]), ("page", "other-page"), ("task", scene["task"]))
        assert db_get_page_refs(page) == set()  # nothing before the snapshot
        snapshot(client, page)
        assert db_get_page_refs(page) == {("task", scene["task"]), ("page", "other-page")}
        clear(peer)
        add_mentions(peer, ("person", scene["other_id"]))
        snapshot(client, page)
        assert db_get_page_refs(page) == {("user", scene["other_id"])}
    registry.forget()


def test_refs_are_removed_with_the_page(client, connect_page, scene):
    page = scene["page"]
    with connect_page(scene["author"], page) as ws:
        add_mentions(Peer(ws), ("task", scene["task"]))
        snapshot(client, page)
    registry.forget()
    assert client.patch(f"/api/pages/{page}", json={"archived": True}, headers=auth(scene["author"])).status_code == 200
    assert client.delete(f"/api/pages/{page}", headers=auth(scene["author"])).status_code == 200
    with get_db() as conn:
        assert fetchall(execute(conn, "SELECT 1 FROM page_refs WHERE page_id = ?", (page,))) == []


# ---------- backlinks ----------

def backlinks(client, token, kind, target_id):
    res = client.get("/api/backlinks", params={"kind": kind, "id": target_id}, headers=auth(token))
    assert res.status_code == 200, res.text
    return res.json()["pages"]


def test_backlinks_list_pages_the_caller_may_read(client, connect_page, scene):
    page = scene["page"]
    with connect_page(scene["author"], page) as ws:
        add_mentions(Peer(ws), ("task", scene["task"]))
        snapshot(client, page)
    found = backlinks(client, scene["other"], "task", scene["task"])
    assert [p["id"] for p in found] == [page]
    assert found[0]["title"] == "Plan" and found[0]["route"] == f"/p/{scene['project']}/page/{page}"
    # a personal page that mentions the task shows up for its owner only
    mine = create(client, scene["author"], "me", "Private notes")["id"]
    with connect_page(scene["author"], mine) as ws:
        add_mentions(Peer(ws), ("task", scene["task"]))
        snapshot(client, mine)
    assert {p["id"] for p in backlinks(client, scene["author"], "task", scene["task"])} == {page, mine}
    assert [p["id"] for p in backlinks(client, scene["other"], "task", scene["task"])] == [page]
    # no access to the task: nothing at all
    assert backlinks(client, scene["outsider"], "task", scene["task"]) == []
    assert backlinks(client, scene["reviewer"], "task", scene["task"]) == []
    registry.forget()


def test_backlinks_for_a_page_and_a_person(client, connect_page, scene):
    target = create(client, scene["author"], scene["space"], "Target")["id"]
    page = scene["page"]
    with connect_page(scene["author"], page) as ws:
        add_mentions(Peer(ws), ("page", target), ("person", scene["other_id"]))
        snapshot(client, page)
    assert [p["id"] for p in backlinks(client, scene["author"], "page", target)] == [page]
    assert [p["id"] for p in backlinks(client, scene["author"], "person", scene["other_id"])] == [page]
    assert client.get("/api/backlinks", params={"kind": "nope", "id": "x"}, headers=auth(scene["author"])).status_code == 400
    registry.forget()


# ---------- notifications ----------

def test_a_mentioned_person_is_notified_once_with_a_link(client, connect_page, scene):
    page = scene["page"]
    with connect_page(scene["author"], page) as ws:
        peer = Peer(ws)
        add_mentions(peer, ("person", scene["other_id"]))
        snapshot(client, page)
        made = notes(client, scene["other"])
        assert len(made) == 1 and made[0]["link"] == f"/p/{scene['project']}/page/{page}"
        assert "Plan" in made[0]["title"]
        # more edits, more snapshots, even removing and adding the chip again: still one notification
        add_mentions(peer, ("person", scene["other_id"]))
        snapshot(client, page)
        clear(peer)
        snapshot(client, page)
        add_mentions(peer, ("person", scene["other_id"]))
        snapshot(client, page)
    assert len(notes(client, scene["other"])) == 1
    registry.forget()


def test_no_notification_for_a_self_mention(client, connect_page, scene):
    page = scene["page"]
    with connect_page(scene["author"], page) as ws:
        add_mentions(Peer(ws), ("person", scene["author_id"]))
        snapshot(client, page)
    assert notes(client, scene["author"]) == []
    registry.forget()


def test_no_notification_when_the_person_cannot_read_the_page(client, connect_page, scene, make_user):
    stranger = make_user()
    page = scene["page"]
    with connect_page(scene["author"], page) as ws:
        add_mentions(Peer(ws), ("person", stranger["user"]["id"]))
        snapshot(client, page)
    assert notes(client, stranger["token"]) == []
    assert ("user", stranger["user"]["id"]) in db_get_page_refs(page)  # the chip is still recorded
    registry.forget()


def test_a_fresh_mention_makes_the_page_due_after_a_short_idle_time(client, connect_page, scene):
    page = scene["page"]
    with connect_page(scene["author"], page) as ws:
        peer = Peer(ws)
        add_mentions(peer, ("person", scene["other_id"]))
        room = registry.rooms[page]
        assert room.has_new_mention and scene["author_id"] in room.mention_authors
        room.last_update -= 5  # five seconds of quiet: not enough for a normal edit, enough for a mention
        client.portal.call(registry.snapshot_due)
        assert len(notes(client, scene["other"])) == 1
    registry.forget()


# ---------- resolve ----------

def resolve(client, token, *items):
    res = client.post("/api/mentions/resolve", json={"items": [{"kind": k, "id": i} for k, i in items]},
                      headers=auth(token))
    assert res.status_code == 200, res.text
    return res.json()["items"]


def test_resolve_gives_current_names_and_never_leaks_titles(client, scene):
    page = create(client, scene["author"], scene["space"], "Visible page")["id"]
    mine = create(client, scene["author"], "me", "Private title")["id"]
    ok = resolve(client, scene["other"], ("task", scene["task"]), ("page", page), ("person", scene["author_id"]))
    assert [i["ok"] for i in ok] == [True, True, True]
    assert ok[0]["title"] == "Write script" and ok[0]["route"] == f"?task={scene['task']}"
    assert ok[1]["title"] == "Visible page" and ok[1]["route"] == f"/p/{scene['project']}/page/{page}"

    # someone without access, and a target that does not exist, give the same bare answer
    denied = resolve(client, scene["outsider"], ("task", scene["task"]), ("page", page), ("page", mine),
                     ("page", "missing"), ("clip", f"{scene['project']}:nothing"))
    assert all(i == {"kind": i["kind"], "id": i["id"], "ok": False} for i in denied)
    assert resolve(client, scene["other"], ("page", mine))[0]["ok"] is False  # someone else's personal page
    # a task the reviewer cannot open
    assert resolve(client, scene["reviewer"], ("task", scene["task"]))[0] == {"kind": "task", "id": scene["task"], "ok": False}


def test_resolve_follows_renames(client, scene):
    page = create(client, scene["author"], scene["space"], "Old name")["id"]
    client.patch(f"/api/pages/{page}", json={"title": "New name"}, headers=auth(scene["author"]))
    assert resolve(client, scene["other"], ("page", page))[0]["title"] == "New name"


def test_resolve_validates_its_input(client, scene):
    assert client.post("/api/mentions/resolve", json={"items": [{"kind": "x", "id": "1"}]},
                       headers=auth(scene["author"])).status_code == 400
    assert client.post("/api/mentions/resolve", json={}, headers=auth(scene["author"])).status_code == 400
