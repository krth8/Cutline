"""The page sync WebSocket (PLAN.md 5.7). The protocol is implemented in api/pagesync.py."""

import json
import time
from typing import Optional

from fastapi import APIRouter, Query, WebSocket, WebSocketDisconnect

from api.auth import can_edit_page, can_read_page, principal_from_ticket
from api.pagesync import (
    AWARENESS,
    MAX_FRAME_BYTES,
    STATE_VECTOR,
    SYNC_STATE,
    UPDATE,
    parse_awareness,
    registry,
)
from api.state import WS_ACCESS_REMOVED, WS_SESSION_ENDED, track_socket, untrack_socket
from database.pages import db_get_page

router = APIRouter()

WS_BAD_DATA = 1007  # a frame the server cannot use as an update
EDIT_RECHECK_SECONDS = 5


@router.websocket("/ws/pages/{page_id}")
async def page_socket(websocket: WebSocket, page_id: str, ticket: Optional[str] = Query(None)):
    principal = principal_from_ticket(ticket)
    await websocket.accept()
    if not principal:
        await websocket.close(code=WS_SESSION_ENDED)
        return
    page = db_get_page(page_id)
    if not page or page["archivedAt"] or not can_read_page(principal, page):
        await websocket.close(code=WS_ACCESS_REMOVED)
        return

    entry = track_socket(principal, websocket, page["projectId"])
    room = None
    try:
        readonly = not can_edit_page(principal, page)
        checked = time.monotonic()
        room, member = await registry.join(page_id, websocket, readonly)
        await websocket.send_bytes(bytes([SYNC_STATE]) + room.full_state())
        if readonly:
            await websocket.send_json({"type": "readonly"})

        while True:
            message = await websocket.receive()
            if message["type"] == "websocket.disconnect":
                break
            text, data = message.get("text"), message.get("bytes")
            if text is not None:
                if len(text) > 4096:
                    continue
                try:
                    control = json.loads(text)
                except ValueError:
                    continue
                if isinstance(control, dict) and control.get("type") == "ping":
                    await websocket.send_json({"type": "pong"})
                continue
            if not data or len(data) > MAX_FRAME_BYTES:
                continue
            kind, payload = data[0], data[1:]

            if kind == UPDATE:
                if not member.readonly and time.monotonic() - checked > EDIT_RECHECK_SECONDS:
                    checked = time.monotonic()
                    current = db_get_page(page_id)
                    if not current or current["archivedAt"] or not can_edit_page(principal, current):
                        member.readonly = True
                        await websocket.send_json({"type": "readonly"})
                if member.readonly:
                    continue
                try:
                    changed = room.apply(payload)
                except Exception:
                    await websocket.close(code=WS_BAD_DATA)
                    break
                if changed:
                    await room.relay(websocket, data)
                    await registry.store(room)
            elif kind == STATE_VECTOR:
                try:
                    diff = room.diff_for(payload)
                except Exception:
                    await websocket.close(code=WS_BAD_DATA)
                    break
                await websocket.send_bytes(bytes([UPDATE]) + diff)
            elif kind == AWARENESS:
                try:
                    entries = parse_awareness(payload)
                except Exception:
                    continue
                for client_id, clock, state in entries:
                    if state.strip() == b"null":
                        member.awareness.pop(client_id, None)
                    elif len(member.awareness) < 50 or client_id in member.awareness:
                        member.awareness[client_id] = clock
                await room.relay(websocket, data)
    except (WebSocketDisconnect, RuntimeError):
        pass
    finally:
        untrack_socket(principal, entry)
        if room is not None:
            await registry.leave(room, websocket)
