"""Collaborative page editing: one pycrdt Doc per open page (PLAN.md 5.7).

Rules kept here:
- All access to a pycrdt Doc happens on the event-loop thread. Only database calls go to a thread.
- An update is stored (in `page_updates`) only after it applied cleanly and changed the document.
- Per page one asyncio.Lock serialises loading, storing and snapshotting, so rows are stored in the
  order the updates were applied.
"""

import asyncio
import time
from typing import Dict, List, Optional, Tuple

from pycrdt import Doc, XmlElement, XmlFragment, XmlText, merge_updates

from api.state import WS_ACCESS_REMOVED
from database.pages import (
    db_append_page_updates,
    db_get_page,
    db_load_page_state,
    db_pages_with_updates,
    db_write_page_snapshot,
)

FRAGMENT = "default"  # the Y.XmlFragment that Tiptap's Collaboration extension uses
SYNC_STATE, UPDATE, AWARENESS, STATE_VECTOR = 0, 1, 2, 3

MAX_FRAME_BYTES = 5 * 1024 * 1024
SNAPSHOT_IDLE_SECONDS = 30
SNAPSHOT_MAX_ROWS = 200
JOB_INTERVAL_SECONDS = 5

_INLINE_TAGS = {"hardBreak", "mention", "pageLink", "taskChip"}


# ============ Plain text ============

def _inline_text(node) -> str:
    if isinstance(node, XmlText):
        # str(XmlText) would put formatting in as XML tags; diff() gives the plain runs
        return "".join(run for run, _attrs in node.diff() if isinstance(run, str))
    if isinstance(node, XmlElement):
        if node.tag == "hardBreak":
            return "\n"
        if node.tag in _INLINE_TAGS:
            attrs = dict(node.attributes)
            return str(attrs.get("label") or attrs.get("title") or attrs.get("name") or "")
        return _block_text(node)
    return ""


def _block_text(element) -> str:
    children = list(element.children)
    is_container = bool(children) and all(
        isinstance(c, XmlElement) and c.tag not in _INLINE_TAGS for c in children)
    if is_container:
        return "\n".join(_block_text(c) for c in children)
    return "".join(_inline_text(c) for c in children)


def extract_text(doc: Doc) -> str:
    """Plain text of the editor content: top-level blocks separated by newlines, no formatting."""
    fragment = doc.get(FRAGMENT, type=XmlFragment)
    return "\n".join(_inline_text(block) if isinstance(block, XmlText) else _block_text(block)
                     for block in fragment.children)


# ============ Awareness (opaque, but its client ids are needed for cleanup) ============

def _read_varuint(data: bytes, i: int) -> Tuple[int, int]:
    number = shift = 0
    while True:
        byte = data[i]
        i += 1
        number |= (byte & 0x7F) << shift
        shift += 7
        if byte < 0x80:
            return number, i
        if shift > 70:
            raise ValueError("varuint too long")


def _write_varuint(number: int) -> bytes:
    out = bytearray()
    while number > 0x7F:
        out.append(0x80 | (number & 0x7F))
        number >>= 7
    out.append(number)
    return bytes(out)


def parse_awareness(payload: bytes) -> List[Tuple[int, int, bytes]]:
    """[(clientID, clock, state json bytes)]. Raises ValueError/IndexError when malformed."""
    count, i = _read_varuint(payload, 0)
    if count > 1000:
        raise ValueError("too many awareness entries")
    entries = []
    for _ in range(count):
        client_id, i = _read_varuint(payload, i)
        clock, i = _read_varuint(payload, i)
        length, i = _read_varuint(payload, i)
        if i + length > len(payload):
            raise ValueError("truncated awareness frame")
        entries.append((client_id, clock, payload[i:i + length]))
        i += length
    return entries


def awareness_removal(clients: Dict[int, int]) -> bytes:
    """A type-2 payload that removes the given {clientID: last clock} (clock + 1, state null)."""
    out = bytearray(_write_varuint(len(clients)))
    for client_id, clock in clients.items():
        out += _write_varuint(client_id) + _write_varuint(clock + 1) + _write_varuint(4) + b"null"
    return bytes(out)


# ============ Rooms ============

class Member:
    """One connected socket of a room."""

    def __init__(self, websocket, readonly: bool):
        self.websocket = websocket
        self.readonly = readonly
        self.awareness: Dict[int, int] = {}  # awareness clientID -> last clock seen on this socket


class PageRoom:
    def __init__(self, page_id: str, doc: Doc, pending_rows: int):
        self.page_id = page_id
        self.doc = doc
        self.members: Dict[object, Member] = {}  # websocket -> Member
        self.queue: List[bytes] = []  # applied but not yet stored
        self.pending_rows = pending_rows  # rows in page_updates since the last snapshot
        self.last_update = time.monotonic()

    def apply(self, update: bytes) -> bool:
        """Apply a client update. True if it changed the document (then it is queued for storing).
        Raises ValueError for an update that cannot be decoded; the Doc is untouched then."""
        before = self.doc.get_state()
        self.doc.apply_update(update)
        if self.doc.get_state() == before:
            return False
        self.queue.append(update)
        self.pending_rows += 1
        self.last_update = time.monotonic()
        return True

    def diff_for(self, state_vector: bytes) -> bytes:
        return self.doc.get_update(state_vector)

    def full_state(self) -> bytes:
        return self.doc.get_update()

    async def relay(self, sender, data: bytes) -> None:
        for websocket in list(self.members):
            if websocket is not sender:
                try:
                    await websocket.send_bytes(data)
                except Exception:
                    pass  # that socket's own handler notices and cleans up


class PageRegistry:
    def __init__(self):
        self.rooms: Dict[str, PageRoom] = {}
        self._locks: Dict[str, asyncio.Lock] = {}

    def lock(self, page_id: str) -> asyncio.Lock:
        return self._locks.setdefault(page_id, asyncio.Lock())

    def forget(self) -> None:
        """Drop every in-memory room without saving (simulates a process restart; used by tests)."""
        self.rooms.clear()

    # ---- joining and leaving ----

    async def join(self, page_id: str, websocket, readonly: bool) -> Tuple[PageRoom, Member]:
        async with self.lock(page_id):
            room = self.rooms.get(page_id)
            if room is None:
                room = await self._load(page_id)
                self.rooms[page_id] = room
            member = Member(websocket, readonly)
            room.members[websocket] = member
            return room, member

    async def leave(self, room: PageRoom, websocket) -> None:
        member = room.members.pop(websocket, None)
        if member and member.awareness:
            await room.relay(websocket, bytes([AWARENESS]) + awareness_removal(member.awareness))
        if room.members:
            return
        async with self.lock(room.page_id):
            if room.members or self.rooms.get(room.page_id) is not room:
                return
            try:
                await self._snapshot_locked(room.page_id, room)
            except Exception as exc:
                print(f"Page snapshot failed for {room.page_id}: {exc}")
            if not room.members and self.rooms.get(room.page_id) is room:
                del self.rooms[room.page_id]

    async def _load(self, page_id: str) -> PageRoom:
        snapshot, rows = await asyncio.to_thread(db_load_page_state, page_id)
        doc = Doc()
        for data in ([snapshot] if snapshot else []) + [data for _id, data in rows]:
            try:
                doc.apply_update(data)
            except Exception as exc:  # a damaged stored blob must not keep the page closed
                print(f"Skipping an unreadable stored update of page {page_id}: {exc}")
        return PageRoom(page_id, doc, len(rows))

    # ---- storing ----

    async def store(self, room: PageRoom) -> None:
        """Write the room's queued updates to page_updates, in order."""
        async with self.lock(room.page_id):
            await self._flush_locked(room)

    async def _flush_locked(self, room: PageRoom) -> None:
        if not room.queue:
            return
        batch, room.queue = room.queue, []
        try:
            await asyncio.to_thread(db_append_page_updates, room.page_id, batch)
        except Exception as exc:  # e.g. the page was deleted meanwhile
            room.pending_rows -= len(batch)
            print(f"Could not store updates of page {room.page_id}: {exc}")

    # ---- snapshot ----

    async def snapshot(self, page_id: str) -> int:
        """Merge the pending rows into pages.ydoc, refresh pages.text and updated_at, delete the merged
        rows. Returns how many rows were merged."""
        async with self.lock(page_id):
            return await self._snapshot_locked(page_id, self.rooms.get(page_id))

    async def _snapshot_locked(self, page_id: str, room: Optional[PageRoom]) -> int:
        if room is not None:
            await self._flush_locked(room)
        snapshot, rows = await asyncio.to_thread(db_load_page_state, page_id)
        if not rows:
            return 0
        parts = ([snapshot] if snapshot else []) + [data for _id, data in rows]
        merged = await asyncio.to_thread(lambda: merge_updates(*parts) if len(parts) > 1 else parts[0])
        doc = Doc()
        doc.apply_update(merged)
        text = extract_text(doc)
        last_id = rows[-1][0]
        await asyncio.to_thread(db_write_page_snapshot, page_id, merged, text, last_id)
        if room is not None:
            room.pending_rows = max(0, room.pending_rows - len(rows))
        return len(rows)

    async def snapshot_all(self) -> None:
        for page_id in list(self.rooms):
            try:
                await self.snapshot(page_id)
            except Exception as exc:
                print(f"Page snapshot failed for {page_id}: {exc}")

    async def snapshot_due(self) -> None:
        """One round of the background job: pages idle for 30 s or with more than 200 pending rows,
        plus pages with rows left over from a crash that nobody has open."""
        now = time.monotonic()
        for page_id, room in list(self.rooms.items()):
            if room.pending_rows > 0 and (room.pending_rows > SNAPSHOT_MAX_ROWS
                                          or now - room.last_update >= SNAPSHOT_IDLE_SECONDS):
                try:
                    await self.snapshot(page_id)
                except Exception as exc:
                    print(f"Page snapshot failed for {page_id}: {exc}")
        for page_id, _count in await asyncio.to_thread(db_pages_with_updates):
            if page_id not in self.rooms:
                try:
                    await self.snapshot(page_id)
                except Exception as exc:
                    print(f"Page snapshot failed for {page_id}: {exc}")

    # ---- closing ----

    async def close_unavailable(self) -> None:
        """Close the sockets of rooms whose page is gone or archived."""
        for page_id, room in list(self.rooms.items()):
            page = await asyncio.to_thread(db_get_page, page_id)
            if page and not page["archivedAt"]:
                continue
            for websocket in list(room.members):
                try:
                    await websocket.close(code=WS_ACCESS_REMOVED)
                except Exception:
                    pass


registry = PageRegistry()


async def close_unavailable_rooms() -> None:
    """Call after archiving or deleting pages: connected editors of those pages are disconnected."""
    await registry.close_unavailable()


_job: Optional[asyncio.Task] = None


async def _job_loop() -> None:
    while True:
        await asyncio.sleep(JOB_INTERVAL_SECONDS)
        try:
            await registry.snapshot_due()
        except Exception as exc:
            print(f"Page snapshot job failed: {exc}")


def start_snapshot_job() -> None:
    global _job
    if _job is None or _job.done():
        _job = asyncio.create_task(_job_loop())


async def stop_snapshot_job() -> None:
    """Stop the job and snapshot every loaded page (server shutdown)."""
    global _job
    if _job is not None:
        _job.cancel()
        try:
            await _job
        except BaseException:
            pass
        _job = None
    await registry.snapshot_all()
