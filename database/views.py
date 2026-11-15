"""Views: database operations (PLAN.md 5.4, table ``views``).

A view is a named layout plus a JSON config (query, columns, layout settings) on one table.
A view created for a page (owner_page_id) is deleted together with the page.
"""

import json
import secrets
from datetime import datetime
from typing import Optional

from .engine import execute, fetchone
from .utils import get_db


def _view(row: dict) -> dict:
    return {
        "id": row["id"],
        "tableRef": row["table_ref"],
        "name": row["name"],
        "layout": row["layout"],
        "config": json.loads(row["config"]) if row["config"] else {},
        "ownerPageId": row["owner_page_id"],
        "createdBy": row["created_by"],
        "createdAt": row["created_at"],
        "updatedAt": row["updated_at"],
    }


def db_get_view(view_id: str) -> Optional[dict]:
    with get_db() as conn:
        row = fetchone(execute(conn, "SELECT * FROM views WHERE id = ?", (view_id,)))
    return _view(row) if row else None


def db_create_view(table_ref: str, name: str, layout: str, config: dict, owner_page_id: Optional[str],
                   created_by: Optional[str]) -> dict:
    view_id = secrets.token_urlsafe(9)
    now = datetime.now().isoformat()
    with get_db() as conn:
        execute(conn, """
            INSERT INTO views (id, table_ref, name, owner_page_id, layout, config, created_by, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (view_id, table_ref, name, owner_page_id, layout, json.dumps(config), created_by, now, now))
    return db_get_view(view_id)


def db_update_view(view_id: str, name: Optional[str] = None, layout: Optional[str] = None,
                   config: Optional[dict] = None) -> Optional[dict]:
    sets, params = ["updated_at = ?"], [datetime.now().isoformat()]
    if name is not None:
        sets.append("name = ?")
        params.append(name)
    if layout is not None:
        sets.append("layout = ?")
        params.append(layout)
    if config is not None:
        sets.append("config = ?")
        params.append(json.dumps(config))
    with get_db() as conn:
        execute(conn, f"UPDATE views SET {', '.join(sets)} WHERE id = ?", tuple(params) + (view_id,))
    return db_get_view(view_id)


def db_delete_view(view_id: str) -> bool:
    with get_db() as conn:
        return execute(conn, "DELETE FROM views WHERE id = ?", (view_id,)).rowcount > 0
