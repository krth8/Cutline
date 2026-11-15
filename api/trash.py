"""Automatic purge of the task trash: tasks deleted more than TRASH_DAYS days ago are deleted for good.

The job runs once at startup and then every PURGE_INTERVAL_SECONDS; a task still in the trash after
TRASH_DAYS days has nothing left to wait for, so it goes with everything attached.
"""

import asyncio
from datetime import datetime, timedelta
from typing import Optional

from api.routes.tasks import purge_task_records
from database.task_trash import db_trash_ids_older_than

TRASH_DAYS = 30
PURGE_INTERVAL_SECONDS = 6 * 60 * 60


async def purge_expired(now: Optional[datetime] = None) -> int:
    """Delete for good every task deleted more than TRASH_DAYS days before `now`. Returns how many were removed."""
    cutoff = ((now or datetime.now()) - timedelta(days=TRASH_DAYS)).isoformat()
    old = await asyncio.to_thread(db_trash_ids_older_than, cutoff)
    return await purge_task_records([row["id"] for row in old])


_job: Optional[asyncio.Task] = None


async def _job_loop() -> None:
    while True:
        try:
            removed = await purge_expired()
            if removed:
                print(f"Trash: {removed} task(s) older than {TRASH_DAYS} days deleted for good")
        except Exception as exc:
            print(f"Trash purge failed: {exc}")
        await asyncio.sleep(PURGE_INTERVAL_SECONDS)


def start_trash_job() -> None:
    global _job
    if _job is None or _job.done():
        _job = asyncio.create_task(_job_loop())
