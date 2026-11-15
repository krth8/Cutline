"""The TableSource contract and the resolver from a table ref to a source.

A table ref names a table: ``tasks:<projectId>``, ``tasks:*`` or ``tbl_<id>`` (a custom table).
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


def custom_columns_for(table_ref: str) -> List[dict]:
    """Hook for WP T2: the user-defined columns of a table, as Column dicts (builtin: False).

    Sources append these after their builtin columns in schema(), in sort order. Custom
    columns belong to one project: ``tasks:*`` has none (rows still carry their values).
    """
    from .columns import list_columns
    return list_columns(table_ref)


_TASKS_REF = re.compile(r"^tasks:(\*|[A-Za-z0-9_-]+)$")
_CUSTOM_REF = re.compile(r"^tbl_[A-Za-z0-9_-]+$")


def resolve_source(ref: str) -> TableSource:
    """The source for a table ref. Unknown or malformed refs are a 404."""
    match = _TASKS_REF.match(ref or "")
    if match:
        from .tasks_source import TasksSource
        return TasksSource(match.group(1))
    if _CUSTOM_REF.match(ref or ""):
        from .custom_source import CustomTableSource
        return CustomTableSource(ref)
    raise HTTPException(status_code=404, detail=f"Unknown table {ref!r}")
