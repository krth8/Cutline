"""Web push: every notification a user gets in the app is also sent to the browsers where they enabled it.

The server signs its messages with a VAPID key pair. It is made on first use and kept in the settings
table, so it survives restarts (a new key would silently invalidate every subscription). The messages go
out on a small thread pool: the push services are plain HTTPS calls and must not hold up a request.

``VAPID_SUBJECT`` (environment) is the contact the push services may use, a ``mailto:`` or ``https:``
address. Set it to a real one in production: some services refuse messages without it.
"""

import base64
import json
import logging
import os
from concurrent.futures import ThreadPoolExecutor
from typing import Optional

from cryptography.hazmat.primitives import serialization
from py_vapid import Vapid
from pywebpush import WebPushException, webpush

from database import notifications as notifications_db
from database.push import db_delete_push_subscription, db_list_push_subscriptions
from database.settings import db_get_setting, db_set_setting

log = logging.getLogger("cutline.push")

SETTING_KEY = "push_vapid_private_pem"
DEFAULT_SUBJECT = "mailto:admin@example.com"
TTL_SECONDS = 24 * 3600  # how long a push service keeps a message for a device that is offline

_executor = ThreadPoolExecutor(max_workers=2, thread_name_prefix="push")
_vapid: Optional[Vapid] = None


def _keys() -> Vapid:
    global _vapid
    if _vapid is None:
        pem = db_get_setting(SETTING_KEY)
        if pem:
            _vapid = Vapid.from_pem(pem.encode("ascii"))
        else:
            made = Vapid()
            made.generate_keys()
            db_set_setting(SETTING_KEY, made.private_pem().decode("ascii"))
            _vapid = made
    return _vapid


def public_key() -> str:
    """The key a browser needs to subscribe (base64url of the uncompressed point)."""
    raw = _keys().public_key.public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def _subject() -> str:
    return os.environ.get("VAPID_SUBJECT") or DEFAULT_SUBJECT


def send_now(user_id: str, payload: dict) -> int:
    """Send one message to every browser of the user. Returns how many were accepted; dead subscriptions are removed."""
    sent = 0
    for sub in db_list_push_subscriptions(user_id):
        try:
            webpush(
                subscription_info={"endpoint": sub["endpoint"], "keys": {"p256dh": sub["p256dh"], "auth": sub["auth"]}},
                data=json.dumps(payload),
                vapid_private_key=_keys(),
                vapid_claims={"sub": _subject()},
                ttl=TTL_SECONDS,
                timeout=10,
            )
            sent += 1
        except WebPushException as e:
            status = getattr(getattr(e, "response", None), "status_code", None)
            if status in (404, 410):  # the browser unsubscribed or the subscription expired
                db_delete_push_subscription(sub["endpoint"])
            else:
                log.warning("push to %s failed: %s", sub["endpoint"][:60], e)
        except Exception as e:  # network trouble must never reach the request that caused the notification
            log.warning("push failed: %s", e)
    return sent


def payload_of(notification: dict) -> dict:
    return {
        "id": notification.get("id"),
        "title": notification.get("title") or "Cutline",
        "body": notification.get("message") or "",
        "link": notification.get("link") or (f"/p/{notification['projectId']}/review" if notification.get("projectId") else "/"),
    }


def _on_notification(notification: dict) -> None:
    user_id = notification.get("userId")
    if user_id:
        _executor.submit(send_now, user_id, payload_of(notification))


if _on_notification not in notifications_db.listeners:
    notifications_db.listeners.append(_on_notification)
