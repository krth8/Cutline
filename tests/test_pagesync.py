"""Page sync: the Yjs WebSocket, snapshots, storage, access. pycrdt Docs act as the browser clients."""

import pytest
from pycrdt import Doc, XmlElement, XmlFragment, XmlText
from starlette.websockets import WebSocketDisconnect

import api.pagesync as pagesync
from api.pagesync import _write_varuint, awareness_removal, extract_text, registry
from database.engine import execute, fetchone
from database.pages import db_append_page_updates, db_load_page_state
from database.utils import get_db

from conftest import auth
from test_pages import create, make_task, patch, set_legacy, team  # noqa: F401  (team is a fixture)

SYNC, UPDATE, AWARENESS, STATE_VECTOR = 0, 1, 2, 3


# ---------- helpers ----------

class Peer:
    """A browser tab: a Doc plus a socket. Local edits are sent as type-1 frames."""

    def __init__(self, ws):
        self.ws = ws
        self.doc = Doc()
        self.frag = self.doc.get("default", type=XmlFragment)
        self.first = ws.receive_bytes()
        assert self.first[0] == SYNC
        self.doc.apply_update(self.first[1:])

    def edit(self, fn):
        before = self.doc.get_state()
        fn()
        self.ws.send_bytes(bytes([UPDATE]) + self.doc.get_update(before))

    def sync(self):
        """Read everything the server sent us up to the answer to a ping; returns the other frames."""
        self.ws.send_json({"type": "ping"})
        frames = []
        while True:
            msg = self.ws.receive()
            if msg.get("text") is not None:
                if '"pong"' in msg["text"]:
                    return frames
                frames.append(msg["text"])
                continue
            data = msg["bytes"]
            frames.append(data)
            if data[0] == UPDATE:
                self.doc.apply_update(data[1:])

    def text(self):
        return extract_text(self.doc)


def paragraph(frag, text, bold_first=0):
    p = XmlElement("paragraph")
    frag.children.append(p)
    t = XmlText(text)
    p.children.append(t)
    if bold_first:
        t.format(0, bold_first, {"bold": True})
    return t


def first_text(peer):
    return peer.frag.children[0].children[0]


@pytest.fixture
def connect_page(client, ticket):
    def _connect(token, page_id):
        return client.websocket_connect(f"/ws/pages/{page_id}?ticket={ticket(token)}")
    return _connect


@pytest.fixture
def page(client, team):
    return create(client, team["member"], team["space"], "Doc")["id"]


def rows(page_id):
    with get_db() as conn:
        return fetchone(execute(conn, "SELECT COUNT(*) AS n FROM page_updates WHERE page_id = ?", (page_id,)))["n"]


def page_row(page_id):
    with get_db() as conn:
        return fetchone(execute(conn, "SELECT ydoc, text, updated_at FROM pages WHERE id = ?", (page_id,)))


def snapshot(client, page_id):
    return client.portal.call(registry.snapshot, page_id)


def refused_with(connect_page, token, page_id):
    with pytest.raises(WebSocketDisconnect) as closed:
        with connect_page(token, page_id) as ws:
            ws.receive_bytes()
    return closed.value.code


def wait_closed(ws):
    """Read until the server closes the socket (raises WebSocketDisconnect with the close code)."""
    while True:
        ws._raise_on_close(ws.receive())


def aw_frame(client_id, clock, state=b'{"user":"x"}'):
    w = _write_varuint
    return bytes([AWARENESS]) + w(1) + w(client_id) + w(clock) + w(len(state)) + state


# ---------- migration ----------

def test_page_updates_table():
    with get_db() as conn:
        cols = {r[1] for r in execute(conn, "PRAGMA table_info(page_updates)").fetchall()}
        idx = {r[1] for r in execute(conn, "PRAGMA index_list(page_updates)").fetchall()}
    assert {"id", "page_id", "update", "created_at"} <= cols
    assert "idx_page_updates_page" in idx


# ---------- convergence ----------

def test_two_clients_converge_both_ways_and_on_concurrent_edits(connect_page, team, page):
    with connect_page(team["member"], page) as wa, connect_page(team["viewer"], page) as wb:
        a, b = Peer(wa), Peer(wb)
        a.edit(lambda: paragraph(a.frag, "Hello world"))
        a.sync()
        b.sync()
        assert b.text() == "Hello world"
    # (the viewer above is read-only; the two-way test uses two editors)
    other = team["member"]
    with connect_page(team["member"], page) as wa, connect_page(other, page) as wb:
        a, b = Peer(wa), Peer(wb)
        assert a.text() == b.text() == "Hello world"
        b.edit(lambda: first_text(b).insert(5, ","))
        b.sync()
        a.sync()
        assert a.text() == "Hello, world"
        # both type in the same paragraph before seeing each other's edit
        a.edit(lambda: first_text(a).insert(0, "AAA "))
        b.edit(lambda: first_text(b).insert(len(first_text(b)), " BBB"))
        a.sync(), b.sync(), a.sync(), b.sync()
        assert a.text() == b.text() == "AAA Hello, world BBB"


def test_late_joiner_gets_the_full_state_in_type_0(connect_page, team, page):
    with connect_page(team["member"], page) as wa:
        a = Peer(wa)
        a.edit(lambda: paragraph(a.frag, "Early text"))
        a.sync()
        with connect_page(team["viewer"], page) as wc:
            assert Peer(wc).text() == "Early text"


def test_state_vector_returns_only_what_is_missing(connect_page, team, page):
    with connect_page(team["member"], page) as wa:
        a = Peer(wa)
        a.edit(lambda: paragraph(a.frag, "One"))
        a.sync()
        with connect_page(team["viewer"], page) as wc:
            c = Peer(wc)
            known = c.doc.get_state()
            a.edit(lambda: first_text(a).insert(3, " two"))
            a.sync()
            wc.send_bytes(bytes([STATE_VECTOR]) + known)
            frames = [f for f in c.sync() if isinstance(f, bytes) and f[0] == UPDATE]
            assert frames and c.text() == "One two"
            # the diff holds the missing edit only, not the whole document
            assert len(frames[-1]) < len(c.first) + 30
            diff_doc = Doc()
            diff_doc.apply_update(frames[-1][1:])
            # a client that is complete gets an empty diff back
            wc.send_bytes(bytes([STATE_VECTOR]) + c.doc.get_state())
            reply = [f for f in c.sync() if isinstance(f, bytes)][-1]
            assert reply[0] == UPDATE and len(reply) <= 3


# ---------- storage ----------

def test_content_survives_a_restart_from_rows_and_from_a_snapshot(client, connect_page, team, page):
    with connect_page(team["member"], page) as wa:
        a = Peer(wa)
        a.edit(lambda: paragraph(a.frag, "Persist me"))
        a.sync()
        assert rows(page) >= 1 and page_row(page)["ydoc"] is None
        registry.forget()  # the process "dies" with the socket still open
    with connect_page(team["member"], page) as wa:  # loads from the pending rows
        assert Peer(wa).text() == "Persist me"
        assert snapshot(client, page) >= 1
        assert rows(page) == 0
        registry.forget()
    with connect_page(team["member"], page) as wa:  # loads from pages.ydoc only
        assert Peer(wa).text() == "Persist me"


def test_snapshot_merges_rows_sets_text_and_keeps_rows_arriving_meanwhile(client, connect_page, team, page, monkeypatch):
    with connect_page(team["member"], page) as wa:
        a = Peer(wa)
        a.edit(lambda: paragraph(a.frag, "Hello bold", bold_first=5))  # "Hello" is bold
        a.edit(lambda: paragraph(a.frag, "Second block"))
        a.sync()
        assert rows(page) == 2
        before = page_row(page)["updated_at"]

        late = Doc()
        paragraph(late.get("default", type=XmlFragment), "Late")
        late_update = late.get_update()
        real = pagesync.db_load_page_state

        def load_then_a_row_arrives(page_id):
            result = real(page_id)
            db_append_page_updates(page_id, [late_update])
            return result

        monkeypatch.setattr(pagesync, "db_load_page_state", load_then_a_row_arrives)
        assert snapshot(client, page) == 2
        monkeypatch.undo()

        assert rows(page) == 1  # the row that arrived during the snapshot survived
        row = page_row(page)
        assert row["text"] == "Hello bold\nSecond block"  # no <bold> tags
        assert row["updated_at"] >= before
        assert row["ydoc"] is not None
        _snap, pending = db_load_page_state(page)
        assert pending[0][1] == late_update


def test_extract_text_is_plain_and_block_separated():
    doc = Doc()
    frag = doc.get("default", type=XmlFragment)
    paragraph(frag, "a bold word", bold_first=1)
    lst = XmlElement("bulletList")
    frag.children.append(lst)
    for word in ("one", "two"):
        item = XmlElement("listItem")
        lst.children.append(item)
        p = XmlElement("paragraph")
        item.children.append(p)
        p.children.append(XmlText(word))
    assert extract_text(doc) == "a bold word\none\ntwo"


def test_noop_and_repeated_updates_are_not_stored(connect_page, team, page):
    with connect_page(team["member"], page) as wa:
        a = Peer(wa)
        before = a.doc.get_state()
        paragraph(a.frag, "Once")
        update = a.doc.get_update(before)
        wa.send_bytes(bytes([UPDATE]) + update)
        wa.send_bytes(bytes([UPDATE]) + update)  # the same again, as after a reconnect
        wa.send_bytes(bytes([UPDATE]) + Doc().get_update())  # an empty update
        a.sync()
        assert rows(page) == 1


def test_the_job_snapshots_pages_with_many_rows(client, connect_page, team, page, monkeypatch):
    monkeypatch.setattr(pagesync, "SNAPSHOT_MAX_ROWS", 3)
    with connect_page(team["member"], page) as wa:
        a = Peer(wa)
        a.edit(lambda: paragraph(a.frag, "x"))
        for _ in range(4):
            a.edit(lambda: first_text(a).insert(0, "y"))
        a.sync()
        assert rows(page) == 5
        client.portal.call(registry.snapshot_due)
        assert rows(page) == 0 and page_row(page)["text"] == "yyyyx"


# ---------- access ----------

def test_read_only_reader_gets_updates_but_cannot_change_the_document(connect_page, team, page):
    with connect_page(team["member"], page) as wa, connect_page(team["viewer"], page) as wv:
        a, v = Peer(wa), Peer(wv)
        assert wv.receive_json() == {"type": "readonly"}
        a.edit(lambda: paragraph(a.frag, "From the editor"))
        a.sync()
        v.sync()
        assert v.text() == "From the editor"
        v.edit(lambda: first_text(v).insert(0, "HACK "))
        v.sync()
        a.sync()
        assert a.text() == "From the editor"
        assert rows(page) == 1
        # awareness still goes through
        frame = aw_frame(9, 1)
        wv.send_bytes(frame)
        v.sync()
        assert frame in a.sync()


def test_refusals(client, connect_page, team, page, share):
    assert refused_with(connect_page, team["outsider"], page) == 4403
    assert refused_with(connect_page, team["member"], "no-such-page") == 4403
    guest = share(team["project"])["token"]
    assert refused_with(connect_page, guest, page) == 4403
    with pytest.raises(WebSocketDisconnect) as closed:
        with client.websocket_connect(f"/ws/pages/{page}?ticket=bogus") as ws:
            ws.receive_bytes()
    assert closed.value.code == 4401
    with pytest.raises(WebSocketDisconnect) as closed:
        with client.websocket_connect(f"/ws/pages/{page}") as ws:
            ws.receive_bytes()
    assert closed.value.code == 4401
    assert patch(client, team["member"], page, archived=True).status_code == 200
    assert refused_with(connect_page, team["member"], page) == 4403


def test_personal_page_is_for_the_owner_only(client, connect_page, team):
    mine = create(client, team["member"], "me", "Private")["id"]
    with connect_page(team["member"], mine) as ws:
        assert Peer(ws).text() == ""
    assert refused_with(connect_page, team["reviewer"], mine) == 4403


def test_task_pages_follow_the_task_access(client, connect_page, team, admin):
    task_id = make_task(client, admin["token"], team["project"])
    task_page = client.get(f"/api/tasks/{task_id}/page", headers=auth(team["member"])).json()["id"]
    with connect_page(team["member"], task_page) as wa, connect_page(team["viewer"], task_page) as wv:
        a, v = Peer(wa), Peer(wv)
        a.edit(lambda: paragraph(a.frag, "Task notes"))
        a.sync()
        v.sync()
        assert v.text() == "Task notes"
    assert refused_with(connect_page, team["reviewer"], task_page) == 4403  # project access, no task access
    assert refused_with(connect_page, team["outsider"], task_page) == 4403


def test_logout_closes_the_page_socket(client, admin, make_user, make_project, grant, connect_page):
    project_id = make_project()
    user = make_user()
    grant(project_id, user["user"]["id"])
    page_id = create(client, admin["token"], f"p:{project_id}", "Shared")["id"]
    with pytest.raises(WebSocketDisconnect) as closed:
        with connect_page(user["token"], page_id) as ws:
            Peer(ws)
            client.post("/api/auth/logout", headers=auth(user["token"]))
            wait_closed(ws)
    assert closed.value.code == 4401


def test_revoking_project_access_closes_the_page_socket(client, admin, make_project, make_user, grant, connect_page):
    project_id = make_project()
    user = make_user()
    grant(project_id, user["user"]["id"], can_tasks=True)
    page_id = create(client, admin["token"], f"p:{project_id}", "Shared")["id"]
    with pytest.raises(WebSocketDisconnect) as closed:
        with connect_page(user["token"], page_id) as ws:
            Peer(ws)
            client.delete(f"/api/projects/{project_id}/access/{user['user']['id']}", headers=auth(admin["token"]))
            wait_closed(ws)
    assert closed.value.code == 4403


def test_archiving_and_deleting_a_page_close_its_sockets(client, connect_page, team, page):
    with pytest.raises(WebSocketDisconnect) as closed:
        with connect_page(team["viewer"], page) as ws:
            Peer(ws)
            assert patch(client, team["member"], page, archived=True).status_code == 200
            wait_closed(ws)
    assert closed.value.code == 4403
    other = create(client, team["member"], team["space"], "Other")["id"]
    patch(client, team["member"], other, archived=True)
    with connect_page(team["member"], other) as ws:  # not possible while archived
        pass
    assert client.delete(f"/api/pages/{other}", headers=auth(team["member"])).status_code == 200


# ---------- awareness ----------

def test_awareness_is_relayed_never_stored_and_removed_on_close(connect_page, team, page):
    with connect_page(team["member"], page) as wa:
        a = Peer(wa)
        with connect_page(team["viewer"], page) as wb:
            b = Peer(wb)
            frame = aw_frame(4242, 3)
            wb.send_bytes(frame)
            b.sync()
            assert frame in a.sync()
        assert rows(page) == 0 and page_row(page)["ydoc"] is None
        removal = [f for f in a.sync() if isinstance(f, bytes) and f[0] == AWARENESS]
        assert removal == [bytes([AWARENESS]) + awareness_removal({4242: 3})]
        assert rows(page) == 0


# ---------- robustness ----------

def test_garbage_frames_do_not_break_the_room(connect_page, team, page):
    with connect_page(team["member"], page) as wa, connect_page(team["viewer"], page) as wb:
        a, b = Peer(wa), Peer(wb)
        a.edit(lambda: paragraph(a.frag, "Fine"))
        a.sync()
        b.sync()
        wa.send_bytes(bytes([AWARENESS]) + b"\xff\xff")  # malformed awareness: dropped
        wa.send_bytes(b"\x09whatever")  # unknown type: ignored
        wa.send_bytes(b"")
        wa.send_text("not json")
        wa.send_bytes(bytes([UPDATE]) + b"\xde\xad\xbe\xef garbage")  # bad update: this socket is closed
        with pytest.raises(WebSocketDisconnect) as closed:
            wait_closed(wa)
        assert closed.value.code == 1007
        assert b.sync() == [] and b.text() == "Fine"
        assert rows(page) == 1
    with connect_page(team["member"], page) as wc:
        assert Peer(wc).text() == "Fine"


def test_oversized_frames_are_dropped(connect_page, team, page, monkeypatch):
    import api.routes.pagesync as route
    monkeypatch.setattr(route, "MAX_FRAME_BYTES", 100)
    with connect_page(team["member"], page) as wa:
        a = Peer(wa)
        wa.send_bytes(bytes([UPDATE]) + b"\x00" * 500)
        a.sync()  # still connected, nothing stored
        assert rows(page) == 0


# ---------- needsImport ----------

def test_needs_import_turns_false_once_content_exists(client, connect_page, team, page):
    set_legacy(page, "<p>old</p>")
    assert client.get(f"/api/pages/{page}", headers=auth(team["member"])).json()["needsImport"] is True
    with connect_page(team["member"], page) as wa:
        a = Peer(wa)
        a.edit(lambda: paragraph(a.frag, "imported"))
        a.sync()
        assert rows(page) == 1
        assert client.get(f"/api/pages/{page}", headers=auth(team["member"])).json()["needsImport"] is False
        res = client.post(f"/api/pages/{page}/claim-import", headers=auth(team["member"]))
        assert res.json() == {"granted": False}
