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

# principal id (user id, or a guest token's sub) -> {(websocket, project_id)} they have open
live_sockets: Dict[str, set] = {}


async def close_live_sockets(principal_id: str, project_id: str = None) -> None:
    """Drop the live review connections of a user or guest (used when kicking them).

    With project_id only the connections to that project are closed.
    """
    for entry in list(live_sockets.get(principal_id, ())):
        ws, ws_project = entry
        if project_id and ws_project != project_id:
            continue
        live_sockets[principal_id].discard(entry)
        try:
            await ws.close(code=4403)
        except Exception:
            pass
