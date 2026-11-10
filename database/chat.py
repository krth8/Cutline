"""
Chat database operations for the Lounge module
Handles chat rooms, messages, attachments, and reactions
"""

import uuid
from datetime import datetime
from typing import Dict, List, Optional
from .engine import execute, fetchone, fetchall, get_schema_type
from .utils import get_db


def init_chat_tables(conn):
    """Initialize chat-related tables."""
    auto_id = get_schema_type("AUTO_ID")

    # Chat rooms (one per project, or custom rooms)
    execute(conn, """
        CREATE TABLE IF NOT EXISTS chat_rooms (
            id TEXT PRIMARY KEY,
            project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
            name TEXT NOT NULL,
            description TEXT,
            room_type TEXT DEFAULT 'project',
            created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
            created_at TEXT NOT NULL
        )
    """)

    # Chat messages
    execute(conn, """
        CREATE TABLE IF NOT EXISTS chat_messages (
            id TEXT PRIMARY KEY,
            room_id TEXT NOT NULL REFERENCES chat_rooms(id) ON DELETE CASCADE,
            user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            text TEXT,
            reply_to_id TEXT REFERENCES chat_messages(id) ON DELETE SET NULL,
            is_edited INTEGER DEFAULT 0,
            is_deleted INTEGER DEFAULT 0,
            created_at TEXT NOT NULL,
            updated_at TEXT
        )
    """)

    # Message attachments
    execute(conn, """
        CREATE TABLE IF NOT EXISTS chat_attachments (
            id TEXT PRIMARY KEY,
            message_id TEXT NOT NULL REFERENCES chat_messages(id) ON DELETE CASCADE,
            filename TEXT NOT NULL,
            original_name TEXT NOT NULL,
            file_type TEXT NOT NULL,
            file_size INTEGER NOT NULL,
            mime_type TEXT,
            uploaded_at TEXT NOT NULL
        )
    """)

    # Message reactions
    execute(conn, """
        CREATE TABLE IF NOT EXISTS chat_reactions (
            id TEXT PRIMARY KEY,
            message_id TEXT NOT NULL REFERENCES chat_messages(id) ON DELETE CASCADE,
            user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            emoji TEXT NOT NULL,
            created_at TEXT NOT NULL,
            UNIQUE(message_id, user_id, emoji)
        )
    """)

    # User presence/typing status (volatile, could use Redis in prod)
    execute(conn, """
        CREATE TABLE IF NOT EXISTS chat_presence (
            user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
            room_id TEXT REFERENCES chat_rooms(id) ON DELETE CASCADE,
            status TEXT DEFAULT 'offline',
            last_seen TEXT NOT NULL,
            is_typing INTEGER DEFAULT 0
        )
    """)

    # Unread message tracking
    execute(conn, """
        CREATE TABLE IF NOT EXISTS chat_read_status (
            user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            room_id TEXT NOT NULL REFERENCES chat_rooms(id) ON DELETE CASCADE,
            last_read_message_id TEXT REFERENCES chat_messages(id) ON DELETE SET NULL,
            last_read_at TEXT NOT NULL,
            PRIMARY KEY (user_id, room_id)
        )
    """)

    # Create indexes
    indexes = [
        ("idx_chat_rooms_project", "chat_rooms", "project_id"),
        ("idx_chat_messages_room", "chat_messages", "room_id"),
        ("idx_chat_messages_user", "chat_messages", "user_id"),
        ("idx_chat_messages_created", "chat_messages", "created_at"),
        ("idx_chat_attachments_message", "chat_attachments", "message_id"),
        ("idx_chat_reactions_message", "chat_reactions", "message_id"),
        ("idx_chat_presence_room", "chat_presence", "room_id"),
    ]

    for idx_name, table, column in indexes:
        try:
            execute(conn, f"CREATE INDEX IF NOT EXISTS {idx_name} ON {table}({column})")
        except Exception:
            pass


# ============ Rooms ============

def db_get_or_create_project_room(project_id: str, project_name: str) -> dict:
    """Get or create a chat room for a project."""
    with get_db() as conn:
        # Check if room exists
        cursor = execute(conn,
            "SELECT * FROM chat_rooms WHERE project_id = ? AND room_type = 'project'",
            (project_id,)
        )
        row = fetchone(cursor)

        if row:
            return {
                "id": row["id"],
                "projectId": row["project_id"],
                "name": row["name"],
                "description": row["description"],
                "roomType": row["room_type"],
                "createdAt": row["created_at"]
            }

        # Create new room
        room_id = str(uuid.uuid4())
        now = datetime.now().isoformat()

        execute(conn,
            """INSERT INTO chat_rooms (id, project_id, name, description, room_type, created_at)
               VALUES (?, ?, ?, ?, 'project', ?)""",
            (room_id, project_id, f"#{project_name}", f"Chat for {project_name}", now)
        )

        return {
            "id": room_id,
            "projectId": project_id,
            "name": f"#{project_name}",
            "description": f"Chat for {project_name}",
            "roomType": "project",
            "createdAt": now
        }


def db_get_room(room_id: str) -> Optional[dict]:
    """Get a chat room by ID."""
    with get_db() as conn:
        cursor = execute(conn, "SELECT * FROM chat_rooms WHERE id = ?", (room_id,))
        row = fetchone(cursor)

    if not row:
        return None

    return {
        "id": row["id"],
        "projectId": row["project_id"],
        "name": row["name"],
        "description": row["description"],
        "roomType": row["room_type"],
        "createdAt": row["created_at"]
    }


def db_get_user_rooms(user_id: str) -> List[dict]:
    """Get all rooms a user has access to (via project access)."""
    with get_db() as conn:
        cursor = execute(conn, """
            SELECT DISTINCT cr.*, p.name as project_name,
                   (SELECT COUNT(*) FROM chat_messages cm
                    WHERE cm.room_id = cr.id
                    AND cm.created_at > COALESCE(
                        (SELECT last_read_at FROM chat_read_status
                         WHERE user_id = ? AND room_id = cr.id),
                        '1970-01-01'
                    )) as unread_count
            FROM chat_rooms cr
            LEFT JOIN projects p ON cr.project_id = p.id
            LEFT JOIN project_access pa ON p.id = pa.project_id
            WHERE pa.user_id = ? OR cr.created_by = ?
            ORDER BY cr.name
        """, (user_id, user_id, user_id))
        rows = fetchall(cursor)

    return [{
        "id": row["id"],
        "projectId": row["project_id"],
        "name": row["name"],
        "projectName": row["project_name"],
        "description": row["description"],
        "roomType": row["room_type"],
        "unreadCount": row["unread_count"] or 0,
        "createdAt": row["created_at"]
    } for row in rows]


# ============ Messages ============

def db_create_message(room_id: str, user_id: str, text: str, reply_to_id: str = None) -> dict:
    """Create a new chat message."""
    message_id = str(uuid.uuid4())
    now = datetime.now().isoformat()

    with get_db() as conn:
        execute(conn,
            """INSERT INTO chat_messages (id, room_id, user_id, text, reply_to_id, created_at)
               VALUES (?, ?, ?, ?, ?, ?)""",
            (message_id, room_id, user_id, text, reply_to_id, now)
        )

        # Get user info
        cursor = execute(conn, "SELECT username, profile_image FROM users WHERE id = ?", (user_id,))
        user = fetchone(cursor)

    return {
        "id": message_id,
        "roomId": room_id,
        "userId": user_id,
        "userName": user["username"] if user else "Unknown",
        "userImage": user["profile_image"] if user else None,
        "text": text,
        "replyToId": reply_to_id,
        "attachments": [],
        "reactions": [],
        "isEdited": False,
        "isDeleted": False,
        "createdAt": now
    }


def db_get_messages(room_id: str, limit: int = 50, before_id: str = None) -> List[dict]:
    """Get messages for a room with pagination."""
    with get_db() as conn:
        if before_id:
            cursor = execute(conn, """
                SELECT cm.*, u.username, u.profile_image,
                       rm.text as reply_text, ru.username as reply_user_name
                FROM chat_messages cm
                LEFT JOIN users u ON cm.user_id = u.id
                LEFT JOIN chat_messages rm ON cm.reply_to_id = rm.id
                LEFT JOIN users ru ON rm.user_id = ru.id
                WHERE cm.room_id = ? AND cm.created_at < (
                    SELECT created_at FROM chat_messages WHERE id = ?
                )
                ORDER BY cm.created_at DESC
                LIMIT ?
            """, (room_id, before_id, limit))
        else:
            cursor = execute(conn, """
                SELECT cm.*, u.username, u.profile_image,
                       rm.text as reply_text, ru.username as reply_user_name
                FROM chat_messages cm
                LEFT JOIN users u ON cm.user_id = u.id
                LEFT JOIN chat_messages rm ON cm.reply_to_id = rm.id
                LEFT JOIN users ru ON rm.user_id = ru.id
                WHERE cm.room_id = ?
                ORDER BY cm.created_at DESC
                LIMIT ?
            """, (room_id, limit))

        messages = fetchall(cursor)

        # Get attachments and reactions for these messages
        message_ids = [m["id"] for m in messages]
        if message_ids:
            placeholders = ",".join(["?" for _ in message_ids])

            # Attachments
            cursor = execute(conn, f"""
                SELECT * FROM chat_attachments WHERE message_id IN ({placeholders})
            """, tuple(message_ids))
            attachments = fetchall(cursor)
            attachments_by_msg = {}
            for a in attachments:
                if a["message_id"] not in attachments_by_msg:
                    attachments_by_msg[a["message_id"]] = []
                attachments_by_msg[a["message_id"]].append({
                    "id": a["id"],
                    "filename": a["filename"],
                    "originalName": a["original_name"],
                    "fileType": a["file_type"],
                    "fileSize": a["file_size"],
                    "mimeType": a["mime_type"]
                })

            # Reactions
            cursor = execute(conn, f"""
                SELECT cr.*, u.username FROM chat_reactions cr
                LEFT JOIN users u ON cr.user_id = u.id
                WHERE cr.message_id IN ({placeholders})
            """, tuple(message_ids))
            reactions = fetchall(cursor)
            reactions_by_msg = {}
            for r in reactions:
                if r["message_id"] not in reactions_by_msg:
                    reactions_by_msg[r["message_id"]] = []
                reactions_by_msg[r["message_id"]].append({
                    "emoji": r["emoji"],
                    "userId": r["user_id"],
                    "userName": r["username"]
                })
        else:
            attachments_by_msg = {}
            reactions_by_msg = {}

    # Build response (reverse to chronological order)
    result = []
    for m in reversed(messages):
        result.append({
            "id": m["id"],
            "roomId": m["room_id"],
            "userId": m["user_id"],
            "userName": m["username"],
            "userImage": m["profile_image"],
            "text": m["text"] if not m["is_deleted"] else "[Message deleted]",
            "replyToId": m["reply_to_id"],
            "replyText": m["reply_text"][:100] + "..." if m["reply_text"] and len(m["reply_text"]) > 100 else m["reply_text"],
            "replyUserName": m["reply_user_name"],
            "attachments": attachments_by_msg.get(m["id"], []),
            "reactions": reactions_by_msg.get(m["id"], []),
            "isEdited": bool(m["is_edited"]),
            "isDeleted": bool(m["is_deleted"]),
            "createdAt": m["created_at"]
        })

    return result


def db_update_message(message_id: str, text: str) -> Optional[dict]:
    """Update a message text."""
    now = datetime.now().isoformat()

    with get_db() as conn:
        execute(conn,
            "UPDATE chat_messages SET text = ?, is_edited = 1, updated_at = ? WHERE id = ?",
            (text, now, message_id)
        )

        cursor = execute(conn, """
            SELECT cm.*, u.username, u.profile_image
            FROM chat_messages cm
            LEFT JOIN users u ON cm.user_id = u.id
            WHERE cm.id = ?
        """, (message_id,))
        row = fetchone(cursor)

    if not row:
        return None

    return {
        "id": row["id"],
        "roomId": row["room_id"],
        "userId": row["user_id"],
        "userName": row["username"],
        "text": row["text"],
        "isEdited": True,
        "updatedAt": now
    }


def db_delete_message(message_id: str) -> bool:
    """Soft delete a message."""
    with get_db() as conn:
        execute(conn,
            "UPDATE chat_messages SET is_deleted = 1, text = NULL WHERE id = ?",
            (message_id,)
        )
    return True


# ============ Attachments ============

def db_add_attachment(message_id: str, filename: str, original_name: str,
                      file_type: str, file_size: int, mime_type: str) -> dict:
    """Add an attachment to a message."""
    attachment_id = str(uuid.uuid4())
    now = datetime.now().isoformat()

    with get_db() as conn:
        execute(conn,
            """INSERT INTO chat_attachments (id, message_id, filename, original_name, file_type, file_size, mime_type, uploaded_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
            (attachment_id, message_id, filename, original_name, file_type, file_size, mime_type, now)
        )

    return {
        "id": attachment_id,
        "messageId": message_id,
        "filename": filename,
        "originalName": original_name,
        "fileType": file_type,
        "fileSize": file_size,
        "mimeType": mime_type
    }


# ============ Reactions ============

def db_toggle_reaction(message_id: str, user_id: str, emoji: str) -> dict:
    """Toggle a reaction on a message."""
    with get_db() as conn:
        # Check if reaction exists
        cursor = execute(conn,
            "SELECT id FROM chat_reactions WHERE message_id = ? AND user_id = ? AND emoji = ?",
            (message_id, user_id, emoji)
        )
        existing = fetchone(cursor)

        if existing:
            # Remove reaction
            execute(conn, "DELETE FROM chat_reactions WHERE id = ?", (existing["id"],))
            return {"action": "removed", "emoji": emoji, "userId": user_id}
        else:
            # Add reaction
            reaction_id = str(uuid.uuid4())
            now = datetime.now().isoformat()
            execute(conn,
                """INSERT INTO chat_reactions (id, message_id, user_id, emoji, created_at)
                   VALUES (?, ?, ?, ?, ?)""",
                (reaction_id, message_id, user_id, emoji, now)
            )
            return {"action": "added", "emoji": emoji, "userId": user_id}


def db_get_message_reactions(message_id: str) -> List[dict]:
    """Get all reactions for a message, grouped by emoji."""
    with get_db() as conn:
        cursor = execute(conn, """
            SELECT cr.emoji, cr.user_id, u.username
            FROM chat_reactions cr
            LEFT JOIN users u ON cr.user_id = u.id
            WHERE cr.message_id = ?
        """, (message_id,))
        rows = fetchall(cursor)

    # Group by emoji
    grouped = {}
    for r in rows:
        if r["emoji"] not in grouped:
            grouped[r["emoji"]] = {"emoji": r["emoji"], "users": []}
        grouped[r["emoji"]]["users"].append({
            "userId": r["user_id"],
            "userName": r["username"]
        })

    return list(grouped.values())


# ============ Presence ============

def db_update_presence(user_id: str, room_id: str = None, status: str = "online", is_typing: bool = False):
    """Update user presence status."""
    now = datetime.now().isoformat()

    with get_db() as conn:
        execute(conn, """
            INSERT INTO chat_presence (user_id, room_id, status, last_seen, is_typing)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(user_id) DO UPDATE SET
                room_id = excluded.room_id,
                status = excluded.status,
                last_seen = excluded.last_seen,
                is_typing = excluded.is_typing
        """, (user_id, room_id, status, now, 1 if is_typing else 0))


def db_get_room_presence(room_id: str) -> List[dict]:
    """Get presence info for users in a room."""
    with get_db() as conn:
        cursor = execute(conn, """
            SELECT cp.*, u.username, u.profile_image
            FROM chat_presence cp
            LEFT JOIN users u ON cp.user_id = u.id
            WHERE cp.room_id = ? AND cp.status != 'offline'
        """, (room_id,))
        rows = fetchall(cursor)

    return [{
        "userId": r["user_id"],
        "userName": r["username"],
        "userImage": r["profile_image"],
        "status": r["status"],
        "isTyping": bool(r["is_typing"]),
        "lastSeen": r["last_seen"]
    } for r in rows]


# ============ Read Status ============

def db_mark_as_read(user_id: str, room_id: str, message_id: str):
    """Mark messages as read up to a specific message."""
    now = datetime.now().isoformat()

    with get_db() as conn:
        execute(conn, """
            INSERT INTO chat_read_status (user_id, room_id, last_read_message_id, last_read_at)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(user_id, room_id) DO UPDATE SET
                last_read_message_id = excluded.last_read_message_id,
                last_read_at = excluded.last_read_at
        """, (user_id, room_id, message_id, now))


def db_get_unread_count(user_id: str, room_id: str) -> int:
    """Get unread message count for a user in a room."""
    with get_db() as conn:
        cursor = execute(conn, """
            SELECT COUNT(*) as count FROM chat_messages cm
            WHERE cm.room_id = ? AND cm.created_at > COALESCE(
                (SELECT last_read_at FROM chat_read_status
                 WHERE user_id = ? AND room_id = ?),
                '1970-01-01'
            )
        """, (room_id, user_id, room_id))
        row = fetchone(cursor)

    return row["count"] if row else 0


# ============ Custom Channels ============

def db_get_custom_channels() -> List[dict]:
    """Get all custom channels (not project-based)."""
    with get_db() as conn:
        cursor = execute(conn, """
            SELECT * FROM chat_rooms
            WHERE room_type = 'custom'
            ORDER BY name
        """)
        rows = fetchall(cursor)

    return [{
        "id": row["id"],
        "name": row["name"],
        "description": row["description"],
        "roomType": row["room_type"],
        "createdBy": row["created_by"],
        "createdAt": row["created_at"]
    } for row in rows]


def db_create_custom_channel(name: str, user_id: str, description: str = None) -> dict:
    """Create a new custom channel."""
    channel_id = str(uuid.uuid4())
    now = datetime.now().isoformat()

    with get_db() as conn:
        execute(conn, """
            INSERT INTO chat_rooms (id, name, description, room_type, created_by, created_at)
            VALUES (?, ?, ?, 'custom', ?, ?)
        """, (channel_id, name, description or f"Channel for {name}", user_id, now))

    return {
        "id": channel_id,
        "name": name,
        "description": description or f"Channel for {name}",
        "roomType": "custom",
        "createdBy": user_id,
        "createdAt": now
    }
