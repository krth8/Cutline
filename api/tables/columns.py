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
from typing import Any, Dict, List, Optional, Tuple

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


def clean_name(raw: Any, columns: List[dict], own_key: Optional[str] = None) -> str:
    if not isinstance(raw, str) or not raw.strip():
        raise _bad(f"A column name of 1-{MAX_NAME} characters is required")
    name = raw.strip()
    if len(name) > MAX_NAME:
        raise _bad(f"A column name has at most {MAX_NAME} characters")
    taken = {c["name"].casefold() for c in columns if c["key"] != own_key} | BUILTIN_NAMES
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


def validate_value(col: dict, value: Any, project_id: str) -> Any:
    """The normalised value for a custom column (the empty value for 'nothing'), or HTTP 400."""
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
        if not _user_has_access(value, project_id):
            raise _bad(f"'{name}': that user does not have access to this project")
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
            if ctype == "people" and not _user_has_access(v, project_id):
                raise _bad(f"'{name}': user {v!r} does not have access to this project")
        return value
    raise _bad(f"Unsupported column type {ctype!r}")


def split_values(values: dict) -> Tuple[dict, dict]:
    """(builtin values, custom values) of a row's values object."""
    custom = {k: v for k, v in values.items() if isinstance(k, str) and k.startswith(KEY_PREFIX)}
    return {k: v for k, v in values.items() if k not in custom}, custom


def checked_custom_values(project_id: str, custom: dict, base: Optional[dict] = None) -> dict:
    """Validate row values for custom columns and merge them over ``base`` (the stored custom_fields).

    Returns the complete custom_fields object to store (empty values removed).
    """
    cols = {c["key"]: c for c in list_columns(table_ref(project_id))}
    merged = dict(base or {})
    for key, value in custom.items():
        col = cols.get(key)
        if not col:
            raise _bad(f"Unknown column '{key}'")
        normal = validate_value(col, value, project_id)
        if is_empty_value(normal):
            merged.pop(key, None)
        else:
            merged[key] = normal
    return merged


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


async def _announce(project_id: str, changed_ids: List[str]) -> None:
    await live.to_project(project_id, {"type": "schema_changed", "tableRef": table_ref(project_id)}, tasks_only=True)
    if changed_ids:
        await task_api.rows_changed(project_id, changed_ids, "updated")


def _reload(ids: List[str]) -> None:
    for task_id in ids:
        task_api.reload_task(task_id)


async def create_column(principal: dict, project_id: str, data: Any) -> dict:
    need_edit_schema(principal, project_id)
    if not isinstance(data, dict):
        raise _bad("The body must be an object with name and type")
    ref = table_ref(project_id)
    col_type = check_type(data.get("type"))
    name = clean_name(data.get("name"), list_columns(ref))
    config = clean_config(data["config"]) if data.get("config") is not None else {}
    if col_type in SELECT_TYPES:
        config["options"] = clean_options(data.get("options") or [])
    elif data.get("options"):
        raise _bad(f"Options only apply to select and multiselect columns, not {col_type}")
    key = KEY_PREFIX + secrets.token_hex(4)
    stored = db_create_table_column(ref, key, name, col_type, config, principal.get("id"))
    await _announce(project_id, [])
    return to_column(stored)


def _find(project_id: str, key: str) -> dict:
    if key in BUILTIN_KEYS:
        raise _bad(f"'{key}' is a builtin column and cannot be changed or deleted")
    stored = db_get_table_column(table_ref(project_id), key)
    if not stored:
        raise HTTPException(status_code=404, detail="Column not found")
    return stored


async def update_column(principal: dict, project_id: str, key: str, data: Any) -> dict:
    need_edit_schema(principal, project_id)
    stored = _find(project_id, key)
    if not isinstance(data, dict):
        raise _bad("The body must be an object")
    ref = table_ref(project_id)
    old_type = stored["type"]
    config = dict(stored["config"] or {})
    old_options = list(config.get("options") or [])
    fields: dict = {}

    if "name" in data:
        fields["name"] = clean_name(data["name"], list_columns(ref), own_key=key)
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

    values = db_project_custom_fields(project_id)
    updated: Dict[str, dict] = {}

    def set_value(task_id: str, new_value: Any) -> None:
        current = updated.get(task_id)
        if current is None:
            current = dict(values.get(task_id) or {})
        if is_empty_value(new_value):
            current.pop(key, None)
        else:
            current[key] = new_value
        updated[task_id] = current

    # ----- options of the new column
    new_options = list(old_options)
    if new_type in SELECT_TYPES:
        if options_given:
            new_options = clean_options(data["options"], old_options)
        elif retype and old_type not in SELECT_TYPES:
            new_options = []
            if old_type in TEXT_TYPES:
                distinct: Dict[str, str] = {}
                for task_values in values.values():
                    v = task_values.get(key)
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
        for task_id, task_values in values.items():
            if key in task_values:
                set_value(task_id, convert_value(old_type, old_options, new_type, new_options, task_values[key]))
    elif options_given:
        keep = {o["value"] for o in new_options}
        for task_id, task_values in values.items():
            v = task_values.get(key)
            if v is None:
                continue
            if new_type == "select":
                if v not in keep:
                    set_value(task_id, None)
            else:
                kept = [x for x in v if x in keep]
                if kept != v:
                    set_value(task_id, kept)

    if retype:
        fields["type"] = new_type
    if retype or "config" in data or options_given:
        fields["config"] = config
    if fields or updated:
        db_update_table_column(ref, key, fields, updated)
    _reload(list(updated))
    await _announce(project_id, list(updated))
    return to_column(db_get_table_column(ref, key))


async def delete_column(principal: dict, project_id: str, key: str) -> None:
    need_edit_schema(principal, project_id)
    _find(project_id, key)
    updated = {task_id: {k: v for k, v in task_values.items() if k != key}
               for task_id, task_values in db_project_custom_fields(project_id).items() if key in task_values}
    db_delete_table_column(table_ref(project_id), key, updated)
    _reload(list(updated))
    await _announce(project_id, list(updated))
