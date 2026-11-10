"""Per-project live events (task changes) pushed to open task views over WebSocket.

Each browser tab sends a random X-Client-Id header with its API requests and
uses the same id when it opens the events socket, so a change is not echoed
back to the tab that made it.
"""

import contextvars
from typing import Dict, Optional

from fastapi import WebSocket

# Set per request by ClientIdMiddleware
current_client_id: contextvars.ContextVar[Optional[str]] = contextvars.ContextVar("current_client_id", default=None)


class ClientIdMiddleware:
    """Stores the X-Client-Id request header in a context variable (pure ASGI)."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] == "http":
            client_id = None
            for key, value in scope.get("headers", []):
                if key == b"x-client-id":
                    client_id = value.decode("latin-1")[:64]
                    break
            token = current_client_id.set(client_id)
            try:
                await self.app(scope, receive, send)
            finally:
                current_client_id.reset(token)
        else:
            await self.app(scope, receive, send)


class ProjectEvents:
    def __init__(self):
        self.connections: Dict[str, Dict[str, WebSocket]] = {}  # project_id -> {client_id -> ws}

    async def connect(self, project_id: str, client_id: str, websocket: WebSocket):
        await websocket.accept()
        self.connections.setdefault(project_id, {})[client_id] = websocket

    def disconnect(self, project_id: str, client_id: str, websocket: WebSocket):
        conns = self.connections.get(project_id, {})
        if conns.get(client_id) is websocket:
            del conns[client_id]
        if not conns:
            self.connections.pop(project_id, None)

    async def broadcast(self, project_id: str, message: dict):
        """Send to everyone watching the project except the client that caused the change."""
        conns = self.connections.get(project_id)
        if not conns:
            return
        origin = current_client_id.get()
        for client_id, ws in list(conns.items()):
            if client_id == origin:
                continue
            try:
                await ws.send_json(message)
            except Exception:
                self.disconnect(project_id, client_id, ws)


project_events = ProjectEvents()
