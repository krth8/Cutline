"""
Database Module - Backwards Compatibility Wrapper

This file re-exports everything from the new database/ package
to maintain backwards compatibility with existing code.

All actual implementations are now in database/*.py
"""

# Re-export everything from the new database package
from database import (
    # Engine
    get_connection, execute, fetchone, fetchall,
    get_last_insert_id, column_exists, add_column_if_not_exists,
    init_schema, DB_TYPE, DatabaseType, get_db_info,
    # Utils
    get_db, init_database, load_all_projects_to_memory,
    # Projects
    db_create_project, db_get_project, db_list_projects,
    db_update_project_cover, db_delete_project,
    # Clips
    db_add_clip_version, db_update_clip_active_version, db_delete_clip,
    db_create_status, db_list_statuses, db_update_status, db_delete_status,
    db_update_clip_status, db_get_clip_status,
    # Comments
    db_add_comment, db_delete_comment, db_add_annotation,
    # Users
    db_create_user, db_get_user, db_get_user_by_id, db_validate_user,
    db_has_users, db_list_users, db_delete_user, db_update_user_role,
    db_update_user_password, db_update_user_profile_image, db_init_admin_user,
    # Sharing
    db_create_share_link, db_get_share_link, db_validate_share_link_password,
    db_list_share_links, db_list_all_share_links, db_deactivate_share_link,
    db_delete_share_link, db_increment_share_link_access,
    db_track_guest, db_list_guests, db_delete_guest,
    db_create_invite_link, db_get_invite_link, db_list_invite_links,
    db_use_invite_link, db_delete_invite_link,
    # Tasks
    db_create_task, db_get_task, db_list_tasks, db_update_task,
    db_delete_task, db_get_task_by_clip, db_get_task_hierarchy, db_reorder_tasks,
    # Access
    db_grant_project_access, db_get_project_access, db_list_project_access,
    db_list_user_project_access, db_update_project_access, db_revoke_project_access,
    db_check_project_access, db_list_accessible_projects,
    # Notifications
    db_create_notification, db_list_notifications, db_get_unread_count,
    db_mark_notification_read, db_mark_all_notifications_read, db_delete_notification,
)

# Note: init_database() is called automatically when the database package is imported
