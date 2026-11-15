"""Files uploaded into pages: database rows (the bytes are stored on disk by api/routes/page_files.py)."""

import uuid
from datetime import datetime
from typing import List, Optional

from .engine import execute, fetchall, fetchone
from .utils import get_db

_COLUMNS = "id, page_id, name, mime, size, is_image, width, height, created_by, created_at"


def _file(row: dict) -> dict:
    return {
        "id": row["id"], "pageId": row["page_id"], "name": row["name"], "mime": row["mime"], "size": row["size"],
        "isImage": bool(row["is_image"]), "width": row["width"], "height": row["height"],
        "createdBy": row["created_by"], "createdAt": row["created_at"],
    }


def new_file_id() -> str:
    return uuid.uuid4().hex


def db_add_page_file(file_id: str, page_id: str, name: str, mime: str, size: int, is_image: bool,
                     width: Optional[int], height: Optional[int], created_by: Optional[str]) -> dict:
    with get_db() as conn:
        execute(conn, f"INSERT INTO page_files ({_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (file_id, page_id, name, mime, size, 1 if is_image else 0, width, height, created_by,
                 datetime.now().isoformat()))
        row = fetchone(execute(conn, f"SELECT {_COLUMNS} FROM page_files WHERE id = ?", (file_id,)))
    return _file(row)


def db_get_page_file(page_id: str, file_id: str) -> Optional[dict]:
    """The file only if it belongs to that page."""
    with get_db() as conn:
        row = fetchone(execute(conn, f"SELECT {_COLUMNS} FROM page_files WHERE id = ? AND page_id = ?",
                               (file_id, page_id)))
    return _file(row) if row else None


def db_page_subtree_ids(page_id: str) -> List[str]:
    """The page and all its sub-pages."""
    sql = """WITH RECURSIVE sub(id) AS (
        SELECT id FROM pages WHERE id = ?
        UNION ALL
        SELECT p.id FROM pages p JOIN sub ON p.parent_id = sub.id
    ) SELECT id FROM sub"""
    with get_db() as conn:
        return [r["id"] for r in fetchall(execute(conn, sql, (page_id,)))]


def db_delete_files_of_pages(page_ids: List[str]) -> None:
    with get_db() as conn:
        for page_id in page_ids:
            execute(conn, "DELETE FROM page_files WHERE page_id = ?", (page_id,))


def db_list_page_files(page_id: str) -> List[dict]:
    """Every file row of a page, oldest first."""
    with get_db() as conn:
        rows = fetchall(execute(conn, f"SELECT {_COLUMNS} FROM page_files WHERE page_id = ? ORDER BY created_at, id",
                                (page_id,)))
    return [_file(r) for r in rows]
