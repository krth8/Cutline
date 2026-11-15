"""Copy the old Docs (doc_folders, documents) into pages. Used by migration 006 (PLAN.md P7).

Every folder and every document becomes a page in the project's space. The page gets the id of
the folder or document it came from, so the copy needs no mapping table: "was this already
copied?" is "does a page with this id exist?", and an old document id is also the id of its page
(which is what a redirect from an old Docs link needs). Running the copy again adds only what is
missing and changes nothing else.

Document content waits in pages.legacy_html; the first editor who opens the page converts it
into the collaborative document (PLAN.md 5.7). The old tables are left untouched.
"""

from database.engine import execute, fetchall, fetchone, table_exists

DEFAULT_TITLE = "Untitled"


def _rank_key(row):
    return (row["sort_order"] if row["sort_order"] is not None else 0, row["created_at"] or "", row["id"])


def _effective_parents(folders):
    """folder id -> parent folder id, or None for the top. A parent that is missing, in another
    project, or part of a cycle is dropped so the folder lands at the top of its project."""
    by_id = {f["id"]: f for f in folders}
    parents = {}
    for f in folders:
        parent = by_id.get(f["parent_id"])
        parents[f["id"]] = parent["id"] if parent and parent["project_id"] == f["project_id"] else None
    for start in parents:
        seen, current = set(), start
        while current is not None and current not in seen:
            seen.add(current)
            current = parents[current]
        if current is not None:  # walked into a cycle: cut it at this folder
            parents[current] = None
    return parents


def copy_docs_to_pages(conn) -> dict:
    """Create the pages for every folder and document that has none yet. Returns the counts
    {"folders": n, "documents": n} of pages created by this call."""
    created = {"folders": 0, "documents": 0}
    if not (table_exists(conn, "doc_folders") and table_exists(conn, "documents") and table_exists(conn, "pages")):
        return created

    folders = fetchall(execute(
        conn, "SELECT id, project_id, parent_id, name, sort_order, created_at, updated_at FROM doc_folders"))
    documents = fetchall(execute(
        conn, "SELECT id, project_id, folder_id, title, content, created_by, sort_order, created_at, updated_at "
              "FROM documents"))
    existing = {r["id"] for r in fetchall(execute(conn, "SELECT id FROM pages"))}
    parents = _effective_parents(folders)
    folder_project = {f["id"]: f["project_id"] for f in folders}

    # Siblings are ordered like the old tree showed them: folders first, then documents, each
    # group in its old order. The page sort_order is the position in that list.
    children = {}  # (project id, parent folder id or None) -> {"folders": [...], "documents": [...]}
    for f in folders:
        children.setdefault((f["project_id"], parents[f["id"]]), {"folders": [], "documents": []})["folders"].append(f)
    for d in documents:
        folder = d["folder_id"] if folder_project.get(d["folder_id"]) == d["project_id"] else None
        children.setdefault((d["project_id"], folder), {"folders": [], "documents": []})["documents"].append(d)

    # Parents before children, so a page's parent exists when the row is inserted
    def insert(group_key, parent_page_id):
        group = children.get(group_key)
        if not group:
            return
        position = 0
        for f in sorted(group["folders"], key=_rank_key):
            if f["id"] not in existing:
                _insert_page(conn, f["id"], f["project_id"], parent_page_id, f["name"], position, None, None,
                             f["created_at"], f["updated_at"])
                existing.add(f["id"])
                created["folders"] += 1
            position += 1
            insert((f["project_id"], f["id"]), f["id"])
        for d in sorted(group["documents"], key=_rank_key):
            if d["id"] not in existing:
                html = d["content"] if d["content"] and d["content"].strip() else None
                _insert_page(conn, d["id"], d["project_id"], parent_page_id, d["title"], position, html,
                             d["created_by"], d["created_at"], d["updated_at"])
                existing.add(d["id"])
                created["documents"] += 1
            position += 1

    for project_id in sorted({key[0] for key in children}):
        insert((project_id, None), None)
    return created


def _insert_page(conn, page_id, project_id, parent_id, title, sort_order, legacy_html, created_by,
                 created_at, updated_at):
    now_text = created_at or updated_at or ""
    if created_by is not None and not fetchone(execute(conn, "SELECT 1 AS x FROM users WHERE id = ?", (created_by,))):
        created_by = None
    execute(conn, """INSERT INTO pages (id, kind, space_type, project_id, parent_id, title, sort_order,
                                        legacy_html, created_by, created_at, updated_at)
                     VALUES (?, 'page', 'project', ?, ?, ?, ?, ?, ?, ?, ?)""",
            (page_id, project_id, parent_id, title if title and title.strip() else DEFAULT_TITLE,
             float(sort_order), legacy_html, created_by, now_text, updated_at or now_text))


def docs_moved() -> bool:
    """True once migration 006 has run, i.e. the Docs now live in Pages."""
    from database.utils import get_db
    with get_db() as conn:
        if not table_exists(conn, "schema_migrations"):
            return False
        return fetchone(execute(conn, "SELECT 1 AS x FROM schema_migrations WHERE version = ?", ("006",))) is not None
