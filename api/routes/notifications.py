"""Notification routes."""

from fastapi import APIRouter, Body, Depends, HTTPException
from database import (
    db_get_unread_count,
    db_list_notifications,
    db_mark_all_notifications_read,
    db_mark_notification_read,
)
from api.auth import require_auth
from api.notify import KINDS, KIND_NAMES
from database.task_notify import db_get_notification_prefs, db_set_notification_pref


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


@router.get("/api/notifications/prefs")
async def get_notification_prefs(user: dict = Depends(require_auth)):
    """Every kind of notification with whether this person gets it: ``{kinds: [{kind, label, enabled}]}``."""
    chosen = db_get_notification_prefs(user["id"])
    return {"kinds": [{"kind": k["kind"], "label": k["label"], "enabled": chosen.get(k["kind"], k["default"])} for k in KINDS]}


@router.put("/api/notifications/prefs")
async def set_notification_prefs(data: dict = Body(...), user: dict = Depends(require_auth)):
    """Body ``{kind: enabled, ...}``; unknown kinds are a 400."""
    if user.get("is_guest"):
        raise HTTPException(status_code=403, detail="Not available to share-link guests")
    if not isinstance(data, dict) or not data:
        raise HTTPException(status_code=400, detail="Send an object like {\"task_status\": false}")
    for kind, enabled in data.items():
        if kind not in KIND_NAMES or not isinstance(enabled, bool):
            raise HTTPException(status_code=400, detail=f"Unknown kind or value: {kind}")
    for kind, enabled in data.items():
        db_set_notification_pref(user["id"], kind, enabled)
    return await get_notification_prefs(user)
