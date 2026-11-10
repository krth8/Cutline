"""
Document database operations for the Docs module
Handles documents and folders with nested structure
"""

import uuid
from datetime import datetime
from typing import Dict, List, Optional
from .engine import execute, fetchone, fetchall
from .utils import get_db


# ============ Folders ============

def db_create_folder(project_id: str, name: str, parent_id: str = None, created_by: str = None) -> dict:
    """Create a new folder."""
    folder_id = str(uuid.uuid4())
    now = datetime.now().isoformat()

    # Get max sort_order for siblings
    with get_db() as conn:
        if parent_id:
            cursor = execute(conn,
                "SELECT COALESCE(MAX(sort_order), -1) + 1 AS next_order FROM doc_folders WHERE project_id = ? AND parent_id = ?",
                (project_id, parent_id)
            )
        else:
            cursor = execute(conn,
                "SELECT COALESCE(MAX(sort_order), -1) + 1 AS next_order FROM doc_folders WHERE project_id = ? AND parent_id IS NULL",
                (project_id,)
            )
        row = fetchone(cursor)
        sort_order = row["next_order"] if row else 0

        execute(conn,
            """INSERT INTO doc_folders (id, project_id, parent_id, name, sort_order, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?)""",
            (folder_id, project_id, parent_id, name, sort_order, now, now)
        )

    return {
        "id": folder_id,
        "projectId": project_id,
        "parentId": parent_id,
        "name": name,
        "sortOrder": sort_order,
        "createdAt": now,
        "updatedAt": now
    }


def db_get_folders(project_id: str) -> List[dict]:
    """Get all folders for a project (flat list, client builds tree)."""
    with get_db() as conn:
        cursor = execute(conn,
            """SELECT id, project_id, parent_id, name, sort_order, created_at, updated_at
               FROM doc_folders WHERE project_id = ? ORDER BY sort_order""",
            (project_id,)
        )
        rows = fetchall(cursor)

    return [{
        "id": row["id"],
        "projectId": row["project_id"],
        "parentId": row["parent_id"],
        "name": row["name"],
        "sortOrder": row["sort_order"],
        "createdAt": row["created_at"],
        "updatedAt": row["updated_at"]
    } for row in rows]


def db_update_folder(folder_id: str, updates: dict) -> Optional[dict]:
    """Update a folder (name, parent_id, sort_order)."""
    allowed = {"name", "parent_id", "sort_order"}
    filtered = {k: v for k, v in updates.items() if k in allowed}

    if not filtered:
        return None

    filtered["updated_at"] = datetime.now().isoformat()

    set_clause = ", ".join(f"{k} = ?" for k in filtered.keys())
    values = list(filtered.values()) + [folder_id]

    with get_db() as conn:
        execute(conn, f"UPDATE doc_folders SET {set_clause} WHERE id = ?", values)
        cursor = execute(conn, "SELECT * FROM doc_folders WHERE id = ?", (folder_id,))
        row = fetchone(cursor)

    if not row:
        return None

    return {
        "id": row["id"],
        "projectId": row["project_id"],
        "parentId": row["parent_id"],
        "name": row["name"],
        "sortOrder": row["sort_order"],
        "createdAt": row["created_at"],
        "updatedAt": row["updated_at"]
    }


def db_delete_folder(folder_id: str) -> bool:
    """Delete a folder (cascades to subfolders and moves docs to parent)."""
    with get_db() as conn:
        # Get folder info
        cursor = execute(conn, "SELECT parent_id FROM doc_folders WHERE id = ?", (folder_id,))
        row = fetchone(cursor)
        if not row:
            return False
        parent_id = row["parent_id"]

        # Move documents in this folder to parent folder
        execute(conn, "UPDATE documents SET folder_id = ? WHERE folder_id = ?", (parent_id, folder_id))

        # Delete folder (subfolders cascade)
        execute(conn, "DELETE FROM doc_folders WHERE id = ?", (folder_id,))

    return True


# ============ Documents ============

def db_create_document(project_id: str, title: str = "Untitled", folder_id: str = None, created_by: str = None) -> dict:
    """Create a new document."""
    doc_id = str(uuid.uuid4())
    now = datetime.now().isoformat()

    # Get max sort_order for siblings
    with get_db() as conn:
        if folder_id:
            cursor = execute(conn,
                "SELECT COALESCE(MAX(sort_order), -1) + 1 AS next_order FROM documents WHERE project_id = ? AND folder_id = ?",
                (project_id, folder_id)
            )
        else:
            cursor = execute(conn,
                "SELECT COALESCE(MAX(sort_order), -1) + 1 AS next_order FROM documents WHERE project_id = ? AND folder_id IS NULL",
                (project_id,)
            )
        row = fetchone(cursor)
        sort_order = row["next_order"] if row else 0

        execute(conn,
            """INSERT INTO documents (id, project_id, folder_id, title, content, created_by, sort_order, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (doc_id, project_id, folder_id, title, None, created_by, sort_order, now, now)
        )

    return {
        "id": doc_id,
        "projectId": project_id,
        "folderId": folder_id,
        "title": title,
        "content": None,
        "createdBy": created_by,
        "sortOrder": sort_order,
        "createdAt": now,
        "updatedAt": now
    }


def db_get_documents(project_id: str) -> List[dict]:
    """Get all documents for a project (metadata only, no content)."""
    with get_db() as conn:
        cursor = execute(conn,
            """SELECT id, project_id, folder_id, title, created_by, sort_order, created_at, updated_at
               FROM documents WHERE project_id = ? ORDER BY sort_order""",
            (project_id,)
        )
        rows = fetchall(cursor)

    return [{
        "id": row["id"],
        "projectId": row["project_id"],
        "folderId": row["folder_id"],
        "title": row["title"],
        "createdBy": row["created_by"],
        "sortOrder": row["sort_order"],
        "createdAt": row["created_at"],
        "updatedAt": row["updated_at"]
    } for row in rows]


def db_get_document(doc_id: str) -> Optional[dict]:
    """Get a single document with content."""
    with get_db() as conn:
        cursor = execute(conn,
            """SELECT id, project_id, folder_id, title, content, yjs_state, created_by, sort_order, created_at, updated_at
               FROM documents WHERE id = ?""",
            (doc_id,)
        )
        row = fetchone(cursor)

    if not row:
        return None

    return {
        "id": row["id"],
        "projectId": row["project_id"],
        "folderId": row["folder_id"],
        "title": row["title"],
        "content": row["content"],
        "yjsState": row["yjs_state"],
        "createdBy": row["created_by"],
        "sortOrder": row["sort_order"],
        "createdAt": row["created_at"],
        "updatedAt": row["updated_at"]
    }


def db_update_document(doc_id: str, updates: dict) -> Optional[dict]:
    """Update a document."""
    allowed = {"title", "content", "yjs_state", "folder_id", "sort_order"}
    filtered = {k: v for k, v in updates.items() if k in allowed}

    if not filtered:
        return None

    filtered["updated_at"] = datetime.now().isoformat()

    set_clause = ", ".join(f"{k} = ?" for k in filtered.keys())
    values = list(filtered.values()) + [doc_id]

    with get_db() as conn:
        execute(conn, f"UPDATE documents SET {set_clause} WHERE id = ?", values)
        cursor = execute(conn,
            """SELECT id, project_id, folder_id, title, content, created_by, sort_order, created_at, updated_at
               FROM documents WHERE id = ?""",
            (doc_id,)
        )
        row = fetchone(cursor)

    if not row:
        return None

    return {
        "id": row["id"],
        "projectId": row["project_id"],
        "folderId": row["folder_id"],
        "title": row["title"],
        "content": row["content"],
        "createdBy": row["created_by"],
        "sortOrder": row["sort_order"],
        "createdAt": row["created_at"],
        "updatedAt": row["updated_at"]
    }


def db_update_document_yjs(doc_id: str, yjs_state: bytes) -> bool:
    """Update only the Yjs state (binary) for collaboration."""
    now = datetime.now().isoformat()
    with get_db() as conn:
        execute(conn,
            "UPDATE documents SET yjs_state = ?, updated_at = ? WHERE id = ?",
            (yjs_state, now, doc_id)
        )
    return True


def db_get_document_yjs(doc_id: str) -> Optional[bytes]:
    """Get Yjs state for a document."""
    with get_db() as conn:
        cursor = execute(conn, "SELECT yjs_state FROM documents WHERE id = ?", (doc_id,))
        row = fetchone(cursor)

    if not row:
        return None
    return row["yjs_state"]


def db_delete_document(doc_id: str) -> bool:
    """Delete a document."""
    with get_db() as conn:
        cursor = execute(conn, "SELECT id FROM documents WHERE id = ?", (doc_id,))
        if not fetchone(cursor):
            return False
        execute(conn, "DELETE FROM documents WHERE id = ?", (doc_id,))
    return True
