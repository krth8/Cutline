"""Login sessions: idle timeout, maximum age and logout.

Every login creates a session; its id travels in the token (`sid`). A token
only works while its session is alive, so logging out, changing a password or
sitting idle for too long ends it on the server - not just in the browser.
Share-link guests get a session too (keyed by their token's id), so they
time out the same way.

"Idle" means no user input. Browsers report how long ago the user last did
something with every request (X-Idle-Seconds), so background polling does not
keep a session alive, and activity in one tab counts for all of them.

Sessions are kept in memory and written through to the auth_sessions table.
"""

import contextvars
import os
import secrets
import time
from typing import Dict, List, Optional

from database.auth_sessions import (
    db_create_auth_session,
    db_delete_auth_sessions,
    db_list_auth_sessions,
    db_touch_auth_session,
)

IDLE_TIMEOUT = max(1, int(os.environ.get("IDLE_TIMEOUT_MINUTES", "60"))) * 60
MAX_AGE = max(1, int(os.environ.get("SESSION_MAX_DAYS", "30"))) * 86400
# How long before the timeout the browser warns the user
IDLE_WARNING = min(120, IDLE_TIMEOUT // 2)
# last_activity is only written to the database when it has moved this far
_SAVE_EVERY = 60

# Seconds since the user's last input, as reported by the current HTTP request.
# None = not an HTTP request (e.g. a WebSocket): never counts as activity.
request_idle_seconds: contextvars.ContextVar[Optional[int]] = contextvars.ContextVar("request_idle_seconds", default=None)

_sessions: Optional[Dict[str, dict]] = None


def _all() -> Dict[str, dict]:
    global _sessions
    if _sessions is None:
        _sessions = {}
        for row in db_list_auth_sessions():
            _sessions[row["id"]] = {
                "user_id": row["user_id"],
                "last_activity": row["last_activity"],
                "expires_at": row["expires_at"],
                "saved": row["last_activity"],
            }
    return _sessions


def _alive(session: dict, now: float) -> bool:
    return now < session["expires_at"] and now - session["last_activity"] < IDLE_TIMEOUT


def create(user_id: str, max_age: int = MAX_AGE) -> str:
    """Start a session for a user who just logged in (or a guest who opened a share link). Returns its id."""
    now = int(time.time())
    sid = secrets.token_urlsafe(24)
    db_create_auth_session(sid, user_id, now, now + max_age)
    _all()[sid] = {"user_id": user_id, "last_activity": now, "expires_at": now + max_age, "saved": now}
    return sid


def validate(sid: Optional[str], user_id: str, touch: bool = True) -> bool:
    """True while the session is alive. Also records activity for HTTP requests."""
    session = _all().get(sid) if sid else None
    now = time.time()
    if not session or session["user_id"] != user_id or not _alive(session, now):
        return False
    idle = request_idle_seconds.get()
    if touch and idle is not None:
        active_at = int(now) - max(0, idle)
        if active_at > session["last_activity"]:
            session["last_activity"] = active_at
            if active_at - session["saved"] >= _SAVE_EVERY:
                session["saved"] = active_at
                db_touch_auth_session(sid, active_at)
    return True


def idle_remaining(sid: str) -> int:
    """Seconds until the session times out (0 if it is gone)."""
    session = _all().get(sid)
    if not session:
        return 0
    now = time.time()
    return max(0, int(min(session["last_activity"] + IDLE_TIMEOUT, session["expires_at"]) - now))


def end(sid: str) -> None:
    if _all().pop(sid, None) is not None:
        db_delete_auth_sessions([sid])


def end_for_user(user_id: str, keep: Optional[str] = None) -> List[str]:
    """End all of a user's sessions (except `keep`). Returns the ended ids."""
    ended = [sid for sid, s in _all().items() if s["user_id"] == user_id and sid != keep]
    for sid in ended:
        del _all()[sid]
    db_delete_auth_sessions(ended)
    return ended


def end_expired() -> List[str]:
    """Drop sessions that timed out. Returns their ids so open connections can be closed."""
    now = time.time()
    ended = [sid for sid, s in _all().items() if not _alive(s, now)]
    for sid in ended:
        del _all()[sid]
    db_delete_auth_sessions(ended)
    return ended


class IdleHeaderMiddleware:
    """Reads X-Idle-Seconds into a context variable (pure ASGI).

    Requests without the header (scripts, plain links) count as activity now.
    """

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        idle = 0
        for key, value in scope.get("headers", []):
            if key == b"x-idle-seconds":
                try:
                    idle = max(0, int(value))
                except ValueError:
                    idle = 0
                break
        token = request_idle_seconds.set(idle)
        try:
            await self.app(scope, receive, send)
        finally:
            request_idle_seconds.reset(token)
