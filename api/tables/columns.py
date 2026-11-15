"""Custom columns of the tasks table (WP T2): definitions, value validation, retyping.

A custom column belongs to one project (``table_ref`` = ``tasks:<projectId>``); its key is
``cf_<random>``. Values live in the task's ``custom_fields`` JSON object, keyed by column key.
A missing key means empty (null; false for checkbox; [] for multiselect and people). Writes drop
empty values instead of storing them.

Select options are stored inside the column's config under "options" and shown as the
column's top-level ``options`` in the schema. The server assigns each option's ``value`` id;
a client keeps an option by sending its existing ``value`` (so renaming a label never loses data).
"""

from __future__ import annotations

import json
import math
import secrets
from datetime import date
from typing import Any, Callable, Dict, List, Optional, Tuple

from fastapi import HTTPException

from api.events import live
from api.routes import tasks as task_api
from api.state import projects
from database import db_check_project_access, db_get_project_access, db_get_user_by_id
from database.table_columns import (
    db_create_table_column,
    db_delete_table_column,
    db_get_table_column,
    db_list_table_columns,
    db_project_custom_fields,
    db_update_table_column,
)

CUSTOM_TYPES = ("text", "longtext", "number", "checkbox", "date", "select", "multiselect", "url", "person", "people")
SELECT_TYPES = ("select", "multiselect")
MULTI_TYPES = ("multiselect", "people")
TEXT_TYPES = ("text", "longtext", "url")
TEXT_LIMITS = {"text": 10_000, "longtext": 100_000, "url": 2000}
MAX_OPTIONS = 200
MAX_NAME = 80
MAX_CONFIG = 8000
KEY_PREFIX = "cf_"

# Builtin task columns: their keys cannot be changed here, their names cannot be reused
BUILTIN_KEYS = {"name", "status", "assignees", "priority", "stage", "startDate", "dueDate", "section", "clip",
                "description", "createdAt", "createdBy", "project"}
BUILTIN_NAMES = {"name", "status", "assignees", "priority", "stage", "start date", "due date", "section", "clip",
                 "description", "created", "created by", "project"}


def _bad(detail: str) -> HTTPException:
    return HTTPException(status_code=400, detail=detail)


# ---------------------------------------------------------------- column definitions

def table_ref(project_id: str) -> str:
    return f"tasks:{project_id}"


def to_column(stored: dict) -> dict:
    """The Column dict (PLAN 5.6) of a stored column."""
    config = dict(stored.get("config") or {})
    options = config.pop("options", None)
    column = {"key": stored["key"], "name": stored["name"], "type": stored["type"], "builtin": False}
    if options is not None:
        column["options"] = [dict(o) for o in options]
    if config:
        column["config"] = config
    return column


def list_columns(ref: str) -> List[dict]:
    return [to_column(c) for c in db_list_table_columns(ref)]


def empty_value(col_type: str) -> Any:
    if col_type == "checkbox":
        return False
    if col_type in MULTI_TYPES:
        return []
    return None


def is_empty_value(value: Any) -> bool:
    if isinstance(value, bool):
        return not value
    if isinstance(value, (int, float)):
        return False
    return value is None or value == "" or value == []


def _new_option_value() -> str:
    return "o_" + secrets.token_hex(4)


def clean_options(raw: Any, existing: Optional[List[dict]] = None) -> List[dict]:
    """Validate client options. Entries whose ``value`` is an existing option keep it; others get a new id."""
    if not isinstance(raw, list):
        raise _bad("options must be a list of {label, color?}")
    if len(raw) > MAX_OPTIONS:
        raise _bad(f"A column can have at most {MAX_OPTIONS} options")
    known = {o["value"] for o in (existing or [])}
    used, seen_labels, out = set(), set(), []
    for item in raw:
        if isinstance(item, str):
            item = {"label": item}
        if not isinstance(item, dict):
            raise _bad("Each option must be an object like {label, color?}")
        label = item.get("label")
        if not isinstance(label, str) or not label.strip() or len(label.strip()) > MAX_NAME:
            raise _bad(f"Option labels must be text of 1-{MAX_NAME} characters")
        label = label.strip()
        if label.casefold() in seen_labels:
            raise _bad(f"Duplicate option label '{label}'")
        seen_labels.add(label.casefold())
        value = item.get("value")
        if isinstance(value, str) and value in known and value not in used:
            used.add(value)
        else:
            value = _new_option_value()
        option = {"value": value, "label": label}
        color = item.get("color")
        if color is not None:
            if not isinstance(color, str) or len(color) > 40:
                raise _bad("Option color must be text such as '#ef4444'")
            if color:
                option["color"] = color
        out.append(option)
    return out


def clean_config(raw: Any) -> dict:
    if not isinstance(raw, dict):
        raise _bad("config must be an object")
    if "options" in raw:
        raise _bad("Send options as the top-level 'options' field, not inside config")
    try:
        size = len(json.dumps(raw))
    except (TypeError, ValueError):
        raise _bad("config must be plain JSON")
    if size > MAX_CONFIG:
        raise _bad("config is too large")
    return dict(raw)


def clean_name(raw: Any, columns: List[dict], own_key: Optional[str] = None,
               reserved: Optional[set] = None) -> str:
    if not isinstance(raw, str) or not raw.strip():
        raise _bad(f"A column name of 1-{MAX_NAME} characters is required")
    name = raw.strip()
    if len(name) > MAX_NAME:
        raise _bad(f"A column name has at most {MAX_NAME} characters")
    taken = {c["name"].casefold() for c in columns if c["key"] != own_key} | (BUILTIN_NAMES if reserved is None else reserved)
    if name.casefold() in taken:
        raise HTTPException(status_code=409, detail=f"A column named '{name}' already exists in this table")
    return name


def check_type(raw: Any) -> str:
    if raw not in CUSTOM_TYPES:
        raise _bad(f"Unsupported column type {raw!r}. Use one of: {', '.join(CUSTOM_TYPES)}")
    return raw


# ---------------------------------------------------------------- values

def _user_has_access(user_id: str, project_id: str) -> bool:
    return bool(db_get_user_by_id(user_id)) and db_check_project_access(user_id, project_id)


def project_user_check(project_id: str) -> Callable[[str], bool]:
    """May this user id be picked in a person column of a table of the project?"""
    return lambda user_id: _user_has_access(user_id, project_id)


def validate_value(col: dict, value: Any, user_ok: Callable[[str], bool]) -> Any:
    """The normalised value for a custom column (the empty value for 'nothing'), or HTTP 400.

    ``user_ok`` says which user ids a person / people column of this table accepts.
    """
    ctype, name = col["type"], col["name"]
    if ctype in TEXT_TYPES:
        if value is None:
            return None
        if not isinstance(value, str):
            raise _bad(f"'{name}' must be text or null")
        if ctype == "url":
            value = value.strip()
        if len(value) > TEXT_LIMITS[ctype]:
            raise _bad(f"'{name}' is too long (at most {TEXT_LIMITS[ctype]} characters)")
        return value if value.strip() else None
    if ctype == "number":
        if value is None or value == "":
            return None
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
            raise _bad(f"'{name}' must be a finite number or null")
        return value
    if ctype == "checkbox":
        if value is None:
            return False
        if not isinstance(value, bool):
            raise _bad(f"'{name}' must be true or false")
        return value
    if ctype == "date":
        if value is None or value == "":
            return None
        if not isinstance(value, str) or len(value) != 10:
            raise _bad(f"'{name}' must be a date like 2030-01-31 or null")
        try:
            date.fromisoformat(value)
        except ValueError:
            raise _bad(f"'{name}' must be a date like 2030-01-31 or null")
        return value
    options = {o["value"] for o in col.get("options") or []}
    if ctype == "select":
        if value is None or value == "":
            return None
        if not isinstance(value, str) or value not in options:
            raise _bad(f"'{name}': unknown option {value!r}")
        return value
    if ctype == "person":
        if value is None or value == "":
            return None
        if not isinstance(value, str):
            raise _bad(f"'{name}' must be a user id or null")
        if not user_ok(value):
            raise _bad(f"'{name}': that user does not have access to this table")
        return value
    if ctype in MULTI_TYPES:
        if value is None:
            return []
        if not isinstance(value, list) or not all(isinstance(v, str) for v in value):
            raise _bad(f"'{name}' must be a list of {'option values' if ctype == 'multiselect' else 'user ids'}")
        value = list(dict.fromkeys(value))
        for v in value:
            if ctype == "multiselect" and v not in options:
                raise _bad(f"'{name}': unknown option {v!r}")
            if ctype == "people" and not user_ok(v):
                raise _bad(f"'{name}': user {v!r} does not have access to this table")
        return value
    raise _bad(f"Unsupported column type {ctype!r}")


def split_values(values: dict) -> Tuple[dict, dict]:
    """(builtin values, custom values) of a row's values object."""
    custom = {k: v for k, v in values.items() if isinstance(k, str) and k.startswith(KEY_PREFIX)}
    return {k: v for k, v in values.items() if k not in custom}, custom


def checked_values(cols: Dict[str, dict], custom: dict, base: Optional[dict], user_ok: Callable[[str], bool]) -> dict:
    """Validate row values for custom columns (``cols``: key -> Column) and merge them over ``base``.

    Returns the complete object to store (empty values removed).
    """
    merged = dict(base or {})
    for key, value in custom.items():
        col = cols.get(key)
        if not col:
            raise _bad(f"Unknown column '{key}'")
        normal = validate_value(col, value, user_ok)
        if is_empty_value(normal):
            merged.pop(key, None)
        else:
            merged[key] = normal
    return merged


def checked_custom_values(project_id: str, custom: dict, base: Optional[dict] = None) -> dict:
    """checked_values for the custom columns of a project's tasks (the stored custom_fields)."""
    cols = {c["key"]: c for c in list_columns(table_ref(project_id))}
    return checked_values(cols, custom, base, project_user_check(project_id))


def row_values(task: dict, cols: List[dict]) -> dict:
    """Values of a task's custom columns, with the empty value for what is not set."""
    stored = task.get("customFields") or {}
    out = {}
    for col in cols:
        value = stored.get(col["key"])
        out[col["key"]] = empty_value(col["type"]) if value is None else value
    return out


# ---------------------------------------------------------------- retyping

def _fmt_number(v: Any) -> str:
    return str(int(v)) if float(v).is_integer() else str(v)


def _parse_number(text: str) -> Optional[float]:
    text = text.strip().replace(" ", "")
    if not text:
        return None
    if "," in text and "." not in text:
        text = text.replace(",", ".")
    else:
        text = text.replace(",", "")
    try:
        num = float(text)
    except ValueError:
        return None
    if not math.isfinite(num):
        return None
    return int(num) if num.is_integer() and abs(num) < 2 ** 53 else num


def _parse_date(text: str) -> Optional[str]:
    text = text.strip()
    if len(text) >= 10:
        try:
            return date.fromisoformat(text[:10]).isoformat()
        except ValueError:
            return None
    return None


def convert_value(old_type: str, old_options: List[dict], new_type: str, new_options: List[dict],
                  value: Any) -> Any:
    """Convert one non-empty stored value to another type; None means 'clear it'."""
    labels = {o["value"]: o["label"] for o in old_options}
    by_label = {o["label"].casefold(): o["value"] for o in new_options}
    new_values = {o["value"] for o in new_options}

    if new_type == "checkbox":
        return True  # any non-empty value (0 and "0" included) counts as checked
    if new_type in TEXT_TYPES:
        if old_type in TEXT_TYPES or old_type == "date":
            text = value
        elif old_type == "number":
            text = _fmt_number(value)
        elif old_type == "select":
            text = labels.get(value, value)
        elif old_type == "multiselect":
            text = ", ".join(labels.get(v, v) for v in value)
        elif old_type == "checkbox":
            text = "Yes"
        else:
            return None  # person(s): ids are not text anyone wants
        text = text.strip() if new_type == "url" else text
        return text if text.strip() and len(text) <= TEXT_LIMITS[new_type] else None
    if new_type == "number":
        return _parse_number(value) if old_type in TEXT_TYPES else None
    if new_type == "date":
        return _parse_date(value) if old_type in TEXT_TYPES else None
    if new_type in SELECT_TYPES:
        if old_type in SELECT_TYPES:
            picked = [value] if old_type == "select" else list(value)
            picked = [v for v in picked if v in new_values]
        elif old_type in TEXT_TYPES:
            hit = by_label.get(value.strip().casefold())
            picked = [hit] if hit else []
        else:
            return None
        if not picked:
            return None
        return picked[0] if new_type == "select" else picked
    if new_type in ("person", "people"):
        if old_type not in ("person", "people"):
            return None
        ids = [value] if old_type == "person" else list(value)
        if not ids:
            return None
        return ids[0] if new_type == "person" else ids
    return None


# ---------------------------------------------------------------- endpoint logic

class ColumnHost:
    """Where the columns of one table and the values in its rows live.

    The create / update / delete logic below is the same for every table kind; a host supplies
    what differs: who may change the schema, who a person column accepts, where the row values
    are read and written, and which live events go out. Values are plain ``{column key: value}``
    objects per row id.
    """

    ref: str
    reserved_keys: set = BUILTIN_KEYS
    reserved_names: set = BUILTIN_NAMES

    def need_edit_schema(self, principal: dict) -> None:
        raise NotImplementedError

    def user_ok(self, user_id: str) -> bool:
        raise NotImplementedError

    def stored_values(self) -> Dict[str, dict]:
        """row id -> stored values object, for every row that has any."""
        raise NotImplementedError

    def save_column(self, key: str, fields: dict, updated: Dict[str, dict]) -> None:
        """Change the column (fields as in db_update_table_column) and write ``updated`` (row id -> complete values)."""
        raise NotImplementedError

    def remove_column(self, key: str, updated: Dict[str, dict]) -> None:
        raise NotImplementedError

    def reload(self, ids: List[str]) -> None:
        """Bring in-memory copies of the changed rows in step with the database."""

    async def announce(self, changed_ids: List[str]) -> None:
        """schema_changed, plus rows_changed (updated) when values changed."""
        raise NotImplementedError


def need_edit_schema(principal: dict, project_id: str) -> None:
    """Project owner or admin; everyone else 403."""
    if principal.get("is_guest"):
        raise HTTPException(status_code=403, detail="Not available to share-link guests")
    if project_id not in projects:
        raise HTTPException(status_code=404, detail="Project not found")
    if principal.get("role") == "admin" or principal.get("is_admin"):
        return
    access = db_get_project_access(principal["id"], project_id)
    if not (access and access["isOwner"]):
        raise HTTPException(status_code=403, detail="Only the project owner or an admin can change columns")


class TasksColumnHost(ColumnHost):
    """The custom columns of ``tasks:<projectId>``; values live in ``tasks.custom_fields``."""

    def __init__(self, project_id: str):
        self.project_id = project_id
        self.ref = table_ref(project_id)

    def need_edit_schema(self, principal: dict) -> None:
        need_edit_schema(principal, self.project_id)

    def user_ok(self, user_id: str) -> bool:
        return _user_has_access(user_id, self.project_id)

    def stored_values(self) -> Dict[str, dict]:
        return db_project_custom_fields(self.project_id)

    def save_column(self, key: str, fields: dict, updated: Dict[str, dict]) -> None:
        db_update_table_column(self.ref, key, fields, updated)

    def remove_column(self, key: str, updated: Dict[str, dict]) -> None:
        db_delete_table_column(self.ref, key, updated)

    def reload(self, ids: List[str]) -> None:
        for task_id in ids:
            task_api.reload_task(task_id)

    async def announce(self, changed_ids: List[str]) -> None:
        await live.to_project(self.project_id, {"type": "schema_changed", "tableRef": self.ref}, tasks_only=True)
        if changed_ids:
            await task_api.rows_changed(self.project_id, changed_ids, "updated")


async def create_column_in(host: ColumnHost, principal: dict, data: Any) -> dict:
    host.need_edit_schema(principal)
    if not isinstance(data, dict):
        raise _bad("The body must be an object with name and type")
    ref = host.ref
    col_type = check_type(data.get("type"))
    name = clean_name(data.get("name"), list_columns(ref), reserved=host.reserved_names)
    config = clean_config(data["config"]) if data.get("config") is not None else {}
    if col_type in SELECT_TYPES:
        config["options"] = clean_options(data.get("options") or [])
    elif data.get("options"):
        raise _bad(f"Options only apply to select and multiselect columns, not {col_type}")
    key = KEY_PREFIX + secrets.token_hex(4)
    stored = db_create_table_column(ref, key, name, col_type, config, principal.get("id"))
    await host.announce([])
    return to_column(stored)


def _find(host: ColumnHost, key: str) -> dict:
    if key in host.reserved_keys:
        raise _bad(f"'{key}' is a builtin column and cannot be changed or deleted")
    stored = db_get_table_column(host.ref, key)
    if not stored:
        raise HTTPException(status_code=404, detail="Column not found")
    return stored


async def update_column_in(host: ColumnHost, principal: dict, key: str, data: Any) -> dict:
    host.need_edit_schema(principal)
    stored = _find(host, key)
    if not isinstance(data, dict):
        raise _bad("The body must be an object")
    ref = host.ref
    old_type = stored["type"]
    config = dict(stored["config"] or {})
    old_options = list(config.get("options") or [])
    fields: dict = {}

    if "name" in data:
        fields["name"] = clean_name(data["name"], list_columns(ref), own_key=key, reserved=host.reserved_names)
    if "sortOrder" in data:
        so = data["sortOrder"]
        if isinstance(so, bool) or not isinstance(so, (int, float)) or not math.isfinite(so):
            raise _bad("sortOrder must be a number")
        fields["sortOrder"] = so
    if "config" in data:
        config = {**clean_config(data["config"]), **({"options": config["options"]} if "options" in config else {})}

    new_type = check_type(data["type"]) if "type" in data else old_type
    retype = new_type != old_type
    options_given = "options" in data
    if options_given and new_type not in SELECT_TYPES:
        raise _bad(f"Options only apply to select and multiselect columns, not {new_type}")

    values = host.stored_values()
    updated: Dict[str, dict] = {}

    def set_value(row_id: str, new_value: Any) -> None:
        current = updated.get(row_id)
        if current is None:
            current = dict(values.get(row_id) or {})
        if is_empty_value(new_value):
            current.pop(key, None)
        else:
            current[key] = new_value
        updated[row_id] = current

    # ----- options of the new column
    new_options = list(old_options)
    if new_type in SELECT_TYPES:
        if options_given:
            new_options = clean_options(data["options"], old_options)
        elif retype and old_type not in SELECT_TYPES:
            new_options = []
            if old_type in TEXT_TYPES:
                distinct: Dict[str, str] = {}
                for stored_row in values.values():
                    v = stored_row.get(key)
                    if isinstance(v, str) and v.strip():
                        distinct.setdefault(v.strip().casefold(), v.strip())
                if len(distinct) > MAX_OPTIONS:
                    raise _bad(f"Cannot turn this column into a {new_type}: it has {len(distinct)} distinct "
                               f"values (at most {MAX_OPTIONS} options)")
                new_options = [{"value": _new_option_value(), "label": label[:MAX_NAME]}
                               for label in sorted(distinct.values(), key=str.casefold)]
        config["options"] = new_options
    else:
        config.pop("options", None)

    # ----- values
    if retype:
        for row_id, stored_row in values.items():
            if key in stored_row:
                set_value(row_id, convert_value(old_type, old_options, new_type, new_options, stored_row[key]))
    elif options_given:
        keep = {o["value"] for o in new_options}
        for row_id, stored_row in values.items():
            v = stored_row.get(key)
            if v is None:
                continue
            if new_type == "select":
                if v not in keep:
                    set_value(row_id, None)
            else:
                kept = [x for x in v if x in keep]
                if kept != v:
                    set_value(row_id, kept)

    if retype:
        fields["type"] = new_type
    if retype or "config" in data or options_given:
        fields["config"] = config
    if fields or updated:
        host.save_column(key, fields, updated)
    host.reload(list(updated))
    await host.announce(list(updated))
    return to_column(db_get_table_column(ref, key))


async def delete_column_in(host: ColumnHost, principal: dict, key: str) -> None:
    host.need_edit_schema(principal)
    _find(host, key)
    updated = {row_id: {k: v for k, v in stored_row.items() if k != key}
               for row_id, stored_row in host.stored_values().items() if key in stored_row}
    host.remove_column(key, updated)
    host.reload(list(updated))
    await host.announce(list(updated))


async def create_column(principal: dict, project_id: str, data: Any) -> dict:
    return await create_column_in(TasksColumnHost(project_id), principal, data)


async def update_column(principal: dict, project_id: str, key: str, data: Any) -> dict:
    return await update_column_in(TasksColumnHost(project_id), principal, key, data)


async def delete_column(principal: dict, project_id: str, key: str) -> None:
    await delete_column_in(TasksColumnHost(project_id), principal, key)
