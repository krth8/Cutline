"""
Settings and Presets database operations
Handles global settings, project settings, and priority/status presets
"""

import json
import uuid
from datetime import datetime
from typing import Dict, List, Optional, Any
from .engine import execute, fetchone, fetchall
from .utils import get_db


# ============ Settings CRUD ============

def db_get_setting(key: str, scope: str = 'global', scope_id: str = None) -> Optional[Any]:
    """Get a setting value by key and scope."""
    with get_db() as conn:
        if scope_id:
            cursor = execute(conn,
                "SELECT value_json FROM settings WHERE key = ? AND scope = ? AND scope_id = ?",
                (key, scope, scope_id)
            )
        else:
            cursor = execute(conn,
                "SELECT value_json FROM settings WHERE key = ? AND scope = ? AND scope_id IS NULL",
                (key, scope)
            )
        row = fetchone(cursor)
        if row and row.get('value_json'):
            return json.loads(row['value_json'])
        return None


def db_set_setting(key: str, value: Any, scope: str = 'global', scope_id: str = None) -> dict:
    """Set a setting value. Creates or updates."""
    now = datetime.now().isoformat()
    value_json = json.dumps(value) if value is not None else None

    with get_db() as conn:
        # Check if exists
        if scope_id:
            cursor = execute(conn,
                "SELECT id FROM settings WHERE key = ? AND scope = ? AND scope_id = ?",
                (key, scope, scope_id)
            )
        else:
            cursor = execute(conn,
                "SELECT id FROM settings WHERE key = ? AND scope = ? AND scope_id IS NULL",
                (key, scope)
            )
        existing = fetchone(cursor)

        if existing:
            # Update
            execute(conn,
                "UPDATE settings SET value_json = ?, updated_at = ? WHERE id = ?",
                (value_json, now, existing['id'])
            )
            return {'id': existing['id'], 'key': key, 'value': value, 'updated': True}
        else:
            # Insert
            setting_id = str(uuid.uuid4())
            execute(conn,
                """INSERT INTO settings (id, scope, scope_id, key, value_json, created_at, updated_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?)""",
                (setting_id, scope, scope_id, key, value_json, now, now)
            )
            return {'id': setting_id, 'key': key, 'value': value, 'created': True}


def db_delete_setting(key: str, scope: str = 'global', scope_id: str = None) -> bool:
    """Delete a setting."""
    with get_db() as conn:
        if scope_id:
            cursor = execute(conn,
                "DELETE FROM settings WHERE key = ? AND scope = ? AND scope_id = ?",
                (key, scope, scope_id)
            )
        else:
            cursor = execute(conn,
                "DELETE FROM settings WHERE key = ? AND scope = ? AND scope_id IS NULL",
                (key, scope)
            )
        return cursor.rowcount > 0


def db_list_settings(scope: str = 'global', scope_id: str = None) -> Dict[str, Any]:
    """List all settings for a scope as a dict."""
    with get_db() as conn:
        if scope_id:
            cursor = execute(conn,
                "SELECT key, value_json FROM settings WHERE scope = ? AND scope_id = ?",
                (scope, scope_id)
            )
        else:
            cursor = execute(conn,
                "SELECT key, value_json FROM settings WHERE scope = ? AND scope_id IS NULL",
                (scope,)
            )
        result = {}
        for row in fetchall(cursor):
            value = json.loads(row['value_json']) if row.get('value_json') else None
            result[row['key']] = value
        return result


def db_get_effective_setting(key: str, project_id: str = None) -> Any:
    """Get effective setting value with fallback: project -> global -> None."""
    # Try project-specific first
    if project_id:
        value = db_get_setting(key, scope='project', scope_id=project_id)
        if value is not None:
            return value

    # Fall back to global
    return db_get_setting(key, scope='global')


# ============ Priority Presets ============

BUILTIN_PRIORITY_PRESETS = {
    'default': {
        'name': 'Standard',
        'options': [
            {'id': 'low', 'label': 'Low', 'color': '#6b7280', 'sortOrder': 1},
            {'id': 'medium', 'label': 'Medium', 'color': '#f59e0b', 'sortOrder': 2},
            {'id': 'high', 'label': 'High', 'color': '#ef4444', 'sortOrder': 3}
        ]
    },
    'urgency': {
        'name': 'Urgency',
        'options': [
            {'id': 'none', 'label': 'None', 'color': '#6b7280', 'sortOrder': 1},
            {'id': 'normal', 'label': 'Normal', 'color': '#3b82f6', 'sortOrder': 2},
            {'id': 'urgent', 'label': 'Urgent', 'color': '#f59e0b', 'sortOrder': 3},
            {'id': 'critical', 'label': 'Critical', 'color': '#ef4444', 'sortOrder': 4}
        ]
    },
    'numbered': {
        'name': 'P1-P4',
        'options': [
            {'id': 'p4', 'label': 'P4', 'color': '#6b7280', 'sortOrder': 1},
            {'id': 'p3', 'label': 'P3', 'color': '#3b82f6', 'sortOrder': 2},
            {'id': 'p2', 'label': 'P2', 'color': '#f59e0b', 'sortOrder': 3},
            {'id': 'p1', 'label': 'P1', 'color': '#ef4444', 'sortOrder': 4}
        ]
    }
}


def db_init_builtin_priority_presets():
    """Initialize built-in priority presets if they don't exist."""
    now = datetime.now().isoformat()
    with get_db() as conn:
        for preset_id, preset_data in BUILTIN_PRIORITY_PRESETS.items():
            cursor = execute(conn,
                "SELECT id FROM priority_presets WHERE id = ?",
                (preset_id,)
            )
            if not fetchone(cursor):
                execute(conn,
                    """INSERT INTO priority_presets (id, name, is_builtin, options_json, created_at, updated_at)
                       VALUES (?, ?, 1, ?, ?, ?)""",
                    (preset_id, preset_data['name'], json.dumps(preset_data['options']), now, now)
                )


def db_list_priority_presets() -> List[dict]:
    """List all priority presets."""
    with get_db() as conn:
        cursor = execute(conn,
            "SELECT * FROM priority_presets ORDER BY is_builtin DESC, name ASC"
        )
        result = []
        for row in fetchall(cursor):
            result.append({
                'id': row['id'],
                'name': row['name'],
                'isBuiltin': bool(row['is_builtin']),
                'options': json.loads(row['options_json']) if row.get('options_json') else [],
                'createdBy': row.get('created_by'),
                'createdAt': row.get('created_at'),
                'updatedAt': row.get('updated_at')
            })
        return result


def db_get_priority_preset(preset_id: str) -> Optional[dict]:
    """Get a priority preset by ID."""
    with get_db() as conn:
        cursor = execute(conn,
            "SELECT * FROM priority_presets WHERE id = ?",
            (preset_id,)
        )
        row = fetchone(cursor)
        if not row:
            return None
        return {
            'id': row['id'],
            'name': row['name'],
            'isBuiltin': bool(row['is_builtin']),
            'options': json.loads(row['options_json']) if row.get('options_json') else [],
            'createdBy': row.get('created_by'),
            'createdAt': row.get('created_at'),
            'updatedAt': row.get('updated_at')
        }


def db_create_priority_preset(name: str, options: List[dict], created_by: str = None) -> dict:
    """Create a custom priority preset."""
    preset_id = str(uuid.uuid4())
    now = datetime.now().isoformat()

    with get_db() as conn:
        execute(conn,
            """INSERT INTO priority_presets (id, name, is_builtin, options_json, created_by, created_at, updated_at)
               VALUES (?, ?, 0, ?, ?, ?, ?)""",
            (preset_id, name, json.dumps(options), created_by, now, now)
        )

    return db_get_priority_preset(preset_id)


def db_update_priority_preset(preset_id: str, name: str = None, options: List[dict] = None) -> Optional[dict]:
    """Update a priority preset. Cannot update built-in presets."""
    with get_db() as conn:
        # Check if exists and is not builtin
        cursor = execute(conn,
            "SELECT is_builtin FROM priority_presets WHERE id = ?",
            (preset_id,)
        )
        row = fetchone(cursor)
        if not row:
            return None
        if row['is_builtin']:
            raise ValueError("Cannot modify built-in presets")

        updates = []
        params = []
        if name is not None:
            updates.append("name = ?")
            params.append(name)
        if options is not None:
            updates.append("options_json = ?")
            params.append(json.dumps(options))

        if updates:
            updates.append("updated_at = ?")
            params.append(datetime.now().isoformat())
            params.append(preset_id)

            execute(conn,
                f"UPDATE priority_presets SET {', '.join(updates)} WHERE id = ?",
                tuple(params)
            )

    return db_get_priority_preset(preset_id)


def db_delete_priority_preset(preset_id: str) -> bool:
    """Delete a priority preset. Cannot delete built-in presets."""
    with get_db() as conn:
        cursor = execute(conn,
            "SELECT is_builtin FROM priority_presets WHERE id = ?",
            (preset_id,)
        )
        row = fetchone(cursor)
        if not row:
            return False
        if row['is_builtin']:
            raise ValueError("Cannot delete built-in presets")

        execute(conn, "DELETE FROM priority_presets WHERE id = ?", (preset_id,))
        return True


# ============ Status Presets ============

BUILTIN_STATUS_PRESETS = {
    'kanban': {
        'name': 'Kanban',
        'statuses': [
            {'name': 'Backlog', 'color': '#6b7280'},
            {'name': 'To Do', 'color': '#3b82f6'},
            {'name': 'In Progress', 'color': '#f59e0b'},
            {'name': 'Review', 'color': '#8b5cf6'},
            {'name': 'Done', 'color': '#22c55e'}
        ]
    },
    'vfx_pipeline': {
        'name': 'VFX Pipeline',
        'statuses': [
            {'name': 'Not Started', 'color': '#6b7280'},
            {'name': 'WIP', 'color': '#f59e0b'},
            {'name': 'Pending Review', 'color': '#8b5cf6'},
            {'name': 'Revisions', 'color': '#ef4444'},
            {'name': 'Approved', 'color': '#22c55e'},
            {'name': 'On Hold', 'color': '#64748b'}
        ]
    },
    'simple': {
        'name': 'Simple',
        'statuses': [
            {'name': 'Open', 'color': '#3b82f6'},
            {'name': 'Closed', 'color': '#22c55e'}
        ]
    },
    'bug_tracking': {
        'name': 'Bug Tracking',
        'statuses': [
            {'name': 'New', 'color': '#3b82f6'},
            {'name': 'Confirmed', 'color': '#8b5cf6'},
            {'name': 'In Progress', 'color': '#f59e0b'},
            {'name': 'Fixed', 'color': '#22c55e'},
            {'name': 'Won\'t Fix', 'color': '#6b7280'},
            {'name': 'Duplicate', 'color': '#64748b'}
        ]
    }
}


def db_init_builtin_status_presets():
    """Initialize built-in status presets if they don't exist."""
    now = datetime.now().isoformat()
    with get_db() as conn:
        for preset_id, preset_data in BUILTIN_STATUS_PRESETS.items():
            cursor = execute(conn,
                "SELECT id FROM status_presets WHERE id = ?",
                (preset_id,)
            )
            if not fetchone(cursor):
                execute(conn,
                    """INSERT INTO status_presets (id, name, is_builtin, statuses_json, created_at, updated_at)
                       VALUES (?, ?, 1, ?, ?, ?)""",
                    (preset_id, preset_data['name'], json.dumps(preset_data['statuses']), now, now)
                )


def db_list_status_presets() -> List[dict]:
    """List all status presets."""
    with get_db() as conn:
        cursor = execute(conn,
            "SELECT * FROM status_presets ORDER BY is_builtin DESC, name ASC"
        )
        result = []
        for row in fetchall(cursor):
            result.append({
                'id': row['id'],
                'name': row['name'],
                'isBuiltin': bool(row['is_builtin']),
                'statuses': json.loads(row['statuses_json']) if row.get('statuses_json') else [],
                'createdBy': row.get('created_by'),
                'createdAt': row.get('created_at'),
                'updatedAt': row.get('updated_at')
            })
        return result


def db_get_status_preset(preset_id: str) -> Optional[dict]:
    """Get a status preset by ID."""
    with get_db() as conn:
        cursor = execute(conn,
            "SELECT * FROM status_presets WHERE id = ?",
            (preset_id,)
        )
        row = fetchone(cursor)
        if not row:
            return None
        return {
            'id': row['id'],
            'name': row['name'],
            'isBuiltin': bool(row['is_builtin']),
            'statuses': json.loads(row['statuses_json']) if row.get('statuses_json') else [],
            'createdBy': row.get('created_by'),
            'createdAt': row.get('created_at'),
            'updatedAt': row.get('updated_at')
        }


def db_create_status_preset(name: str, statuses: List[dict], created_by: str = None) -> dict:
    """Create a custom status preset."""
    preset_id = str(uuid.uuid4())
    now = datetime.now().isoformat()

    with get_db() as conn:
        execute(conn,
            """INSERT INTO status_presets (id, name, is_builtin, statuses_json, created_by, created_at, updated_at)
               VALUES (?, ?, 0, ?, ?, ?, ?)""",
            (preset_id, name, json.dumps(statuses), created_by, now, now)
        )

    return db_get_status_preset(preset_id)


def db_update_status_preset(preset_id: str, name: str = None, statuses: List[dict] = None) -> Optional[dict]:
    """Update a status preset. Cannot update built-in presets."""
    with get_db() as conn:
        cursor = execute(conn,
            "SELECT is_builtin FROM status_presets WHERE id = ?",
            (preset_id,)
        )
        row = fetchone(cursor)
        if not row:
            return None
        if row['is_builtin']:
            raise ValueError("Cannot modify built-in presets")

        updates = []
        params = []
        if name is not None:
            updates.append("name = ?")
            params.append(name)
        if statuses is not None:
            updates.append("statuses_json = ?")
            params.append(json.dumps(statuses))

        if updates:
            updates.append("updated_at = ?")
            params.append(datetime.now().isoformat())
            params.append(preset_id)

            execute(conn,
                f"UPDATE status_presets SET {', '.join(updates)} WHERE id = ?",
                tuple(params)
            )

    return db_get_status_preset(preset_id)


def db_delete_status_preset(preset_id: str) -> bool:
    """Delete a status preset. Cannot delete built-in presets."""
    with get_db() as conn:
        cursor = execute(conn,
            "SELECT is_builtin FROM status_presets WHERE id = ?",
            (preset_id,)
        )
        row = fetchone(cursor)
        if not row:
            return False
        if row['is_builtin']:
            raise ValueError("Cannot delete built-in presets")

        execute(conn, "DELETE FROM status_presets WHERE id = ?", (preset_id,))
        return True


def db_apply_status_preset_to_project(preset_id: str, project_id: str = None) -> List[dict]:
    """Apply a status preset - creates actual statuses from the preset template."""
    from .clips import db_create_status, db_list_statuses

    preset = db_get_status_preset(preset_id)
    if not preset:
        raise ValueError(f"Preset not found: {preset_id}")

    created_statuses = []
    for i, status_template in enumerate(preset['statuses']):
        status = db_create_status(
            name=status_template['name'],
            color=status_template.get('color', '#6366f1'),
            sort_order=i
        )
        created_statuses.append(status)

    return created_statuses


# ============ Stage Presets ============

# Built-in stage presets
BUILTIN_STAGE_PRESETS = {
    'vfx': {
        'name': 'VFX Pipeline',
        'stages': [
            {'value': 'Previz', 'label': 'Previz', 'color': '#8b5cf6'},
            {'value': 'Layout', 'label': 'Layout', 'color': '#3b82f6'},
            {'value': 'Animation', 'label': 'Animation', 'color': '#10b981'},
            {'value': 'Lighting', 'label': 'Lighting', 'color': '#f59e0b'},
            {'value': 'FX', 'label': 'FX', 'color': '#ef4444'},
            {'value': 'Comp', 'label': 'Comp', 'color': '#ec4899'},
            {'value': 'Review', 'label': 'Review', 'color': '#6366f1'}
        ]
    },
    'video': {
        'name': 'Video Production',
        'stages': [
            {'value': 'Pre-production', 'label': 'Pre-production', 'color': '#8b5cf6'},
            {'value': 'Filming', 'label': 'Filming', 'color': '#3b82f6'},
            {'value': 'Editing', 'label': 'Editing', 'color': '#10b981'},
            {'value': 'Color', 'label': 'Color', 'color': '#f59e0b'},
            {'value': 'Sound', 'label': 'Sound', 'color': '#ef4444'},
            {'value': 'Final', 'label': 'Final', 'color': '#6366f1'}
        ]
    },
    'software': {
        'name': 'Software Development',
        'stages': [
            {'value': 'Design', 'label': 'Design', 'color': '#8b5cf6'},
            {'value': 'Development', 'label': 'Development', 'color': '#3b82f6'},
            {'value': 'Testing', 'label': 'Testing', 'color': '#f59e0b'},
            {'value': 'Staging', 'label': 'Staging', 'color': '#10b981'},
            {'value': 'Production', 'label': 'Production', 'color': '#6366f1'}
        ]
    }
}


def db_init_builtin_stage_presets():
    """Initialize built-in stage presets if they don't exist."""
    now = datetime.now().isoformat()
    with get_db() as conn:
        for preset_id, preset_data in BUILTIN_STAGE_PRESETS.items():
            cursor = execute(conn,
                "SELECT id FROM stage_presets WHERE id = ?",
                (preset_id,)
            )
            if not fetchone(cursor):
                execute(conn,
                    """INSERT INTO stage_presets (id, name, is_builtin, stages_json, created_at, updated_at)
                       VALUES (?, ?, 1, ?, ?, ?)""",
                    (preset_id, preset_data['name'], json.dumps(preset_data['stages']), now, now)
                )


def db_list_stage_presets() -> List[dict]:
    """List all stage presets."""
    with get_db() as conn:
        cursor = execute(conn,
            "SELECT * FROM stage_presets ORDER BY is_builtin DESC, name ASC"
        )
        result = []
        for row in fetchall(cursor):
            result.append({
                'id': row['id'],
                'name': row['name'],
                'isBuiltin': bool(row['is_builtin']),
                'stages': json.loads(row['stages_json']) if row.get('stages_json') else [],
                'createdBy': row.get('created_by'),
                'createdAt': row.get('created_at'),
                'updatedAt': row.get('updated_at')
            })
        return result


def db_get_stage_preset(preset_id: str) -> Optional[dict]:
    """Get a stage preset by ID."""
    with get_db() as conn:
        cursor = execute(conn,
            "SELECT * FROM stage_presets WHERE id = ?",
            (preset_id,)
        )
        row = fetchone(cursor)
        if not row:
            return None
        return {
            'id': row['id'],
            'name': row['name'],
            'isBuiltin': bool(row['is_builtin']),
            'stages': json.loads(row['stages_json']) if row.get('stages_json') else [],
            'createdBy': row.get('created_by'),
            'createdAt': row.get('created_at'),
            'updatedAt': row.get('updated_at')
        }


def db_create_stage_preset(name: str, stages: List[dict], created_by: str = None) -> dict:
    """Create a custom stage preset."""
    preset_id = str(uuid.uuid4())
    now = datetime.now().isoformat()

    with get_db() as conn:
        execute(conn,
            """INSERT INTO stage_presets (id, name, is_builtin, stages_json, created_by, created_at, updated_at)
               VALUES (?, ?, 0, ?, ?, ?, ?)""",
            (preset_id, name, json.dumps(stages), created_by, now, now)
        )

    return db_get_stage_preset(preset_id)


def db_update_stage_preset(preset_id: str, name: str = None, stages: List[dict] = None) -> Optional[dict]:
    """Update a stage preset. Cannot update built-in presets."""
    with get_db() as conn:
        cursor = execute(conn,
            "SELECT is_builtin FROM stage_presets WHERE id = ?",
            (preset_id,)
        )
        row = fetchone(cursor)
        if not row:
            return None
        if row['is_builtin']:
            raise ValueError("Cannot modify built-in presets")

        updates = []
        params = []
        if name is not None:
            updates.append("name = ?")
            params.append(name)
        if stages is not None:
            updates.append("stages_json = ?")
            params.append(json.dumps(stages))

        if updates:
            updates.append("updated_at = ?")
            params.append(datetime.now().isoformat())
            params.append(preset_id)

            execute(conn,
                f"UPDATE stage_presets SET {', '.join(updates)} WHERE id = ?",
                tuple(params)
            )

    return db_get_stage_preset(preset_id)


def db_delete_stage_preset(preset_id: str) -> bool:
    """Delete a stage preset. Cannot delete built-in presets."""
    with get_db() as conn:
        cursor = execute(conn,
            "SELECT is_builtin FROM stage_presets WHERE id = ?",
            (preset_id,)
        )
        row = fetchone(cursor)
        if not row:
            return False
        if row['is_builtin']:
            raise ValueError("Cannot delete built-in presets")

        execute(conn, "DELETE FROM stage_presets WHERE id = ?", (preset_id,))
        return True
