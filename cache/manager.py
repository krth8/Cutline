"""
In-Memory Cache Manager with Periodic Persistence

Implements write-back caching for clips and tasks:
- Changes go to memory first
- Dirty data is persisted periodically (every 30s) or when buffer exceeds threshold
- Graceful shutdown ensures all dirty data is flushed
- persist_now() writes at once, for changes that must not be lost or that
  other database code depends on (a new clip version)

Review comments and annotations are not cached: they are written straight to
the database when they are made.
"""

import asyncio
import atexit
import signal
import threading
from datetime import datetime
from typing import Dict, Set, List, Optional, Any
from dataclasses import dataclass, field
from collections import defaultdict


# Configuration
DEFAULT_PERSISTENCE_INTERVAL = 30  # seconds
DEFAULT_DIRTY_THRESHOLD = 100  # max dirty items before forced persist


@dataclass
class DirtyTracker:
    """Tracks which entities need persistence."""

    # Per-entity tracking: {entity_type: {entity_id: modification_timestamp}}
    dirty_entities: Dict[str, Dict[str, datetime]] = field(default_factory=lambda: defaultdict(dict))

    # Lock for thread safety
    _lock: threading.Lock = field(default_factory=threading.Lock)

    def mark_dirty(self, entity_type: str, entity_id: str) -> None:
        """Mark an entity as dirty (needs persistence)."""
        with self._lock:
            self.dirty_entities[entity_type][entity_id] = datetime.now()

    def get_dirty(self, entity_type: str) -> Dict[str, datetime]:
        """Get all dirty entities of a type (returns copy for thread safety)."""
        with self._lock:
            return dict(self.dirty_entities.get(entity_type, {}))

    def get_all_dirty(self) -> Dict[str, Dict[str, datetime]]:
        """Get all dirty entities (returns copy)."""
        with self._lock:
            return {k: dict(v) for k, v in self.dirty_entities.items()}

    def clear_dirty(self, entity_type: str, entity_ids: Set[str] = None) -> None:
        """Clear dirty status after successful persistence."""
        with self._lock:
            if entity_ids is None:
                self.dirty_entities[entity_type].clear()
            else:
                for eid in entity_ids:
                    self.dirty_entities[entity_type].pop(eid, None)

    def count(self) -> int:
        """Count total dirty items."""
        with self._lock:
            return sum(len(v) for v in self.dirty_entities.values())

    def has_dirty(self) -> bool:
        """Check if any data needs persistence."""
        with self._lock:
            return any(self.dirty_entities.values())


@dataclass
class CacheStats:
    """Statistics about cache operations."""
    last_persistence: Optional[datetime] = None
    total_persisted: int = 0
    persistence_count: int = 0
    last_persistence_duration_ms: float = 0


class CacheManager:
    """
    Central cache manager with dirty tracking and periodic persistence.

    Features:
    - Per-entity dirty tracking for efficient batch persistence
    - Periodic persistence loop (configurable interval)
    - Threshold-based persistence (if dirty count exceeds limit)
    - Graceful shutdown with data flush
    - Thread-safe operations
    """

    def __init__(
        self,
        persistence_interval_seconds: int = DEFAULT_PERSISTENCE_INTERVAL,
        dirty_threshold: int = DEFAULT_DIRTY_THRESHOLD
    ):
        self.persistence_interval = persistence_interval_seconds
        self.dirty_threshold = dirty_threshold
        self.dirty_tracker = DirtyTracker()
        self.stats = CacheStats()

        # In-memory stores (references set by server)
        self._projects: Dict[str, dict] = {}
        self._tasks: Dict[str, dict] = {}
        self._statuses: List[dict] = []
        self._project_access: Dict[str, Dict[str, dict]] = {}

        # Persistence state
        self._persistence_task: Optional[asyncio.Task] = None
        self._shutdown_event: Optional[asyncio.Event] = None
        self._is_running = False
        self._loop: Optional[asyncio.AbstractEventLoop] = None

        # Register shutdown handlers
        atexit.register(self._sync_shutdown)

    def set_projects_ref(self, projects: Dict[str, dict]) -> None:
        """Set reference to the projects dictionary."""
        self._projects = projects

    def set_tasks_ref(self, tasks: Dict[str, dict]) -> None:
        """Set reference to the tasks dictionary."""
        self._tasks = tasks

    def set_statuses_ref(self, statuses: List[dict]) -> None:
        """Set reference to the statuses list."""
        self._statuses = statuses

    # === Lifecycle Methods ===

    def start(self) -> None:
        """Start the periodic persistence worker."""
        if not self._is_running:
            self._is_running = True
            self._loop = asyncio.get_event_loop()
            self._shutdown_event = asyncio.Event()
            self._persistence_task = asyncio.create_task(self._persistence_loop())
            print(f"Cache persistence started (interval: {self.persistence_interval}s, threshold: {self.dirty_threshold} items)")

    async def stop(self) -> None:
        """Stop persistence and flush all dirty data."""
        if self._is_running:
            self._is_running = False
            if self._shutdown_event:
                self._shutdown_event.set()
            if self._persistence_task:
                try:
                    await asyncio.wait_for(self._persistence_task, timeout=5.0)
                except asyncio.TimeoutError:
                    self._persistence_task.cancel()

            # Final flush
            await self._flush_all_dirty()
            print("Cache persistence stopped, all data flushed")

    def _sync_shutdown(self) -> None:
        """Synchronous shutdown handler for atexit."""
        if self._is_running and self.dirty_tracker.has_dirty():
            print("Emergency flush: persisting dirty data...")
            try:
                # Try to get existing loop or create new one
                try:
                    loop = asyncio.get_event_loop()
                    if loop.is_running():
                        # Can't run sync in running loop, schedule it
                        asyncio.ensure_future(self._flush_all_dirty())
                        return
                except RuntimeError:
                    loop = asyncio.new_event_loop()
                    asyncio.set_event_loop(loop)

                loop.run_until_complete(self._flush_all_dirty())
            except Exception as e:
                print(f"Emergency flush failed: {e}")

    # === Dirty Marking Methods ===

    def mark_project_dirty(self, project_id: str) -> None:
        """Mark a project as needing persistence."""
        self.dirty_tracker.mark_dirty("project", project_id)
        self._check_threshold()

    def mark_clip_dirty(self, project_id: str, base_name: str) -> None:
        """Mark a clip as needing persistence."""
        self.dirty_tracker.mark_dirty("clip", f"{project_id}:{base_name}")
        self._check_threshold()

    def mark_task_dirty(self, task_id: str) -> None:
        """Mark a task as needing persistence."""
        self.dirty_tracker.mark_dirty("task", task_id)
        self._check_threshold()

    def mark_status_dirty(self, status_id: str) -> None:
        """Mark a status as needing persistence."""
        self.dirty_tracker.mark_dirty("status", status_id)
        self._check_threshold()

    def _check_threshold(self) -> None:
        """Check if dirty count exceeds threshold and trigger persist if needed."""
        if self._is_running and self.dirty_tracker.count() >= self.dirty_threshold:
            # Schedule immediate persistence
            if self._loop and self._loop.is_running():
                asyncio.ensure_future(self._persist_dirty())

    # === Persistence Loop ===

    async def _persistence_loop(self) -> None:
        """Main persistence loop - runs at configured interval."""
        while self._is_running:
            try:
                # Wait for interval or shutdown
                await asyncio.wait_for(
                    self._shutdown_event.wait(),
                    timeout=self.persistence_interval
                )
                # Shutdown event triggered
                break
            except asyncio.TimeoutError:
                # Normal timeout, check for dirty data
                pass

            if self.dirty_tracker.has_dirty():
                await self._persist_dirty()

    async def _persist_dirty(self) -> None:
        """Persist all dirty data to database."""
        if not self.dirty_tracker.has_dirty():
            return

        start_time = datetime.now()
        persisted_counts = {}

        try:
            # Import here to avoid circular imports
            from database.batch import db_batch_upsert_clips, db_batch_upsert_tasks

            # Persist in order of dependency
            persisted_counts["clips"] = await self._persist_dirty_clips(db_batch_upsert_clips)
            persisted_counts["tasks"] = await self._persist_dirty_tasks(db_batch_upsert_tasks)

            # Update stats
            elapsed = (datetime.now() - start_time).total_seconds() * 1000
            total = sum(persisted_counts.values())

            self.stats.last_persistence = datetime.now()
            self.stats.total_persisted += total
            self.stats.persistence_count += 1
            self.stats.last_persistence_duration_ms = elapsed

            if total > 0:
                print(f"Persisted {total} items in {elapsed:.1f}ms: {persisted_counts}")

        except Exception as e:
            print(f"Persistence error: {e}")
            import traceback
            traceback.print_exc()

    async def persist_now(self) -> None:
        """Write everything that is dirty to the database right away."""
        await self._persist_dirty()

    async def _flush_all_dirty(self) -> None:
        """Force persistence of all dirty data (for shutdown)."""
        if self.dirty_tracker.has_dirty():
            print(f"Flushing {self.dirty_tracker.count()} dirty items...")
            await self._persist_dirty()

    # === Entity-specific persistence methods ===

    async def _persist_dirty_clips(self, batch_upsert_fn) -> int:
        """Persist dirty clips."""
        dirty = self.dirty_tracker.get_dirty("clip")
        if not dirty:
            return 0

        by_project = defaultdict(list)
        for key in dirty.keys():
            project_id, base_name = key.split(":", 1)
            if project_id in self._projects:
                clip = self._projects[project_id].get("clips", {}).get(base_name)
                if clip:
                    by_project[project_id].append((base_name, clip))

        persisted = set()
        for project_id, clips in by_project.items():
            try:
                await asyncio.to_thread(batch_upsert_fn, project_id, clips)
                persisted.update(f"{project_id}:{name}" for name, _ in clips)
            except Exception as e:
                print(f"Failed to persist clips for {project_id}: {e}")

        self.dirty_tracker.clear_dirty("clip", persisted)
        return len(persisted)

    async def _persist_dirty_tasks(self, batch_upsert_fn) -> int:
        """Persist dirty tasks."""
        dirty = self.dirty_tracker.get_dirty("task")
        if not dirty:
            return 0

        tasks_to_persist = [
            self._tasks[tid] for tid in dirty.keys()
            if tid in self._tasks
        ]

        if tasks_to_persist:
            try:
                await asyncio.to_thread(batch_upsert_fn, tasks_to_persist)
                self.dirty_tracker.clear_dirty("task", set(dirty.keys()))
            except Exception as e:
                print(f"Failed to persist tasks: {e}")
                return 0

        return len(tasks_to_persist)

    # === Stats Methods ===

    def get_stats(self) -> dict:
        """Get cache statistics."""
        return {
            "lastPersistence": self.stats.last_persistence.isoformat() if self.stats.last_persistence else None,
            "totalPersisted": self.stats.total_persisted,
            "persistenceCount": self.stats.persistence_count,
            "lastDurationMs": self.stats.last_persistence_duration_ms,
            "dirtyCount": self.dirty_tracker.count(),
            "dirtyByType": {k: len(v) for k, v in self.dirty_tracker.get_all_dirty().items()},
            "persistenceInterval": self.persistence_interval,
            "dirtyThreshold": self.dirty_threshold,
            "isRunning": self._is_running
        }


# Global cache manager instance
cache_manager = CacheManager()
