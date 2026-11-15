"""The TableSource contract and the resolver from a table ref to a source.

A table ref names a table: ``tasks:<projectId>``, ``tasks:*`` or (Phase 4) ``tbl_<id>``.
Every source answers the same six calls, so the routes and every view layout work the
same for tasks and for user-created tables.

Sources raise HTTPException for permission problems (401/403/404) and for invalid row
values (400); an invalid query raises ``QueryError`` (the route turns it into a 400).
"""

from __future__ import annotations

import re
from typing import Any, List, Optional

from fastapi import HTTPException

from .query import QueryError  # noqa: F401  (re-exported for the routes)


# "parent_id was not given" for update_row (None means: move to the top level)
UNSET: Any = object()


class TableSource:
    """What a table kind has to implement. ``principal`` is the signed-in user dict."""

    ref: str

    def schema(self, principal: dict) -> dict:
        """TableSchema (custom columns included, see custom_columns_for)."""
        raise NotImplementedError

    def query(self, principal: dict, query: Optional[dict]) -> dict:
        """QueryResult for a Query, limited to what the principal may read."""
        raise NotImplementedError

    def get_row(self, principal: dict, row_id: str) -> dict:
        """One Row; 404 when it does not exist or may not be read."""
        raise NotImplementedError

    async def create_row(self, principal: dict, values: dict, parent_id: Optional[str] = None,
                         project_id: Optional[str] = None) -> dict:
        raise NotImplementedError

    async def update_row(self, principal: dict, row_id: str, values: dict, parent_id: Any = UNSET) -> dict:
        """Change values; `parent_id` (a row id or None for top level) moves the row when given."""
        raise NotImplementedError

    async def delete_row(self, principal: dict, row_id: str) -> None:
        raise NotImplementedError

    async def reorder(self, principal: dict, ids: List[str], before: Optional[str] = None) -> None:
        raise NotImplementedError

    # ---- Trash (optional, WP H3) ----
    # A source with a trash sets supports_trash = True, makes delete_row move the row to the trash instead of
    # destroying it, and implements the four calls below. The routes answer 400 for sources without one.

    supports_trash = False

    def list_trash(self, principal: dict) -> List[dict]:
        """Deleted rows the principal may restore: [{id, name, deletedAt, deletedBy, deletedByName,
        parentId, parentName, subtaskCount, ...}], newest first."""
        raise HTTPException(status_code=400, detail="This table has no trash")

    async def restore_rows(self, principal: dict, ids: List[str]) -> List[str]:
        """Bring rows back from the trash with everything attached. Returns the ids restored."""
        raise HTTPException(status_code=400, detail="This table has no trash")

    async def purge_rows(self, principal: dict, ids: List[str]) -> int:
        """Delete rows in the trash for good. Returns how many were removed."""
        raise HTTPException(status_code=400, detail="This table has no trash")

    async def empty_trash(self, principal: dict) -> int:
        """Delete the whole trash of the table for good (restricted to owners and admins by the source)."""
        raise HTTPException(status_code=400, detail="This table has no trash")


def custom_columns_for(table_ref: str) -> List[dict]:
    """Hook for WP T2: the user-defined columns of a table, as Column dicts (builtin: False).

    Sources append these after their builtin columns in schema(), in sort order. Custom
    columns belong to one project: ``tasks:*`` has none (rows still carry their values).
    """
    from .columns import list_columns
    return list_columns(table_ref)


_TASKS_REF = re.compile(r"^tasks:(\*|[A-Za-z0-9_-]+)$")


def resolve_source(ref: str) -> TableSource:
    """The source for a table ref. Unknown or malformed refs are a 404."""
    match = _TASKS_REF.match(ref or "")
    if match:
        from .tasks_source import TasksSource
        return TasksSource(match.group(1))
    # Phase 4 (WP C1): refs like "tbl_<id>" resolve to a CustomTableSource here.
    raise HTTPException(status_code=404, detail=f"Unknown table {ref!r}")
