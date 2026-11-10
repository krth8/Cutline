"""Chat / Lounge routes, chat WebSocket and chat uploads."""

import os
import uuid
from datetime import datetime
from fastapi import (
    APIRouter,
    Depends,
    File,
    HTTPException,
    Query,
    Request,
    UploadFile,
    WebSocket,
    WebSocketDisconnect,
)
from fastapi.responses import FileResponse
from pathlib import Path
from typing import Dict, List, Optional
from database import db_check_project_access, db_get_project
from database.chat import (
    db_create_custom_channel,
    db_create_message,
    db_delete_message,
    db_get_custom_channels,
    db_get_message_reactions,
    db_get_messages,
    db_get_or_create_project_room,
    db_get_room,
    db_get_user_rooms,
    db_mark_as_read,
    db_toggle_reaction,
    db_update_message,
    db_update_presence,
)
from api.auth import (
    can_view_project,
    get_current_user,
    principal_from_token,
    require_auth,
)


router = APIRouter()


# ============ Chat / Lounge API ============

# Chat uploads directory
CHAT_UPLOADS_DIR = os.environ.get("CHAT_UPLOADS_DIR", "chat_uploads")
os.makedirs(CHAT_UPLOADS_DIR, exist_ok=True)


class ChatConnectionManager:
    """Manages WebSocket connections for chat rooms."""

    def __init__(self):
        self.active_connections: Dict[str, Dict[str, WebSocket]] = {}  # room_id -> {user_id -> ws}
        self.user_info: Dict[str, Dict[str, dict]] = {}  # room_id -> {user_id -> info}

    async def connect(self, websocket: WebSocket, room_id: str, user_id: str, user_name: str, user_image: str = None):
        await websocket.accept()
        if room_id not in self.active_connections:
            self.active_connections[room_id] = {}
            self.user_info[room_id] = {}

        self.active_connections[room_id][user_id] = websocket
        self.user_info[room_id][user_id] = {
            "id": user_id,
            "name": user_name,
            "image": user_image,
            "joinedAt": datetime.now().isoformat()
        }

        # Update presence in database
        db_update_presence(user_id, room_id, "online")

    def disconnect(self, room_id: str, user_id: str):
        if room_id in self.active_connections:
            self.active_connections[room_id].pop(user_id, None)
            self.user_info[room_id].pop(user_id, None)
            if not self.active_connections[room_id]:
                del self.active_connections[room_id]
                del self.user_info[room_id]

        # Update presence
        db_update_presence(user_id, None, "offline")

    async def broadcast(self, room_id: str, message: dict, exclude_user: str = None):
        if room_id in self.active_connections:
            for user_id, ws in list(self.active_connections[room_id].items()):
                if user_id != exclude_user:
                    try:
                        await ws.send_json(message)
                    except Exception:
                        self.disconnect(room_id, user_id)

    def get_online_users(self, room_id: str) -> List[dict]:
        if room_id not in self.user_info:
            return []
        return list(self.user_info[room_id].values())


chat_manager = ChatConnectionManager()


@router.get("/api/chat/rooms")
async def get_chat_rooms(user: dict = Depends(require_auth)):
    """Get all chat rooms the user has access to."""
    rooms = db_get_user_rooms(user["id"])
    return {"rooms": rooms}


@router.get("/api/chat/channels")
async def get_custom_channels(user: dict = Depends(require_auth)):
    """Get all custom channels."""
    channels = db_get_custom_channels()
    return {"channels": channels}


@router.post("/api/chat/channels")
async def create_custom_channel(request: Request, user: dict = Depends(require_auth)):
    """Create a new custom channel."""
    data = await request.json()
    name = data.get("name", "").strip()

    if not name:
        raise HTTPException(status_code=400, detail="Channel name is required")

    channel = db_create_custom_channel(name, user["id"], data.get("description"))
    return channel


@router.get("/api/chat/rooms/{room_id}")
async def get_chat_room(room_id: str, user: dict = Depends(require_auth)):
    """Get a specific chat room."""
    room = db_get_room(room_id)
    if not room:
        raise HTTPException(status_code=404, detail="Room not found")

    # Check access via project
    if room.get("projectId"):
        if not db_check_project_access(user["id"], room["projectId"]):
            raise HTTPException(status_code=403, detail="Access denied")

    return room


@router.get("/api/projects/{project_id}/chat")
async def get_project_chat_room(project_id: str, user: dict = Depends(require_auth)):
    """Get or create chat room for a project."""
    if not db_check_project_access(user["id"], project_id):
        raise HTTPException(status_code=403, detail="Access denied")

    project = db_get_project(project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    room = db_get_or_create_project_room(project_id, project["name"])
    return room


@router.get("/api/chat/rooms/{room_id}/messages")
async def get_chat_messages(
    room_id: str,
    limit: int = Query(50, ge=1, le=100),
    before: Optional[str] = Query(None),
    user: dict = Depends(require_auth)
):
    """Get messages for a room with pagination."""
    room = db_get_room(room_id)
    if not room:
        raise HTTPException(status_code=404, detail="Room not found")

    if room.get("projectId"):
        if not db_check_project_access(user["id"], room["projectId"]):
            raise HTTPException(status_code=403, detail="Access denied")

    messages = db_get_messages(room_id, limit, before)
    return {"messages": messages}


@router.post("/api/chat/rooms/{room_id}/messages")
async def send_chat_message(room_id: str, request: Request, user: dict = Depends(require_auth)):
    """Send a message to a room."""
    room = db_get_room(room_id)
    if not room:
        raise HTTPException(status_code=404, detail="Room not found")

    if room.get("projectId"):
        if not db_check_project_access(user["id"], room["projectId"]):
            raise HTTPException(status_code=403, detail="Access denied")

    data = await request.json()
    message = db_create_message(
        room_id=room_id,
        user_id=user["id"],
        text=data.get("text", ""),
        reply_to_id=data.get("replyToId")
    )

    # Broadcast to connected users
    await chat_manager.broadcast(room_id, {
        "type": "message",
        "message": message
    })

    return message


@router.patch("/api/chat/messages/{message_id}")
async def edit_chat_message(message_id: str, request: Request, user: dict = Depends(require_auth)):
    """Edit a message (only by author)."""
    data = await request.json()
    updated = db_update_message(message_id, data.get("text", ""))
    if not updated:
        raise HTTPException(status_code=404, detail="Message not found")

    # Broadcast edit
    room_id = updated.get("roomId")
    if room_id:
        await chat_manager.broadcast(room_id, {
            "type": "message_edited",
            "message": updated
        })

    return updated


@router.delete("/api/chat/messages/{message_id}")
async def delete_chat_message(message_id: str, user: dict = Depends(require_auth)):
    """Delete a message (soft delete)."""
    db_delete_message(message_id)
    return {"success": True}


@router.post("/api/chat/messages/{message_id}/reactions")
async def toggle_message_reaction(message_id: str, request: Request, user: dict = Depends(require_auth)):
    """Toggle a reaction on a message."""
    data = await request.json()
    result = db_toggle_reaction(message_id, user["id"], data.get("emoji", "👍"))

    # Get message to find room
    reactions = db_get_message_reactions(message_id)

    return {"reactions": reactions, "action": result["action"]}


@router.post("/api/chat/rooms/{room_id}/attachments")
async def upload_chat_attachment(
    room_id: str,
    file: UploadFile = File(...),
    user: dict = Depends(require_auth)
):
    """Upload an attachment for a chat message."""
    room = db_get_room(room_id)
    if not room:
        raise HTTPException(status_code=404, detail="Room not found")

    if room.get("projectId"):
        if not db_check_project_access(user["id"], room["projectId"]):
            raise HTTPException(status_code=403, detail="Access denied")

    # Save file
    file_ext = Path(file.filename).suffix.lower()
    file_id = str(uuid.uuid4())[:8]
    filename = f"{file_id}{file_ext}"
    filepath = os.path.join(CHAT_UPLOADS_DIR, filename)

    with open(filepath, "wb") as f:
        content = await file.read()
        f.write(content)

    # Determine file type
    image_exts = {".jpg", ".jpeg", ".png", ".gif", ".webp"}
    video_exts = {".mp4", ".webm", ".mov"}
    file_type = "image" if file_ext in image_exts else "video" if file_ext in video_exts else "file"

    return {
        "filename": filename,
        "originalName": file.filename,
        "fileType": file_type,
        "fileSize": len(content),
        "mimeType": file.content_type
    }


@router.post("/api/chat/rooms/{room_id}/read")
async def mark_messages_read(room_id: str, request: Request, user: dict = Depends(require_auth)):
    """Mark messages as read up to a specific message."""
    data = await request.json()
    db_mark_as_read(user["id"], room_id, data.get("messageId"))
    return {"success": True}


@router.websocket("/ws/chat/{room_id}/{user_id}")
async def chat_websocket_endpoint(
    websocket: WebSocket,
    room_id: str,
    user_id: str,
    name: Optional[str] = Query(None),
    image: Optional[str] = Query(None),
    token: Optional[str] = Query(None)
):
    """WebSocket endpoint for real-time chat."""
    principal = principal_from_token(token)
    room = db_get_room(room_id)
    allowed = (
        principal is not None
        and not principal.get("is_guest")
        and principal["id"] == user_id
        and room is not None
        and (not room.get("projectId") or can_view_project(principal, room["projectId"]))
    )
    if not allowed:
        await websocket.close(code=4403)
        return
    user_name = name or f"User {user_id[:4]}"
    await chat_manager.connect(websocket, room_id, user_id, user_name, image)

    # Send initial state
    await websocket.send_json({
        "type": "init",
        "users": chat_manager.get_online_users(room_id)
    })

    # Notify others
    await chat_manager.broadcast(room_id, {
        "type": "user_joined",
        "user": chat_manager.user_info[room_id].get(user_id, {})
    }, exclude_user=user_id)

    try:
        while True:
            data = await websocket.receive_json()

            if data["type"] == "typing":
                # Broadcast typing indicator
                await chat_manager.broadcast(room_id, {
                    "type": "typing",
                    "userId": user_id,
                    "userName": user_name,
                    "isTyping": data.get("isTyping", False)
                }, exclude_user=user_id)
                db_update_presence(user_id, room_id, "online", data.get("isTyping", False))

            elif data["type"] == "ping":
                await websocket.send_json({"type": "pong"})

            elif data["type"] == "read":
                # Mark as read
                message_id = data.get("messageId")
                if message_id:
                    db_mark_as_read(user_id, room_id, message_id)

    except WebSocketDisconnect:
        chat_manager.disconnect(room_id, user_id)
        await chat_manager.broadcast(room_id, {
            "type": "user_left",
            "userId": user_id
        })


# Serve chat uploads
@router.get("/chat_uploads/{filename}")
async def get_chat_upload(filename: str, token: Optional[str] = Query(None), user: Optional[dict] = Depends(get_current_user)):
    """Serve uploaded chat files to logged-in users (token via header or ?token= for <img> tags)."""
    principal = user or principal_from_token(token)
    if not principal or principal.get("is_guest"):
        raise HTTPException(status_code=401, detail="Authentication required")
    safe_name = Path(filename).name
    if safe_name != filename:
        raise HTTPException(status_code=400, detail="Invalid filename")
    filepath = os.path.join(CHAT_UPLOADS_DIR, safe_name)
    if not os.path.exists(filepath):
        raise HTTPException(status_code=404, detail="File not found")
    return FileResponse(filepath)
