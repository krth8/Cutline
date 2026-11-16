"""Export of pages to Markdown (CommonMark + GFM) and to a zip with sub-pages and attachments.

The stored Yjs document is walked node by node (the node names and attributes are those of the editor,
PLAN.md 5.8). Everything that reads other data (views, mentions, files) does so as the exporter, so an export
never contains more than the exporter could see in the app.
"""

import asyncio
import os
import re
import tempfile
import zipfile
from typing import Dict, List, Optional, Tuple
from urllib.parse import quote, urlsplit

from fastapi import HTTPException
from pycrdt import Doc, XmlElement, XmlFragment, XmlText

from api.auth import can_read_page
from api.export_tables import ViewExport, format_number, safe_filename
from api.mentions import resolve_target
from api.pagesync import FRAGMENT, registry
from api.routes.page_files import PAGES_DIR, clean_name
from api.routes.views import _may as _may_view
from api.state import projects
from api.tables.query import QueryError
from api.tables.source import resolve_source
from database.access import db_list_accessible_projects
from database.page_files import db_get_page_file
from database.pages import db_get_page, db_list_pages, db_load_page_state, db_recent_pages, space_of
from database.views import db_get_view

VIEW_ROW_CAP = 500
MAX_PAGES = 500
MAX_LIST_DEPTH = 40
FILE_ID = re.compile(r"^[0-9a-f]{32}$")
FILE_URL = re.compile(r"/api/pages/([A-Za-z0-9_-]+)/files/([0-9a-f]{32})(?:[/?#]|$)")
SAFE_SCHEMES = ("http", "https", "mailto", "tel")
INLINE_TAGS = {"hardBreak", "mention", "pageLink", "taskChip", "summaryInline"}
MARK_ORDER = ["link", "bold", "italic", "strike", "underline", "highlight", "code"]
ALERTS = {"info": "NOTE", "success": "TIP", "warning": "WARNING", "danger": "CAUTION"}
NOT_AVAILABLE_VIEW = "*(view not available)*"


# ============ Small text helpers ============

_ESCAPE = re.compile(r"([\\`*_\[\]<>|~#&])")


def escape_text(text: str) -> str:
    """Backslash-escape the characters that would be read as Markdown or HTML."""
    return _ESCAPE.sub(r"\\\1", text)


def _escape_line_start(line: str) -> str:
    """A line that would start a list ("- ", "1. ") is written with the marker escaped."""
    line = re.sub(r"^(\s*)(\d+)([.)])(\s|$)", r"\1\2\\\3\4", line)
    return re.sub(r"^(\s*)([-+])(\s|$)", r"\1\\\2\3", line)


def encode_url(url: str) -> str:
    """A link target that survives the parentheses and spaces of Markdown."""
    return (url.replace(" ", "%20").replace("(", "%28").replace(")", "%29")
            .replace("<", "%3C").replace(">", "%3E").replace("\n", "").replace("\r", ""))


def safe_href(href: str) -> Optional[str]:
    """The link target if it is a web or mail link or a relative path; None for anything else (javascript:, data:)."""
    href = (href or "").strip()
    if not href:
        return None
    scheme = urlsplit(href).scheme.lower()
    if scheme and scheme not in SAFE_SCHEMES:
        return None
    return href


def indent(text: str, first: str, rest: str) -> str:
    out = []
    for i, line in enumerate(text.split("\n")):
        out.append((first if i == 0 else rest) + line if (line or i == 0) else line)
    return "\n".join(out)


def single_line(text: str) -> str:
    return re.sub(r"\s*\n\s*", " ", text).strip()


def zip_part(name: str, fallback: str = "page") -> str:
    """One path component for a zip entry: no separators, no dots-only names, not too long."""
    part = safe_filename(name, fallback, 80)
    return fallback if part in (".", "..") else part


def unique_name(name: str, used: set) -> str:
    """`name`, or `name-2.ext`, `name-3.ext` ... when the (case-insensitive) name is taken. Records the result."""
    stem, dot, ext = name.rpartition(".")
    if not dot or not stem:
        stem, ext = name, ""
    candidate, n = name, 1
    while candidate.lower() in used:
        n += 1
        candidate = f"{stem}-{n}" + (f".{ext}" if ext else "")
    used.add(candidate.lower())
    return candidate


# ============ Reading the document ============

def _attrs(node) -> dict:
    return dict(node.attributes)


def _truthy(value) -> bool:
    return value is True or (isinstance(value, str) and value.lower() == "true")


def _mark_attrs(raw: dict) -> Dict[str, dict]:
    """The marks of a text run: {name: attrs}. y-prosemirror may write a mark as "name--hash" (overlapping marks)."""
    marks = {}
    for key, value in (raw or {}).items():
        if value is None:
            continue
        marks[key.split("--", 1)[0]] = value if isinstance(value, dict) else {}
    return marks


class PageContext:
    """What one page's render needs: who exports, where links point, which files are attached."""

    def __init__(self, user: dict, base_url: str, page: dict):
        self.user = user
        self.base_url = base_url.rstrip("/")
        self.page = page
        self.files: Dict[str, dict] = {}      # file id -> {name, path, mime}
        self.used_names: set = set()
        self.warnings: List[str] = []

    # ---- files ----

    def attach(self, url: Optional[str], file_id: Optional[str]) -> Optional[str]:
        """Register a page file for the zip and return its name inside `files/`, or None when the exporter
        may not read it (or it does not exist)."""
        page_id = self.page["id"]
        match = FILE_URL.search(url or "")
        if match:
            page_id, file_id = match.group(1), match.group(2)
        if not file_id or not FILE_ID.match(file_id):
            return None
        if file_id in self.files:
            return self.files[file_id]["name"]
        source_page = self.page if page_id == self.page["id"] else db_get_page(page_id)
        if not source_page or not can_read_page(self.user, source_page):
            return None
        row = db_get_page_file(page_id, file_id)
        path = os.path.join(PAGES_DIR, page_id, file_id)
        if not row or not os.path.isfile(path):
            return None
        name = unique_name(zip_part(clean_name(row["name"]), "file"), self.used_names)
        self.files[file_id] = {"name": name, "path": path, "mime": row["mime"]}
        return name

    # ---- links ----

    def link_for(self, kind: str, target_id: str, info: dict) -> Optional[str]:
        base = self.base_url
        if kind == "task":
            return f"{base}/?task={quote(target_id, safe='')}"
        if kind == "page":
            space = info["space"]
            where = "/me" if space == "me" else f"/p/{quote(space[2:], safe='')}"
            return f"{base}{where}/page/{quote(target_id, safe='')}"
        if kind == "clip":
            project_id, _, name = target_id.partition(":")
            return f"{base}/p/{quote(project_id, safe='')}/review?clip={quote(name, safe='')}"
        return None


class Renderer:
    def __init__(self, ctx: PageContext):
        self.ctx = ctx

    # ---- inline content ----

    def inline(self, element, in_table: bool = False) -> str:
        """The inline content of a text block (text runs with marks, line breaks, chips) as Markdown."""
        items: List[Tuple[str, str, Dict[str, dict]]] = []   # (kind 'text'|'raw', text, marks)
        for child in element.children:
            if isinstance(child, XmlText):
                for run, attrs in child.diff():
                    if isinstance(run, str) and run:
                        items.append(("text", run, _mark_attrs(attrs)))
            elif isinstance(child, XmlElement):
                items.append(("raw", self.inline_node(child, in_table), {}))
        return self._group(items, frozenset(), in_table)

    def inline_node(self, node, in_table: bool) -> str:
        tag, attrs = node.tag, _attrs(node)
        if tag == "hardBreak":
            return "<br>" if in_table else "\\\n"
        if tag == "mention":
            return self.mention(str(attrs.get("kind") or "task"), str(attrs.get("id") or ""), str(attrs.get("label") or ""))
        if tag == "taskChip":
            return self.mention("task", str(attrs.get("taskId") or ""), str(attrs.get("label") or attrs.get("title") or ""))
        if tag == "pageLink":
            return self.mention("page", str(attrs.get("pageId") or ""), str(attrs.get("label") or attrs.get("title") or ""))
        if tag == "summaryInline":
            return escape_text(summary_text(self.ctx.user, attrs))
        # an inline node this exporter does not know: its text content stays
        return escape_text(plain_text(node))

    def mention(self, kind: str, target_id: str, label: str) -> str:
        info = resolve_target(self.ctx.user, kind, target_id) if target_id else None
        title = (info or {}).get("title") or label or "Not available"
        if kind == "person":
            return "@" + escape_text(title)
        href = self.ctx.link_for(kind, target_id, info) if info else None
        text = escape_text(title)
        return f"[{text}]({encode_url(href)})" if href else text

    def _group(self, items, done: frozenset, in_table: bool) -> str:
        """Join runs so that equal marks wrap as many neighbouring runs as possible (correct nesting)."""
        out: List[str] = []
        i = 0
        while i < len(items):
            kind, text, marks = items[i]
            remaining = [m for m in MARK_ORDER if m in marks and m not in done]
            if not remaining:
                out.append(self._leaf(kind, text))
                i += 1
                continue
            mark = remaining[0]
            j = i + 1
            while j < len(items) and items[j][0] == "text" and mark in items[j][2] and \
                    (mark != "link" or items[j][2][mark] == marks[mark]):
                j += 1
            group = items[i:j]
            if mark == "code":
                out.append(self._wrap(mark, marks[mark], "".join(t for _k, t, _m in group)))
            else:
                out.append(self._wrap(mark, marks[mark], self._group(group, done | {mark}, in_table)))
            i = j
        return "".join(out)

    @staticmethod
    def _leaf(kind: str, text: str) -> str:
        return text if kind == "raw" else escape_text(text).replace("\n", "\\\n")

    @staticmethod
    def _wrap(mark: str, attrs: dict, inner: str) -> str:
        if mark == "code":
            longest = max((len(m) for m in re.findall(r"`+", inner)), default=0)
            fence = "`" * (longest + 1)
            pad = " " if inner.startswith("`") or inner.endswith("`") else ""
            return f"{fence}{pad}{inner.replace(chr(10), ' ')}{pad}{fence}"
        if mark == "link":
            href = safe_href(str(attrs.get("href") or ""))
            return f"[{inner}]({encode_url(href)})" if href else inner
        lead = inner[:len(inner) - len(inner.lstrip(" \t"))]
        trail = inner[len(inner.rstrip(" \t")):]
        core = inner.strip(" \t")
        if not core:
            return inner
        if mark == "bold":
            return f"{lead}**{core}**{trail}"
        if mark == "italic":
            return f"{lead}*{core}*{trail}"
        if mark == "strike":
            return f"{lead}~~{core}~~{trail}"
        if mark == "underline":
            return f"{lead}<u>{core}</u>{trail}"
        if mark == "highlight":
            return f"{lead}<mark>{core}</mark>{trail}"
        return inner

    # ---- blocks ----

    def blocks(self, children) -> str:
        parts = [part for part in (self.block(child) for child in children) if part]
        return "\n\n".join(parts)

    def block(self, node) -> str:
        if isinstance(node, XmlText):
            return self._paragraph_text(self._inline_of_text(node))
        if not isinstance(node, XmlElement):
            return ""
        handler = getattr(self, "b_" + node.tag, None)
        if handler:
            return handler(node, _attrs(node))
        return self.unknown(node)

    def _inline_of_text(self, text_node: XmlText) -> str:
        items = [("text", run, _mark_attrs(attrs)) for run, attrs in text_node.diff() if isinstance(run, str) and run]
        return self._group(items, frozenset(), False)

    @staticmethod
    def _paragraph_text(text: str) -> str:
        return "\n".join(_escape_line_start(line) for line in text.split("\n"))

    def unknown(self, node) -> str:
        """A node this exporter does not know: skipped, but its text stays."""
        children = list(node.children)
        if any(isinstance(c, XmlText) or (isinstance(c, XmlElement) and c.tag in INLINE_TAGS) for c in children):
            return self._paragraph_text(self.inline(node))
        return self.blocks(children)

    def b_paragraph(self, node, attrs) -> str:
        return self._paragraph_text(self.inline(node))

    def b_heading(self, node, attrs) -> str:
        try:
            level = min(6, max(1, int(attrs.get("level") or 1)))
        except (TypeError, ValueError):
            level = 1
        return "#" * level + " " + single_line(self.inline(node))

    def b_blockquote(self, node, attrs) -> str:
        inner = self.blocks(node.children)
        return "\n".join(("> " + line).rstrip() for line in inner.split("\n"))

    def b_columns(self, node, attrs) -> str:
        # Side by side on screen, one after the other in the export
        parts = [self.blocks(column.children) for column in node.children if isinstance(column, XmlElement)]
        return "\n\n".join(p for p in parts if p.strip())

    def b_callout(self, node, attrs) -> str:
        kind = ALERTS.get(str(attrs.get("tone") or "info"), "NOTE")
        inner = f"[!{kind}]\n" + self.blocks(node.children)
        return "\n".join(("> " + line).rstrip() for line in inner.split("\n"))

    def b_codeBlock(self, node, attrs) -> str:
        code = "".join(c for child in node.children if isinstance(child, XmlText)
                       for c in (run for run, _a in child.diff() if isinstance(run, str)))
        language = re.sub(r"[^A-Za-z0-9_+.#-]", "", str(attrs.get("language") or ""))
        longest = max((len(m) for m in re.findall(r"`{3,}", code)), default=2)
        fence = "`" * (longest + 1)
        return f"{fence}{language}\n{code}\n{fence}"

    def b_horizontalRule(self, node, attrs) -> str:
        return "---"

    def _list(self, node, marker) -> str:
        items = []
        for index, item in enumerate(c for c in node.children if isinstance(c, XmlElement)):
            prefix = marker(index, item)
            body = self._item_body(item)
            items.append(indent(body, prefix, " " * len(prefix)))
        return "\n".join(items)

    def _item_body(self, item) -> str:
        pieces = []
        for child in item.children:
            text = self.block(child)
            if not text:
                continue
            nested = isinstance(child, XmlElement) and child.tag in ("bulletList", "orderedList", "taskList")
            pieces.append(("\n" if nested and pieces else "\n\n" if pieces else "") + text)
        return "".join(pieces)

    def b_bulletList(self, node, attrs) -> str:
        return self._list(node, lambda i, item: "- ")

    def b_orderedList(self, node, attrs) -> str:
        try:
            start = int(attrs.get("start") or 1)
        except (TypeError, ValueError):
            start = 1
        return self._list(node, lambda i, item: f"{start + i}. ")

    def b_taskList(self, node, attrs) -> str:
        return self._list(node, lambda i, item: "- [x] " if _truthy(_attrs(item).get("checked")) else "- [ ] ")

    def b_image(self, node, attrs) -> str:
        alt = escape_text(str(attrs.get("alt") or ""))
        url = str(attrs.get("src") or "")
        name = self.ctx.attach(url, str(attrs.get("fileId") or ""))
        if name:
            target = "files/" + quote(name)
        elif attrs.get("fileId") or FILE_URL.search(url) or not safe_href(url) or not urlsplit(url).scheme:
            return "*(image not available)*"
        else:
            target = encode_url(url)
        out = f"![{alt}]({target})"
        caption = single_line(str(attrs.get("caption") or ""))
        return out + (f"\n\n*{escape_text(caption)}*" if caption else "")

    def b_file(self, node, attrs) -> str:
        label = str(attrs.get("name") or "File")
        name = self.ctx.attach(str(attrs.get("url") or ""), str(attrs.get("fileId") or ""))
        if not name:
            return f"*(file not available: {escape_text(label)})*"
        return f"[{escape_text(label)}](files/{quote(name)})"

    def b_clipEmbed(self, node, attrs) -> str:
        project_id, base_name = attrs.get("projectId"), attrs.get("baseName")
        if not project_id or not base_name:
            return ""
        target = f"{project_id}:{base_name}"
        info = resolve_target(self.ctx.user, "clip", target)
        if not info:
            return "*(clip not available)*"
        link = self.ctx.link_for("clip", target, info)
        params = ""
        if attrs.get("version") not in (None, ""):
            params += f"&v={quote(str(attrs['version']), safe='')}"
        if attrs.get("frame") not in (None, ""):
            params += f"&frame={quote(str(attrs['frame']), safe='')}"
        return f"[Clip: {escape_text(str(base_name))}]({encode_url(link + params)})"

    def b_viewBlock(self, node, attrs) -> str:
        return view_block_md(self.ctx.user, str(attrs.get("viewId") or ""))

    def b_summary(self, node, attrs) -> str:
        label = str(attrs.get("label") or "").strip() or "Summary"
        return f"{escape_text(label)}: {escape_text(summary_text(self.ctx.user, attrs))}"

    def b_chart(self, node, attrs) -> str:
        return chart_md(self.ctx.user, attrs)

    def b_pageList(self, node, attrs) -> str:
        return page_list_md(self.ctx, attrs)

    # tables (the editor has no table node yet; these keep documents from other sources readable)
    def b_table(self, node, attrs) -> str:
        rows = []
        for row in node.children:
            if isinstance(row, XmlElement):
                rows.append([single_line(" ".join(self.inline(p, True) for p in cell.children if isinstance(p, XmlElement)))
                             .replace("|", "\\|") for cell in row.children if isinstance(cell, XmlElement)])
        return markdown_table(rows[0], rows[1:]) if rows else ""


# ============ Plain text of unknown nodes ============

def plain_text(node) -> str:
    if isinstance(node, XmlText):
        return "".join(run for run, _a in node.diff() if isinstance(run, str))
    if isinstance(node, XmlElement):
        return "".join(plain_text(c) for c in node.children)
    return ""


# ============ Tables, views, summaries, charts, page lists ============

def markdown_table(headers: List[str], rows: List[List[str]]) -> str:
    def cell(text: str) -> str:
        return single_line(text).replace("|", "\\|")
    width = max([len(headers)] + [len(r) for r in rows])
    pad = lambda r: [cell(c) for c in r] + [""] * (width - len(r))
    lines = ["| " + " | ".join(pad(headers)) + " |", "|" + " --- |" * width]
    lines += ["| " + " | ".join(pad(r)) + " |" for r in rows]
    return "\n".join(lines)


def readable_view(user: dict, view_id: str) -> Optional[dict]:
    view = db_get_view(view_id) if view_id else None
    return view if view and _may_view(user, view, False) else None


def view_block_md(user: dict, view_id: str) -> str:
    """A view as a table of its current rows (at most 500), as the exporter sees them; or a note."""
    view = readable_view(user, view_id)
    if not view:
        return NOT_AVAILABLE_VIEW
    config = view.get("config") or {}
    try:
        export = ViewExport(user, view["tableRef"], config.get("query"), config.get("columns"), cap=VIEW_ROW_CAP)
    except (HTTPException, QueryError):
        return NOT_AVAILABLE_VIEW
    rows = [export.texts(row, parent) for row, parent in export.rows]
    out = [f"**{escape_text(view['name'])}**", "", markdown_table([escape_text(h) for h in export.headers()],
                                                                  [[escape_text(c) for c in r] for r in rows])]
    if export.total > len(rows):
        out += ["", f"*Showing the first {len(rows)} of {export.total} rows.*"]
    return "\n".join(out)


def _number_text(value, percent: bool) -> str:
    if value is None:
        return "-"
    if isinstance(value, str):
        return value
    return f"{round(value)}%" if percent else format_number(round(float(value), 2))


def summary_text(user: dict, attrs: dict) -> str:
    """The value a summary block or inline number shows, computed for the exporter ("-" when it has none)."""
    fn, column = str(attrs.get("fn") or "count"), attrs.get("column")
    percent = fn in ("percentChecked", "percentDone")
    view = readable_view(user, str(attrs.get("viewId") or ""))
    if not view:
        return "not available"
    try:
        source = resolve_source(view["tableRef"])
        schema = source.schema(user)
        view_query = (view.get("config") or {}).get("query") or {}
        query = {k: view_query[k] for k in ("filter", "search") if view_query.get(k)}
        if "parentId" in view_query:
            query["parentId"] = view_query["parentId"]
        query["limit"] = 0
        columns = {c["key"]: c for c in schema["columns"]}
        if fn == "count":
            return _number_text(source.query(user, query)["total"], False)
        if fn == "percentDone":
            status = next((c for c in schema["columns"] if c["type"] == "status"), None)
            done = {str(o["value"]) for o in (status or {}).get("options", []) if o.get("done")}
            if status and done:
                result = source.query(user, {**query, "groupBy": status["key"]})
                total = result["total"]
                hit = sum(g["count"] for g in result.get("groups", []) if g["key"] in done)
                return _number_text(100 * hit / total if total else None, True)
            box = next((c for c in schema["columns"] if c["type"] == "checkbox"), None)
            if not box:
                return "-"
            fn, column = "percentChecked", box["key"]
        if column not in columns:
            return "-"
        result = source.query(user, {**query, "summaries": {column: fn}})
        return _number_text((result.get("summaries") or {}).get(column), percent)
    except (HTTPException, QueryError):
        return "not available"


def chart_md(user: dict, attrs: dict) -> str:
    """A chart block as a small table of group and value (count of rows, or a summary of the value column)."""
    view = readable_view(user, str(attrs.get("viewId") or ""))
    if not view:
        return "*(chart not available)*"
    group = attrs.get("groupBy") or attrs.get("group") or attrs.get("xColumn") or attrs.get("category")
    value_col = attrs.get("valueColumn") or attrs.get("yColumn") or attrs.get("column")
    fn = str(attrs.get("fn") or attrs.get("aggregate") or ("sum" if value_col else "count"))
    if not group:
        return "*(chart not available)*"
    try:
        source = resolve_source(view["tableRef"])
        view_query = (view.get("config") or {}).get("query") or {}
        query = {k: view_query[k] for k in ("filter", "search") if view_query.get(k)}
        query.update(groupBy=group, limit=0)
        if attrs.get("bucket"):
            query["groupBucket"] = attrs["bucket"]
        if value_col and fn != "count":
            query["summaries"] = {value_col: fn}
        result = source.query(user, query)
    except (HTTPException, QueryError):
        return "*(chart not available)*"
    rows = []
    for g in result.get("groups", []):
        value = (g.get("summaries") or {}).get(value_col) if value_col and fn != "count" else g["count"]
        rows.append([escape_text(str(g.get("label") or "(empty)")), escape_text(format_number(value) if value is not None else "-")])
    title = str(attrs.get("title") or attrs.get("label") or "Chart")
    return f"**{escape_text(title)}**\n\n" + markdown_table(["Group", "Value"], rows)


def page_list_md(ctx: PageContext, attrs: dict) -> str:
    """The pages a page-list block shows (recent pages the exporter may read) as a bullet list of links."""
    scope = str(attrs.get("scope") or "all")
    try:
        limit = max(1, min(50, int(attrs.get("limit") or 8)))
    except (TypeError, ValueError):
        limit = 8
    user = ctx.user
    if scope == "all":
        project_ids = [p["id"] for p in db_list_accessible_projects(user["id"])
                       if p["id"] in projects and p.get("canTasks", True)]  # pages are part of the Main tab
        pages = db_recent_pages("all", project_ids, user["id"], limit)
    elif scope == "me":
        pages = db_recent_pages("personal", [], user["id"], limit)
    elif scope.startswith("p:") and scope[2:] in projects:
        from api.auth import can_access_space
        pages = db_recent_pages("project", [scope[2:]], user["id"], limit) if can_access_space(user, scope) else []
    else:
        pages = []
    lines = []
    for page in pages:
        href = ctx.link_for("page", page["id"], {"space": space_of(page)})
        lines.append(f"- [{escape_text(page['title'] or 'Untitled')}]({encode_url(href)})")
    return "\n".join(lines)


# ============ Whole pages ============

async def load_document(page_id: str) -> Doc:
    """The stored document of a page, including what a connected editor has typed but not yet saved."""
    room = registry.rooms.get(page_id)
    if room is not None:
        await registry.store(room)   # writes the room's queued updates to page_updates
    snapshot, rows = await asyncio.to_thread(db_load_page_state, page_id)
    doc = Doc()
    for data in ([snapshot] if snapshot else []) + [data for _id, data in rows]:
        try:
            doc.apply_update(data)
        except Exception:
            continue   # a damaged stored update must not make the export fail
    return doc


def page_markdown(ctx: PageContext, doc: Doc) -> str:
    """The page as Markdown: its title as a level-1 heading, then the document."""
    fragment = doc.get(FRAGMENT, type=XmlFragment)
    body = Renderer(ctx).blocks(list(fragment.children))
    title = single_line(escape_text(ctx.page["title"] or "Untitled"))
    return f"# {title}\n\n{body}\n" if body else f"# {title}\n"


def _subpages(page: dict, user: dict) -> List[dict]:
    """The sub-pages (all depths) the user may read, in tree order, each with its `depth` and parent id."""
    rows = db_list_pages(page["spaceType"], project_id=page["projectId"], owner_id=page["ownerId"])
    rows = [r for r in rows if r["kind"] != "task"]
    children: Dict[Optional[str], List[dict]] = {}
    for row in rows:
        children.setdefault(row["parentId"], []).append(row)
    out: List[dict] = []

    def walk(parent_id: str, depth: int) -> None:
        for row in children.get(parent_id, []):
            if len(out) >= MAX_PAGES or depth > MAX_LIST_DEPTH:
                return
            full = db_get_page(row["id"])
            if full and can_read_page(user, full):
                out.append({**full, "depth": depth})
                walk(row["id"], depth + 1)

    walk(page["id"], 1)
    return out


class ExportResult:
    """The outcome of a page export: one Markdown text, or a zip file (a path to a temporary file)."""

    def __init__(self, filename: str, media_type: str, markdown: Optional[str] = None, zip_path: Optional[str] = None):
        self.filename, self.media_type, self.markdown, self.zip_path = filename, media_type, markdown, zip_path


async def export_page(user: dict, page: dict, base_url: str, subpages: bool) -> ExportResult:
    """Markdown for one page, or a zip when the page has files or `subpages` asks for the tree."""
    nodes = [{**page, "depth": 0}] + (_subpages(page, user) if subpages else [])
    # folder of each page inside the zip: the root's own folder is the zip root
    folders: Dict[str, str] = {page["id"]: ""}
    names: Dict[str, str] = {}
    used_by_folder: Dict[str, set] = {}
    rendered = []
    parent_of = {n["id"]: n.get("parentId") for n in nodes}
    for node in nodes:
        parent_folder = folders.get(parent_of[node["id"]], "") if node["id"] != page["id"] else ""
        if node["id"] != page["id"]:
            sibling_names = used_by_folder.setdefault(parent_folder, set())
            slug = unique_name(zip_part(node["title"] or "Untitled"), sibling_names)
            folders[node["id"]] = f"{parent_folder}{slug}/"
        else:
            slug = zip_part(node["title"] or "Untitled")
        names[node["id"]] = slug
        ctx = PageContext(user, base_url, node)
        doc = await load_document(node["id"])
        markdown = page_markdown(ctx, doc)
        rendered.append((node, ctx, markdown))

    has_files = any(ctx.files for _n, ctx, _m in rendered)
    if len(rendered) == 1 and not has_files:
        slug = names[page["id"]]
        return ExportResult(f"{slug}.md", "text/markdown; charset=utf-8", markdown=rendered[0][2])

    handle, path = tempfile.mkstemp(suffix=".zip", prefix="cutline-export-")
    os.close(handle)
    try:
        with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as archive:
            taken = set()
            for node, ctx, markdown in rendered:
                folder = folders[node["id"]]
                entry = f"{folder}{names[node['id']]}.md"
                archive.writestr(_checked_entry(entry, taken), markdown.encode("utf-8"))
                for info in ctx.files.values():
                    archive.write(info["path"], _checked_entry(f"{folder}files/{info['name']}", taken))
    except BaseException:
        os.remove(path)
        raise
    return ExportResult(f"{names[page['id']]}.zip", "application/zip", zip_path=path)


def _checked_entry(entry: str, taken: set) -> str:
    """A zip entry name that stays inside the zip root and is unique."""
    parts = [p for p in entry.split("/") if p not in ("", ".", "..")]
    clean = "/".join(parts)
    if not clean or clean.startswith("/") or ".." in clean.split("/"):
        raise ValueError("unsafe zip entry")
    candidate, n = clean, 1
    while candidate.lower() in taken:
        n += 1
        stem, dot, ext = clean.rpartition(".")
        candidate = f"{stem}-{n}.{ext}" if dot else f"{clean}-{n}"
    taken.add(candidate.lower())
    return candidate
