"""Deep copies of page trees (H4): the machinery behind "Duplicate", templates and project templates.

A copy is made in two steps so that duplicating a page and using a template are the same code:

1. ``build_bundle`` reads a page tree into a plain dict (the *bundle*): the pages with their Yjs documents,
   the views the pages own, the custom tables that only those pages use (schema only) and the page files.
   A template stores this dict; a duplicate builds it and uses it at once.
2. ``instantiate`` creates new pages from a bundle in a space and re-points everything the content refers to
   to things owned by the new pages (rules below).

Re-pointing rules (``instantiate``):
- A view owned by a copied page is copied (name, layout, config) and owned by the new page; every node
  attribute ``viewId`` (viewBlock, summary, summaryInline, chart, anything else) in the new documents is
  rewritten to the new view id. Views the pages do not own keep their id.
- A view on ``tasks:<source project>`` copied into another project becomes a view on ``tasks:<target>``; custom
  column keys that do not exist in the target are dropped from its config. Into the personal space it becomes
  ``tasks:*`` filtered to ``@me``. A view on ``tasks:*`` copied into a project becomes ``tasks:<target>``.
  Views on other projects' tasks are left alone.
- A custom table whose views are all owned by the copied pages is copied as a new empty table (same columns,
  same column keys, no rows) in the destination space and the copied views point at it. Tables that other
  pages use are not copied: the copied views keep pointing at them (and show the normal no-access state when
  the copy lives where its readers cannot read that table).
- Relation columns of a copied table keep working when their target is valid in the destination (a table copied
  along maps to its copy; a project table may only point at its own project's tasks and tables; a personal
  table at the owner's tables and at tasks of projects the owner can use). Otherwise the column is dropped,
  together with its references in the copied views.
- Images and files are copied on disk and in ``page_files``; ``fileId`` and URLs of the form
  ``/api/pages/<page>/files/<file>`` in node attributes are rewritten to the copies.
- Mentions, clip embeds and page lists are kept as they are.
"""

import asyncio
import base64
import os
import re
import shutil
from typing import Dict, List, Optional

from pycrdt import Doc, XmlElement, XmlFragment

from api.config import UPLOAD_DIR
from api.mentions import extract_refs
from api.pagehistory import replace_content
from api.pagesync import extract_text, registry
from database import db_check_project_access
from database.custom_tables import db_create_custom_table, db_delete_custom_table, db_get_custom_table
from database.mentions import db_replace_page_refs
from database.page_files import db_add_page_file, db_list_page_files, new_file_id
from database.pages import (
    EMPTY_YDOC_BYTES,
    db_create_page,
    db_delete_page,
    db_get_page,
    db_list_pages,
    db_load_page_state,
    db_write_page_snapshot,
    space_of,
)
from database.table_columns import db_create_table_column, db_list_table_columns
from database.views import db_create_view, db_delete_view, db_list_views

FRAGMENT = "default"
PAGES_DIR = os.path.join(UPLOAD_DIR, "pages")
TEMPLATES_DIR = os.path.join(UPLOAD_DIR, "templates")
KEY_PREFIX = "cf_"  # keys of custom columns (api/tables/columns.py)
ME = {"column": "assignees", "op": "in", "value": ["@me"]}
MAX_PAGES = 500  # one copy never creates more pages than this

_FILE_URL = re.compile(r"/api/pages/([^/\s\"'?#]+)/files/([^/\s\"'?#]+)")


# ============ Reading: the bundle ============

async def current_state(page_id: str) -> Optional[bytes]:
    """The encoded document of a page as people see it now: the live room (queued edits flushed first) or,
    with nobody connected, the snapshot plus the pending updates. None when the page has no content."""
    room = registry.rooms.get(page_id)
    if room is not None:
        await registry.store(room)
        state = room.full_state()
    else:
        snapshot, rows = await asyncio.to_thread(db_load_page_state, page_id)
        parts = ([snapshot] if snapshot else []) + [data for _id, data in rows]
        if not parts:
            return None
        doc = Doc()
        for data in parts:
            try:
                doc.apply_update(data)
            except Exception:
                continue  # a damaged stored update does not stop the copy
        state = doc.get_update()
    doc = Doc()
    doc.apply_update(state)
    return state if len(doc.get(FRAGMENT, type=XmlFragment).children) else None


def _descendants(rows: List[dict], root_id: str) -> List[str]:
    """The root and its sub-pages (breadth first, parents before children, siblings in tree order)."""
    children: Dict[Optional[str], List[str]] = {}
    for row in rows:
        if row["kind"] == "page":
            children.setdefault(row["parentId"], []).append(row["id"])
    order, queue = [], [root_id]
    while queue:
        current = queue.pop(0)
        order.append(current)
        queue.extend(children.get(current, []))
    return order


def table_bundle(table_id: str) -> Optional[dict]:
    table = db_get_custom_table(table_id)
    if not table:
        return None
    return {"ref": table_id, "name": table["name"],
            "columns": [{"key": c["key"], "name": c["name"], "type": c["type"], "config": c["config"]}
                        for c in db_list_table_columns(table_id)]}


async def build_bundle(root_ids: List[str], with_subpages: bool = True, extra_tables: tuple = ()) -> dict:
    """Read the pages (and their sub-pages), owned views, own custom tables and file rows into a bundle.

    ``extra_tables``: custom tables that are copied as own tables whatever else uses them (project copy).
    Archived pages and task pages are left out. Raises ValueError for a missing root or too many pages."""
    first = db_get_page(root_ids[0]) if root_ids else None
    if not first:
        raise ValueError("Page not found")
    listing = db_list_pages(first["spaceType"], first["projectId"], first["ownerId"])
    ids: List[str] = []
    for root_id in root_ids:
        ids.extend(_descendants(listing, root_id) if with_subpages else [root_id])
    ids = list(dict.fromkeys(ids))
    if len(ids) > MAX_PAGES:
        raise ValueError(f"A copy can hold at most {MAX_PAGES} pages")
    keys = {pid: str(i) for i, pid in enumerate(ids)}

    pages, views = [], []
    for pid in ids:
        page = db_get_page(pid)
        if not page or page["archivedAt"] or page["kind"] != "page":
            continue
        state = await current_state(pid)
        parent_key = keys.get(page["parentId"]) if pid not in root_ids else None
        files = []
        for f in db_list_page_files(pid):
            path = os.path.join(PAGES_DIR, pid, f["id"])
            if os.path.isfile(path):
                files.append({"id": f["id"], "pageId": pid, "name": f["name"], "mime": f["mime"], "size": f["size"],
                              "isImage": f["isImage"], "width": f["width"], "height": f["height"], "src": path})
        pages.append({"key": keys[pid], "parentKey": parent_key, "title": page["title"], "icon": page["icon"],
                      "system": page["system"], "doc": base64.b64encode(state).decode() if state else None,
                      "files": files})
        for view in sorted(db_list_views(owner_page_id=pid), key=lambda v: (v["createdAt"] or "", v["id"])):
            views.append({"id": view["id"], "pageKey": keys[pid], "tableRef": view["tableRef"],
                          "name": view["name"], "layout": view["layout"], "config": view["config"]})

    copied_pages = set(ids)
    tables, seen = [], set()
    candidates = [v["tableRef"] for v in views if v["tableRef"].startswith("tbl_")] + list(extra_tables)
    for ref in candidates:
        if ref in seen:
            continue
        seen.add(ref)
        forced = ref in extra_tables
        if not forced and any(v["ownerPageId"] not in copied_pages for v in db_list_views(table_ref=ref)):
            continue  # used by other pages too: shared, not copied
        table = table_bundle(ref)
        if table:
            tables.append(table)

    return {"v": 1, "sourceSpace": space_of(first), "sourceProject": first["projectId"], "pages": pages,
            "views": views, "tables": tables}


# ============ Re-pointing views ============

def _strip_filter(node, allowed: set):
    """The filter without conditions on custom columns that are not in ``allowed`` (None when nothing is left)."""
    if not isinstance(node, dict):
        return None
    for op in ("and", "or"):
        if op in node and isinstance(node[op], list):
            kept = [x for x in (_strip_filter(c, allowed) for c in node[op]) if x]
            return {op: kept} if kept else None
    column = node.get("column")
    if isinstance(column, str) and column.startswith(KEY_PREFIX) and column not in allowed:
        return None
    return node


def strip_custom_columns(config: dict, allowed: set) -> dict:
    """A copy of a view config without references to custom task columns that are not in ``allowed``."""
    config = dict(config or {})

    def gone(key) -> bool:
        return isinstance(key, str) and key.startswith(KEY_PREFIX) and key not in allowed

    if isinstance(config.get("columns"), list):
        config["columns"] = [c for c in config["columns"] if not (isinstance(c, dict) and gone(c.get("key")))]
    query = dict(config.get("query") or {})
    if "filter" in query:
        stripped = _strip_filter(query["filter"], allowed)
        if stripped:
            query["filter"] = stripped
        else:
            del query["filter"]
    if isinstance(query.get("sort"), list):
        query["sort"] = [s for s in query["sort"] if not (isinstance(s, dict) and gone(s.get("column")))]
    if gone(query.get("groupBy")):
        del query["groupBy"]
    if isinstance(query.get("summaries"), dict):
        query["summaries"] = {k: v for k, v in query["summaries"].items() if not gone(k)}
    if "query" in config:
        config["query"] = query
    board = config.get("board")
    if isinstance(board, dict):
        board = dict(board)
        if gone(board.get("groupBy")):
            board["groupBy"] = "status"
        if isinstance(board.get("cardColumns"), list):
            board["cardColumns"] = [k for k in board["cardColumns"] if not gone(k)]
        config["board"] = board
    calendar = config.get("calendar")
    if isinstance(calendar, dict):
        calendar = dict(calendar)
        if gone(calendar.get("dateColumn")):
            calendar["dateColumn"] = "dueDate"
        if gone(calendar.get("endColumn")):
            calendar.pop("endColumn", None)
        config["calendar"] = calendar
    gantt = config.get("gantt")
    if isinstance(gantt, dict):
        gantt = dict(gantt)
        if gone(gantt.get("startColumn")):
            gantt["startColumn"] = "startDate"
        if gone(gantt.get("endColumn")):
            gantt["endColumn"] = "dueDate"
        config["gantt"] = gantt
    gallery = config.get("gallery")
    if isinstance(gallery, dict):
        gallery = dict(gallery)
        if isinstance(gallery.get("cardColumns"), list):
            gallery["cardColumns"] = [k for k in gallery["cardColumns"] if not gone(k)]
        if gone(gallery.get("cover")):
            gallery["cover"] = "auto"
        config["gallery"] = gallery
    listing = config.get("list")
    if isinstance(listing, dict) and isinstance(listing.get("secondaryColumns"), list):
        config["list"] = {**listing, "secondaryColumns": [k for k in listing["secondaryColumns"] if not gone(k)]}
    return config


def _with_me_filter(config: dict) -> dict:
    query = dict(config.get("query") or {})
    existing = query.get("filter")
    query["filter"] = {"and": [ME, existing]} if existing else ME
    return {**config, "query": query}


def repoint_view(table_ref: str, config: dict, source_project: Optional[str], dest_project: Optional[str],
                 table_map: Dict[str, str]) -> tuple:
    """(table_ref, config) of the copy of a view; see the rules in the module docstring."""
    if table_ref in table_map:
        return table_map[table_ref], config
    if table_ref == "tasks:*":
        if dest_project is None:
            return table_ref, config
        allowed = {c["key"] for c in db_list_table_columns(f"tasks:{dest_project}")}
        return f"tasks:{dest_project}", strip_custom_columns(config, allowed)
    if table_ref.startswith("tasks:") and source_project and table_ref == f"tasks:{source_project}" \
            and dest_project != source_project:
        if dest_project is None:
            return "tasks:*", _with_me_filter(strip_custom_columns(config, set()))
        allowed = {c["key"] for c in db_list_table_columns(f"tasks:{dest_project}")}
        return f"tasks:{dest_project}", strip_custom_columns(config, allowed)
    return table_ref, config


# ============ Rewriting documents ============

def _rewrite_element(element: XmlElement, view_map: Dict[str, str], file_ids: Dict[tuple, str],
                     page_map: Dict[str, str], own_page: str) -> None:
    for key, value in dict(element.attributes).items():
        new = value
        if key == "viewId" and isinstance(value, str):
            new = view_map.get(value, value)
        elif key == "fileId" and isinstance(value, str):
            new = next((nf for (op, of), nf in file_ids.items() if of == value and page_map.get(op) == own_page), value)
        elif isinstance(value, str) and "/api/pages/" in value:
            def swap(match):
                found = file_ids.get((match.group(1), match.group(2)))
                return f"/api/pages/{page_map[match.group(1)]}/files/{found}" if found else match.group(0)
            new = _FILE_URL.sub(swap, value)
        if new != value:
            element.attributes[key] = new
    for child in element.children:
        if isinstance(child, XmlElement):
            _rewrite_element(child, view_map, file_ids, page_map, own_page)


def rewrite_document(state: bytes, view_map: Dict[str, str], file_ids: Dict[tuple, str],
                     page_map: Dict[str, str], own_page: str) -> Doc:
    """A new Doc with the content of ``state`` (copied through ``replace_content``, so it has its own history)
    and view ids / file ids / file URLs rewritten."""
    doc = Doc()
    replace_content(doc, state)
    for child in doc.get(FRAGMENT, type=XmlFragment).children:
        if isinstance(child, XmlElement):
            _rewrite_element(child, view_map, file_ids, page_map, own_page)
    return doc


# ============ Relation columns ============

def relation_target_for_copy(target, space_type: str, project_id: Optional[str], user: dict,
                             table_map: Dict[str, str], source_project: Optional[str] = None) -> Optional[str]:
    """The target a copied relation column gets in the destination space, or None when it is not valid there
    (the column is then dropped). Tables copied in the same bundle map to their copies; a project table may
    point at its own project's tasks and tables, a personal table at its owner's tables and at tasks of projects
    the owner can use (api/tables/relations.py). ``source_project`` tasks map to the destination project when
    the project copy asks for it."""
    if not isinstance(target, str):
        return None
    if target in table_map:
        return table_map[target]
    if target.startswith("tasks:") and target != "tasks:*":
        pid = target[6:]
        if space_type == "project":
            return target if pid == project_id else None
        return target if db_check_project_access(user["id"], pid, require_tasks=True) else None
    if target.startswith("tbl_"):
        table = db_get_custom_table(target)
        if not table:
            return None
        if space_type == "project":
            return target if table["spaceType"] == "project" and table["projectId"] == project_id else None
        return target if table["spaceType"] == "personal" and table["ownerId"] == user["id"] else None
    return None


# ============ Writing: pages from a bundle ============

def _resolve(src: str) -> str:
    return src if os.path.isabs(src) else os.path.join(UPLOAD_DIR, src)


def instantiate(bundle: dict, user: dict, space_type: str, project_id: Optional[str], parent_id: Optional[str],
                title: Optional[str] = None, sort_order: Optional[float] = None,
                system_pages: Optional[Dict[str, str]] = None) -> dict:
    """Create the pages of a bundle in a space under ``parent_id`` (top level when None).

    ``title`` replaces the title of the first root page, ``sort_order`` places it. ``system_pages`` maps a system
    key ('tasks') to an existing page of the destination that takes the place of the bundle's page with that
    key (its owned views are replaced); without it such a page is copied as an ordinary page.
    Returns {"pageIds": [...], "rootIds": [...], "idMap": {key: id}}. Raises ValueError (nothing is left behind)
    for a bad parent."""
    owner_id = user["id"] if space_type == "personal" else None
    system_pages = system_pages or {}
    id_map: Dict[str, str] = {}
    created_pages: List[str] = []
    created_tables: List[str] = []
    created_folders: List[str] = []
    root_ids: List[str] = []
    try:
        # custom tables (schema only)
        table_map: Dict[str, str] = {}
        for table in bundle.get("tables", []):
            new = db_create_custom_table(table["name"], space_type, project_id, owner_id, user["id"])
            created_tables.append(new["id"])
            table_map[table["ref"]] = new["id"]
        dropped: Dict[str, set] = {}  # new table -> keys of relation columns that are not valid here
        for table in bundle.get("tables", []):
            new_ref = table_map[table["ref"]]
            for column in table["columns"]:
                config = column.get("config") or {}
                if column["type"] == "relation":
                    target = relation_target_for_copy(config.get("target"), space_type, project_id, user, table_map)
                    if target is None:
                        dropped.setdefault(new_ref, set()).add(column["key"])
                        continue
                    config = {**config, "target": target}
                db_create_table_column(new_ref, column["key"], column["name"], column["type"], config, user["id"])

        # pages, parents first
        first_root = True
        reused = set()
        for page in bundle["pages"]:
            existing = system_pages.get(page["system"]) if page.get("system") else None
            if existing:
                id_map[page["key"]] = existing
                reused.add(page["key"])
                continue
            is_root = page["parentKey"] is None or page["parentKey"] not in id_map
            parent = parent_id if is_root else id_map[page["parentKey"]]
            made = db_create_page(space_type, project_id, owner_id, user["id"],
                                  title=(title if first_root and title else page["title"]) or "Untitled",
                                  parent_id=parent, icon=page["icon"],
                                  sort_order=sort_order if (first_root and is_root) else None)
            if is_root:
                first_root = False
                root_ids.append(made["id"])
            id_map[page["key"]] = made["id"]
            created_pages.append(made["id"])
        if not root_ids:
            root_ids = [id_map[p["key"]] for p in bundle["pages"] if p["parentKey"] is None and p["key"] in id_map][:1]

        # views
        for key in reused:
            for old in db_list_views(owner_page_id=id_map[key]):
                db_delete_view(old["id"])
        view_map: Dict[str, str] = {}
        for view in bundle.get("views", []):
            ref, config = repoint_view(view["tableRef"], view["config"], bundle.get("sourceProject"), project_id,
                                       table_map)
            if dropped.get(ref):
                kept = {c["key"] for c in db_list_table_columns(ref)}
                config = strip_custom_columns(config, kept)
            new_view = db_create_view(ref, view["name"], view["layout"], config, id_map[view["pageKey"]], user["id"])
            view_map[view["id"]] = new_view["id"]

        # files
        page_map = {p["files"][0]["pageId"]: id_map[p["key"]] for p in bundle["pages"] if p["files"]}
        file_ids: Dict[tuple, str] = {}
        for page in bundle["pages"]:
            new_page = id_map[page["key"]]
            for f in page["files"]:
                source = _resolve(f["src"])
                if not os.path.isfile(source):
                    continue
                folder = os.path.join(PAGES_DIR, new_page)
                os.makedirs(folder, exist_ok=True)
                if folder not in created_folders:
                    created_folders.append(folder)
                new_id = new_file_id()
                shutil.copyfile(source, os.path.join(folder, new_id))
                db_add_page_file(new_id, new_page, f["name"], f["mime"], f["size"], f["isImage"], f["width"],
                                 f["height"], user["id"])
                file_ids[(f["pageId"], f["id"])] = new_id

        # documents
        for page in bundle["pages"]:
            if not page.get("doc"):
                continue
            new_page = id_map[page["key"]]
            doc = rewrite_document(base64.b64decode(page["doc"]), view_map, file_ids, page_map, new_page)
            state = doc.get_update()
            if len(state) <= EMPTY_YDOC_BYTES:
                continue
            db_write_page_snapshot(new_page, state, extract_text(doc), 0)
            db_replace_page_refs(new_page, extract_refs(doc))  # backlinks; no mention notifications for a copy
    except Exception:
        for page_id in root_ids:
            db_delete_page(page_id)
        for page_id in created_pages:
            db_delete_page(page_id)
        for table_id in created_tables:
            db_delete_custom_table(table_id)
        for folder in created_folders:
            shutil.rmtree(folder, ignore_errors=True)
        raise
    return {"pageIds": [id_map[p["key"]] for p in bundle["pages"] if p["key"] in id_map],
            "rootIds": root_ids, "idMap": id_map, "tableMap": table_map}


# ============ Templates: storing a bundle ============

def freeze_bundle(bundle: dict, template_id: str) -> dict:
    """The bundle with its files copied into UPLOAD_DIR/templates/<id> and ``src`` made relative to UPLOAD_DIR,
    so later edits or deletion of the source pages cannot change it."""
    folder = os.path.join(TEMPLATES_DIR, template_id)
    os.makedirs(folder, exist_ok=True)
    try:
        for page in bundle["pages"]:
            for f in page["files"]:
                shutil.copyfile(_resolve(f["src"]), os.path.join(folder, f["id"]))
                f["src"] = f"templates/{template_id}/{f['id']}"
    except Exception:
        shutil.rmtree(folder, ignore_errors=True)
        raise
    return bundle


def delete_template_files(template_id: str) -> None:
    shutil.rmtree(os.path.join(TEMPLATES_DIR, template_id), ignore_errors=True)
