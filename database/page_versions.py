"""Page versions: database operations (H2). A version is a full copy of the encoded Yjs document."""

import json
import uuid
from datetime import datetime
from typing import List, Optional

from .engine import execute, fetchall, fetchone
from .utils import get_db

_META = "id, page_id, created_at, created_by, name, kind, text_length, excerpt, editors"


def _version(row: dict, with_state: bool = False) -> dict:
    out = {
        "id": row["id"],
        "pageId": row["page_id"],
        "createdAt": row["created_at"],
        "createdBy": row["created_by"],
        "name": row["name"],
        "kind": row["kind"],
        "textLength": row["text_length"] or 0,
        "excerpt": row["excerpt"] or "",
        "editors": json.loads(row["editors"] or "[]"),
    }
    if with_state:
        out["state"] = bytes(row["state"])
    return out


def db_create_version(page_id: str, state: bytes, text: str, kind: str, created_by: Optional[str] = None,
                      name: Optional[str] = None, editors: Optional[List[str]] = None,
                      created_at: Optional[str] = None) -> dict:
    version_id = uuid.uuid4().hex
    created_at = created_at or datetime.now().isoformat()
    with get_db() as conn:
        execute(conn, "INSERT INTO page_versions (id, page_id, created_at, created_by, name, kind, state, text_length, "
                      "excerpt, editors) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (version_id, page_id, created_at, created_by, name, kind, state, len(text), text[:160].strip(),
                 json.dumps(sorted(editors or []))))
    return {"id": version_id, "createdAt": created_at}


def db_list_versions(page_id: str) -> List[dict]:
    """Newest first, without the state."""
    with get_db() as conn:
        rows = fetchall(execute(conn, f"SELECT {_META} FROM page_versions WHERE page_id = ? "
                                      "ORDER BY created_at DESC, id DESC", (page_id,)))
    return [_version(r) for r in rows]


def db_get_version(page_id: str, version_id: str, with_state: bool = False) -> Optional[dict]:
    columns = _META + (", state" if with_state else "")
    with get_db() as conn:
        row = fetchone(execute(conn, f"SELECT {columns} FROM page_versions WHERE id = ? AND page_id = ?",
                               (version_id, page_id)))
    return _version(row, with_state) if row else None


def db_latest_version_state(page_id: str) -> Optional[dict]:
    """The newest version of any kind with its state, or None."""
    with get_db() as conn:
        row = fetchone(execute(conn, f"SELECT {_META}, state FROM page_versions WHERE page_id = ? "
                                     "ORDER BY created_at DESC, id DESC LIMIT 1", (page_id,)))
    return _version(row, True) if row else None


def db_latest_auto_time(page_id: str) -> Optional[str]:
    with get_db() as conn:
        row = fetchone(execute(conn, "SELECT MAX(created_at) AS t FROM page_versions WHERE page_id = ? AND kind = 'auto'",
                               (page_id,)))
    return row["t"] if row else None


def db_set_version_name(page_id: str, version_id: str, name: Optional[str]) -> bool:
    with get_db() as conn:
        return execute(conn, "UPDATE page_versions SET name = ? WHERE id = ? AND page_id = ?",
                       (name, version_id, page_id)).rowcount > 0


def db_delete_version(page_id: str, version_id: str) -> bool:
    with get_db() as conn:
        return execute(conn, "DELETE FROM page_versions WHERE id = ? AND page_id = ?", (version_id, page_id)).rowcount > 0


def db_thinnable_versions(page_id: str) -> List[dict]:
    """Versions without a name (candidates for thinning): [{id, createdAt}], newest first."""
    with get_db() as conn:
        rows = fetchall(execute(conn, "SELECT id, created_at FROM page_versions WHERE page_id = ? AND name IS NULL "
                                      "ORDER BY created_at DESC, id DESC", (page_id,)))
    return [{"id": r["id"], "createdAt": r["created_at"]} for r in rows]


def db_delete_versions(page_id: str, ids: List[str]) -> None:
    with get_db() as conn:
        for version_id in ids:
            execute(conn, "DELETE FROM page_versions WHERE id = ? AND page_id = ? AND name IS NULL", (version_id, page_id))
