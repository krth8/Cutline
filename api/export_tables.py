"""Export of table views: plain-text cell values, the rows of a view, and CSV.

Used by `GET /api/views/{id}/export`, `POST /api/tables/{ref}/export` and by the Markdown export of
pages (a view block becomes a table of its current rows). Every read goes through the table source
with the exporter as principal, so the exporter sees exactly what the table API shows them.
"""

import csv
import io
import re
from collections import defaultdict
from decimal import Decimal
from typing import Any, Dict, Iterator, List, Optional, Tuple
from urllib.parse import quote

from api.tables.source import resolve_source
from database import db_get_user_by_id

# Columns of a query that matter for an export: the rest (grouping, summaries, paging) is ignored.
EXPORT_QUERY_KEYS = ("filter", "sort", "search")
FORMULA_PREFIXES = ("=", "+", "-", "@", "\t", "\r")
CSV_BOM = "﻿"
PARENT_COLUMN = "Parent"


# ============ Plain-text values ============

def format_number(value: Any) -> str:
    """A number with `.` as the decimal separator and no exponent (3.0 -> "3")."""
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, int):
        return str(value)
    try:
        text = format(Decimal(repr(float(value))), "f")
    except Exception:
        return str(value)
    if "." in text:
        text = text.rstrip("0").rstrip(".")
    return text or "0"


class Labels:
    """Turns ids into names for one column: option labels first, then the user table."""

    def __init__(self, column: dict):
        self.options = {str(o.get("value")): str(o.get("label", o.get("value"))) for o in column.get("options") or []}
        self.users: Dict[str, str] = {}

    def label(self, value: Any, person: bool = False) -> str:
        key = str(value)
        if key in self.options:
            return self.options[key]
        if person:
            if key not in self.users:
                user = db_get_user_by_id(key)
                self.users[key] = user["username"] if user else key
            return self.users[key]
        return key


def _title_of(item: Any) -> str:
    if isinstance(item, dict):
        for key in ("title", "name", "label"):
            if item.get(key) not in (None, ""):
                return str(item[key])
        if item.get("baseName"):
            version = item.get("version")
            return f"{item['baseName']} v{version}" if version else str(item["baseName"])
        return str(item.get("id", ""))
    return str(item)


def cell_text(column: dict, value: Any, labels: Labels) -> str:
    """The value of one cell as the plain text a spreadsheet or a Markdown table shows."""
    kind = column.get("type")
    if value is None:
        return ""
    if kind == "checkbox":
        return "true" if value else "false"
    if kind == "date":
        return str(value)[:10]
    if kind == "number":
        return format_number(value)
    if kind in ("select", "status", "priority"):
        return labels.label(value)
    if kind == "multiselect":
        return "; ".join(labels.label(v) for v in (value if isinstance(value, list) else [value]))
    if kind == "person":
        return labels.label(value, person=True)
    if kind == "people":
        return "; ".join(labels.label(v, person=True) for v in (value if isinstance(value, list) else [value]))
    if kind == "clip":
        return _title_of(value)
    if kind == "relation":
        return "; ".join(_title_of(v) for v in (value if isinstance(value, list) else [value]))
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (int, float)):
        return format_number(value)
    if isinstance(value, list):
        return "; ".join(_title_of(v) for v in value)
    if isinstance(value, dict):
        return _title_of(value)
    return str(value)


# ============ Columns and rows of a view ============

def export_columns(schema: dict, view_columns: Optional[list], group_by: Optional[str]) -> List[dict]:
    """The columns of an export: the view's visible columns in display order, the title column first,
    and the grouping column even when hidden. Columns the view does not mention are shown (as the layouts do)."""
    by_key = {c["key"]: c for c in schema["columns"]}
    ordered: List[Tuple[dict, bool]] = []
    seen = set()
    for entry in view_columns or []:
        key = entry.get("key") if isinstance(entry, dict) else None
        if key in by_key and key not in seen:
            seen.add(key)
            ordered.append((by_key[key], bool(entry.get("hidden"))))
    for column in schema["columns"]:
        if column["key"] not in seen:
            ordered.append((column, False))
    title_key = schema.get("titleColumn")
    visible = [c for c, hidden in ordered if not hidden and c["key"] != title_key]
    if group_by and group_by in by_key and group_by != title_key and all(c["key"] != group_by for c in visible):
        visible.append(by_key[group_by])
    title = [by_key[title_key]] if title_key in by_key else []
    return title + visible


def view_rows(source, user: dict, schema: dict, query: dict, cap: Optional[int] = None
              ) -> Tuple[List[Tuple[dict, Optional[str]]], int, bool]:
    """The rows an export lists, as (row, parent title or None), the number of rows in total, and whether
    the rows are nested (a view that lists subtasks under their parents).

    The view's filter, sort and search apply. A nested view lists the matching top-level rows, each followed by
    all its descendants (depth first, in the view's sort order), as the table layout does when it expands them.
    """
    base = {k: query[k] for k in EXPORT_QUERY_KEYS if query.get(k)}
    nested = bool(schema["capabilities"].get("hierarchy")) and "parentId" in query and query["parentId"] is None
    if not nested:
        result = source.query(user, {**base, **({"limit": cap} if cap else {})})
        return [(row, None) for row in result["rows"]], result["total"], False

    roots = source.query(user, {**base, "parentId": None})["rows"]
    everything = source.query(user, {"sort": base["sort"]} if base.get("sort") else {})["rows"]
    children: Dict[str, List[dict]] = defaultdict(list)
    for row in everything:
        if row.get("parentId"):
            children[row["parentId"]].append(row)
    title_key = schema["titleColumn"]
    out: List[Tuple[dict, Optional[str]]] = []
    seen = set()
    stack = [(row, None) for row in reversed(roots)]
    while stack:
        row, parent = stack.pop()
        if row["id"] in seen:
            continue
        seen.add(row["id"])
        out.append((row, parent))
        title = str((row.get("values") or {}).get(title_key) or "")
        stack.extend((kid, title) for kid in reversed(children.get(row["id"], [])))
    total = len(out)
    return (out[:cap] if cap else out), total, True


class ViewExport:
    """Everything an export needs from one view state: schema, columns, rows."""

    def __init__(self, user: dict, table_ref: str, query: Optional[dict], columns: Optional[list], cap: Optional[int] = None):
        query = query if isinstance(query, dict) else {}
        source = resolve_source(table_ref)
        self.schema = source.schema(user)
        self.columns = export_columns(self.schema, columns, query.get("groupBy"))
        self.rows, self.total, self.nested = view_rows(source, user, self.schema, query, cap)
        self.labels = {c["key"]: Labels(c) for c in self.columns}

    def headers(self) -> List[str]:
        names = [c["name"] for c in self.columns]
        return names + [PARENT_COLUMN] if self.nested else names

    def texts(self, row: dict, parent: Optional[str]) -> List[str]:
        values = row.get("values") or {}
        cells = [cell_text(c, values.get(c["key"]), self.labels[c["key"]]) for c in self.columns]
        return cells + [parent or ""] if self.nested else cells


# ============ CSV ============

def guard_formula(text: str) -> str:
    """Spreadsheets run cells that start with = + - @ tab or CR as formulas: a leading ' makes them text."""
    return "'" + text if text.startswith(FORMULA_PREFIXES) else text


def csv_chunks(export: ViewExport, chunk_rows: int = 500) -> Iterator[bytes]:
    """The export as UTF-8 CSV (BOM first, CRLF line ends, RFC 4180 quoting), in chunks."""
    buffer = io.StringIO()
    writer = csv.writer(buffer, lineterminator="\r\n", quoting=csv.QUOTE_MINIMAL)
    buffer.write(CSV_BOM)
    writer.writerow([guard_formula(h) for h in export.headers()])
    numeric = [c.get("type") in ("number", "formula") for c in export.columns]
    for count, (row, parent) in enumerate(export.rows, 1):
        cells = export.texts(row, parent)
        out = []
        for i, text in enumerate(cells):
            # a real number such as -5 is a value, not a formula
            is_number = i < len(numeric) and numeric[i] and re.fullmatch(r"-?\d+(\.\d+)?", text)
            out.append(text if is_number else guard_formula(text))
        writer.writerow(out)
        if count % chunk_rows == 0:
            yield buffer.getvalue().encode("utf-8")
            buffer.seek(0)
            buffer.truncate()
    yield buffer.getvalue().encode("utf-8")


# ============ Download headers ============

def safe_filename(name: str, fallback: str = "export", limit: int = 80) -> str:
    """A file name without path parts, control characters or characters Windows refuses."""
    name = re.sub(r'[\x00-\x1f\x7f<>:"/\\|?*]', "_", name or "")
    name = name.strip().strip(".").strip()
    return name[:limit].strip() or fallback


def content_disposition(filename: str) -> str:
    """`attachment` with an ASCII fallback name and the real name as RFC 5987 `filename*`."""
    ascii_name = re.sub(r"[^A-Za-z0-9._ -]", "_", filename).strip() or "export"
    return f'attachment; filename="{ascii_name}"; filename*=UTF-8\'\'{quote(filename, safe="")}'
