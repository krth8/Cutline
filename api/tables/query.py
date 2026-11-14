"""Table query engine: filter, search, sort, group, summarise and page a list of rows.

Pure and storage independent. It works on Row dicts (``{"id", "values": {key: value}, ...}``)
and the column definitions of the table, so every table source (tasks now, custom
tables later) shares the same semantics. A query is the JSON object of PLAN.md 5.6.

Value shapes the engine understands, per column type:

  text, longtext, url   str
  number                int | float
  checkbox              bool
  date                  "YYYY-MM-DD" (a longer ISO datetime counts by its date part only;
                        no time zone conversion ever happens)
  select, status,
  priority, person      option value (str) or None
  multiselect, people   list of option values
  clip, relation        an id, or ``{"id": ..., "name": ...}``, or None
  formula               any scalar

Anything invalid in the query raises QueryError; the routes answer it with a 400.
"""

from __future__ import annotations

import calendar
from datetime import date, timedelta
from typing import Any, Callable, Dict, List, Optional


class QueryError(ValueError):
    """The query is not valid for this table (unknown column, wrong operator, bad value)."""


SINGLE_OPTION = {"select", "status", "priority"}
MULTI = {"multiselect", "people"}
PERSON = {"person", "people"}
TEXTY = {"text", "longtext", "url"}

_COMMON = {"eq", "neq", "in", "nin", "empty", "notEmpty"}
_COMPARE = {"lt", "lte", "gt", "gte", "between"}

OPS_BY_TYPE: Dict[str, set] = {
    "text": _COMMON | {"contains"},
    "longtext": _COMMON | {"contains"},
    "url": _COMMON | {"contains"},
    "number": _COMMON | _COMPARE,
    "checkbox": {"eq", "neq"},
    "date": _COMMON | _COMPARE | {"before", "after", "relative"},
    "select": set(_COMMON),
    "status": set(_COMMON),
    "priority": set(_COMMON),
    "person": set(_COMMON),
    "multiselect": _COMMON | {"contains"},
    "people": _COMMON | {"contains"},
    "clip": set(_COMMON),
    "relation": set(_COMMON),
    "formula": _COMMON | _COMPARE | {"contains"},
}

SUMMARY_FUNCTIONS = {"count", "countEmpty", "countFilled", "sum", "avg", "min", "max", "percentChecked"}
_TOP_LEVEL_KEYS = {"filter", "sort", "groupBy", "summaries", "parentId", "search", "limit", "offset"}
_MAX_FILTER_DEPTH = 8


# ---------------------------------------------------------------- helpers

def _is_number(v: Any) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def to_date(v: Any, what: str = "value") -> date:
    """The date of "YYYY-MM-DD" or of an ISO datetime (its date part, as written)."""
    if isinstance(v, date):
        return v
    if isinstance(v, str) and len(v) >= 10:
        try:
            return date.fromisoformat(v[:10])
        except ValueError:
            pass
    raise QueryError(f"{what} must be a date like 2030-01-31, got {v!r}")


def _cell_date(v: Any) -> Optional[date]:
    try:
        return to_date(v)
    except QueryError:
        return None


def add_months(d: date, months: int) -> date:
    index = d.year * 12 + (d.month - 1) + months
    year, month = divmod(index, 12)
    month += 1
    return date(year, month, min(d.day, calendar.monthrange(year, month)[1]))


def relative_range(spec: Any, today: date) -> tuple:
    """(first day, last day), both inclusive, for {unit: day|week|month, from: n, to: m}."""
    if not isinstance(spec, dict) or spec.get("unit") not in ("day", "week", "month"):
        raise QueryError("relative needs a value like {\"unit\": \"day\"|\"week\"|\"month\", \"from\": -7, \"to\": 0}")
    start, end = spec.get("from", 0), spec.get("to", 0)
    for n in (start, end):
        if not isinstance(n, int) or isinstance(n, bool):
            raise QueryError("relative: 'from' and 'to' must be whole numbers")
    if start > end:
        raise QueryError("relative: 'from' must not be greater than 'to'")
    unit = spec["unit"]
    if unit == "month":
        return add_months(today, start), add_months(today, end)
    step = 7 if unit == "week" else 1
    return today + timedelta(days=start * step), today + timedelta(days=end * step)


def is_empty(col: dict, v: Any) -> bool:
    if v is None or v == "" or v == [] or v == {}:
        return True
    if isinstance(v, dict) and v.get("id") in (None, ""):
        return True
    if col["type"] == "checkbox":
        return not v
    return False


def atoms(col: dict, v: Any) -> List[str]:
    """The comparable pieces of an option-like cell, as strings (a multi-value cell has several)."""
    if is_empty(col, v):
        return []
    if isinstance(v, dict):
        v = v.get("id")
    if isinstance(v, (list, tuple)):
        return [str(x) for x in v if x not in (None, "")]
    return [str(v)]


def _option_map(col: dict) -> Dict[str, dict]:
    return {str(o["value"]): o for o in (col.get("options") or [])}


def _label(col: dict, value: str) -> str:
    option = _option_map(col).get(value)
    return option.get("label", value) if option else value


def _fmt_number(v: Any) -> str:
    return str(int(v)) if float(v).is_integer() else str(v)


class _Ctx:
    def __init__(self, columns: List[dict], me: Optional[str], today: date, title_column: Optional[str]):
        self.columns = columns
        self.by_key = {c["key"]: c for c in columns}
        self.me = me
        self.today = today
        self.title_column = title_column

    def column(self, key: Any, what: str = "column") -> dict:
        if not isinstance(key, str) or key not in self.by_key:
            known = ", ".join(self.by_key)
            raise QueryError(f"Unknown {what} {key!r}. This table has: {known}")
        return self.by_key[key]


# ---------------------------------------------------------------- filters

def _compile_leaf(node: dict, ctx: _Ctx) -> Callable[[dict], bool]:
    key, op = node.get("column"), node.get("op")
    col = ctx.column(key)
    ctype = col["type"]
    valid = OPS_BY_TYPE.get(ctype, _COMMON)
    if op not in valid:
        raise QueryError(f"Operator {op!r} is not valid for {ctype} column '{key}'. Use one of: {', '.join(sorted(valid))}")

    def cell(row: dict) -> Any:
        return (row.get("values") or {}).get(key)

    if op == "empty":
        return lambda row: is_empty(col, cell(row))
    if op == "notEmpty":
        return lambda row: not is_empty(col, cell(row))

    if "value" not in node:
        raise QueryError(f"Operator {op!r} on '{key}' needs a value")
    value = node["value"]

    if op in ("in", "nin", "between") and not isinstance(value, (list, tuple)):
        raise QueryError(f"Operator {op!r} on '{key}' needs a list, got {value!r}")

    # ----- how to compare a cell with the value(s), by column type
    if ctype == "checkbox":
        if not isinstance(value, bool):
            raise QueryError(f"Value for checkbox column '{key}' must be true or false, got {value!r}")
        want = lambda row: bool(cell(row)) == value  # noqa: E731
        return want if op == "eq" else (lambda row: not want(row))

    if ctype == "date":
        return _compile_date(op, value, key, cell, col, ctx)

    if ctype == "number":
        return _compile_number(op, value, key, cell)

    if ctype in TEXTY:
        def text(v: Any) -> str:
            if not isinstance(v, str):
                raise QueryError(f"Value for text column '{key}' must be text, got {v!r}")
            return v.casefold()
        if op == "contains":
            needle = text(value)
            return lambda row: needle in str(cell(row) or "").casefold()
        if op in ("in", "nin"):
            wanted = {text(v) for v in value}
            hit = lambda row: str(cell(row) or "").casefold() in wanted and not is_empty(col, cell(row))  # noqa: E731
        else:
            one = text(value)
            hit = lambda row: not is_empty(col, cell(row)) and str(cell(row)).casefold() == one  # noqa: E731
        return hit if op in ("eq", "in") else (lambda row: not hit(row))

    if ctype == "formula":
        return _compile_formula(op, value, key, cell, col)

    # ----- option-like: select, status, priority, person(s), multiselect, clip, relation
    def option_value(v: Any) -> str:
        if ctype in PERSON and v == "@me":
            if not ctx.me:
                raise QueryError("'@me' needs a signed-in user")
            return ctx.me
        if isinstance(v, (str, int)) and not isinstance(v, bool):
            return str(v)
        raise QueryError(f"Value for {ctype} column '{key}' must be an id, got {v!r}")

    if op in ("in", "nin"):
        wanted = {option_value(v) for v in value}
    else:
        wanted = {option_value(value)}
    # Multi-value cells match when any of their values matches
    hit = lambda row: any(a in wanted for a in atoms(col, cell(row)))  # noqa: E731
    return hit if op in ("eq", "in", "contains") else (lambda row: not hit(row))


def _compile_number(op: str, value: Any, key: str, cell) -> Callable[[dict], bool]:
    def num(v: Any) -> float:
        if not _is_number(v):
            raise QueryError(f"Value for number column '{key}' must be a number, got {v!r}")
        return v

    def current(row: dict) -> Optional[float]:
        v = cell(row)
        return v if _is_number(v) else None

    if op in ("in", "nin"):
        wanted = {num(v) for v in value}
        hit = lambda row: current(row) in wanted  # noqa: E731
        return hit if op == "in" else (lambda row: not hit(row))
    if op == "between":
        if len(value) != 2:
            raise QueryError(f"between on '{key}' needs [low, high]")
        low, high = num(value[0]), num(value[1])
        return lambda row: current(row) is not None and low <= current(row) <= high
    limit = num(value)
    tests = {
        "eq": lambda c: c == limit, "neq": lambda c: c != limit,
        "lt": lambda c: c < limit, "lte": lambda c: c <= limit,
        "gt": lambda c: c > limit, "gte": lambda c: c >= limit,
    }
    test = tests[op]
    if op == "neq":
        return lambda row: current(row) is None or test(current(row))
    return lambda row: current(row) is not None and test(current(row))


def _compile_date(op: str, value: Any, key: str, cell, col: dict, ctx: _Ctx) -> Callable[[dict], bool]:
    def current(row: dict) -> Optional[date]:
        return _cell_date(cell(row))

    label = f"Value for date column '{key}'"
    if op == "relative":
        low, high = relative_range(value, ctx.today)
        return lambda row: current(row) is not None and low <= current(row) <= high
    if op in ("in", "nin"):
        wanted = {to_date(v, label) for v in value}
        hit = lambda row: current(row) in wanted  # noqa: E731
        return hit if op == "in" else (lambda row: not hit(row))
    if op == "between":
        if len(value) != 2:
            raise QueryError(f"between on '{key}' needs [first day, last day]")
        low, high = to_date(value[0], label), to_date(value[1], label)
        return lambda row: current(row) is not None and low <= current(row) <= high
    limit = to_date(value, label)
    tests = {
        "eq": lambda c: c == limit, "neq": lambda c: c != limit,
        "lt": lambda c: c < limit, "before": lambda c: c < limit, "lte": lambda c: c <= limit,
        "gt": lambda c: c > limit, "after": lambda c: c > limit, "gte": lambda c: c >= limit,
    }
    test = tests[op]
    if op == "neq":
        return lambda row: current(row) is None or test(current(row))
    return lambda row: current(row) is not None and test(current(row))


def _compile_formula(op: str, value: Any, key: str, cell, col: dict) -> Callable[[dict], bool]:
    """Formula results can be numbers or text: compare like the matching column type would."""
    def same(a: Any, b: Any) -> bool:
        if _is_number(a) and _is_number(b):
            return a == b
        return str(a).casefold() == str(b).casefold()

    if op == "contains":
        return lambda row: str(value).casefold() in str(cell(row) if cell(row) is not None else "").casefold()
    if op in ("in", "nin"):
        hit = lambda row: not is_empty(col, cell(row)) and any(same(cell(row), v) for v in value)  # noqa: E731
        return hit if op == "in" else (lambda row: not hit(row))
    if op in ("eq", "neq"):
        hit = lambda row: not is_empty(col, cell(row)) and same(cell(row), value)  # noqa: E731
        return hit if op == "eq" else (lambda row: not hit(row))
    return _compile_number(op, value, key, cell)


def compile_filter(node: Any, ctx: _Ctx, depth: int = 0) -> Callable[[dict], bool]:
    if depth > _MAX_FILTER_DEPTH:
        raise QueryError("Filter is nested too deeply")
    if not isinstance(node, dict):
        raise QueryError("A filter must be an object like {\"column\": ..., \"op\": ..., \"value\": ...}")
    if "and" in node or "or" in node:
        if len(node) != 1:
            raise QueryError("A filter group has only 'and' or 'or'")
        kind = "and" if "and" in node else "or"
        children = node[kind]
        if not isinstance(children, list):
            raise QueryError(f"'{kind}' needs a list of filters")
        parts = [compile_filter(c, ctx, depth + 1) for c in children]
        if not parts:
            return lambda row: True
        if kind == "and":
            return lambda row: all(p(row) for p in parts)
        return lambda row: any(p(row) for p in parts)
    if "column" not in node or "op" not in node:
        raise QueryError("A filter needs 'column' and 'op' (or 'and' / 'or')")
    return _compile_leaf(node, ctx)


# ---------------------------------------------------------------- search, sort, group

def _search_predicate(text: str, ctx: _Ctx) -> Callable[[dict], bool]:
    needle = text.casefold()
    keys = [c["key"] for c in ctx.columns
            if c["type"] in ("text", "longtext", "url") or c["key"] == ctx.title_column]

    def hit(row: dict) -> bool:
        values = row.get("values") or {}
        return any(needle in str(values.get(k) or "").casefold() for k in keys)
    return hit


def _sort_key(col: dict, v: Any):
    """Comparable key for a non-empty cell."""
    ctype = col["type"]
    if ctype == "number" or (ctype == "formula" and _is_number(v)):
        return (0, float(v)) if _is_number(v) else (1, str(v))
    if ctype == "checkbox":
        return bool(v)
    if ctype == "date":
        return str(v)
    if ctype in TEXTY or ctype == "formula":
        return str(v).casefold()
    if ctype in PERSON:
        return tuple(sorted(_label(col, a).casefold() for a in atoms(col, v)))
    if ctype == "clip":
        return str(v.get("name") or v.get("id")).casefold() if isinstance(v, dict) else str(v)
    # select-like: option order, unknown values last
    order = {value: i for i, value in enumerate(_option_map(col))}
    return tuple(sorted((order.get(a, len(order)), a) for a in atoms(col, v)))


def _sort_rows(rows: List[dict], sort: list, ctx: _Ctx) -> List[dict]:
    """Multi-column stable sort; empty values are always last, whatever the direction."""
    for spec in reversed(sort):
        col, desc = spec["col"], spec["desc"]
        filled, empty = [], []
        for row in rows:
            v = (row.get("values") or {}).get(col["key"])
            (empty if is_empty(col, v) and col["type"] != "checkbox" else filled).append(row)
        filled.sort(key=lambda r: _sort_key(col, (r.get("values") or {}).get(col["key"])), reverse=desc)
        rows = filled + empty
    return rows


def _group_keys(col: dict, v: Any) -> List[Optional[str]]:
    """The groups a cell belongs to ([None] = the empty group; several for multi-value cells)."""
    ctype = col["type"]
    if ctype == "checkbox":
        return ["true" if v else "false"]
    if is_empty(col, v):
        return [None]
    if ctype == "number":
        return [_fmt_number(v)] if _is_number(v) else [str(v)]
    if ctype == "date":
        d = _cell_date(v)
        return [d.isoformat() if d else str(v)]
    keys = atoms(col, v) if ctype not in TEXTY and ctype != "formula" else [str(v)]
    seen, unique = set(), []
    for k in keys:
        if k not in seen:
            seen.add(k)
            unique.append(k)
    return unique or [None]


def _group_order(col: dict, keys: List[Optional[str]]) -> List[Optional[str]]:
    """Known option values in option order, then the rest (sorted), the empty group last."""
    present = {k for k in keys if k is not None}
    ctype = col["type"]
    options = [str(o["value"]) for o in (col.get("options") or [])]
    if ctype == "checkbox":
        ordered = [k for k in ("false", "true") if k in present]
    elif ctype in SINGLE_OPTION or ctype == "multiselect":
        # Board columns exist even when nothing is in them yet
        ordered = list(options) + sorted(present - set(options))
    else:
        ordered = [o for o in options if o in present]
        rest = present - set(ordered)
        if ctype == "number":
            ordered += sorted(rest, key=float)
        else:
            ordered += sorted(rest, key=lambda s: _label(col, s).casefold())
    if None in keys:
        ordered.append(None)
    return ordered


def _group_info(col: dict, key: Optional[str]) -> dict:
    if key is None:
        return {"label": "No value"}
    if col["type"] == "checkbox":
        return {"label": "Checked" if key == "true" else "Unchecked"}
    option = _option_map(col).get(key)
    if option:
        info = {"label": option.get("label", key)}
        if option.get("color"):
            info["color"] = option["color"]
        return info
    return {"label": key}


# ---------------------------------------------------------------- summaries

def _check_summaries(spec: Any, ctx: _Ctx) -> Dict[str, tuple]:
    if not isinstance(spec, dict):
        raise QueryError("summaries must be an object like {\"dueDate\": \"countEmpty\"}")
    checked = {}
    for key, fn in spec.items():
        col = ctx.column(key, "summary column")
        if fn not in SUMMARY_FUNCTIONS:
            raise QueryError(f"Unknown summary {fn!r}. Use one of: {', '.join(sorted(SUMMARY_FUNCTIONS))}")
        ctype = col["type"]
        if fn in ("sum", "avg") and ctype not in ("number", "formula"):
            raise QueryError(f"'{fn}' needs a number column; '{key}' is {ctype}")
        if fn in ("min", "max") and ctype not in ("number", "formula", "date"):
            raise QueryError(f"'{fn}' needs a number or date column; '{key}' is {ctype}")
        if fn == "percentChecked" and ctype != "checkbox":
            raise QueryError(f"'percentChecked' needs a checkbox column; '{key}' is {ctype}")
        checked[key] = (col, fn)
    return checked


def summarize(checked: Dict[str, tuple], rows: List[dict]) -> Dict[str, Any]:
    out: Dict[str, Any] = {}
    for key, (col, fn) in checked.items():
        values = [(r.get("values") or {}).get(key) for r in rows]
        filled = [v for v in values if not is_empty(col, v)]
        if fn == "count":
            out[key] = len(rows)
        elif fn == "countFilled":
            out[key] = len(filled)
        elif fn == "countEmpty":
            out[key] = len(rows) - len(filled)
        elif fn == "percentChecked":
            out[key] = round(100 * sum(1 for v in values if v) / len(rows), 2) if rows else None
        elif col["type"] == "date":
            dates = sorted(d.isoformat() for d in (_cell_date(v) for v in filled) if d)
            out[key] = (dates[0] if fn == "min" else dates[-1]) if dates else None
        else:
            numbers = [v for v in filled if _is_number(v)]
            if fn == "sum":
                out[key] = sum(numbers)
            elif not numbers:
                out[key] = None
            elif fn == "avg":
                out[key] = sum(numbers) / len(numbers)
            else:
                out[key] = min(numbers) if fn == "min" else max(numbers)
    return out


# ---------------------------------------------------------------- entry point

def _int_param(query: dict, name: str) -> Optional[int]:
    v = query.get(name)
    if v is None:
        return None
    if not isinstance(v, int) or isinstance(v, bool) or v < 0:
        raise QueryError(f"'{name}' must be a whole number of 0 or more")
    return v


def run_query(rows: List[dict], columns: List[dict], query: Optional[dict], *, me: Optional[str] = None,
              today: Optional[date] = None, title_column: Optional[str] = None) -> dict:
    """Apply a Query to rows and return a QueryResult dict.

    rows are in their natural order (the order used when the query has no sort).
    ``total`` counts the rows that match, before limit/offset. ``me`` is the caller's id
    (for "@me"); ``today`` is injectable for tests.
    """
    query = query or {}
    if not isinstance(query, dict):
        raise QueryError("The query must be an object")
    unknown = set(query) - _TOP_LEVEL_KEYS
    if unknown:
        raise QueryError(f"Unknown query field(s): {', '.join(sorted(unknown))}")

    ctx = _Ctx(columns, me, today or date.today(), title_column)

    # Validate everything first, so a bad query fails even when no rows match
    predicate = compile_filter(query["filter"], ctx) if query.get("filter") else None

    sort = []
    raw_sort = query.get("sort") or []
    if not isinstance(raw_sort, list):
        raise QueryError("sort must be a list of {column, dir}")
    for item in raw_sort:
        if not isinstance(item, dict):
            raise QueryError("sort must be a list of {column, dir}")
        direction = item.get("dir", "asc")
        if direction not in ("asc", "desc"):
            raise QueryError(f"Sort direction must be 'asc' or 'desc', got {direction!r}")
        sort.append({"col": ctx.column(item.get("column"), "sort column"), "desc": direction == "desc"})

    group_col = None
    if query.get("groupBy") is not None:
        group_col = ctx.column(query["groupBy"], "groupBy column")
        if group_col["type"] == "longtext":
            raise QueryError(f"Cannot group by long text column '{group_col['key']}'")

    summary_spec = _check_summaries(query["summaries"], ctx) if query.get("summaries") else None

    search = query.get("search")
    if search is not None and not isinstance(search, str):
        raise QueryError("search must be text")

    limit, offset = _int_param(query, "limit"), _int_param(query, "offset")
    if "parentId" in query and query["parentId"] is not None and not isinstance(query["parentId"], str):
        raise QueryError("parentId must be a row id or null")

    # ----- run
    result_rows = rows
    if "parentId" in query:
        wanted_parent = query["parentId"]
        result_rows = [r for r in result_rows if (r.get("parentId") or None) == wanted_parent]
    if predicate:
        result_rows = [r for r in result_rows if predicate(r)]
    if search and search.strip():
        match = _search_predicate(search.strip(), ctx)
        result_rows = [r for r in result_rows if match(r)]

    if sort:
        result_rows = _sort_rows(list(result_rows), sort, ctx)

    result: Dict[str, Any] = {"total": len(result_rows)}

    if group_col is not None:
        cells = [(r, _group_keys(group_col, (r.get("values") or {}).get(group_col["key"]))) for r in result_rows]
        order = _group_order(group_col, [k for _, keys in cells for k in keys])
        position = {k: i for i, k in enumerate(order)}
        members: Dict[Optional[str], List[dict]] = {k: [] for k in order}
        for row, keys in cells:
            for k in keys:
                members[k].append(row)
        # Rows follow the groups (a multi-value row is listed under its first group)
        result_rows = [r for r, _ in sorted(cells, key=lambda c: min(position[k] for k in c[1]))]
        groups = []
        for k in order:
            group = {"key": k, **_group_info(group_col, k), "count": len(members[k])}
            if summary_spec:
                group["summaries"] = summarize(summary_spec, members[k])
            groups.append(group)
        result["groups"] = groups

    if summary_spec:
        result["summaries"] = summarize(summary_spec, list(result_rows))

    start = offset or 0
    result["rows"] = result_rows[start:start + limit] if limit is not None else result_rows[start:]
    return result
