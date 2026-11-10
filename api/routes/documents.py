"""Document/folder routes and the document collaboration WebSocket."""

from fastapi import (
    APIRouter,
    Depends,
    HTTPException,
    Query,
    Request,
    WebSocket,
    WebSocketDisconnect,
)
from typing import Dict, Optional
from database import db_check_project_access
from database.documents import (
    db_create_folder, db_get_folders, db_update_folder, db_delete_folder,
    db_create_document, db_get_documents, db_get_document, db_update_document, db_delete_document,
)
from api.auth import can_view_project, principal_from_token, require_auth


router = APIRouter()


# ============ Documents API ============

@router.get("/api/projects/{project_id}/folders")
async def list_folders(project_id: str, user: dict = Depends(require_auth)):
    """Get all folders for a project."""
    if not db_check_project_access(user["id"], project_id):
        raise HTTPException(status_code=403, detail="Access denied")
    folders = db_get_folders(project_id)
    return {"folders": folders}


@router.post("/api/projects/{project_id}/folders")
async def create_folder(project_id: str, request: Request, user: dict = Depends(require_auth)):
    """Create a new folder."""
    if not db_check_project_access(user["id"], project_id):
        raise HTTPException(status_code=403, detail="Access denied")

    data = await request.json()
    folder = db_create_folder(
        project_id=project_id,
        name=data.get("name", "New Folder"),
        parent_id=data.get("parentId"),
        created_by=user["id"]
    )
    return folder


@router.patch("/api/folders/{folder_id}")
async def update_folder(folder_id: str, request: Request, user: dict = Depends(require_auth)):
    """Update a folder (rename, move)."""
    data = await request.json()
    # Convert camelCase to snake_case
    updates = {}
    if "name" in data:
        updates["name"] = data["name"]
    if "parentId" in data:
        updates["parent_id"] = data["parentId"]
    if "sortOrder" in data:
        updates["sort_order"] = data["sortOrder"]

    folder = db_update_folder(folder_id, updates)
    if not folder:
        raise HTTPException(status_code=404, detail="Folder not found")
    return folder


@router.delete("/api/folders/{folder_id}")
async def delete_folder(folder_id: str, user: dict = Depends(require_auth)):
    """Delete a folder."""
    success = db_delete_folder(folder_id)
    if not success:
        raise HTTPException(status_code=404, detail="Folder not found")
    return {"success": True}


@router.get("/api/projects/{project_id}/documents")
async def list_documents(project_id: str, user: dict = Depends(require_auth)):
    """Get all documents for a project (metadata only)."""
    if not db_check_project_access(user["id"], project_id):
        raise HTTPException(status_code=403, detail="Access denied")
    documents = db_get_documents(project_id)
    return {"documents": documents}


@router.get("/api/projects/{project_id}/docs-tree")
async def get_docs_tree(project_id: str, user: dict = Depends(require_auth)):
    """Get folders and documents in a single call for better performance."""
    if not db_check_project_access(user["id"], project_id):
        raise HTTPException(status_code=403, detail="Access denied")
    folders = db_get_folders(project_id)
    documents = db_get_documents(project_id)
    return {"folders": folders, "documents": documents}


@router.post("/api/projects/{project_id}/documents")
async def create_document(project_id: str, request: Request, user: dict = Depends(require_auth)):
    """Create a new document."""
    if not db_check_project_access(user["id"], project_id):
        raise HTTPException(status_code=403, detail="Access denied")

    data = await request.json()
    doc = db_create_document(
        project_id=project_id,
        title=data.get("title", "Untitled"),
        folder_id=data.get("folderId"),
        created_by=user["id"]
    )
    return doc


@router.get("/api/documents/{doc_id}")
async def get_document(doc_id: str, user: dict = Depends(require_auth)):
    """Get a document with content."""
    doc = db_get_document(doc_id)
    if not doc:
        raise HTTPException(status_code=404, detail="Document not found")

    if not db_check_project_access(user["id"], doc["projectId"]):
        raise HTTPException(status_code=403, detail="Access denied")

    return doc


@router.patch("/api/documents/{doc_id}")
async def update_document(doc_id: str, request: Request, user: dict = Depends(require_auth)):
    """Update a document."""
    doc = db_get_document(doc_id)
    if not doc:
        raise HTTPException(status_code=404, detail="Document not found")

    if not db_check_project_access(user["id"], doc["projectId"], require_tasks=True):
        raise HTTPException(status_code=403, detail="Access denied")

    data = await request.json()
    # Convert camelCase to snake_case
    updates = {}
    if "title" in data:
        updates["title"] = data["title"]
    if "content" in data:
        updates["content"] = data["content"]
    if "folderId" in data:
        updates["folder_id"] = data["folderId"]
    if "sortOrder" in data:
        updates["sort_order"] = data["sortOrder"]

    updated = db_update_document(doc_id, updates)
    return updated


@router.delete("/api/documents/{doc_id}")
async def delete_document(doc_id: str, user: dict = Depends(require_auth)):
    """Delete a document."""
    doc = db_get_document(doc_id)
    if not doc:
        raise HTTPException(status_code=404, detail="Document not found")

    if not db_check_project_access(user["id"], doc["projectId"], require_tasks=True):
        raise HTTPException(status_code=403, detail="Access denied")

    db_delete_document(doc_id)
    return {"success": True}



# ============ Document Collaboration WebSocket ============

class DocConnectionManager:
    """Manages WebSocket connections for document collaboration."""
    def __init__(self):
        self.active_connections: Dict[str, Dict[str, WebSocket]] = {}  # doc_id -> {user_id -> ws}
        self.user_info: Dict[str, Dict[str, dict]] = {}  # doc_id -> {user_id -> {name, color}}
        self.colors = ["#5f5de5", "#e55d5d", "#5de58a", "#e5c35d", "#5dc3e5", "#c35de5", "#e5875d", "#75e55d"]

    async def connect(self, websocket: WebSocket, doc_id: str, user_id: str, user_name: str = None):
        await websocket.accept()
        if doc_id not in self.active_connections:
            self.active_connections[doc_id] = {}
            self.user_info[doc_id] = {}

        self.active_connections[doc_id][user_id] = websocket

        # Assign color based on user count
        color_index = len(self.user_info[doc_id]) % len(self.colors)
        self.user_info[doc_id][user_id] = {
            "name": user_name or f"User {user_id[:4]}",
            "color": self.colors[color_index]
        }

    def disconnect(self, doc_id: str, user_id: str):
        if doc_id in self.active_connections:
            self.active_connections[doc_id].pop(user_id, None)
            self.user_info[doc_id].pop(user_id, None)
            if not self.active_connections[doc_id]:
                del self.active_connections[doc_id]
                del self.user_info[doc_id]

    def get_users(self, doc_id: str) -> list:
        if doc_id not in self.user_info:
            return []
        return [{"id": uid, **info} for uid, info in self.user_info[doc_id].items()]

    async def broadcast(self, doc_id: str, message: dict, exclude_user: str = None):
        if doc_id not in self.active_connections:
            return
        for user_id, ws in list(self.active_connections[doc_id].items()):
            if user_id != exclude_user:
                try:
                    await ws.send_json(message)
                except Exception:
                    self.disconnect(doc_id, user_id)


doc_manager = DocConnectionManager()


@router.websocket("/ws/docs/{doc_id}/{user_id}")
async def doc_websocket_endpoint(
    websocket: WebSocket,
    doc_id: str,
    user_id: str,
    name: Optional[str] = Query(None),
    token: Optional[str] = Query(None)
):
    """WebSocket endpoint for real-time document collaboration."""
    principal = principal_from_token(token)
    doc = db_get_document(doc_id)
    if not principal or principal.get("is_guest") or not doc or not can_view_project(principal, doc.get("projectId")):
        await websocket.close(code=4403)
        return

    await doc_manager.connect(websocket, doc_id, user_id, name)

    # Send initial state to new user
    await websocket.send_json({
        "type": "init",
        "users": doc_manager.get_users(doc_id),
        "content": doc.get("content") if doc else None
    })

    # Notify others about new user
    await doc_manager.broadcast(doc_id, {
        "type": "user_joined",
        "user_id": user_id,
        "user": doc_manager.user_info[doc_id].get(user_id, {})
    }, exclude_user=user_id)

    try:
        while True:
            data = await websocket.receive_json()

            if data["type"] == "cursor":
                # Broadcast cursor position
                await doc_manager.broadcast(doc_id, {
                    "type": "cursor",
                    "user_id": user_id,
                    "position": data.get("position"),
                    "color": doc_manager.user_info[doc_id].get(user_id, {}).get("color", "#5f5de5")
                }, exclude_user=user_id)

            elif data["type"] == "selection":
                # Broadcast text selection
                await doc_manager.broadcast(doc_id, {
                    "type": "selection",
                    "user_id": user_id,
                    "range": data.get("range"),
                    "color": doc_manager.user_info[doc_id].get(user_id, {}).get("color", "#5f5de5")
                }, exclude_user=user_id)

            elif data["type"] == "content_update":
                # Broadcast content update to all other users
                content = data.get("content")
                await doc_manager.broadcast(doc_id, {
                    "type": "content_update",
                    "user_id": user_id,
                    "content": content
                }, exclude_user=user_id)

                # Save to database (debounced on client, so this is safe)
                if content is not None:
                    db_update_document(doc_id, {"content": content})

            elif data["type"] == "title_update":
                # Broadcast title update
                title = data.get("title")
                await doc_manager.broadcast(doc_id, {
                    "type": "title_update",
                    "user_id": user_id,
                    "title": title
                }, exclude_user=user_id)

            elif data["type"] == "pong":
                # Heartbeat response
                pass

    except WebSocketDisconnect:
        doc_manager.disconnect(doc_id, user_id)
        await doc_manager.broadcast(doc_id, {
            "type": "user_left",
            "user_id": user_id
        })
