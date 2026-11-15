"""Relation columns (WP C3): a custom column whose value is a list of rows of another table.

Column config: ``{"target": "tasks:<projectId>" | "tbl_<id>", "multiple": true, "twoWay": false}``.
Stored value (in the row's custom values): a list of target row ids. A reader gets
``[{"id", "label"}]`` instead, where the label is the target row's title. Only rows the reader may
read are listed, so a title never reaches someone who could not open the row. Rows that no longer
exist (deleted custom rows, tasks in the trash) are left out when reading; the stored ids stay, so a
restored task is linked again.

Target rules (``check_target``):
  * a table of a project may point at the project's tasks or at a custom table of the same project;
  * a personal table may point at the owner's personal tables and at the tasks of any project the
    owner has task access to;
  * a project table never points at a personal table or at another project;
  * a table may point at itself.

"Show on the other table" (``twoWay``): the target table gets a read-only mirror column, built when
the schema is read, that lists the rows linking to each row. Mirrors are never stored.
"""

from __future__ import annotations

from typing import Any, Callable, Dict, List, Optional, Tuple

from fastapi import HTTPException

from api.auth import can_read_custom_table
from api.state import projects, tasks
from database import db_check_project_access
from database.custom_tables import db_custom_row_names, db_get_custom_table, db_list_custom_rows
from database.table_columns import db_list_relation_columns

RELATION = "relation"
MIRROR_PREFIX = "rv_"
CONFIG_KEYS = {"target", "multiple", "twoWay"}
MAX_LINKS = 500
UNTITLED = "Untitled"


def _bad(detail: str) -> HTTPException:
    return HTTPException(status_code=400, detail=detail)


def is_task_ref(ref: Any) -> bool:
    return isinstance(ref, str) and ref.startswith("tasks:") and ref != "tasks:*" and len(ref) > 6


def is_custom_ref(ref: Any) -> bool:
    return isinstance(ref, str) and ref.startswith("tbl_")


# ---------------------------------------------------------------- target rules

def _can_read_target(principal: dict, target: str) -> bool:
    """May the principal read the rows of the target table at all?"""
    if principal.get("is_guest"):
        return False
    if is_task_ref(target):
        pid = target[6:]
        return pid in projects and db_check_project_access(principal["id"], pid, require_tasks=True)
    if is_custom_ref(target):
        table = db_get_custom_table(target)
        return bool(table) and can_read_custom_table(principal, table)
    return False


def target_exists(target: str) -> bool:
    if is_task_ref(target):
        return target[6:] in projects
    if is_custom_ref(target):
        return db_get_custom_table(target) is not None
    return False


def target_name(target: str) -> Optional[str]:
    if is_task_ref(target):
        project = projects.get(target[6:])
        return f"{project.get('name', 'Project')} tasks" if project else None
    table = db_get_custom_table(target) if is_custom_ref(target) else None
    return table["name"] if table else None


def check_target(principal: dict, space: Tuple[str, str], target: Any) -> str:
    """The target ref when a table of ``space`` ('project', id) / ('personal', ownerId) may point at it.

    The principal must be able to read the target. Anything else is a 400.
    """
    if not isinstance(target, str) or not target:
        raise _bad("A relation column needs config.target: a table ref such as tasks:<projectId> or tbl_<id>")
    kind, owner = space
    if is_task_ref(target):
        pid = target[6:]
        if pid not in projects:
            raise _bad("The target project does not exist")
        if kind == "project" and pid != owner:
            raise _bad("A table can only point at tables of its own project")
        if not _can_read_target(principal, target):
            raise _bad("You do not have task access to the target project")
        return target
    if is_custom_ref(target):
        table = db_get_custom_table(target)
        if not table:
            raise _bad("The target table does not exist")
        if kind == "project":
            if table["spaceType"] != "project" or table["projectId"] != owner:
                raise _bad("A project table can only point at tables of its own project")
        elif table["spaceType"] != "personal" or table["ownerId"] != owner:
            raise _bad("A personal table can only point at your own personal tables or at project tasks")
        if not _can_read_target(principal, target):
            raise _bad("You cannot read the target table")
        return target
    raise _bad("config.target must be tasks:<projectId> or tbl_<id>")


def clean_config(principal: dict, space: Tuple[str, str], raw: Any) -> dict:
    """Validate a relation column's config and return it with every key set."""
    if not isinstance(raw, dict):
        raise _bad("A relation column needs a config like {target, multiple?, twoWay?}")
    unknown = set(raw) - CONFIG_KEYS
    if unknown:
        raise _bad(f"Unknown relation setting(s): {', '.join(sorted(unknown))}")
    for flag in ("multiple", "twoWay"):
        if flag in raw and not isinstance(raw[flag], bool):
            raise _bad(f"config.{flag} must be true or false")
    return {"target": check_target(principal, space, raw.get("target")),
            "multiple": raw.get("multiple", True), "twoWay": raw.get("twoWay", False)}


# ---------------------------------------------------------------- reading rows of a target

def row_labels(principal: dict, target: str, ids: List[str]) -> Dict[str, str]:
    """id -> title of the target rows that exist and that the principal may read (one batched lookup)."""
    ids = list(dict.fromkeys(i for i in ids if isinstance(i, str)))
    if not ids or not _can_read_target(principal, target):
        return {}
    if is_task_ref(target):
        pid = target[6:]
        found = {}
        for task_id in ids:
            task = tasks.get(task_id)  # tasks in the trash are not in memory
            if task and task.get("projectId") == pid:
                found[task_id] = task.get("name") or UNTITLED
        return found
    return {i: name or UNTITLED for i, name in db_custom_row_names(target, ids).items()}


def stored_ids(value: Any) -> List[str]:
    """The ids of a stored (or already resolved) relation value."""
    if not isinstance(value, list):
        return []
    out = []
    for item in value:
        item = item.get("id") if isinstance(item, dict) else item
        if isinstance(item, str) and item:
            out.append(item)
    return out


def validate_ids(principal: Optional[dict], col: dict, value: Any, current: Any = None) -> List[str]:
    """The list of ids to store for a write: existing, readable by the writer, no duplicates.

    ``current`` is what is stored now. Ids in it that the writer cannot see (no access, or the row is
    deleted or in the trash) are kept on a multiple column, so editing never drops somebody else's
    links and a restored task is still linked.
    """
    name = col["name"]
    config = col.get("config") or {}
    if principal is None or not config.get("target"):
        raise _bad(f"'{name}' is not a usable relation column")
    if value is None:
        value = []
    elif isinstance(value, (str, dict)):
        value = [value]
    if not isinstance(value, list):
        raise _bad(f"'{name}' must be a list of row ids")
    ids = []
    for item in value:
        if isinstance(item, dict):
            item = item.get("id")
        if not isinstance(item, str) or not item:
            raise _bad(f"'{name}' must be a list of row ids")
        ids.append(item)
    ids = list(dict.fromkeys(ids))
    multiple = config.get("multiple", True)
    if not multiple:
        ids = ids[:1]
    if len(ids) > MAX_LINKS:
        raise _bad(f"'{name}' can link at most {MAX_LINKS} rows")
    hidden_now = stored_ids(current) if multiple else []
    labels = row_labels(principal, config["target"], ids + hidden_now)
    for row_id in ids:
        if row_id not in labels:
            raise _bad(f"'{name}': row {row_id!r} does not exist in the target table or you cannot read it")
    return ids + [i for i in hidden_now if i not in labels and i not in ids]


# ---------------------------------------------------------------- schema

def finish_columns(principal: dict, ref: str, columns: List[dict], with_mirrors: bool = True) -> List[dict]:
    """Add what the reader's schema needs for relation columns.

    Own relation columns get ``config.targetName`` (when the reader may see the table) and
    ``config.targetDeleted`` (the target table is gone). Mirror columns of tables that point here are
    appended.
    """
    out = []
    for col in columns:
        if col.get("type") == RELATION and col.get("config", {}).get("target"):
            config = dict(col["config"])
            target = config["target"]
            if not target_exists(target):
                config["targetDeleted"] = True
            elif _can_read_target(principal, target):
                config["targetName"] = target_name(target)
            col = {**col, "config": config}
        out.append(col)
    if with_mirrors:
        out.extend(mirror_columns(principal, ref))
    return out


def mirror_columns(principal: dict, ref: str) -> List[dict]:
    """Read-only columns for the relation columns of other tables that point at ``ref`` with twoWay on."""
    out = []
    for stored in db_list_relation_columns():
        config = stored["config"] or {}
        if not config.get("twoWay") or config.get("target") != ref:
            continue
        source = stored["tableRef"]
        if not target_exists(source) or not _can_read_target(principal, source):
            continue
        out.append({
            "key": MIRROR_PREFIX + stored["id"], "name": f"{stored['name']} ({target_name(source)})",
            "type": RELATION, "builtin": True, "readonly": True,
            "config": {"target": source, "multiple": True, "twoWay": False,
                       "mirrorOf": {"ref": source, "key": stored["key"]}, "targetName": target_name(source)},
        })
    return out


def refs_pointing_at(target: str) -> List[str]:
    """Tables that have a relation column with this target."""
    return sorted({c["tableRef"] for c in db_list_relation_columns() if (c["config"] or {}).get("target") == target})


# ---------------------------------------------------------------- row values

def _source_rows(ref: str) -> List[Tuple[str, dict, str]]:
    """(id, stored custom values, title) of every row of a table, for reverse lookups."""
    if is_task_ref(ref):
        pid = ref[6:]
        found = [t for t in tasks.values() if t.get("projectId") == pid]
        found.sort(key=lambda t: (t.get("sortOrder") or 0, t.get("createdAt") or ""))
        return [(t["id"], t.get("customFields") or {}, t.get("name") or UNTITLED) for t in found]
    return [(r["id"], r["values"], r["values"].get("name") or UNTITLED) for r in db_list_custom_rows(ref)]


def fill_rows(principal: dict, rows: List[dict], cols_by_ref: Dict[str, List[dict]]) -> List[dict]:
    """Turn the relation values of rows into ``[{id, label}]`` for this reader and fill mirror columns.

    ``cols_by_ref`` maps a row's ``tableRef`` to its columns. One lookup per target table.
    """
    wanted: Dict[str, List[str]] = {}
    plain: List[Tuple[dict, dict]] = []
    mirrors: List[Tuple[dict, dict]] = []
    for row in rows:
        for col in cols_by_ref.get(row.get("tableRef"), ()):
            if col.get("type") != RELATION:
                continue
            config = col.get("config") or {}
            if config.get("mirrorOf"):
                mirrors.append((row, col))
            elif config.get("target"):
                plain.append((row, col))
                wanted.setdefault(config["target"], []).extend(stored_ids(row["values"].get(col["key"])))
    labels = {target: row_labels(principal, target, ids) for target, ids in wanted.items()}
    for row, col in plain:
        found = labels[col["config"]["target"]]
        row["values"][col["key"]] = [{"id": i, "label": found[i]}
                                      for i in stored_ids(row["values"].get(col["key"])) if i in found]
    reverse: Dict[Tuple[str, str], Dict[str, List[dict]]] = {}
    for row, col in mirrors:
        source, key = col["config"]["mirrorOf"]["ref"], col["config"]["mirrorOf"]["key"]
        if (source, key) not in reverse:
            links: Dict[str, List[dict]] = {}
            for src_id, values, title in _source_rows(source):
                for target_id in stored_ids(values.get(key)):
                    links.setdefault(target_id, []).append({"id": src_id, "label": title})
            reverse[(source, key)] = links
        row["values"][col["key"]] = list(reverse[(source, key)].get(row["id"], []))
    return rows


def labels_for_retype(principal: dict, config: dict, stored_rows: List[Any]) -> Dict[str, str]:
    """id -> title for every id in the stored values of a column about to change type (readable rows only)."""
    ids = [i for value in stored_rows for i in stored_ids(value)]
    return row_labels(principal, config.get("target"), ids) if config.get("target") else {}


async def announce_schema_changed(refs: List[str]) -> None:
    """Tell tabs of the given tables that their schema changed (a relation target was deleted)."""
    from api.events import live
    for ref in refs:
        if is_task_ref(ref):
            await live.to_project(ref[6:], {"type": "schema_changed", "tableRef": ref}, tasks_only=True)
        else:
            table = db_get_custom_table(ref)
            if not table:
                continue
            message = {"type": "schema_changed", "tableRef": ref}
            if table["spaceType"] == "project":
                await live.to_project(table["projectId"], message, tasks_only=True)
            else:
                await live.to_user(table["ownerId"], {**message, "project": None})
