"""Templates: database operations (table ``templates``, migration 020). No permission checks here."""

import json
import uuid
from datetime import datetime
from typing import List, Optional

from .engine import execute, fetchall, fetchone
from .utils import get_db

_LIST_COLUMNS = "id, name, description, scope, owner_id, page_count, created_at"


def _template(row: dict, with_bundle: bool = False) -> dict:
    out = {
        "id": row["id"], "name": row["name"], "description": row["description"] or "", "scope": row["scope"],
        "ownerId": row["owner_id"], "pageCount": row["page_count"], "createdAt": row["created_at"],
    }
    if with_bundle:
        out["bundle"] = json.loads(row["bundle"])
    return out


def new_template_id() -> str:
    return uuid.uuid4().hex


def db_add_template(template_id: str, name: str, description: str, scope: str, owner_id: str,
                    page_count: int, bundle: dict) -> dict:
    with get_db() as conn:
        execute(conn, "INSERT INTO templates (id, name, description, scope, owner_id, page_count, bundle, created_at) "
                      "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                (template_id, name, description, scope, owner_id, page_count, json.dumps(bundle),
                 datetime.now().isoformat()))
    return db_get_template(template_id)


def db_get_template(template_id: str, with_bundle: bool = False) -> Optional[dict]:
    columns = _LIST_COLUMNS + (", bundle" if with_bundle else "")
    with get_db() as conn:
        row = fetchone(execute(conn, f"SELECT {columns} FROM templates WHERE id = ?", (template_id,)))
    return _template(row, with_bundle) if row else None


def db_list_templates_for(user_id: str) -> List[dict]:
    """Workspace templates and the user's own personal ones, newest first (without bundles)."""
    with get_db() as conn:
        rows = fetchall(execute(
            conn, f"SELECT {_LIST_COLUMNS} FROM templates WHERE scope = 'workspace' OR owner_id = ? "
                  "ORDER BY created_at DESC, id", (user_id,)))
    return [_template(r) for r in rows]


def db_delete_template(template_id: str) -> bool:
    with get_db() as conn:
        return execute(conn, "DELETE FROM templates WHERE id = ?", (template_id,)).rowcount > 0
