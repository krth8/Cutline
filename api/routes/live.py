"""The live-updates WebSocket (see api/events.py)."""

from typing import Optional

from fastapi import APIRouter, Query, WebSocket, WebSocketDisconnect

from api.auth import principal_from_ticket
from api.events import live
from api.state import WS_SESSION_ENDED, track_socket, untrack_socket

router = APIRouter()


@router.websocket("/ws/live")
async def live_socket(
    websocket: WebSocket,
    client_id: str = Query(..., max_length=64),
    ticket: Optional[str] = Query(None),
):
    """One per browser tab, for logged-in users and share-link guests.

    The tab sends {"type": "watch", "projects": [ids], "allTasks": bool} to choose
    the projects it gets updates for (allTasks: task events of every project the
    user has task access to; guests never get it), {"type": "place", "place":
    {"projectId", "label"} | null} to say where it is (the people panel of Lounge), and
    {"type": "ping"} to check the line.
    """
    principal = principal_from_ticket(ticket)
    await websocket.accept()
    if not principal:
        # Accept first so the browser gets the close code: the login is over
        await websocket.close(code=WS_SESSION_ENDED)
        return

    conn = live.add(websocket, client_id, principal)
    entry = track_socket(principal, websocket)
    try:
        while True:
            message = await websocket.receive_json()
            kind = message.get("type") if isinstance(message, dict) else None
            if kind == "ping":
                await websocket.send_json({"type": "pong"})
            elif kind == "place":
                # Where the tab is now: the people panel of Lounge shows it
                if live.set_place(conn, message.get("place")) and not principal.get("is_guest"):
                    await live.to_all_users({"type": "presence", "userId": principal["id"]})
            elif kind == "watch":
                wanted = message.get("projects")
                denied = live.watch(conn, wanted if isinstance(wanted, list) else [],
                                    all_tasks=message.get("allTasks") is True)
                await websocket.send_json({"type": "watching", "projects": list(conn.projects),
                                           "allTasks": conn.all_tasks})
                for project_id in denied:
                    await websocket.send_json({"type": "access_removed", "project": project_id})
    except (WebSocketDisconnect, ValueError, RuntimeError):
        pass
    finally:
        had_place = conn.place is not None
        live.remove(conn)
        untrack_socket(principal, entry)
        if had_place and not principal.get("is_guest"):  # only tabs that said where they were
            try:
                await live.to_all_users({"type": "presence", "userId": principal["id"]})
            except Exception:
                pass
