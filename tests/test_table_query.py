"""The table query engine on its own: no database, no HTTP."""

from datetime import date

import pytest

from api.tables.query import QueryError, run_query

TODAY = date(2030, 6, 15)  # a Saturday

COLUMNS = [
    {"key": "name", "name": "Name", "type": "text", "builtin": True},
    {"key": "notes", "name": "Notes", "type": "longtext", "builtin": True},
    {"key": "status", "name": "Status", "type": "status", "builtin": True, "options": [
        {"value": "s1", "label": "Todo", "color": "#111111"},
        {"value": "s2", "label": "Doing", "color": "#222222"},
        {"value": "s3", "label": "Done", "color": "#333333"}]},
    {"key": "tags", "name": "Tags", "type": "multiselect", "builtin": False, "options": [
        {"value": "a", "label": "Alpha"}, {"value": "b", "label": "Beta"}, {"value": "c", "label": "Gamma"}]},
    {"key": "owner", "name": "Owner", "type": "person", "builtin": True, "options": [
        {"value": "u1", "label": "Zed"}, {"value": "u2", "label": "Amy"}]},
    {"key": "people", "name": "People", "type": "people", "builtin": True, "options": [
        {"value": "u1", "label": "Zed"}, {"value": "u2", "label": "Amy"}, {"value": "u3", "label": "Bob"}]},
    {"key": "points", "name": "Points", "type": "number", "builtin": False},
    {"key": "done", "name": "Done", "type": "checkbox", "builtin": False},
    {"key": "due", "name": "Due", "type": "date", "builtin": True},
    {"key": "link", "name": "Link", "type": "url", "builtin": False},
    {"key": "clip", "name": "Clip", "type": "clip", "builtin": True},
]


def row(id, parent=None, **values):
    return {"id": id, "tableRef": "t", "parentId": parent, "values": values, "canEdit": True}


ROWS = [
    row("r1", name="Alpha shot", status="s1", tags=["a", "b"], owner="u1", people=["u1", "u2"], points=3,
        done=True, due="2030-06-10", notes="Needs a warmer grade", link="https://x.test/a", clip={"id": 1, "name": "c1"}),
    row("r2", name="beta shot", status="s2", tags=["b"], owner="u2", people=["u3"], points=10,
        done=False, due="2030-06-15", notes="", link=None),
    row("r3", name="Gamma", status="s2", tags=[], owner=None, people=[], points=None,
        done=False, due=None, notes=None),
    row("r4", parent="r1", name="Sub of alpha", status="s3", tags=["c"], owner="u1", people=["u2"], points=7,
        done=True, due="2030-06-20T23:30:00+14:00"),
]


def ids(result):
    return [r["id"] for r in result["rows"]]


def q(query=None, rows=ROWS, **kw):
    kw.setdefault("today", TODAY)
    kw.setdefault("me", "u2")
    return run_query(rows, COLUMNS, query, title_column="name", **kw)


def flt(column, op, *value):
    node = {"column": column, "op": op}
    if value:
        node["value"] = value[0]
    return ids(q({"filter": node}))


# ---------------------------------------------------------------- filters

def test_no_query_returns_everything_in_order():
    result = q()
    assert ids(result) == ["r1", "r2", "r3", "r4"]
    assert result["total"] == 4
    assert "groups" not in result and "summaries" not in result


def test_eq_text_is_case_insensitive_and_whole_value():
    assert flt("name", "eq", "GAMMA") == ["r3"]
    assert flt("name", "eq", "Alpha") == []


def test_eq_on_option_number_checkbox_and_date():
    assert flt("status", "eq", "s2") == ["r2", "r3"]
    assert flt("points", "eq", 10) == ["r2"]
    assert flt("done", "eq", True) == ["r1", "r4"]
    assert flt("due", "eq", "2030-06-15") == ["r2"]


def test_neq_includes_empty_values():
    assert flt("status", "neq", "s2") == ["r1", "r4"]
    assert flt("points", "neq", 3) == ["r2", "r3", "r4"]
    assert flt("done", "neq", True) == ["r2", "r3"]
    assert flt("due", "neq", "2030-06-15") == ["r1", "r3", "r4"]


def test_in_and_nin():
    assert flt("status", "in", ["s1", "s3"]) == ["r1", "r4"]
    assert flt("status", "nin", ["s1", "s3"]) == ["r2", "r3"]
    assert flt("points", "in", [3, 7]) == ["r1", "r4"]
    assert flt("due", "in", ["2030-06-10", "2030-06-15"]) == ["r1", "r2"]
    assert flt("name", "in", ["gamma"]) == ["r3"]


def test_in_and_nin_on_multi_value_columns_match_any_value():
    assert flt("tags", "in", ["a", "c"]) == ["r1", "r4"]
    assert flt("tags", "nin", ["a", "c"]) == ["r2", "r3"]
    assert flt("tags", "eq", "b") == ["r1", "r2"]
    assert flt("tags", "neq", "b") == ["r3", "r4"]


def test_contains_on_text_is_a_case_insensitive_substring():
    assert flt("name", "contains", "SHOT") == ["r1", "r2"]
    assert flt("notes", "contains", "warm") == ["r1"]
    assert flt("link", "contains", "x.test") == ["r1"]


def test_contains_on_multi_value_columns_matches_a_value():
    assert flt("tags", "contains", "a") == ["r1"]
    assert flt("people", "contains", "u2") == ["r1", "r4"]


def test_empty_and_notEmpty_for_every_kind_of_cell():
    assert flt("notes", "empty") == ["r2", "r3", "r4"]  # "", None and missing
    assert flt("tags", "empty") == ["r3"]
    assert flt("owner", "empty") == ["r3"]
    assert flt("points", "empty") == ["r3"]
    assert flt("due", "empty") == ["r3"]
    assert flt("clip", "empty") == ["r2", "r3", "r4"]
    assert flt("notes", "notEmpty") == ["r1"]
    assert flt("clip", "notEmpty") == ["r1"]
    assert flt("people", "notEmpty") == ["r1", "r2", "r4"]


def test_checkbox_only_supports_eq_and_neq():
    with pytest.raises(QueryError, match="not valid for checkbox"):
        flt("done", "empty")


def test_lt_lte_gt_gte_on_numbers_skip_empty():
    assert flt("points", "lt", 7) == ["r1"]
    assert flt("points", "lte", 7) == ["r1", "r4"]
    assert flt("points", "gt", 7) == ["r2"]
    assert flt("points", "gte", 7) == ["r2", "r4"]


def test_lt_lte_gt_gte_on_dates():
    assert flt("due", "lt", "2030-06-15") == ["r1"]
    assert flt("due", "lte", "2030-06-15") == ["r1", "r2"]
    assert flt("due", "gt", "2030-06-15") == ["r4"]
    assert flt("due", "gte", "2030-06-15") == ["r2", "r4"]


def test_before_and_after():
    assert flt("due", "before", "2030-06-15") == ["r1"]
    assert flt("due", "after", "2030-06-15") == ["r4"]


def test_between_is_inclusive_for_numbers_and_dates():
    assert flt("points", "between", [3, 7]) == ["r1", "r4"]
    assert flt("due", "between", ["2030-06-10", "2030-06-15"]) == ["r1", "r2"]


def test_dates_are_compared_as_dates_never_shifted_by_time_zones():
    # 23:30 at +14:00 is still the 20th: only the written date counts
    assert flt("due", "eq", "2030-06-20") == ["r4"]
    assert flt("due", "before", "2030-06-21") == ["r1", "r2", "r4"]
    assert flt("due", "gt", "2030-06-20") == []


def test_relative_day_range_from_today():
    # last 7 days up to today: 2030-06-08 .. 2030-06-15
    assert flt("due", "relative", {"unit": "day", "from": -7, "to": 0}) == ["r1", "r2"]
    assert flt("due", "relative", {"unit": "day", "from": 0, "to": 0}) == ["r2"]
    assert flt("due", "relative", {"unit": "day", "from": 1, "to": 5}) == ["r4"]


def test_relative_week_and_month_units():
    assert flt("due", "relative", {"unit": "week", "from": 0, "to": 1}) == ["r2", "r4"]
    assert flt("due", "relative", {"unit": "month", "from": -1, "to": 0}) == ["r1", "r2"]
    # month arithmetic clamps the day: 31 Mar + 1 month = 30 Apr
    rows = [row("m1", due="2030-04-30"), row("m2", due="2030-05-01")]
    res = q({"filter": {"column": "due", "op": "relative", "value": {"unit": "month", "from": 0, "to": 1}}},
            rows=rows, today=date(2030, 3, 31))
    assert ids(res) == ["m1"]


def test_at_me_resolves_to_the_caller_for_person_and_people():
    assert flt("owner", "eq", "@me") == ["r2"]
    assert flt("people", "contains", "@me") == ["r1", "r4"]
    assert flt("people", "in", ["@me", "u3"]) == ["r1", "r2", "r4"]
    assert ids(q({"filter": {"column": "owner", "op": "eq", "value": "@me"}}, me="u1")) == ["r1", "r4"]


def test_at_me_without_a_user_is_invalid():
    with pytest.raises(QueryError, match="@me"):
        q({"filter": {"column": "owner", "op": "eq", "value": "@me"}}, me=None)


def test_and_or_nesting():
    f = {"or": [
        {"and": [{"column": "status", "op": "eq", "value": "s2"}, {"column": "done", "op": "eq", "value": False}]},
        {"column": "points", "op": "gte", "value": 7},
    ]}
    assert ids(q({"filter": f})) == ["r2", "r3", "r4"]
    assert ids(q({"filter": {"and": []}})) == ["r1", "r2", "r3", "r4"]


def test_filter_on_every_column_type_with_a_value_it_supports():
    # a smoke test that no operator table entry is missing for a column type
    for col in COLUMNS:
        if col["type"] == "checkbox":
            continue
        assert q({"filter": {"column": col["key"], "op": "notEmpty"}})["total"] >= 1


# ---- invalid filters

@pytest.mark.parametrize("node, message", [
    ({"column": "nope", "op": "eq", "value": 1}, "Unknown column 'nope'"),
    ({"column": "name", "op": "bogus", "value": 1}, "not valid for text"),
    ({"column": "name", "op": "lt", "value": "a"}, "not valid for text"),
    ({"column": "done", "op": "contains", "value": True}, "not valid for checkbox"),
    ({"column": "status", "op": "contains", "value": "s1"}, "not valid for status"),
    ({"column": "points", "op": "contains", "value": "1"}, "not valid for number"),
    ({"column": "points", "op": "eq", "value": "three"}, "must be a number"),
    ({"column": "points", "op": "eq"}, "needs a value"),
    ({"column": "points", "op": "between", "value": [1]}, r"needs \[low, high\]"),
    ({"column": "points", "op": "between", "value": 3}, "needs a list"),
    ({"column": "status", "op": "in", "value": "s1"}, "needs a list"),
    ({"column": "done", "op": "eq", "value": "yes"}, "true or false"),
    ({"column": "due", "op": "before", "value": "tomorrow"}, "must be a date"),
    ({"column": "due", "op": "between", "value": ["2030-01-01"]}, r"needs \[first day, last day\]"),
    ({"column": "due", "op": "relative", "value": "last week"}, "relative needs"),
    ({"column": "due", "op": "relative", "value": {"unit": "year", "from": 0, "to": 1}}, "relative needs"),
    ({"column": "due", "op": "relative", "value": {"unit": "day", "from": 3, "to": 1}}, "must not be greater"),
    ({"column": "due", "op": "relative", "value": {"unit": "day", "from": "a", "to": 1}}, "whole numbers"),
    ({"column": "name", "op": "eq", "value": 5}, "must be text"),
    ({"column": "status", "op": "eq", "value": {"x": 1}}, "must be an id"),
    ({"op": "eq", "value": 1}, "needs 'column' and 'op'"),
    ({"and": "x"}, "needs a list"),
    ({"and": [], "or": []}, "only 'and' or 'or'"),
    ("name", "must be an object"),
])
def test_invalid_filters_raise_a_helpful_error(node, message):
    with pytest.raises(QueryError, match=message):
        q({"filter": node})


def test_unknown_column_error_lists_the_known_columns():
    with pytest.raises(QueryError, match="name, notes, status"):
        q({"filter": {"column": "nope", "op": "empty"}})


def test_filter_nesting_is_limited():
    node = {"column": "name", "op": "notEmpty"}
    for _ in range(12):
        node = {"and": [node]}
    with pytest.raises(QueryError, match="nested too deeply"):
        q({"filter": node})


def test_unknown_query_field_is_rejected():
    with pytest.raises(QueryError, match="Unknown query field"):
        q({"filtr": {}})


# ---------------------------------------------------------------- hierarchy and search

def test_parent_id_null_is_roots_and_an_id_is_its_children():
    assert ids(q({"parentId": None})) == ["r1", "r2", "r3"]
    assert ids(q({"parentId": "r1"})) == ["r4"]
    assert ids(q({"parentId": "r3"})) == []
    assert ids(q({})) == ["r1", "r2", "r3", "r4"]  # omitted = flat


def test_search_is_case_insensitive_over_title_and_text_columns():
    assert ids(q({"search": "ALPHA"})) == ["r1", "r4"]
    assert ids(q({"search": "warmer"})) == ["r1"]       # longtext
    assert ids(q({"search": "x.test"})) == ["r1"]       # url
    assert ids(q({"search": "s2"})) == []               # option values are not searched
    assert ids(q({"search": "  "})) == ["r1", "r2", "r3", "r4"]


def test_search_combines_with_filters():
    assert ids(q({"search": "shot", "filter": {"column": "status", "op": "eq", "value": "s2"}})) == ["r2"]


# ---------------------------------------------------------------- sorting

def test_sort_numbers_ascending_and_descending_with_empties_last():
    assert ids(q({"sort": [{"column": "points", "dir": "asc"}]})) == ["r1", "r4", "r2", "r3"]
    assert ids(q({"sort": [{"column": "points", "dir": "desc"}]})) == ["r2", "r4", "r1", "r3"]


def test_sort_direction_defaults_to_ascending():
    assert ids(q({"sort": [{"column": "points"}]})) == ["r1", "r4", "r2", "r3"]


def test_sort_text_ignores_case():
    assert ids(q({"sort": [{"column": "name", "dir": "asc"}]})) == ["r1", "r2", "r3", "r4"]
    assert ids(q({"sort": [{"column": "name", "dir": "desc"}]})) == ["r4", "r3", "r2", "r1"]


def test_sort_dates_empties_last():
    assert ids(q({"sort": [{"column": "due", "dir": "asc"}]})) == ["r1", "r2", "r4", "r3"]
    assert ids(q({"sort": [{"column": "due", "dir": "desc"}]})) == ["r4", "r2", "r1", "r3"]


def test_sort_select_like_columns_follow_option_order_not_the_alphabet():
    cols = [dict(c) for c in COLUMNS]
    rows = [row("x1", status="s3"), row("x2", status="s1"), row("x3", status="s2"), row("x4")]
    res = run_query(rows, cols, {"sort": [{"column": "status"}]}, today=TODAY)
    assert ids(res) == ["x2", "x3", "x1", "x4"]
    res = run_query(rows, cols, {"sort": [{"column": "status", "dir": "desc"}]}, today=TODAY)
    assert ids(res) == ["x1", "x3", "x2", "x4"]


def test_sort_people_by_name_not_by_id():
    # owner u1 is "Zed", u2 is "Amy": Amy sorts first although u1 < u2
    assert ids(q({"sort": [{"column": "owner"}]})) == ["r2", "r1", "r4", "r3"]
    assert ids(q({"sort": [{"column": "owner", "dir": "desc"}]})) == ["r1", "r4", "r2", "r3"]


def test_multi_column_sort_and_stability():
    res = q({"sort": [{"column": "status", "dir": "asc"}, {"column": "points", "dir": "desc"}]})
    assert ids(res) == ["r1", "r2", "r3", "r4"]  # s1; s2: 10 then empty; s3
    # rows that tie on every sort column keep their order
    assert ids(q({"sort": [{"column": "done"}]})) == ["r2", "r3", "r1", "r4"]


def test_sort_checkbox_false_before_true():
    assert ids(q({"sort": [{"column": "done", "dir": "desc"}]})) == ["r1", "r4", "r2", "r3"]


def test_invalid_sort():
    with pytest.raises(QueryError, match="Unknown sort column"):
        q({"sort": [{"column": "nope"}]})
    with pytest.raises(QueryError, match="'asc' or 'desc'"):
        q({"sort": [{"column": "name", "dir": "up"}]})
    with pytest.raises(QueryError, match="list of"):
        q({"sort": "name"})


# ---------------------------------------------------------------- grouping

def test_group_by_status_in_option_order_with_label_color_and_count():
    res = q({"groupBy": "status"})
    assert [(g["key"], g["label"], g["color"], g["count"]) for g in res["groups"]] == [
        ("s1", "Todo", "#111111", 1), ("s2", "Doing", "#222222", 2), ("s3", "Done", "#333333", 1)]
    assert res["total"] == 4


def test_group_rows_are_listed_group_by_group():
    res = q({"groupBy": "status", "sort": [{"column": "name", "dir": "desc"}]})
    assert ids(res) == ["r1", "r3", "r2", "r4"]


def test_empty_values_form_a_null_group_that_comes_last():
    res = q({"groupBy": "owner"})
    assert [(g["key"], g["count"]) for g in res["groups"]] == [("u1", 2), ("u2", 1), (None, 1)]
    assert res["groups"][-1]["label"] == "No value"
    assert "color" not in res["groups"][-1]


def test_single_option_groups_include_options_nobody_uses():
    res = q({"groupBy": "status", "filter": {"column": "status", "op": "eq", "value": "s2"}})
    assert [(g["key"], g["count"]) for g in res["groups"]] == [("s1", 0), ("s2", 2), ("s3", 0)]


def test_multi_value_rows_appear_in_each_of_their_groups():
    res = q({"groupBy": "tags"})
    counts = {g["key"]: g["count"] for g in res["groups"]}
    assert counts == {"a": 1, "b": 2, "c": 1, None: 1}
    assert [g["key"] for g in res["groups"]] == ["a", "b", "c", None]
    assert res["total"] == 4  # total counts rows, not memberships


def test_group_by_people_uses_names_as_labels():
    res = q({"groupBy": "people"})
    assert [(g["key"], g["label"], g["count"]) for g in res["groups"]] == [
        ("u1", "Zed", 1), ("u2", "Amy", 2), ("u3", "Bob", 1), (None, "No value", 1)]


def test_group_by_checkbox_and_date_and_number():
    res = q({"groupBy": "done"})
    assert [(g["key"], g["label"], g["count"]) for g in res["groups"]] == [
        ("false", "Unchecked", 2), ("true", "Checked", 2)]
    res = q({"groupBy": "due"})
    assert [g["key"] for g in res["groups"]] == ["2030-06-10", "2030-06-15", "2030-06-20", None]
    res = q({"groupBy": "points"})
    assert [g["key"] for g in res["groups"]] == ["3", "7", "10", None]


def test_group_by_text_sorts_groups_alphabetically_ignoring_case():
    res = q({"groupBy": "name"})
    assert [g["key"] for g in res["groups"]] == ["Alpha shot", "beta shot", "Gamma", "Sub of alpha"]


def test_group_by_unknown_or_longtext_is_invalid():
    with pytest.raises(QueryError, match="Unknown groupBy column"):
        q({"groupBy": "nope"})
    with pytest.raises(QueryError, match="long text"):
        q({"groupBy": "notes"})


def test_groups_cover_all_matching_rows_not_just_the_page():
    res = q({"groupBy": "status", "limit": 1})
    assert len(res["rows"]) == 1
    assert sum(g["count"] for g in res["groups"]) == 4


# ---------------------------------------------------------------- summaries

def summary(column, fn, rows=ROWS, **query):
    return q({"summaries": {column: fn}, **query}, rows=rows)["summaries"][column]


def test_summary_count():
    assert summary("name", "count") == 4
    assert summary("name", "count", filter={"column": "status", "op": "eq", "value": "s2"}) == 2


def test_summary_countEmpty_and_countFilled():
    assert summary("due", "countEmpty") == 1
    assert summary("due", "countFilled") == 3
    assert summary("tags", "countFilled") == 3
    assert summary("notes", "countEmpty") == 3


def test_summary_sum_avg_min_max_on_numbers_ignore_empties():
    assert summary("points", "sum") == 20
    assert summary("points", "avg") == pytest.approx(20 / 3)
    assert summary("points", "min") == 3
    assert summary("points", "max") == 10


def test_summary_min_max_on_dates():
    assert summary("due", "min") == "2030-06-10"
    assert summary("due", "max") == "2030-06-20"


def test_summary_percentChecked():
    assert summary("done", "percentChecked") == 50
    assert summary("done", "percentChecked", filter={"column": "name", "op": "eq", "value": "nothing"}) is None


def test_summaries_of_nothing_are_null_or_zero():
    none = [row("n1", name="x")]
    assert summary("points", "sum", rows=none) == 0
    assert summary("points", "avg", rows=none) is None
    assert summary("points", "min", rows=none) is None
    assert summary("due", "max", rows=none) is None


def test_summaries_per_group_and_for_the_whole_result():
    res = q({"groupBy": "status", "summaries": {"points": "sum", "done": "percentChecked"}})
    by_key = {g["key"]: g["summaries"] for g in res["groups"]}
    assert by_key["s1"] == {"points": 3, "done": 100}
    assert by_key["s2"] == {"points": 10, "done": 0}
    assert by_key["s3"] == {"points": 7, "done": 100}
    assert res["summaries"] == {"points": 20, "done": 50}


def test_summaries_cover_all_matching_rows_not_just_the_page():
    res = q({"summaries": {"points": "sum"}, "limit": 1})
    assert len(res["rows"]) == 1 and res["summaries"]["points"] == 20


def test_invalid_summaries():
    with pytest.raises(QueryError, match="Unknown summary column"):
        q({"summaries": {"nope": "count"}})
    with pytest.raises(QueryError, match="Unknown summary 'median'"):
        q({"summaries": {"points": "median"}})
    with pytest.raises(QueryError, match="needs a number column"):
        q({"summaries": {"name": "sum"}})
    with pytest.raises(QueryError, match="needs a number column"):
        q({"summaries": {"due": "avg"}})
    with pytest.raises(QueryError, match="needs a number or date column"):
        q({"summaries": {"name": "max"}})
    with pytest.raises(QueryError, match="needs a checkbox column"):
        q({"summaries": {"points": "percentChecked"}})
    with pytest.raises(QueryError, match="must be an object"):
        q({"summaries": ["count"]})


# ---------------------------------------------------------------- paging

def test_limit_and_offset_page_the_result_and_total_counts_before_paging():
    res = q({"sort": [{"column": "name"}], "limit": 2})
    assert ids(res) == ["r1", "r2"] and res["total"] == 4
    res = q({"sort": [{"column": "name"}], "limit": 2, "offset": 2})
    assert ids(res) == ["r3", "r4"] and res["total"] == 4
    assert ids(q({"offset": 3})) == ["r4"]
    assert ids(q({"offset": 10})) == [] and q({"offset": 10})["total"] == 4
    assert ids(q({"limit": 0})) == []


def test_total_counts_matches_of_the_filter():
    res = q({"filter": {"column": "status", "op": "eq", "value": "s2"}, "limit": 1})
    assert ids(res) == ["r2"] and res["total"] == 2


@pytest.mark.parametrize("bad", [{"limit": -1}, {"limit": "5"}, {"offset": 1.5}, {"limit": True}])
def test_invalid_paging(bad):
    with pytest.raises(QueryError, match="whole number"):
        q(bad)


def test_the_engine_does_not_modify_its_input():
    rows = [dict(r) for r in ROWS]
    before = [r["id"] for r in rows]
    q({"sort": [{"column": "points", "dir": "desc"}], "groupBy": "tags"}, rows=rows)
    assert [r["id"] for r in rows] == before
