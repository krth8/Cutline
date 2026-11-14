"""The live-updates WebSocket (see api/events.py)."""

from typing import Optional

from fastapi import APIRouter, Query, WebSocket, WebSocketDisconnect

from api.auth import principal_from_token
from api.events import live
from api.state import WS_SESSION_ENDED, track_socket, untrack_socket

router = APIRouter()


@router.websocket("/ws/live")
async def live_socket(
    websocket: WebSocket,
    client_id: str = Query(..., max_length=64),
    token: Optional[str] = Query(None),
):
    """One per browser tab, for logged-in users and share-link guests.

    The tab sends {"type": "watch", "projects": [ids]} to choose the projects
    it gets updates for, and {"type": "ping"} to check the line.
    """
    principal = principal_from_token(token)
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
            elif kind == "watch":
                wanted = message.get("projects")
                denied = live.watch(conn, wanted if isinstance(wanted, list) else [])
                await websocket.send_json({"type": "watching", "projects": list(conn.projects)})
                for project_id in denied:
                    await websocket.send_json({"type": "access_removed", "project": project_id})
    except (WebSocketDisconnect, ValueError, RuntimeError):
        pass
    finally:
        live.remove(conn)
        untrack_socket(principal, entry)
