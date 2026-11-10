"""Notification routes."""

from fastapi import APIRouter, Depends, HTTPException
from database import (
    db_get_unread_count,
    db_list_notifications,
    db_mark_all_notifications_read,
    db_mark_notification_read,
)
from api.auth import require_auth


router = APIRouter()


# ============ Notifications API ============

@router.get("/api/notifications")
async def get_notifications(user: dict = Depends(require_auth)):
    """Get notifications for the current user."""
    notifications = db_list_notifications(user["id"])
    unread_count = db_get_unread_count(user["id"])
    return {"notifications": notifications, "unreadCount": unread_count}


@router.get("/api/notifications/unread-count")
async def get_unread_count(user: dict = Depends(require_auth)):
    """Get count of unread notifications."""
    count = db_get_unread_count(user["id"])
    return {"unreadCount": count}


@router.post("/api/notifications/{notification_id}/read")
async def mark_notification_read(notification_id: str, user: dict = Depends(require_auth)):
    """Mark a notification as read."""
    success = db_mark_notification_read(notification_id, user["id"])
    if not success:
        raise HTTPException(status_code=404, detail="Notification not found")
    return {"success": True}


@router.post("/api/notifications/read-all")
async def mark_all_read(user: dict = Depends(require_auth)):
    """Mark all notifications as read."""
    count = db_mark_all_notifications_read(user["id"])
    return {"success": True, "count": count}
