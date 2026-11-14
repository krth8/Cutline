"""Spike server: one pycrdt Doc per page, SQLite update log, relay, awareness cleanup.

Run: python server.py [port]   (env COLLAB_DB for the database path)
All pycrdt Doc access happens on the event-loop thread (Doc is not thread-safe).
"""
import os
import sqlite3
import sys
import time
from pathlib import Path

import uvicorn
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, PlainTextResponse
from pycrdt import Doc, XmlElement, XmlFragment, XmlText, merge_updates

HERE = Path(__file__).parent
DB_PATH = os.environ.get("COLLAB_DB", str(HERE / "collab.db"))
FRAGMENT = "default"  # name used by @tiptap/extension-collaboration

SYNC_STATE, UPDATE, AWARENESS, STATE_VECTOR = 0, 1, 2, 3


# ---------- storage ----------
def open_db() -> sqlite3.Connection:
    con = sqlite3.connect(DB_PATH)
    con.execute("PRAGMA journal_mode=WAL")
    con.execute("CREATE TABLE IF NOT EXISTS pages (id TEXT PRIMARY KEY, ydoc BLOB)")
    con.execute(
        "CREATE TABLE IF NOT EXISTS page_updates "
        "(id INTEGER PRIMARY KEY AUTOINCREMENT, page_id TEXT NOT NULL, data BLOB NOT NULL)"
    )
    return con


CON = open_db()


class Room:
    def __init__(self, page_id: str):
        self.id = page_id
        self.doc = Doc()
        self.sockets: dict[WebSocket, dict[int, int]] = {}  # socket -> {awareness clientID: clock}
        row = CON.execute("SELECT ydoc FROM pages WHERE id=?", (page_id,)).fetchone()
        if row and row[0]:
            self.doc.apply_update(row[0])
        for (data,) in CON.execute("SELECT data FROM page_updates WHERE page_id=? ORDER BY id", (page_id,)):
            self.doc.apply_update(data)

    def apply(self, update: bytes):
        self.doc.apply_update(update)  # raises on malformed input; caller drops the frame
        CON.execute("INSERT INTO page_updates (page_id, data) VALUES (?,?)", (self.id, update))
        CON.commit()

    def text(self) -> str:
        return extract_text(self.doc)

    def snapshot(self) -> dict:
        """Merge snapshot + stored updates into one blob and delete the merged rows."""
        rows = CON.execute("SELECT id, data FROM page_updates WHERE page_id=? ORDER BY id", (self.id,)).fetchall()
        old = CON.execute("SELECT ydoc FROM pages WHERE id=?", (self.id,)).fetchone()
        parts = ([old[0]] if old and old[0] else []) + [r[1] for r in rows]
        merged = merge_updates(*parts) if len(parts) > 1 else (parts[0] if parts else b"")
        with CON:
            CON.execute(
                "INSERT INTO pages (id, ydoc) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET ydoc=excluded.ydoc",
                (self.id, merged),
            )
            if rows:
                CON.execute("DELETE FROM page_updates WHERE page_id=? AND id<=?", (self.id, rows[-1][0]))
        return {"rows_merged": len(rows), "bytes": len(merged)}


ROOMS: dict[str, Room] = {}


def room(page_id: str) -> Room:
    if page_id not in ROOMS:
        ROOMS[page_id] = Room(page_id)
    return ROOMS[page_id]


# ---------- plain text ----------
def _node_text(node) -> str:
    if isinstance(node, XmlText):
        # str(XmlText) would include formatting as XML tags; diff() gives plain runs.
        return "".join(run for run, _attrs in node.diff() if isinstance(run, str))
    if isinstance(node, XmlElement):
        return "".join(_node_text(c) for c in node.children)
    return ""


def extract_text(doc: Doc) -> str:
    frag = doc.get(FRAGMENT, type=XmlFragment)
    return "\n".join(_node_text(block) for block in frag.children)


# ---------- awareness (opaque to us, but we need client ids to clean up on close) ----------
def _varuint(b: bytes, i: int):
    n = shift = 0
    while True:
        c = b[i]
        i += 1
        n |= (c & 0x7F) << shift
        shift += 7
        if c < 0x80:
            return n, i


def _put_varuint(n: int) -> bytes:
    out = bytearray()
    while n > 0x7F:
        out.append(0x80 | (n & 0x7F))
        n >>= 7
    out.append(n)
    return bytes(out)


def parse_awareness(b: bytes):
    count, i = _varuint(b, 0)
    for _ in range(count):
        cid, i = _varuint(b, i)
        clock, i = _varuint(b, i)
        ln, i = _varuint(b, i)
        yield cid, clock, b[i : i + ln]
        i += ln


def awareness_removal(clients: dict[int, int]) -> bytes:
    out = bytearray(_put_varuint(len(clients)))
    for cid, clock in clients.items():
        out += _put_varuint(cid) + _put_varuint(clock + 1) + _put_varuint(4) + b"null"
    return bytes(out)


# ---------- app ----------
app = FastAPI()


async def relay(r: Room, sender: WebSocket, data: bytes):
    for ws in list(r.sockets):
        if ws is not sender:
            try:
                await ws.send_bytes(data)
            except Exception:
                pass


@app.websocket("/ws/pages/{page_id}")
async def ws_page(ws: WebSocket, page_id: str):
    await ws.accept()
    r = room(page_id)
    r.sockets[ws] = {}
    await ws.send_bytes(bytes([SYNC_STATE]) + r.doc.get_update())
    try:
        while True:
            msg = await ws.receive()
            if msg["type"] == "websocket.disconnect":
                break
            data = msg.get("bytes")
            if not data:
                continue
            kind, payload = data[0], data[1:]
            if kind == UPDATE:
                try:
                    r.apply(payload)
                except Exception:
                    continue
                await relay(r, ws, data)
            elif kind == STATE_VECTOR:
                await ws.send_bytes(bytes([UPDATE]) + r.doc.get_update(payload))
            elif kind == AWARENESS:
                try:
                    for cid, clock, state in parse_awareness(payload):
                        if state == b"null":
                            r.sockets[ws].pop(cid, None)
                        else:
                            r.sockets[ws][cid] = clock
                except Exception:
                    continue
                await relay(r, ws, data)
    except WebSocketDisconnect:
        pass
    finally:
        clients = r.sockets.pop(ws, {})
        if clients:  # tell the others these carets are gone
            await relay(r, ws, bytes([AWARENESS]) + awareness_removal(clients))


@app.get("/text/{page_id}", response_class=PlainTextResponse)
async def get_text(page_id: str):
    return room(page_id).text()


@app.post("/snapshot/{page_id}")
async def snapshot(page_id: str):
    return room(page_id).snapshot()


@app.get("/stats/{page_id}")
async def stats(page_id: str):
    n, b = CON.execute(
        "SELECT COUNT(*), COALESCE(SUM(LENGTH(data)),0) FROM page_updates WHERE page_id=?", (page_id,)
    ).fetchone()
    s = CON.execute("SELECT COALESCE(LENGTH(ydoc),0) FROM pages WHERE id=?", (page_id,)).fetchone()
    return {"update_rows": n, "update_bytes": b, "snapshot_bytes": s[0] if s else 0}


@app.post("/reload/{page_id}")
async def reload(page_id: str):
    """Drop the in-memory doc and rebuild it from SQLite; returns the load time."""
    ROOMS.pop(page_id, None)
    t = time.perf_counter()
    r = room(page_id)
    return {"load_ms": (time.perf_counter() - t) * 1000, "chars": len(r.text())}


@app.get("/")
async def index():
    return FileResponse(HERE / "client" / "index.html")


@app.get("/bundle.js")
async def bundle():
    return FileResponse(HERE / "dist" / "bundle.js")


if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=int(sys.argv[1]) if len(sys.argv) > 1 else 8765, log_level="warning")
