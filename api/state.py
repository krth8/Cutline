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
