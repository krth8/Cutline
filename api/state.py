"""In-memory state shared between the server and route modules.

These dicts are mutated in place (never reassigned) so every module sees the same objects."""

import asyncio
from typing import Dict


# In-memory storage (loaded from database on startup)
projects: Dict[str, dict] = {}  # project_id -> {name, clips, ...}
tasks: Dict[str, dict] = {}  # task_id -> {name, projectId, ...}


sessions: Dict[str, dict] = {}  # session_id -> {project_id, users, startedAt, name, lastUserActivity, ...}
transcode_jobs: Dict[str, dict] = {}  # job_id -> {filename, status, progress, ...}
user_states: Dict[str, Dict[str, dict]] = {}  # session_id -> {user_id -> state}
clip_locks: Dict[str, asyncio.Lock] = {}  # base_name -> Lock (prevents race conditions on parallel uploads)

# Close codes the browser understands
WS_SESSION_ENDED = 4401  # logged out / timed out: show the login screen
WS_ACCESS_REMOVED = 4403  # no (longer) access to this project

# Every open WebSocket of a logged-in user or share-link guest:
# principal id (user id, or a guest token's sub) -> {(websocket, project_id, login session id)}
live_sockets: Dict[str, set] = {}


def track_socket(principal: dict, websocket, project_id: str = None) -> tuple:
    """Remember an open socket so it can be closed when its owner is kicked or logs out."""
    entry = (websocket, project_id, principal.get("sid"))
    live_sockets.setdefault(principal["id"], set()).add(entry)
    return entry


def untrack_socket(principal: dict, entry: tuple) -> None:
    entries = live_sockets.get(principal["id"])
    if entries is not None:
        entries.discard(entry)
        if not entries:
            live_sockets.pop(principal["id"], None)


async def close_live_sockets(principal_id: str, project_id: str = None, code: int = WS_ACCESS_REMOVED) -> None:
    """Drop the live connections of a user or guest (used when kicking them).

    With project_id only the connections to that project are closed.
    """
    for entry in list(live_sockets.get(principal_id, ())):
        if project_id and entry[1] != project_id:
            continue
        live_sockets[principal_id].discard(entry)
        try:
            await entry[0].close(code=code)
        except Exception:
            pass


async def close_session_sockets(session_ids) -> None:
    """Close every socket that was opened with one of these login sessions."""
    session_ids = set(session_ids)
    if not session_ids:
        return
    for entries in list(live_sockets.values()):
        for entry in list(entries):
            if entry[2] in session_ids:
                entries.discard(entry)
                try:
                    await entry[0].close(code=WS_SESSION_ENDED)
                except Exception:
                    pass
