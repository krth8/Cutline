"""
Database Module for CollabSuite
Provides database connection, schema, and all CRUD operations
"""

from .engine import (
    get_connection, execute, fetchone, fetchall,
    get_last_insert_id, column_exists, add_column_if_not_exists,
    init_schema, DB_TYPE, DatabaseType, get_db_info
)

from .projects import (
    db_create_project, db_get_project, db_list_projects,
    db_update_project_cover, db_delete_project
)

from .clips import (
    db_add_clip_version, db_update_clip_active_version, db_delete_clip,
    db_create_status, db_list_statuses, db_update_status, db_delete_status,
    db_update_clip_status, db_get_clip_status, db_get_untagged_clips
)

from .comments import (
    db_add_comment, db_delete_comment, db_add_annotation
)

from .users import (
    db_create_user, db_get_user, db_get_user_by_id, db_validate_user,
    db_has_users, db_list_users, db_delete_user, db_update_user_role,
    db_update_user_password, db_update_user_profile_image, db_init_admin_user,
    db_update_user_email
)

from .sharing import (
    db_create_share_link, db_get_share_link, db_validate_share_link_password,
    db_list_share_links, db_list_all_share_links, db_deactivate_share_link,
    db_delete_share_link, db_increment_share_link_access,
    db_track_guest, db_list_guests, db_delete_guest, db_revoke_tokens, db_list_revoked_tokens,
    db_create_invite_link, db_get_invite_link, db_list_invite_links,
    db_use_invite_link, db_delete_invite_link
)

from .tasks import (
    db_create_task, db_get_task, db_list_tasks, db_update_task,
    db_delete_task, db_get_task_by_clip, db_get_task_hierarchy, db_reorder_tasks,
    db_link_task_clip, db_unlink_task_clip, db_get_task_clips, db_get_clip_tasks,
    db_list_checklist_items, db_create_checklist_item, db_update_checklist_item,
    db_delete_checklist_item
)

from .sections import (
    db_create_section, db_list_sections, db_get_section, db_update_section,
    db_delete_section, db_reorder_sections, db_get_section_statuses,
    db_add_section_status, db_remove_section_status, db_create_section_status
)

from .access import (
    db_grant_project_access, db_get_project_access, db_list_project_access,
    db_list_user_project_access, db_update_project_access, db_revoke_project_access,
    db_check_project_access, db_list_accessible_projects
)

from .notifications import (
    db_create_notification, db_list_notifications, db_get_unread_count,
    db_mark_notification_read, db_mark_all_notifications_read, db_delete_notification
)

from .batch import (
    db_batch_upsert_comments, db_batch_delete_comments,
    db_batch_upsert_annotations, db_batch_delete_annotations,
    db_batch_upsert_clips, db_batch_upsert_tasks, db_batch_upsert_statuses
)

from .settings import (
    db_get_setting, db_set_setting, db_delete_setting, db_list_settings,
    db_get_effective_setting,
    db_init_builtin_priority_presets, db_list_priority_presets, db_get_priority_preset,
    db_create_priority_preset, db_update_priority_preset, db_delete_priority_preset,
    db_init_builtin_status_presets, db_list_status_presets, db_get_status_preset,
    db_create_status_preset, db_update_status_preset, db_delete_status_preset,
    db_apply_status_preset_to_project,
    db_init_builtin_stage_presets, db_list_stage_presets, db_get_stage_preset,
    db_create_stage_preset, db_update_stage_preset, db_delete_stage_preset
)

from .utils import get_db, init_database, load_all_projects_to_memory, load_all_tasks_to_memory


# Re-export everything for backwards compatibility
__all__ = [
    # Engine
    'get_connection', 'execute', 'fetchone', 'fetchall',
    'get_last_insert_id', 'column_exists', 'add_column_if_not_exists',
    'init_schema', 'DB_TYPE', 'DatabaseType', 'get_db_info',
    # Utils
    'get_db', 'init_database', 'load_all_projects_to_memory', 'load_all_tasks_to_memory',
    # Projects
    'db_create_project', 'db_get_project', 'db_list_projects',
    'db_update_project_cover', 'db_delete_project',
    # Clips
    'db_add_clip_version', 'db_update_clip_active_version', 'db_delete_clip',
    'db_create_status', 'db_list_statuses', 'db_update_status', 'db_delete_status',
    'db_update_clip_status', 'db_get_clip_status',
    # Comments
    'db_add_comment', 'db_delete_comment', 'db_add_annotation',
    # Users
    'db_create_user', 'db_get_user', 'db_get_user_by_id', 'db_validate_user',
    'db_has_users', 'db_list_users', 'db_delete_user', 'db_update_user_role',
    'db_update_user_password', 'db_update_user_profile_image', 'db_init_admin_user',
    'db_update_user_email',
    # Sharing
    'db_create_share_link', 'db_get_share_link', 'db_validate_share_link_password',
    'db_list_share_links', 'db_list_all_share_links', 'db_deactivate_share_link',
    'db_delete_share_link', 'db_increment_share_link_access',
    'db_track_guest', 'db_list_guests', 'db_delete_guest', 'db_revoke_tokens', 'db_list_revoked_tokens',
    'db_create_invite_link', 'db_get_invite_link', 'db_list_invite_links',
    'db_use_invite_link', 'db_delete_invite_link',
    # Tasks
    'db_create_task', 'db_get_task', 'db_list_tasks', 'db_update_task',
    'db_delete_task', 'db_get_task_by_clip', 'db_get_task_hierarchy', 'db_reorder_tasks',
    'db_link_task_clip', 'db_unlink_task_clip', 'db_get_task_clips', 'db_get_clip_tasks',
    # Task checklist
    'db_list_checklist_items', 'db_create_checklist_item', 'db_update_checklist_item',
    'db_delete_checklist_item',
    # Sections
    'db_create_section', 'db_list_sections', 'db_get_section', 'db_update_section',
    'db_delete_section', 'db_reorder_sections', 'db_get_section_statuses',
    'db_add_section_status', 'db_remove_section_status', 'db_create_section_status',
    # Access
    'db_grant_project_access', 'db_get_project_access', 'db_list_project_access',
    'db_list_user_project_access', 'db_update_project_access', 'db_revoke_project_access',
    'db_check_project_access', 'db_list_accessible_projects',
    # Notifications
    'db_create_notification', 'db_list_notifications', 'db_get_unread_count',
    'db_mark_notification_read', 'db_mark_all_notifications_read', 'db_delete_notification',
    # Batch operations
    'db_batch_upsert_comments', 'db_batch_delete_comments',
    'db_batch_upsert_annotations', 'db_batch_delete_annotations',
    'db_batch_upsert_clips', 'db_batch_upsert_tasks', 'db_batch_upsert_statuses',
    # Settings
    'db_get_setting', 'db_set_setting', 'db_delete_setting', 'db_list_settings',
    'db_get_effective_setting',
    # Priority presets
    'db_init_builtin_priority_presets', 'db_list_priority_presets', 'db_get_priority_preset',
    'db_create_priority_preset', 'db_update_priority_preset', 'db_delete_priority_preset',
    # Status presets
    'db_init_builtin_status_presets', 'db_list_status_presets', 'db_get_status_preset',
    'db_create_status_preset', 'db_update_status_preset', 'db_delete_status_preset',
    'db_apply_status_preset_to_project',
    # Stage presets
    'db_init_builtin_stage_presets', 'db_list_stage_presets', 'db_get_stage_preset',
    'db_create_stage_preset', 'db_update_stage_preset', 'db_delete_stage_preset',
]
