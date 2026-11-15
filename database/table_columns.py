"""Custom table columns (table_columns) and the values they keep in tasks.custom_fields."""

import json
import secrets
from datetime import datetime
from typing import Callable, Dict, List, Optional

from .engine import execute, fetchall, fetchone
from .utils import get_db


def _column(row) -> dict:
    return {
        "id": row["id"],
        "tableRef": row["table_ref"],
        "key": row["key"],
        "name": row["name"],
        "type": row["type"],
        "config": json.loads(row["config"]) if row["config"] else {},
        "sortOrder": row["sort_order"],
        "createdBy": row["created_by"],
        "createdAt": row["created_at"],
    }


def db_list_table_columns(table_ref: str) -> List[dict]:
    with get_db() as conn:
        cursor = execute(conn, "SELECT * FROM table_columns WHERE table_ref = ? ORDER BY sort_order, created_at, key",
                         (table_ref,))
        return [_column(r) for r in fetchall(cursor)]


def db_get_table_column(table_ref: str, key: str) -> Optional[dict]:
    with get_db() as conn:
        cursor = execute(conn, "SELECT * FROM table_columns WHERE table_ref = ? AND key = ?", (table_ref, key))
        row = fetchone(cursor)
        return _column(row) if row else None


def db_create_table_column(table_ref: str, key: str, name: str, col_type: str, config: dict,
                           created_by: Optional[str]) -> dict:
    with get_db() as conn:
        cursor = execute(conn, "SELECT COALESCE(MAX(sort_order), 0) + 1 AS next FROM table_columns WHERE table_ref = ?",
                         (table_ref,))
        sort_order = fetchone(cursor)["next"]
        execute(conn, """
            INSERT INTO table_columns (id, table_ref, key, name, type, config, sort_order, created_by, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (secrets.token_urlsafe(12), table_ref, key, name, col_type, json.dumps(config), sort_order,
              created_by, datetime.now().isoformat()))
    return db_get_table_column(table_ref, key)


def db_project_custom_fields(project_id: str) -> Dict[str, dict]:
    """task id -> custom_fields object, for every task of the project that has any."""
    with get_db() as conn:
        cursor = execute(conn, "SELECT id, custom_fields FROM tasks WHERE project_id = ? AND custom_fields IS NOT NULL",
                         (project_id,))
        out = {}
        for row in fetchall(cursor):
            try:
                data = json.loads(row["custom_fields"])
            except (TypeError, ValueError):
                continue
            if isinstance(data, dict):
                out[row["id"]] = data
        return out


def _write_values(conn, task_values: Dict[str, dict]) -> None:
    for task_id, values in task_values.items():
        execute(conn, "UPDATE tasks SET custom_fields = ? WHERE id = ?",
                (json.dumps(values) if values else None, task_id))


def db_update_table_column(table_ref: str, key: str, fields: dict, task_values: Dict[str, dict],
                           write: Callable = _write_values) -> None:
    """Change a column (name, type, config, sortOrder given in fields) and rewrite the values of the
    given rows (row id -> complete values; tasks by default, ``write`` for another kind of row) in one
    transaction."""
    columns = {"name": "name", "type": "type", "sortOrder": "sort_order"}
    sets, params = [], []
    for field, value in fields.items():
        if field == "config":
            sets.append("config = ?")
            params.append(json.dumps(value))
        elif field in columns:
            sets.append(f"{columns[field]} = ?")
            params.append(value)
    with get_db() as conn:
        if sets:
            execute(conn, f"UPDATE table_columns SET {', '.join(sets)} WHERE table_ref = ? AND key = ?",
                    tuple(params) + (table_ref, key))
        write(conn, task_values)


def db_delete_table_column(table_ref: str, key: str, task_values: Dict[str, dict],
                           write: Callable = _write_values) -> None:
    """Delete a column and rewrite the values of the given rows, in one transaction."""
    with get_db() as conn:
        execute(conn, "DELETE FROM table_columns WHERE table_ref = ? AND key = ?", (table_ref, key))
        write(conn, task_values)
