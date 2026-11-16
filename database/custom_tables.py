"""Custom tables (custom_tables, custom_rows): storage for user-created tables, WP C1.

A table is ``tbl_<id>``; its columns are in ``table_columns`` (database/table_columns.py) under the
same ref. A row's ``values`` is the JSON object stored in ``custom_rows.data``, keyed by column key.
No permission checks here: api/tables/custom_source.py does them.
"""

import json
import secrets
from datetime import datetime
from typing import Dict, List, Optional

from .engine import execute, fetchall, fetchone
from .utils import get_db

TABLE_PREFIX = "tbl_"


def _now() -> str:
    return datetime.now().isoformat()


def _table(row) -> dict:
    return {
        "id": row["id"],
        "name": row["name"],
        "spaceType": row["space_type"],
        "projectId": row["project_id"],
        "ownerId": row["owner_id"],
        "createdBy": row["created_by"],
        "createdAt": row["created_at"],
        "updatedAt": row["updated_at"],
    }


def _row(row) -> dict:
    try:
        values = json.loads(row["data"]) if row["data"] else {}
    except ValueError:
        values = {}
    return {
        "id": row["id"],
        "tableId": row["table_id"],
        "values": values if isinstance(values, dict) else {},
        "sortOrder": row["sort_order"],
        "createdBy": row["created_by"],
        "createdAt": row["created_at"],
        "updatedAt": row["updated_at"],
    }


# ---------------------------------------------------------------- tables

def db_get_custom_table(table_id: str) -> Optional[dict]:
    with get_db() as conn:
        row = fetchone(execute(conn, "SELECT * FROM custom_tables WHERE id = ?", (table_id,)))
    return _table(row) if row else None


def db_list_custom_tables(space_type: str, project_id: Optional[str] = None,
                          owner_id: Optional[str] = None) -> List[dict]:
    """The tables of one space, oldest first."""
    where, params = "space_type = ?", [space_type]
    where += " AND project_id = ?" if space_type == "project" else " AND owner_id = ?"
    params.append(project_id if space_type == "project" else owner_id)
    with get_db() as conn:
        rows = fetchall(execute(conn, f"SELECT * FROM custom_tables WHERE {where} ORDER BY created_at, id",
                                tuple(params)))
    return [_table(r) for r in rows]


def db_create_custom_table(name: str, space_type: str, project_id: Optional[str], owner_id: Optional[str],
                           created_by: Optional[str]) -> dict:
    table_id = TABLE_PREFIX + secrets.token_hex(6)
    now = _now()
    with get_db() as conn:
        execute(conn, """
            INSERT INTO custom_tables (id, name, space_type, project_id, owner_id, created_by, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        """, (table_id, name, space_type, project_id, owner_id, created_by, now, now))
    return db_get_custom_table(table_id)


def db_rename_custom_table(table_id: str, name: str) -> Optional[dict]:
    with get_db() as conn:
        execute(conn, "UPDATE custom_tables SET name = ?, updated_at = ? WHERE id = ?", (name, _now(), table_id))
    return db_get_custom_table(table_id)


def db_delete_custom_table(table_id: str) -> int:
    """Delete the table with its rows, its columns and the views on it. Returns how many views went."""
    with get_db() as conn:
        views = execute(conn, "DELETE FROM views WHERE table_ref = ?", (table_id,)).rowcount
        execute(conn, "DELETE FROM table_columns WHERE table_ref = ?", (table_id,))
        execute(conn, "DELETE FROM custom_rows WHERE table_id = ?", (table_id,))
        execute(conn, "DELETE FROM custom_tables WHERE id = ?", (table_id,))
    return views


# ---------------------------------------------------------------- rows

def db_list_custom_rows(table_id: str) -> List[dict]:
    with get_db() as conn:
        rows = fetchall(execute(conn, "SELECT * FROM custom_rows WHERE table_id = ? ORDER BY sort_order, created_at, id",
                                (table_id,)))
    return [_row(r) for r in rows]


def db_get_custom_row(table_id: str, row_id: str) -> Optional[dict]:
    with get_db() as conn:
        row = fetchone(execute(conn, "SELECT * FROM custom_rows WHERE table_id = ? AND id = ?", (table_id, row_id)))
    return _row(row) if row else None


def db_create_custom_row(table_id: str, values: dict, created_by: Optional[str]) -> dict:
    """Add a row at the end of the table."""
    row_id = secrets.token_urlsafe(9)
    now = _now()
    with get_db() as conn:
        last = fetchone(execute(conn, "SELECT MAX(sort_order) AS m FROM custom_rows WHERE table_id = ?", (table_id,)))
        order = (last["m"] + 1.0) if last and last["m"] is not None else 0.0
        execute(conn, """
            INSERT INTO custom_rows (id, table_id, data, sort_order, created_by, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        """, (row_id, table_id, json.dumps(values), order, created_by, now, now))
        execute(conn, "UPDATE custom_tables SET updated_at = ? WHERE id = ?", (now, table_id))
    return db_get_custom_row(table_id, row_id)


def db_update_custom_row(table_id: str, row_id: str, values: dict) -> Optional[dict]:
    """Replace a row's values object."""
    now = _now()
    with get_db() as conn:
        execute(conn, "UPDATE custom_rows SET data = ?, updated_at = ? WHERE table_id = ? AND id = ?",
                (json.dumps(values), now, table_id, row_id))
        execute(conn, "UPDATE custom_tables SET updated_at = ? WHERE id = ?", (now, table_id))
    return db_get_custom_row(table_id, row_id)


def db_delete_custom_row(table_id: str, row_id: str) -> bool:
    with get_db() as conn:
        done = execute(conn, "DELETE FROM custom_rows WHERE table_id = ? AND id = ?", (table_id, row_id)).rowcount > 0
        execute(conn, "UPDATE custom_tables SET updated_at = ? WHERE id = ?", (_now(), table_id))
    return done


def db_set_custom_row_order(table_id: str, ids: List[str]) -> None:
    """Give the rows the order 0, 1, 2 ... of ``ids`` (every row of the table, in the wanted order)."""
    with get_db() as conn:
        for position, row_id in enumerate(ids):
            execute(conn, "UPDATE custom_rows SET sort_order = ? WHERE table_id = ? AND id = ?",
                    (float(position), table_id, row_id))
        execute(conn, "UPDATE custom_tables SET updated_at = ? WHERE id = ?", (_now(), table_id))


def db_custom_row_values(table_id: str) -> Dict[str, dict]:
    """row id -> values object, for every row that has at least one value."""
    return {r["id"]: r["values"] for r in db_list_custom_rows(table_id) if r["values"]}


def write_custom_values(table_id: str):
    """A ``write`` function for db_update_table_column / db_delete_table_column: rewrites the values of
    custom rows (row id -> complete values) inside the caller's transaction."""
    def write(conn_, updated: Dict[str, dict]) -> None:
        now = _now()
        for row_id, values in updated.items():
            execute(conn_, "UPDATE custom_rows SET data = ?, updated_at = ? WHERE table_id = ? AND id = ?",
                    (json.dumps(values), now, table_id, row_id))
    return write


def db_custom_row_names(table_id: str, row_ids: List[str], title_key: str = "name") -> Dict[str, str]:
    """row id -> title, for the given rows of one table that exist (one query per 500 ids)."""
    out: Dict[str, str] = {}
    ids = list(dict.fromkeys(row_ids))
    with get_db() as conn:
        for start in range(0, len(ids), 500):
            chunk = ids[start:start + 500]
            marks = ", ".join("?" for _ in chunk)
            rows = fetchall(execute(conn, f"SELECT id, data FROM custom_rows WHERE table_id = ? AND id IN ({marks})",
                                    (table_id, *chunk)))
            for row in rows:
                try:
                    data = json.loads(row["data"]) if row["data"] else {}
                except ValueError:
                    data = {}
                title = data.get(title_key) if isinstance(data, dict) else None
                out[row["id"]] = title if isinstance(title, str) else ""
    return out
