"""The custom table source: ``tbl_<id>``, tables people create in a page (WP C1).

A table belongs to a space like a page does: a project, or one person (database/custom_tables.py).
Its columns are rows of ``table_columns`` under the ref; its rows keep their values in
``custom_rows.data``. The schema always has a ``name`` column (the title; it cannot be changed or
deleted) and the read-only ``createdAt`` and ``createdBy``; everything else is a custom column.
There is no hierarchy.

Permissions (api/auth.py: can_read_custom_table, can_edit_custom_rows, can_edit_custom_schema):
read with task access on the project, edit rows like pages and tasks, change columns, rename and
delete as the project owner or an admin; a personal table is the owner's alone. Share-link guests
never get in. Queries run on the shared engine (api/tables/query.py); column logic is the shared
code in api/tables/columns.py.
"""

from __future__ import annotations

import secrets
from datetime import date
from typing import Any, Dict, List, Optional

from fastapi import HTTPException

from api.auth import can_access_space, can_edit_custom_rows, can_edit_custom_schema, can_read_custom_table
from api.events import live
from api.state import projects
from database import db_check_project_access, db_get_user_by_id, db_list_project_access
from database.custom_tables import (
    db_create_custom_row,
    db_create_custom_table,
    db_custom_row_values,
    db_delete_custom_row,
    db_delete_custom_table,
    db_get_custom_row,
    db_get_custom_table,
    db_list_custom_rows,
    db_list_custom_tables,
    db_rename_custom_table,
    db_set_custom_row_order,
    db_update_custom_row,
    write_custom_values,
)
from database.pages import parse_space
from database.table_columns import db_create_table_column, db_delete_table_column, db_update_table_column
from database.views import db_list_views

from . import columns as custom
from . import relations
from .query import run_query
from .source import UNSET, TableSource, custom_columns_for

MAX_TABLE_NAME = 200
MAX_STARTER_COLUMNS = 50
NAME_KEY = "name"
READONLY_KEYS = {"createdAt", "createdBy"}
RESERVED_KEYS = {NAME_KEY} | READONLY_KEYS
RESERVED_NAMES = {"name", "created", "created by"}


def _bad(detail: str) -> HTTPException:
    return HTTPException(status_code=400, detail=detail)


def space_string(table: dict) -> str:
    return "me" if table["spaceType"] == "personal" else f"p:{table['projectId']}"


def load_table(principal: dict, table_id: str) -> dict:
    """The table, or 404 when it does not exist and 403 when the principal may not read it.

    Personal tables of other people are a 404, so their existence is not revealed.
    """
    table = db_get_custom_table(table_id)
    if not table:
        raise HTTPException(status_code=404, detail="Table not found")
    if principal.get("is_guest"):
        raise HTTPException(status_code=403, detail="Not available to share-link guests")
    if not can_read_custom_table(principal, table):
        if table["spaceType"] == "personal":
            raise HTTPException(status_code=404, detail="Table not found")
        raise HTTPException(status_code=403, detail="Task access denied for this project")
    return table


async def publish(table: dict, message: dict) -> None:
    """Tell the people who can see the table, never the tab that made the change.

    Project table: tabs watching the project, with task access. Personal table: the owner's tabs.
    """
    if table["spaceType"] == "project":
        await live.to_project(table["projectId"], message, tasks_only=True)
    else:
        await live.to_user(table["ownerId"], {**message, "project": None}, skip_origin=True)


def _rows_changed(table: dict, ids: List[str], change: str):
    return publish(table, {"type": "rows_changed", "tableRef": table["id"], "ids": list(ids), "change": change})


def _schema_changed(table: dict):
    return publish(table, {"type": "schema_changed", "tableRef": table["id"]})


def _user_check(table: dict):
    """Which users a person column of the table accepts: the owner, or members with task access."""
    if table["spaceType"] == "personal":
        return lambda user_id: user_id == table["ownerId"]
    return lambda user_id: custom._user_has_access(user_id, table["projectId"]) and \
        custom.db_check_project_access(user_id, table["projectId"], require_tasks=True)


def _people_options(table: dict, rows: List[dict]) -> List[dict]:
    """People a person column offers: the owner (personal) or the members with task access, plus the creators of rows."""
    seen: Dict[str, str] = {}
    if table["spaceType"] == "personal":
        user = db_get_user_by_id(table["ownerId"])
        if user:
            seen[user["id"]] = user["username"]
    else:
        for member in db_list_project_access(table["projectId"]):
            if member["canTasks"]:
                seen.setdefault(member["userId"], member["username"])
    for uid in [r.get("createdBy") for r in rows] + [table.get("createdBy")]:
        if uid and uid not in seen:
            user = db_get_user_by_id(uid)
            if user:
                seen[uid] = user["username"]
    return [{"value": uid, "label": name} for uid, name in seen.items()]


# ---------------------------------------------------------------- column host (shared column editor)

class CustomColumnHost(custom.ColumnHost):
    """The columns of one custom table for api/tables/columns.py; values live in ``custom_rows.data``."""

    reserved_keys = RESERVED_KEYS
    reserved_names = RESERVED_NAMES

    def __init__(self, table_id: str):
        self.ref = table_id
        self.table_id = table_id
        self._table: Optional[dict] = None

    def need_edit_schema(self, principal: dict) -> None:
        self._table = load_table(principal, self.table_id)
        if not can_edit_custom_schema(principal, self._table):
            raise HTTPException(status_code=403, detail="Only the project owner or an admin can change columns")

    def user_ok(self, user_id: str) -> bool:
        return _user_check(self._table)(user_id)

    def relation_space(self):
        table = self._table
        return ("personal", table["ownerId"]) if table["spaceType"] == "personal" else ("project", table["projectId"])

    def stored_values(self) -> Dict[str, dict]:
        return db_custom_row_values(self.table_id)

    def save_column(self, key: str, fields: dict, updated: Dict[str, dict]) -> None:
        db_update_table_column(self.ref, key, fields, updated, write=write_custom_values(self.table_id))

    def remove_column(self, key: str, updated: Dict[str, dict]) -> None:
        db_delete_table_column(self.ref, key, updated, write=write_custom_values(self.table_id))

    async def announce(self, changed_ids: List[str]) -> None:
        await _schema_changed(self._table)
        if changed_ids:
            await _rows_changed(self._table, changed_ids, "updated")


# ---------------------------------------------------------------- the source

class CustomTableSource(TableSource):
    def __init__(self, table_id: str):
        self.table_id = table_id
        self.ref = table_id

    def _load(self, principal: dict) -> dict:
        return load_table(principal, self.table_id)

    def _load_for_edit(self, principal: dict) -> dict:
        table = self._load(principal)
        if not can_edit_custom_rows(principal, table):
            raise HTTPException(status_code=403, detail="Task access denied for this project")
        return table

    def column_host(self) -> CustomColumnHost:
        return CustomColumnHost(self.table_id)

    # ------------------------------------------------------------ schema

    def _columns(self, table: dict, rows: List[dict], principal: dict) -> List[dict]:
        people = _people_options(table, rows)
        extra = custom_columns_for(self.ref)
        for column in extra:
            if column["type"] in ("person", "people"):
                column["options"] = people
        columns = [
            {"key": NAME_KEY, "name": "Name", "type": "text", "builtin": True},
            *extra,
            {"key": "createdAt", "name": "Created", "type": "date", "builtin": True, "readonly": True},
            {"key": "createdBy", "name": "Created by", "type": "person", "builtin": True, "readonly": True,
             "options": people},
        ]
        return relations.finish_columns(principal, self.ref, columns)

    def schema(self, principal: dict) -> dict:
        table = self._load(principal)
        space = ({"type": "personal"} if table["spaceType"] == "personal"
                 else {"type": "project", "projectId": table["projectId"]})
        can_edit = can_edit_custom_rows(principal, table)
        return {
            "ref": self.ref,
            "name": table["name"],
            "columns": self._columns(table, db_list_custom_rows(self.table_id), principal),
            "titleColumn": NAME_KEY,
            "capabilities": {"create": can_edit, "delete": can_edit, "hierarchy": False,
                             "editSchema": can_edit_custom_schema(principal, table)},
            "space": space,
        }

    # ------------------------------------------------------------ rows

    def _row(self, stored: dict, can_edit: bool, cols: List[dict]) -> dict:
        values = {NAME_KEY: stored["values"].get(NAME_KEY) or ""}
        values.update(custom.row_values({"customFields": stored["values"]}, [c for c in cols if not c["builtin"]]))
        values["createdAt"] = stored["createdAt"]
        values["createdBy"] = stored["createdBy"]
        return {"id": stored["id"], "tableRef": self.ref, "parentId": None, "childCount": 0,
                "values": values, "canEdit": can_edit}

    def _rows(self, principal: dict, stored: List[dict], can_edit: bool, cols: List[dict]) -> List[dict]:
        """Rows with relation values resolved for this reader and mirror columns filled."""
        rows = [self._row(r, can_edit, cols) for r in stored]
        return relations.fill_rows(principal, rows, {self.ref: cols})

    def query(self, principal: dict, query: Optional[dict], today: Optional[date] = None) -> dict:
        table = self._load(principal)
        stored = db_list_custom_rows(self.table_id)
        cols = self._columns(table, stored, principal)
        rows = self._rows(principal, stored, can_edit_custom_rows(principal, table), cols)
        return run_query(rows, cols, query, me=principal["id"], today=today, title_column=NAME_KEY)

    def get_row(self, principal: dict, row_id: str) -> dict:
        table = self._load(principal)
        stored = db_get_custom_row(self.table_id, row_id)
        if not stored:
            raise HTTPException(status_code=404, detail="Row not found")
        return self._rows(principal, [stored], can_edit_custom_rows(principal, table),
                          self._columns(table, [stored], principal))[0]

    # ------------------------------------------------------------ writes

    def _checked(self, principal: dict, table: dict, values: Any, base: Optional[dict]) -> dict:
        """Row values by column key -> the complete values object to store, validated."""
        if not isinstance(values, dict):
            raise _bad("values must be an object of column key -> value")
        result = dict(base or {})
        custom_values: Dict[str, Any] = {}
        for key, value in values.items():
            if key in READONLY_KEYS:
                raise _bad(f"Column '{key}' is read-only")
            if key == NAME_KEY:
                if value is None:
                    value = ""
                if not isinstance(value, str):
                    raise _bad("Name must be text")
                if len(value) > custom.TEXT_LIMITS["text"]:
                    raise _bad("Name is too long")
                result[NAME_KEY] = value
            elif isinstance(key, str) and key.startswith(custom.KEY_PREFIX):
                custom_values[key] = value
            else:
                raise _bad(f"Unknown column '{key}'")
        if custom_values:
            cols = {c["key"]: c for c in custom_columns_for(self.ref)}
            result = custom.checked_values(cols, custom_values, result, _user_check(table), principal)
        return result

    async def create_row(self, principal: dict, values: dict, parent_id: Optional[str] = None,
                         project_id: Optional[str] = None) -> dict:
        table = self._load_for_edit(principal)
        if parent_id:
            raise _bad("This table has no hierarchy: parentId is not supported")
        stored = db_create_custom_row(self.table_id, self._checked(principal, table, values, None), principal["id"])
        await _rows_changed(table, [stored["id"]], "created")
        return self._rows(principal, [stored], True, self._columns(table, [stored], principal))[0]

    async def update_row(self, principal: dict, row_id: str, values: dict, parent_id: Any = UNSET) -> dict:
        table = self._load_for_edit(principal)
        stored = db_get_custom_row(self.table_id, row_id)
        if not stored:
            raise HTTPException(status_code=404, detail="Row not found")
        if parent_id is not UNSET and parent_id is not None:
            raise _bad("This table has no hierarchy: parentId is not supported")
        merged = self._checked(principal, table, values, stored["values"])
        stored = db_update_custom_row(self.table_id, row_id, merged)
        await _rows_changed(table, [row_id], "updated")
        return self._rows(principal, [stored], True, self._columns(table, [stored], principal))[0]

    async def delete_row(self, principal: dict, row_id: str) -> None:
        table = self._load_for_edit(principal)
        if not db_delete_custom_row(self.table_id, row_id):
            raise HTTPException(status_code=404, detail="Row not found")
        await _rows_changed(table, [row_id], "deleted")

    async def reorder(self, principal: dict, ids: List[str], before: Optional[str] = None) -> None:
        if not isinstance(ids, list) or not ids or not all(isinstance(i, str) for i in ids):
            raise _bad("ids must be a non-empty list of row ids")
        table = self._load_for_edit(principal)
        everything = [r["id"] for r in db_list_custom_rows(self.table_id)]
        moving = list(dict.fromkeys(ids))
        if any(i not in everything for i in moving):
            raise HTTPException(status_code=404, detail="Row not found")
        rest = [i for i in everything if i not in moving]
        if before is None:
            result = rest + moving
        elif before in moving:
            raise _bad("'before' cannot be one of the moved rows")
        elif before in rest:
            at = rest.index(before)
            result = rest[:at] + moving + rest[at:]
        else:
            raise _bad("'before' is not a row of this table")
        db_set_custom_row_order(self.table_id, result)
        await _rows_changed(table, moving, "reordered")


# ---------------------------------------------------------------- table CRUD

def table_summary(principal: dict, table: dict) -> dict:
    """What the endpoints say about a table."""
    return {
        "id": table["id"], "ref": table["id"], "name": table["name"], "space": space_string(table),
        "spaceType": table["spaceType"], "projectId": table["projectId"],
        "createdBy": table["createdBy"], "createdAt": table["createdAt"], "updatedAt": table["updatedAt"],
        "canEdit": can_edit_custom_rows(principal, table),
        "canEditSchema": can_edit_custom_schema(principal, table),
    }


def _clean_table_name(raw: Any) -> str:
    if not isinstance(raw, str) or not raw.strip():
        raise _bad("A table name is required")
    return raw.strip()[:MAX_TABLE_NAME]


def _space(principal: dict, space: Any, write: bool) -> tuple:
    """Validate a space string ('me' or 'p:<projectId>') and the caller's rights. Returns (space_type, project_id)."""
    try:
        space_type, project_id = parse_space(space)
    except ValueError as exc:
        raise _bad(str(exc))
    if principal.get("is_guest"):
        raise HTTPException(status_code=403, detail="Not available to share-link guests")
    if project_id is not None and project_id not in projects:
        raise HTTPException(status_code=404, detail="Project not found")
    if write:
        allowed = can_access_space(principal, space, write=True)
    else:
        probe = {"spaceType": space_type, "projectId": project_id, "ownerId": principal["id"]}
        allowed = can_read_custom_table(principal, probe)
    if not allowed:
        raise HTTPException(status_code=403, detail="Access denied")
    return space_type, project_id


def list_tables(principal: dict, space: Any) -> List[dict]:
    space_type, project_id = _space(principal, space, write=False)
    owner = principal["id"] if space_type == "personal" else None
    return [table_summary(principal, t) for t in db_list_custom_tables(space_type, project_id, owner)]


def _starter_columns(raw: Any) -> List[dict]:
    """Validate the optional ``columns`` of a create request: [{name, type, options?}]."""
    if raw is None:
        return []
    if not isinstance(raw, list) or len(raw) > MAX_STARTER_COLUMNS:
        raise _bad(f"columns must be a list of at most {MAX_STARTER_COLUMNS} {{name, type, options?}}")
    checked: List[dict] = []
    for item in raw:
        if not isinstance(item, dict):
            raise _bad("Each column must be an object like {name, type}")
        col_type = custom.check_type(item.get("type"))
        if col_type == "relation":
            raise _bad("Add relation columns after the table exists: they need a target table")
        name = custom.clean_name(item.get("name"), checked, reserved=RESERVED_NAMES)
        config: dict = {}
        if col_type in custom.SELECT_TYPES:
            config["options"] = custom.clean_options(item.get("options") or [])
        elif item.get("options"):
            raise _bad(f"Options only apply to select and multiselect columns, not {col_type}")
        checked.append({"key": "", "name": name, "type": col_type, "config": config})
    return checked


async def create_table(principal: dict, data: Any) -> dict:
    """Create a table in a space, with optional starter columns, in the caller's name."""
    if not isinstance(data, dict):
        raise _bad("The body must be an object with name and space")
    space_type, project_id = _space(principal, data.get("space"), write=True)
    name = _clean_table_name(data.get("name"))
    starter = _starter_columns(data.get("columns"))
    table = db_create_custom_table(name, space_type, project_id, principal["id"] if space_type == "personal" else None,
                                   principal["id"])
    for column in starter:
        db_create_table_column(table["id"], custom.KEY_PREFIX + secrets.token_hex(4), column["name"],
                               column["type"], column["config"], principal["id"])
    return table_summary(principal, table)


def table_info(principal: dict, table_id: str) -> dict:
    """The summary plus what deleting would remove (row and view counts)."""
    table = load_table(principal, table_id)
    return {**table_summary(principal, table), "rowCount": len(db_list_custom_rows(table_id)),
            "viewCount": len(db_list_views(table_ref=table_id))}


async def rename_table(principal: dict, table_id: str, data: Any) -> dict:
    table = load_table(principal, table_id)
    if not can_edit_custom_schema(principal, table):
        raise HTTPException(status_code=403, detail="Only the project owner or an admin can rename this table")
    if not isinstance(data, dict):
        raise _bad("The body must be an object with name")
    table = db_rename_custom_table(table_id, _clean_table_name(data.get("name")))
    await _schema_changed(table)
    return table_summary(principal, table)


async def delete_table(principal: dict, table_id: str) -> dict:
    """Delete the table with its rows, columns and views. Other tabs get ``view_changed`` for each view."""
    table = load_table(principal, table_id)
    if not can_edit_custom_schema(principal, table):
        raise HTTPException(status_code=403, detail="Only the project owner or an admin can delete this table")
    view_ids = [v["id"] for v in db_list_views(table_ref=table_id)]
    pointing = [ref for ref in relations.refs_pointing_at(table_id) if ref != table_id]
    db_delete_custom_table(table_id)
    await _schema_changed(table)
    await relations.announce_schema_changed(pointing)
    for view_id in view_ids:
        await publish(table, {"type": "view_changed", "viewId": view_id})
    return {"success": True, "deletedViews": len(view_ids)}
