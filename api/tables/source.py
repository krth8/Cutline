"""The TableSource contract and the resolver from a table ref to a source.

A table ref names a table: ``tasks:<projectId>``, ``tasks:*`` or (Phase 4) ``tbl_<id>``.
Every source answers the same six calls, so the routes and every view layout work the
same for tasks and for user-created tables.

Sources raise HTTPException for permission problems (401/403/404) and for invalid row
values (400); an invalid query raises ``QueryError`` (the route turns it into a 400).
"""

from __future__ import annotations

import re
from typing import List, Optional

from fastapi import HTTPException

from .query import QueryError  # noqa: F401  (re-exported for the routes)


class TableSource:
    """What a table kind has to implement. ``principal`` is the signed-in user dict."""

    ref: str

    def schema(self, principal: dict) -> dict:
        """TableSchema (custom columns included, see custom_columns_for)."""
        raise NotImplementedError

    def query(self, principal: dict, query: Optional[dict]) -> dict:
        """QueryResult for a Query, limited to what the principal may read."""
        raise NotImplementedError

    async def create_row(self, principal: dict, values: dict, parent_id: Optional[str] = None,
                         project_id: Optional[str] = None) -> dict:
        raise NotImplementedError

    async def update_row(self, principal: dict, row_id: str, values: dict) -> dict:
        raise NotImplementedError

    async def delete_row(self, principal: dict, row_id: str) -> None:
        raise NotImplementedError

    async def reorder(self, principal: dict, ids: List[str], before: Optional[str] = None) -> None:
        raise NotImplementedError


def custom_columns_for(table_ref: str) -> List[dict]:
    """Hook for WP T2: the user-defined columns of a table, as Column dicts (builtin: False).

    Sources append these after their builtin columns in schema(). Until T2 exists there
    are none.
    """
    return []


_TASKS_REF = re.compile(r"^tasks:(\*|[A-Za-z0-9_-]+)$")


def resolve_source(ref: str) -> TableSource:
    """The source for a table ref. Unknown or malformed refs are a 404."""
    match = _TASKS_REF.match(ref or "")
    if match:
        from .tasks_source import TasksSource
        return TasksSource(match.group(1))
    # Phase 4 (WP C1): refs like "tbl_<id>" resolve to a CustomTableSource here.
    raise HTTPException(status_code=404, detail=f"Unknown table {ref!r}")
