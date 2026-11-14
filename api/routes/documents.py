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
from fastapi.responses import JSONResponse
from typing import Dict, Optional
from database import db_check_project_access
from database.documents import (
    db_create_folder, db_get_folders, db_update_folder, db_delete_folder,
    db_create_document, db_get_documents, db_get_document, db_update_document, db_delete_document,
    db_save_document_content,
)
from api.auth import can_view_project, principal_from_ticket, require_auth
from api.state import WS_ACCESS_REMOVED, SocketRooms, track_socket, untrack_socket


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

    # Content: saved on top of the version the editor started from ("baseVersion").
    # If someone else saved in between, nothing is written and the editor gets
    # the current content back to merge with (409).
    if "content" in data:
        content = data["content"] if isinstance(data["content"], str) else ""
        base_version = data.get("baseVersion")
        version = db_save_document_content(doc_id, content, base_version if isinstance(base_version, int) else None)
        if version is None:
            current = db_get_document(doc_id)
            return JSONResponse(status_code=409, content={
                "detail": "The document was changed by someone else",
                "content": current["content"], "version": current["version"],
            })
        await doc_manager.broadcast(doc_id, {
            "type": "content_update", "user_id": user["id"], "content": content, "version": version,
        })

    # Convert camelCase to snake_case
    updates = {}
    if "title" in data:
        updates["title"] = data["title"]
    if "folderId" in data:
        updates["folder_id"] = data["folderId"]
    if "sortOrder" in data:
        updates["sort_order"] = data["sortOrder"]

    if updates:
        db_update_document(doc_id, updates)
    return db_get_document(doc_id)


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
    """Who has which document open (a user may have it open in several tabs)."""
    def __init__(self):
        self.sockets = SocketRooms()
        self.user_info: Dict[str, Dict[str, dict]] = {}  # doc_id -> {user_id -> {name, color}}
        self.colors = ["#5f5de5", "#e55d5d", "#5de58a", "#e5c35d", "#5dc3e5", "#c35de5", "#e5875d", "#75e55d"]

    async def connect(self, websocket: WebSocket, doc_id: str, user_id: str, user_name: str = None):
        await websocket.accept()
        if self.sockets.add(doc_id, user_id, websocket):
            users = self.user_info.setdefault(doc_id, {})
            users[user_id] = {
                "name": user_name or f"User {user_id[:4]}",
                "color": self.colors[len(users) % len(self.colors)]
            }

    def disconnect(self, doc_id: str, user_id: str, websocket: WebSocket) -> bool:
        """Returns True if the user has no tab left on the document."""
        if not self.sockets.remove(doc_id, user_id, websocket):
            return False
        self.user_info.get(doc_id, {}).pop(user_id, None)
        if self.sockets.is_empty(doc_id):
            self.user_info.pop(doc_id, None)
        return True

    def get_users(self, doc_id: str) -> list:
        return [{"id": uid, **info} for uid, info in self.user_info.get(doc_id, {}).items()]

    def info(self, doc_id: str, user_id: str) -> dict:
        return self.user_info.get(doc_id, {}).get(user_id, {})

    async def broadcast(self, doc_id: str, message: dict, exclude: WebSocket = None):
        await self.sockets.broadcast(doc_id, message, exclude=exclude)


doc_manager = DocConnectionManager()


@router.websocket("/ws/docs/{doc_id}/{user_id}")
async def doc_websocket_endpoint(
    websocket: WebSocket,
    doc_id: str,
    user_id: str,
    name: Optional[str] = Query(None),
    ticket: Optional[str] = Query(None)
):
    """WebSocket endpoint for real-time document collaboration."""
    principal = principal_from_ticket(ticket)
    doc = db_get_document(doc_id)
    if not principal or principal.get("is_guest") or not doc or not can_view_project(principal, doc.get("projectId")):
        await websocket.close(code=WS_ACCESS_REMOVED)
        return

    # Who this is comes from the token; the id and name in the URL are ignored
    user_id = principal["id"]
    await doc_manager.connect(websocket, doc_id, user_id, principal["username"])
    live_socket = track_socket(principal, websocket, doc.get("projectId"))

    # Send initial state to new user
    await websocket.send_json({
        "type": "init",
        "users": doc_manager.get_users(doc_id),
        "content": doc.get("content"),
        "version": doc.get("version", 0),
    })

    # Notify others about new user
    await doc_manager.broadcast(doc_id, {
        "type": "user_joined",
        "user_id": user_id,
        "user": doc_manager.info(doc_id, user_id)
    }, exclude=websocket)

    try:
        while True:
            data = await websocket.receive_json()

            if data["type"] == "cursor":
                # Broadcast cursor position
                await doc_manager.broadcast(doc_id, {
                    "type": "cursor",
                    "user_id": user_id,
                    "position": data.get("position"),
                    "color": doc_manager.info(doc_id, user_id).get("color", "#5f5de5")
                }, exclude=websocket)

            elif data["type"] == "selection":
                # Broadcast text selection
                await doc_manager.broadcast(doc_id, {
                    "type": "selection",
                    "user_id": user_id,
                    "range": data.get("range"),
                    "color": doc_manager.info(doc_id, user_id).get("color", "#5f5de5")
                }, exclude=websocket)

            elif data["type"] == "content_update":
                # An edit made on top of version `baseVersion`. It is only accepted if
                # that is still the current version; otherwise the editor gets the
                # current content back, merges its change into it and sends again.
                # This is what stops two people from overwriting each other.
                content = data.get("content")
                base_version = data.get("baseVersion")
                if not isinstance(content, str) or not isinstance(base_version, int):
                    continue
                version = db_save_document_content(doc_id, content, base_version)
                if version is None:
                    current = db_get_document(doc_id)
                    if not current:
                        break  # the document was deleted
                    await websocket.send_json({
                        "type": "content_conflict",
                        "content": current["content"],
                        "version": current["version"],
                    })
                    continue
                await websocket.send_json({"type": "content_saved", "version": version})
                await doc_manager.broadcast(doc_id, {
                    "type": "content_update",
                    "user_id": user_id,
                    "content": content,
                    "version": version,
                }, exclude=websocket)

            elif data["type"] == "title_update":
                # Broadcast title update
                title = data.get("title")
                await doc_manager.broadcast(doc_id, {
                    "type": "title_update",
                    "user_id": user_id,
                    "title": title
                }, exclude=websocket)

            elif data["type"] == "pong":
                # Heartbeat response
                pass

    except (WebSocketDisconnect, ValueError, RuntimeError, KeyError):
        pass
    finally:
        untrack_socket(principal, live_socket)
        if doc_manager.disconnect(doc_id, user_id, websocket):
            await doc_manager.broadcast(doc_id, {
                "type": "user_left",
                "user_id": user_id
            })
