"""
Database Engine Abstraction Layer
Supports both SQLite (local/simple) and PostgreSQL (scaled/production)
"""

import os
from contextlib import contextmanager
from typing import Any, List, Optional
from enum import Enum


class DatabaseType(Enum):
    SQLITE = "sqlite"
    POSTGRESQL = "postgresql"


# Determine database type from environment
DATABASE_URL = os.environ.get("DATABASE_URL", "")

if DATABASE_URL.startswith("postgresql://") or DATABASE_URL.startswith("postgres://"):
    DB_TYPE = DatabaseType.POSTGRESQL
    import psycopg2
    import psycopg2.extras
else:
    DB_TYPE = DatabaseType.SQLITE
    import sqlite3
    DATABASE_FILE = os.environ.get("DB_PATH", "echoplay.db")


# Parameter placeholder for each database
PARAM = "%s" if DB_TYPE == DatabaseType.POSTGRESQL else "?"


def get_param(index: int = None) -> str:
    """Get parameter placeholder. PostgreSQL uses %s, SQLite uses ?"""
    return PARAM


def convert_query(query: str) -> str:
    """Convert query placeholders from ? to %s for PostgreSQL"""
    if DB_TYPE == DatabaseType.POSTGRESQL:
        return query.replace("?", "%s")
    return query


@contextmanager
def get_connection():
    """Get a database connection with proper configuration."""
    if DB_TYPE == DatabaseType.POSTGRESQL:
        conn = psycopg2.connect(DATABASE_URL)
        conn.autocommit = False
        try:
            yield conn
            conn.commit()
        except Exception as e:
            conn.rollback()
            raise e
        finally:
            conn.close()
    else:
        conn = sqlite3.connect(DATABASE_FILE)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA foreign_keys=ON")
        try:
            yield conn
            conn.commit()
        except Exception as e:
            conn.rollback()
            raise e
        finally:
            conn.close()


def execute(conn, query: str, params: tuple = None) -> Any:
    """Execute a query with automatic placeholder conversion."""
    cursor = conn.cursor()
    converted_query = convert_query(query)

    if DB_TYPE == DatabaseType.POSTGRESQL:
        cursor = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)

    if params:
        cursor.execute(converted_query, params)
    else:
        cursor.execute(converted_query)

    return cursor


def insert_ignore(conn, table: str, columns: tuple, values: tuple, conflict_columns: tuple) -> Any:
    """Insert a row, silently skipping it if it already exists (SQLite and PostgreSQL)."""
    cols = ", ".join(columns)
    placeholders = ", ".join("?" for _ in columns)
    if DB_TYPE == DatabaseType.POSTGRESQL:
        query = (f"INSERT INTO {table} ({cols}) VALUES ({placeholders}) "
                 f"ON CONFLICT ({', '.join(conflict_columns)}) DO NOTHING")
    else:
        query = f"INSERT OR IGNORE INTO {table} ({cols}) VALUES ({placeholders})"
    return execute(conn, query, values)


def fetchone(cursor) -> Optional[dict]:
    """Fetch one row as dict."""
    row = cursor.fetchone()
    if row is None:
        return None
    return dict(row)


def fetchall(cursor) -> List[dict]:
    """Fetch all rows as list of dicts."""
    rows = cursor.fetchall()
    return [dict(row) for row in rows]


def get_last_insert_id(cursor, conn) -> int:
    """Get the last inserted row ID."""
    if DB_TYPE == DatabaseType.POSTGRESQL:
        return _get_scalar_value(cursor.fetchone()) if cursor.description else None
    else:
        return cursor.lastrowid


def _get_scalar_value(row):
    """Extract the first scalar value from tuple-like or dict-like rows."""
    if row is None:
        return None

    if isinstance(row, dict):
        return next(iter(row.values()), None)

    try:
        return row[0]
    except (TypeError, KeyError, IndexError):
        if hasattr(row, "keys"):
            keys = list(row.keys())
            if keys:
                return row[keys[0]]
        return None


def table_exists(conn, table_name: str) -> bool:
    """Check if a table exists."""
    if DB_TYPE == DatabaseType.POSTGRESQL:
        cursor = execute(conn, """
            SELECT EXISTS (
                SELECT FROM information_schema.tables
                WHERE table_name = ?
            )
        """, (table_name,))
        return bool(_get_scalar_value(cursor.fetchone()))
    else:
        cursor = execute(conn,
            "SELECT name FROM sqlite_master WHERE type='table' AND name=?",
            (table_name,)
        )
        return cursor.fetchone() is not None


def column_exists(conn, table_name: str, column_name: str) -> bool:
    """Check if a column exists in a table."""
    if DB_TYPE == DatabaseType.POSTGRESQL:
        cursor = execute(conn, """
            SELECT EXISTS (
                SELECT FROM information_schema.columns
                WHERE table_name = ? AND column_name = ?
            )
        """, (table_name, column_name))
        return bool(_get_scalar_value(cursor.fetchone()))
    else:
        cursor = execute(conn, f"PRAGMA table_info({table_name})")
        columns = [row[1] for row in cursor.fetchall()]
        return column_name in columns


def add_column_if_not_exists(conn, table_name: str, column_name: str, column_type: str):
    """Add a column to a table if it doesn't exist."""
    if not column_exists(conn, table_name, column_name):
        execute(conn, f"ALTER TABLE {table_name} ADD COLUMN {column_name} {column_type}")


def execute_optional(conn, query: str, params: tuple = None, context: str = "optional schema operation") -> bool:
    """Run an optional schema statement without aborting the whole PostgreSQL transaction."""
    savepoint_name = "optional_schema_op"
    savepoint_cursor = None

    try:
        if DB_TYPE == DatabaseType.POSTGRESQL:
            savepoint_cursor = conn.cursor()
            savepoint_cursor.execute(f"SAVEPOINT {savepoint_name}")

        execute(conn, query, params)

        if DB_TYPE == DatabaseType.POSTGRESQL and savepoint_cursor:
            savepoint_cursor.execute(f"RELEASE SAVEPOINT {savepoint_name}")

        return True
    except Exception as exc:
        if DB_TYPE == DatabaseType.POSTGRESQL:
            rollback_cursor = conn.cursor()
            rollback_cursor.execute(f"ROLLBACK TO SAVEPOINT {savepoint_name}")
            rollback_cursor.execute(f"RELEASE SAVEPOINT {savepoint_name}")

        print(f"Schema warning ({context}): {exc}")
        return False


def get_schema_type(type_name: str) -> str:
    """Get the correct type for each database."""
    type_map = {
        "AUTO_ID": "SERIAL PRIMARY KEY" if DB_TYPE == DatabaseType.POSTGRESQL else "INTEGER PRIMARY KEY AUTOINCREMENT",
        "TEXT": "TEXT",
        "INTEGER": "INTEGER",
        "BOOLEAN": "BOOLEAN" if DB_TYPE == DatabaseType.POSTGRESQL else "INTEGER",
        "BLOB": "BYTEA" if DB_TYPE == DatabaseType.POSTGRESQL else "BLOB",
        "TIMESTAMP": "TIMESTAMP" if DB_TYPE == DatabaseType.POSTGRESQL else "TEXT",
    }
    return type_map.get(type_name, type_name)


def get_current_timestamp() -> str:
    """Get current timestamp expression for the database."""
    if DB_TYPE == DatabaseType.POSTGRESQL:
        return "NOW()"
    else:
        return "datetime('now')"


def init_schema(conn):
    """Initialize the database schema with proper types for each database."""
    auto_id = get_schema_type("AUTO_ID")
    blob_type = get_schema_type("BLOB")

    # Projects table
    execute(conn, f"""
        CREATE TABLE IF NOT EXISTS projects (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            cover_image TEXT,
            created_at TEXT NOT NULL,
            created_by TEXT
        )
    """)

    # Clips table
    execute(conn, f"""
        CREATE TABLE IF NOT EXISTS clips (
            id {auto_id},
            project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            base_name TEXT NOT NULL,
            active_version INTEGER DEFAULT 1,
            status_id TEXT,
            UNIQUE(project_id, base_name)
        )
    """)

    # Clip versions table
    execute(conn, f"""
        CREATE TABLE IF NOT EXISTS clip_versions (
            id {auto_id},
            clip_id INTEGER NOT NULL REFERENCES clips(id) ON DELETE CASCADE,
            version INTEGER NOT NULL,
            version_str TEXT,
            filename TEXT NOT NULL,
            thumbnail TEXT,
            proxies_json TEXT,
            default_quality TEXT,
            uploaded_at TEXT NOT NULL,
            media_type TEXT DEFAULT 'video',
            UNIQUE(clip_id, version)
        )
    """)

    # Comments table
    execute(conn, f"""
        CREATE TABLE IF NOT EXISTS comments (
            id TEXT PRIMARY KEY,
            project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            frame INTEGER NOT NULL,
            user_id TEXT NOT NULL,
            user_name TEXT,
            text TEXT,
            drawing_json TEXT,
            color TEXT,
            created_at TEXT NOT NULL,
            user_profile_image TEXT,
            client_hash TEXT,
            resolved INTEGER DEFAULT 0,
            parent_id TEXT,
            clip_base_name TEXT,
            clip_version INTEGER
        )
    """)

    # Add columns to existing comments tables (migrations)
    add_column_if_not_exists(conn, "comments", "resolved", "INTEGER DEFAULT 0")
    add_column_if_not_exists(conn, "comments", "parent_id", "TEXT")
    add_column_if_not_exists(conn, "comments", "clip_base_name", "TEXT")
    add_column_if_not_exists(conn, "comments", "clip_version", "INTEGER")
    # Element anchor for comments on HTML clips (selector, hash, click point)
    add_column_if_not_exists(conn, "comments", "anchor_json", "TEXT")

    # Annotations table
    execute(conn, f"""
        CREATE TABLE IF NOT EXISTS annotations (
            id TEXT PRIMARY KEY,
            project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            frame INTEGER NOT NULL,
            user_id TEXT NOT NULL,
            strokes_json TEXT,
            color TEXT,
            created_at TEXT NOT NULL
        )
    """)

    # Share links table
    execute(conn, f"""
        CREATE TABLE IF NOT EXISTS share_links (
            id TEXT PRIMARY KEY,
            project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            password_hash TEXT,
            password_salt TEXT,
            created_at TEXT NOT NULL,
            created_by TEXT,
            expires_at TEXT,
            is_active INTEGER DEFAULT 1,
            access_count INTEGER DEFAULT 0
        )
    """)

    # Users table
    execute(conn, f"""
        CREATE TABLE IF NOT EXISTS users (
            id TEXT PRIMARY KEY,
            username TEXT UNIQUE NOT NULL,
            password_hash TEXT NOT NULL,
            password_salt TEXT,
            is_admin INTEGER DEFAULT 0,
            role TEXT DEFAULT 'editor',
            profile_image TEXT,
            created_at TEXT NOT NULL
        )
    """)

    # Clip statuses table
    execute(conn, f"""
        CREATE TABLE IF NOT EXISTS clip_statuses (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            color TEXT NOT NULL DEFAULT '#6366f1',
            sort_order INTEGER DEFAULT 0,
            created_at TEXT NOT NULL
        )
    """)

    # Invite links table
    execute(conn, f"""
        CREATE TABLE IF NOT EXISTS invite_links (
            id TEXT PRIMARY KEY,
            created_by TEXT NOT NULL REFERENCES users(id),
            is_admin INTEGER DEFAULT 0,
            role TEXT DEFAULT 'viewer',
            project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
            can_review INTEGER DEFAULT 1,
            can_tasks INTEGER DEFAULT 0,
            max_uses INTEGER DEFAULT 1,
            uses INTEGER DEFAULT 0,
            expires_at TEXT,
            created_at TEXT NOT NULL
        )
    """)

    # Task sections table
    execute(conn, f"""
        CREATE TABLE IF NOT EXISTS task_sections (
            id TEXT PRIMARY KEY,
            project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            name TEXT NOT NULL,
            color TEXT DEFAULT '#6366f1',
            sort_order INTEGER DEFAULT 0,
            is_collapsed INTEGER DEFAULT 0,
            created_at TEXT NOT NULL
        )
    """)

    # Section statuses junction table
    execute(conn, f"""
        CREATE TABLE IF NOT EXISTS section_statuses (
            section_id TEXT NOT NULL REFERENCES task_sections(id) ON DELETE CASCADE,
            status_id TEXT NOT NULL REFERENCES clip_statuses(id) ON DELETE CASCADE,
            is_custom INTEGER DEFAULT 0,
            sort_order INTEGER DEFAULT 0,
            PRIMARY KEY (section_id, status_id)
        )
    """)

    # Tasks table
    execute(conn, f"""
        CREATE TABLE IF NOT EXISTS tasks (
            id TEXT PRIMARY KEY,
            project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            parent_id TEXT REFERENCES tasks(id) ON DELETE CASCADE,
            clip_id INTEGER REFERENCES clips(id) ON DELETE SET NULL,
            section_id TEXT REFERENCES task_sections(id) ON DELETE SET NULL,
            stage_tag TEXT,
            name TEXT NOT NULL,
            description TEXT,
            status_id TEXT REFERENCES clip_statuses(id) ON DELETE SET NULL,
            assignee_id TEXT REFERENCES users(id) ON DELETE SET NULL,
            priority TEXT DEFAULT 'medium',
            due_date TEXT,
            custom_fields TEXT,
            sort_order INTEGER DEFAULT 0,
            created_at TEXT NOT NULL,
            created_by TEXT REFERENCES users(id) ON DELETE SET NULL
        )
    """)

    # Add columns for existing task tables created before sections/priorities were introduced.
    add_column_if_not_exists(conn, "tasks", "section_id", "TEXT REFERENCES task_sections(id) ON DELETE SET NULL")
    add_column_if_not_exists(conn, "tasks", "priority", "TEXT DEFAULT 'medium'")

    # Task assignees junction table (for multi-select)
    execute(conn, f"""
        CREATE TABLE IF NOT EXISTS task_assignees (
            task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
            user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            assigned_at TEXT NOT NULL,
            PRIMARY KEY (task_id, user_id)
        )
    """)

    # Task comments table
    execute(conn, f"""
        CREATE TABLE IF NOT EXISTS task_comments (
            id TEXT PRIMARY KEY,
            task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
            user_id TEXT NOT NULL,
            user_name TEXT,
            user_profile_image TEXT,
            text TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT
        )
    """)

    # Task-clip junction table (many-to-many)
    execute(conn, f"""
        CREATE TABLE IF NOT EXISTS task_clips (
            task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
            clip_id INTEGER NOT NULL REFERENCES clips(id) ON DELETE CASCADE,
            linked_at TEXT NOT NULL,
            PRIMARY KEY (task_id, clip_id)
        )
    """)

    # Task checklist items (simple checkboxes within a task)
    execute(conn, f"""
        CREATE TABLE IF NOT EXISTS task_checklist_items (
            id TEXT PRIMARY KEY,
            task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
            text TEXT NOT NULL,
            is_checked INTEGER DEFAULT 0,
            sort_order INTEGER DEFAULT 0,
            created_at TEXT NOT NULL
        )
    """)

    # Guests table
    execute(conn, f"""
        CREATE TABLE IF NOT EXISTS guests (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
            share_link_id TEXT REFERENCES share_links(id) ON DELETE SET NULL,
            first_seen TEXT NOT NULL,
            last_seen TEXT NOT NULL
        )
    """)

    # Notifications table
    execute(conn, f"""
        CREATE TABLE IF NOT EXISTS notifications (
            id TEXT PRIMARY KEY,
            user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            type TEXT NOT NULL,
            title TEXT NOT NULL,
            message TEXT,
            related_project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
            is_read INTEGER DEFAULT 0,
            created_at TEXT NOT NULL
        )
    """)

    # Project access table
    execute(conn, f"""
        CREATE TABLE IF NOT EXISTS project_access (
            id TEXT PRIMARY KEY,
            user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            can_review INTEGER DEFAULT 1,
            can_tasks INTEGER DEFAULT 0,
            is_owner INTEGER DEFAULT 0,
            granted_by TEXT REFERENCES users(id) ON DELETE SET NULL,
            granted_at TEXT NOT NULL,
            UNIQUE(user_id, project_id)
        )
    """)

    # Settings table (global and project-specific)
    execute(conn, f"""
        CREATE TABLE IF NOT EXISTS settings (
            id TEXT PRIMARY KEY,
            scope TEXT NOT NULL DEFAULT 'global',
            scope_id TEXT,
            key TEXT NOT NULL,
            value_json TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            UNIQUE(scope, scope_id, key)
        )
    """)

    # Priority presets table
    execute(conn, f"""
        CREATE TABLE IF NOT EXISTS priority_presets (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            is_builtin INTEGER DEFAULT 0,
            options_json TEXT NOT NULL,
            created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        )
    """)

    # Status presets table (templates for status configurations)
    execute(conn, f"""
        CREATE TABLE IF NOT EXISTS status_presets (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            is_builtin INTEGER DEFAULT 0,
            statuses_json TEXT NOT NULL,
            created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        )
    """)

    # Stage presets table (templates for stage/pipeline configurations)
    execute(conn, f"""
        CREATE TABLE IF NOT EXISTS stage_presets (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            is_builtin INTEGER DEFAULT 0,
            stages_json TEXT NOT NULL,
            created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        )
    """)

    # Document folders table (nested folder structure for docs)
    execute(conn, f"""
        CREATE TABLE IF NOT EXISTS doc_folders (
            id TEXT PRIMARY KEY,
            project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            parent_id TEXT REFERENCES doc_folders(id) ON DELETE CASCADE,
            name TEXT NOT NULL,
            sort_order INTEGER DEFAULT 0,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        )
    """)

    # Documents table (TipTap/Yjs content)
    execute(conn, f"""
        CREATE TABLE IF NOT EXISTS documents (
            id TEXT PRIMARY KEY,
            project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            folder_id TEXT REFERENCES doc_folders(id) ON DELETE SET NULL,
            title TEXT NOT NULL DEFAULT 'Untitled',
            content TEXT,
            yjs_state {blob_type},
            created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
            sort_order INTEGER DEFAULT 0,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        )
    """)

    # Chat rooms table
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

    # Chat messages table
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

    # Chat attachments table
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

    # Chat reactions table
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

    # Chat presence table
    execute(conn, """
        CREATE TABLE IF NOT EXISTS chat_presence (
            user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
            room_id TEXT REFERENCES chat_rooms(id) ON DELETE CASCADE,
            status TEXT DEFAULT 'offline',
            last_seen TEXT NOT NULL,
            is_typing INTEGER DEFAULT 0
        )
    """)

    # Chat read status table
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
        ("idx_clips_project", "clips", "project_id"),
        ("idx_clip_versions_clip", "clip_versions", "clip_id"),
        ("idx_comments_project", "comments", "project_id"),
        ("idx_annotations_project", "annotations", "project_id"),
        ("idx_share_links_project", "share_links", "project_id"),
        ("idx_task_sections_project", "task_sections", "project_id"),
        ("idx_section_statuses_section", "section_statuses", "section_id"),
        ("idx_tasks_project", "tasks", "project_id"),
        ("idx_tasks_parent", "tasks", "parent_id"),
        ("idx_tasks_clip", "tasks", "clip_id"),
        ("idx_tasks_section", "tasks", "section_id"),
        ("idx_tasks_assignee", "tasks", "assignee_id"),
        ("idx_tasks_priority", "tasks", "priority"),
        ("idx_task_assignees_task", "task_assignees", "task_id"),
        ("idx_task_assignees_user", "task_assignees", "user_id"),
        ("idx_task_comments_task", "task_comments", "task_id"),
        ("idx_task_clips_task", "task_clips", "task_id"),
        ("idx_task_clips_clip", "task_clips", "clip_id"),
        ("idx_guests_project", "guests", "project_id"),
        ("idx_notifications_user", "notifications", "user_id"),
        ("idx_project_access_user", "project_access", "user_id"),
        ("idx_project_access_project", "project_access", "project_id"),
        ("idx_settings_scope", "settings", "scope"),
        ("idx_settings_key", "settings", "key"),
        ("idx_doc_folders_project", "doc_folders", "project_id"),
        ("idx_doc_folders_parent", "doc_folders", "parent_id"),
        ("idx_documents_project", "documents", "project_id"),
        ("idx_documents_folder", "documents", "folder_id"),
        ("idx_chat_rooms_project", "chat_rooms", "project_id"),
        ("idx_chat_messages_room", "chat_messages", "room_id"),
        ("idx_chat_messages_user", "chat_messages", "user_id"),
        ("idx_chat_messages_created", "chat_messages", "created_at"),
        ("idx_chat_attachments_message", "chat_attachments", "message_id"),
        ("idx_chat_reactions_message", "chat_reactions", "message_id"),
        ("idx_chat_presence_room", "chat_presence", "room_id"),
    ]

    for idx_name, table, column in indexes:
        execute_optional(
            conn,
            f"CREATE INDEX IF NOT EXISTS {idx_name} ON {table}({column})",
            context=f"create index {idx_name}"
        )

    execute_optional(
        conn,
        "CREATE INDEX IF NOT EXISTS idx_comments_frame ON comments(project_id, frame)",
        context="create index idx_comments_frame"
    )
    execute_optional(
        conn,
        "CREATE INDEX IF NOT EXISTS idx_annotations_frame ON annotations(project_id, frame)",
        context="create index idx_annotations_frame"
    )

    # Performance indexes for Docs and Lounge modules
    execute_optional(
        conn,
        "CREATE INDEX IF NOT EXISTS idx_doc_folders_project_parent ON doc_folders(project_id, parent_id)",
        context="create index idx_doc_folders_project_parent"
    )
    execute_optional(
        conn,
        "CREATE INDEX IF NOT EXISTS idx_documents_project_folder ON documents(project_id, folder_id)",
        context="create index idx_documents_project_folder"
    )
    execute_optional(
        conn,
        "CREATE INDEX IF NOT EXISTS idx_chat_messages_room_created ON chat_messages(room_id, created_at)",
        context="create index idx_chat_messages_room_created"
    )
    execute_optional(
        conn,
        "CREATE INDEX IF NOT EXISTS idx_chat_reactions_message_emoji ON chat_reactions(message_id, emoji)",
        context="create index idx_chat_reactions_message_emoji"
    )

    # Migrations
    add_column_if_not_exists(conn, "clip_versions", "media_type", "TEXT DEFAULT 'video'")

    # Migrate existing assignee_id to task_assignees table
    if DB_TYPE == DatabaseType.POSTGRESQL:
        execute_optional(conn, """
            INSERT INTO task_assignees (task_id, user_id, assigned_at)
            SELECT id, assignee_id, created_at
            FROM tasks
            WHERE assignee_id IS NOT NULL
            ON CONFLICT (task_id, user_id) DO NOTHING
        """, context="migrate assignee_id to task_assignees")
    else:
        execute_optional(conn, """
            INSERT OR IGNORE INTO task_assignees (task_id, user_id, assigned_at)
            SELECT id, assignee_id, created_at
            FROM tasks
            WHERE assignee_id IS NOT NULL
        """, context="migrate assignee_id to task_assignees")


def get_db_info() -> dict:
    """Get information about the current database configuration."""
    if DB_TYPE == DatabaseType.POSTGRESQL:
        url = DATABASE_URL
    else:
        url = f"sqlite:///{DATABASE_FILE}"

    return {
        "type": DB_TYPE.value,
        "url": url,
        "param_style": PARAM
    }


# Print database info on import
_info = get_db_info()
print(f"Database: {_info['type']} ({_info['url']})")
