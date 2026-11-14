"""Live updates: one WebSocket per browser tab (/ws/live).

A tab connects once it has a token and tells the server which project it is
looking at ("watch"). Changes to that project (comments, clips, tasks) and
things addressed to the user (notifications, project list changes) are pushed
over it, so nobody has to reload to see what others did.

Each tab sends a random X-Client-Id header with its API requests and uses the
same id on the socket, so a change is not echoed back to the tab that made it.
"""

import contextvars
from typing import Dict, Optional

from fastapi import WebSocket

from database import db_check_project_access

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


MAX_WATCHED = 5


class LiveConnection:
    def __init__(self, websocket: WebSocket, client_id: str, principal: dict):
        self.websocket = websocket
        self.client_id = client_id
        self.principal = principal
        # Projects this tab is watching: project_id -> may see task events
        self.projects: Dict[str, bool] = {}


class LiveHub:
    def __init__(self):
        self.connections: Dict[int, LiveConnection] = {}

    def add(self, websocket: WebSocket, client_id: str, principal: dict) -> LiveConnection:
        conn = LiveConnection(websocket, client_id, principal)
        self.connections[id(websocket)] = conn
        return conn

    def remove(self, conn: LiveConnection) -> None:
        self.connections.pop(id(conn.websocket), None)

    def _access(self, principal: dict, project_id: str) -> Optional[bool]:
        """None if the principal may not see the project, else whether it may see its tasks."""
        if principal.get("is_guest"):
            return False if principal.get("project_id") == project_id else None
        if not db_check_project_access(principal["id"], project_id):
            return None
        return db_check_project_access(principal["id"], project_id, require_tasks=True)

    def watch(self, conn: LiveConnection, project_ids: list) -> list:
        """Set the projects a connection gets updates for. Returns the ones it may not see."""
        conn.projects = {}
        denied = []
        for project_id in project_ids[:MAX_WATCHED]:
            if not isinstance(project_id, str) or not project_id:
                continue
            can_tasks = self._access(conn.principal, project_id)
            if can_tasks is None:
                denied.append(project_id)
            else:
                conn.projects[project_id] = can_tasks
        return denied

    async def _send(self, conn: LiveConnection, message: dict) -> None:
        try:
            await conn.websocket.send_json(message)
        except Exception:
            self.remove(conn)

    async def to_project(self, project_id: str, message: dict, tasks_only: bool = False, echo: bool = False) -> None:
        """Send to every tab watching the project (the message gets a "project" field).

        tasks_only: only to people with task access (never guests).
        echo: also send to the tab whose request caused the change. Use it for
        changes that did not come straight from a request (e.g. a finished transcode).
        """
        origin = None if echo else current_client_id.get()
        message = {**message, "project": project_id}
        for conn in list(self.connections.values()):
            if project_id not in conn.projects:
                continue
            if tasks_only and not conn.projects[project_id]:
                continue
            if origin and conn.client_id == origin:
                continue
            await self._send(conn, message)

    async def to_user(self, user_id: str, message: dict) -> None:
        """Send to every tab of one user."""
        for conn in list(self.connections.values()):
            if conn.principal["id"] == user_id:
                await self._send(conn, message)

    async def to_all_users(self, message: dict) -> None:
        """Send to every logged-in user's tabs (not guests), except the one that caused it."""
        origin = current_client_id.get()
        for conn in list(self.connections.values()):
            if conn.principal.get("is_guest") or (origin and conn.client_id == origin):
                continue
            await self._send(conn, message)

    async def recheck_access(self, user_id: str, project_id: str) -> None:
        """A user's rights in a project changed (or were removed): update what their tabs receive."""
        for conn in list(self.connections.values()):
            if conn.principal["id"] != user_id or project_id not in conn.projects:
                continue
            can_tasks = self._access(conn.principal, project_id)
            if can_tasks is None:
                del conn.projects[project_id]
                await self._send(conn, {"type": "access_removed", "project": project_id})
            else:
                conn.projects[project_id] = can_tasks


live = LiveHub()
