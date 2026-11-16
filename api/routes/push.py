"""Push notification routes.

GET  /api/push/key          -> {publicKey}                 what a browser needs to subscribe
GET  /api/push/devices      -> {count}                     how many browsers of the caller are subscribed
POST /api/push/subscribe    {endpoint, keys:{p256dh,auth}} this browser gets the caller's notifications
POST /api/push/unsubscribe  {endpoint}                     and no longer does
POST /api/push/test         -> {sent}                      a test message to the caller's browsers
"""

from fastapi import APIRouter, Depends, HTTPException, Request

from api import push
from api.auth import require_auth
from database.push import db_delete_push_subscription, db_list_push_subscriptions, db_save_push_subscription

router = APIRouter()

MAX_FIELD = 2000


def _text(value, name: str) -> str:
    if not isinstance(value, str) or not value or len(value) > MAX_FIELD:
        raise HTTPException(status_code=400, detail=f"{name} is required")
    return value


@router.get("/api/push/key")
async def push_key(user: dict = Depends(require_auth)):
    return {"publicKey": push.public_key()}


@router.get("/api/push/devices")
async def push_devices(user: dict = Depends(require_auth)):
    return {"count": len(db_list_push_subscriptions(user["id"]))}


@router.post("/api/push/subscribe")
async def push_subscribe(data: dict, request: Request, user: dict = Depends(require_auth)):
    endpoint = _text(data.get("endpoint"), "endpoint")
    if not endpoint.startswith("https://"):
        raise HTTPException(status_code=400, detail="endpoint must be an https address")
    keys = data.get("keys") if isinstance(data.get("keys"), dict) else {}
    db_save_push_subscription(user["id"], endpoint, _text(keys.get("p256dh"), "keys.p256dh"), _text(keys.get("auth"), "keys.auth"),
                              request.headers.get("user-agent"))
    return {"success": True}


@router.post("/api/push/unsubscribe")
async def push_unsubscribe(data: dict, user: dict = Depends(require_auth)):
    db_delete_push_subscription(_text(data.get("endpoint"), "endpoint"), user["id"])
    return {"success": True}


@router.post("/api/push/test")
async def push_test(user: dict = Depends(require_auth)):
    sent = push.send_now(user["id"], {"title": "Cutline", "body": "Notifications work on this device.", "link": "/"})
    return {"sent": sent}
