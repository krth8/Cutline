"""JWT tokens, roles/permissions, auth dependencies and rate limiting."""

import hashlib
import hmac
import json
import os
import re
import secrets
import time
from collections import defaultdict
from datetime import timedelta
from fastapi import Depends, HTTPException, Request, Response, status
from typing import Dict, List, Optional
from database import (
    db_check_project_access,
    db_get_share_link,
    db_get_user_by_id,
    db_list_revoked_tokens,
    db_revoke_tokens,
)
from api import sessions as auth_sessions
from api.state import sessions


# ============ JWT Configuration ============
JWT_SECRET = os.environ.get("JWT_SECRET")
if not JWT_SECRET:
    JWT_SECRET = secrets.token_hex(32)
    print("WARNING: JWT_SECRET is not set - all users will be logged out on every restart. Set JWT_SECRET in production.")
JWT_ALGORITHM = "HS256"
# Share-link guest tokens. Login tokens live as long as their session (api/sessions.py).
JWT_EXPIRATION_HOURS = 24


def create_jwt_token(user_id: str, username: str, is_admin: bool, role: str = None, expires_delta: timedelta = None, extra_claims: dict = None) -> str:
    """Create a JWT token for a user."""
    if expires_delta is None:
        expires_delta = timedelta(hours=JWT_EXPIRATION_HOURS)

    # Determine role if not provided
    if role is None:
        role = 'admin' if is_admin else 'editor'

    now = time.time()
    payload = {
        "sub": user_id,
        "username": username,
        "is_admin": is_admin,
        "role": role,
        "exp": now + expires_delta.total_seconds(),
        "iat": now
    }
    if extra_claims:
        payload.update(extra_claims)

    # Simple JWT encoding (header.payload.signature)
    header = {"alg": JWT_ALGORITHM, "typ": "JWT"}
    header_b64 = _base64url_encode(json.dumps(header))
    payload_b64 = _base64url_encode(json.dumps(payload))

    signature = _create_signature(f"{header_b64}.{payload_b64}")

    return f"{header_b64}.{payload_b64}.{signature}"


def issue_login_token(user: dict) -> str:
    """Start a login session for a user (as returned by the database) and return its token."""
    is_admin = bool(user.get("isAdmin"))
    return create_jwt_token(
        user_id=user["id"],
        username=user["username"],
        is_admin=is_admin,
        role=user.get("role") or ("admin" if is_admin else "editor"),
        expires_delta=timedelta(seconds=auth_sessions.MAX_AGE),
        extra_claims={"sid": auth_sessions.create(user["id"])},
    )


def _base64url_encode(data: str) -> str:
    """Base64url encode a string."""
    import base64
    return base64.urlsafe_b64encode(data.encode()).rstrip(b'=').decode()


def _base64url_decode(data: str) -> str:
    """Base64url decode a string."""
    import base64
    padding = 4 - len(data) % 4
    if padding != 4:
        data += '=' * padding
    return base64.urlsafe_b64decode(data).decode()


def _create_signature(data: str) -> str:
    """Create HMAC-SHA256 signature."""
    import hmac
    signature = hmac.new(JWT_SECRET.encode(), data.encode(), hashlib.sha256).digest()
    import base64
    return base64.urlsafe_b64encode(signature).rstrip(b'=').decode()


def verify_jwt_token(token: str) -> Optional[dict]:
    """Verify a JWT token and return the payload if valid."""
    try:
        parts = token.split('.')
        if len(parts) != 3:
            return None

        header_b64, payload_b64, signature = parts

        # Verify signature
        expected_signature = _create_signature(f"{header_b64}.{payload_b64}")
        if not hmac.compare_digest(signature, expected_signature):
            return None

        # Decode payload
        payload = json.loads(_base64url_decode(payload_b64))

        # Check expiration
        if payload.get("exp", 0) < time.time():
            return None

        return payload
    except Exception:
        return None


# ============ RBAC - Role-Based Access Control ============

class Permission:
    """Permission constants."""
    # Project permissions
    PROJECT_CREATE = "project:create"
    PROJECT_READ = "project:read"
    PROJECT_UPDATE = "project:update"
    PROJECT_DELETE = "project:delete"

    # Share link permissions
    SHARE_CREATE = "share:create"
    SHARE_READ = "share:read"
    SHARE_DELETE = "share:delete"

    # Session permissions
    SESSION_CREATE = "session:create"
    SESSION_JOIN = "session:join"
    SESSION_DELETE = "session:delete"

    # Admin permissions
    ADMIN_USERS = "admin:users"
    ADMIN_SETTINGS = "admin:settings"


# Role definitions with their permissions
ROLES = {
    "admin": {
        "name": "Administrator",
        "permissions": [
            Permission.PROJECT_CREATE, Permission.PROJECT_READ,
            Permission.PROJECT_UPDATE, Permission.PROJECT_DELETE,
            Permission.SHARE_CREATE, Permission.SHARE_READ, Permission.SHARE_DELETE,
            Permission.SESSION_CREATE, Permission.SESSION_JOIN, Permission.SESSION_DELETE,
            Permission.ADMIN_USERS, Permission.ADMIN_SETTINGS
        ]
    },
    "editor": {
        "name": "Editor",
        "permissions": [
            Permission.PROJECT_CREATE, Permission.PROJECT_READ, Permission.PROJECT_UPDATE,
            Permission.SHARE_CREATE, Permission.SHARE_READ,
            Permission.SESSION_CREATE, Permission.SESSION_JOIN
        ]
    },
    "viewer": {
        "name": "Viewer",
        "permissions": [
            Permission.PROJECT_READ,
            Permission.SHARE_READ,
            Permission.SESSION_JOIN
        ]
    },
    "guest": {
        "name": "Guest",
        "permissions": [
            Permission.PROJECT_READ,
            Permission.SESSION_JOIN
        ]
    }
}


def get_role_permissions(role: str) -> List[str]:
    """Get permissions for a role."""
    return ROLES.get(role, ROLES["guest"])["permissions"]


def has_permission(user_role: str, permission: str) -> bool:
    """Check if a role has a specific permission."""
    permissions = get_role_permissions(user_role)
    return permission in permissions


EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


def clean_email(value) -> Optional[str]:
    """Trimmed email, or None when empty. Raises 400 if it doesn't look like an address."""
    email = (value or "").strip() if isinstance(value, str) else ""
    if not email:
        return None
    if len(email) > 254 or not EMAIL_RE.match(email):
        raise HTTPException(status_code=400, detail="That doesn't look like an email address")
    return email


# ============ Kicked guests ============
# Share-link guests have no account to delete, so kicking one means refusing
# the token they hold. Kept in memory, backed by the revoked_tokens table.
_revoked_subs: Optional[set] = None


def _revoked() -> set:
    global _revoked_subs
    if _revoked_subs is None:
        _revoked_subs = set(db_list_revoked_tokens())
    return _revoked_subs


def revoke_token_subs(subs: List[str]) -> None:
    """Stop accepting the guest tokens with these subs."""
    subs = [s for s in subs if s]
    if subs:
        db_revoke_tokens(subs)
        _revoked().update(subs)


def principal_from_token(token: Optional[str], touch: bool = True) -> Optional[dict]:
    """Resolve a JWT into either a user or a share-link guest.

    Users are re-read from the database so deleted users and role changes
    take effect immediately, and their login session must still be alive
    (not logged out, not idle for too long). With touch=False the request
    is not counted as user activity.
    """
    if not token:
        return None
    payload = verify_jwt_token(token)
    if payload is None:
        return None

    # Media tokens only unlock a single file (see /html/...); never treat them as a login.
    if payload.get("scope") == "media":
        return None

    if payload.get("scope") == "share":
        project_id = payload.get("project_id")
        if not project_id or payload.get("sub") in _revoked():
            return None
        # A deleted or deactivated share link takes its guests with it
        link_id = payload.get("share_link_id")
        if link_id:
            link = db_get_share_link(link_id)
            if not link or not link["isActive"] or link["projectId"] != project_id:
                return None
        # Guests time out when idle, like users
        sid = payload.get("sid")
        if not auth_sessions.validate(sid, payload.get("sub"), touch=touch):
            return None
        return {
            "id": payload.get("sub"),
            "username": payload.get("username", "Guest"),
            "is_admin": False,
            "role": "guest",
            "is_guest": True,
            "project_id": project_id,
            "share_link_id": link_id,
            "sid": sid,
        }

    db_user = db_get_user_by_id(payload.get("sub"))
    if not db_user:
        return None
    sid = payload.get("sid")
    if not auth_sessions.validate(sid, db_user["id"], touch=touch):
        return None
    role = db_user.get("role") or ("admin" if db_user.get("isAdmin") else "editor")
    return {
        "id": db_user["id"],
        "username": db_user["username"],
        "is_admin": bool(db_user.get("isAdmin")) or role == "admin",
        "role": role,
        "is_guest": False,
        "sid": sid,
    }


# ============ Where the token comes from ============
# Browsers keep the login token in an HttpOnly cookie, out of reach of scripts.
# Because a cookie is sent automatically, requests that change something must
# also carry the X-Client-Id header, which another site cannot add (CSRF).
# Scripts and share-link guests send the token in the Authorization header.
SESSION_COOKIE = "cutline_session"        # the login token of a user
GUEST_MEDIA_COOKIE = "cutline_guest_"     # + project id: a guest's token, for <img>/<video> only
CSRF_HEADER = "x-client-id"
SAFE_METHODS = {"GET", "HEAD", "OPTIONS"}


def _set_cookie(response: Response, request: Request, name: str, token: str, max_age: int) -> None:
    response.set_cookie(
        name, token, max_age=max_age, httponly=True, samesite="lax",
        secure=request.url.scheme == "https", path="/",
    )


def set_session_cookie(response: Response, request: Request, token: str) -> None:
    _set_cookie(response, request, SESSION_COOKIE, token, auth_sessions.MAX_AGE)


def set_guest_media_cookie(response: Response, request: Request, project_id: str, token: str) -> None:
    _set_cookie(response, request, GUEST_MEDIA_COOKIE + project_id, token, JWT_EXPIRATION_HOURS * 3600)


def clear_session_cookie(response: Response) -> None:
    response.delete_cookie(SESSION_COOKIE, path="/")


def _bearer(request: Request) -> Optional[str]:
    header = request.headers.get("authorization", "")
    return header[7:] if header.lower().startswith("bearer ") else None


def request_token(request: Request) -> Optional[str]:
    """The token an API request is made with: the Authorization header, else the login cookie."""
    token = _bearer(request)
    if token:
        return token
    cookie = request.cookies.get(SESSION_COOKIE)
    if cookie and (request.method in SAFE_METHODS or request.headers.get(CSRF_HEADER)):
        return cookie
    return None


def media_principals(request: Request) -> List[dict]:
    """Everyone a media request (<img>, <video>, download link) speaks for:
    the header, the login cookie and any guest cookies.

    Fetching media is never counted as user activity.
    """
    tokens = [_bearer(request)]
    for name, value in request.cookies.items():
        if name == SESSION_COOKIE or name.startswith(GUEST_MEDIA_COOKIE):
            tokens.append(value)
    principals = [principal_from_token(t, touch=False) for t in tokens if t]
    return [p for p in principals if p]


# ============ WebSocket tickets ============
# A WebSocket URL ends up in logs, so it never carries the token. The browser
# asks for a ticket (one use, valid for a few seconds) and connects with that.
WS_TICKET_SECONDS = 30
_ws_tickets: Dict[str, tuple] = {}  # ticket -> (token, expires at)


def issue_ws_ticket(token: str) -> str:
    now = time.time()
    for ticket, (_, expires) in list(_ws_tickets.items()):
        if expires < now:
            del _ws_tickets[ticket]
    ticket = secrets.token_urlsafe(24)
    _ws_tickets[ticket] = (token, now + WS_TICKET_SECONDS)
    return ticket


def principal_from_ticket(ticket: Optional[str]) -> Optional[dict]:
    """Who a WebSocket belongs to. Opening a socket is never counted as user activity."""
    token, expires = _ws_tickets.pop(ticket, (None, 0)) if ticket else (None, 0)
    if not token or expires < time.time():
        return None
    return principal_from_token(token, touch=False)


# ============ Authentication Dependencies ============

async def get_principal(request: Request) -> Optional[dict]:
    """Current user or share-link guest, or None."""
    return principal_from_token(request_token(request))


async def get_current_user(request: Request) -> Optional[dict]:
    """Get the current authenticated (non-guest) user."""
    principal = principal_from_token(request_token(request))
    if principal is None or principal.get("is_guest"):
        return None
    return principal


async def require_principal(request: Request) -> dict:
    """A logged-in user or a share-link guest - raises 401 otherwise."""
    principal = principal_from_token(request_token(request))
    if principal is None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Authentication required")
    return principal


async def require_auth(request: Request) -> dict:
    """Require a logged-in user.

    401 means "no valid login" (browsers show the login screen on it);
    a share-link guest is known but not allowed, so gets 403.
    """
    principal = principal_from_token(request_token(request))
    if principal is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Authentication required",
            headers={"WWW-Authenticate": "Bearer"}
        )
    if principal.get("is_guest"):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Not available to share-link guests")
    return principal


def can_view_project(principal: Optional[dict], project_id: str) -> bool:
    """True if the user has project access, or the guest's share link is for this project."""
    if not principal or not project_id:
        return False
    if principal.get("is_guest"):
        return principal.get("project_id") == project_id
    return db_check_project_access(principal["id"], project_id)


def can_edit_tasks(user: dict, project_id: str) -> bool:
    """Task access on the project and a role that may change things (viewers are read-only)."""
    return has_permission(user.get("role", "guest"), Permission.PROJECT_UPDATE) and         db_check_project_access(user["id"], project_id, require_tasks=True)


# ============ Pages (PLAN.md 5.5) ============

def can_access_space(principal: Optional[dict], space: str, write: bool = False) -> bool:
    """May the principal read (or, with write, create pages in) a space: 'me' or 'p:<projectId>'?

    'me' is the caller's own personal space (admins are no exception). A project space is readable
    with any access to the project, writable with can_edit_tasks. Share-link guests never get in.
    """
    if not principal or principal.get("is_guest"):
        return False
    if space == "me":
        return True
    if not (isinstance(space, str) and space.startswith("p:") and len(space) > 2):
        return False
    project_id = space[2:]
    if write:
        return can_edit_tasks(principal, project_id)
    return db_check_project_access(principal["id"], project_id)


def can_read_page(principal: Optional[dict], page: dict) -> bool:
    """Personal pages: the owner only. Project pages: any project access. Task pages: task access."""
    if not principal or principal.get("is_guest"):
        return False
    if page["spaceType"] == "personal":
        return page["ownerId"] == principal["id"]
    if page["kind"] == "task":
        return db_check_project_access(principal["id"], page["projectId"], require_tasks=True)
    return db_check_project_access(principal["id"], page["projectId"])


def can_edit_page(principal: Optional[dict], page: dict) -> bool:
    """Personal pages: the owner only. Project pages (and task pages): can_edit_tasks on the project."""
    if not principal or principal.get("is_guest"):
        return False
    if page["spaceType"] == "personal":
        return page["ownerId"] == principal["id"]
    return can_edit_tasks(principal, page["projectId"])


def require_project_viewer(principal: Optional[dict], project_id: str) -> dict:
    """Raise 401/403 unless principal may view project_id."""
    if principal is None:
        raise HTTPException(status_code=401, detail="Authentication required")
    if not can_view_project(principal, project_id):
        raise HTTPException(status_code=403, detail="Access denied")
    return principal


def require_project_access(user: dict, project_id: str, require_review: bool = False, require_tasks: bool = False) -> None:
    """Raise 403 unless a logged-in user has access to project_id."""
    if not db_check_project_access(user["id"], project_id, require_review=require_review, require_tasks=require_tasks):
        raise HTTPException(status_code=403, detail="Access denied")


def resolve_project_id(session_or_project_id: str) -> str:
    """Session IDs map to their project; otherwise the ID is already a project ID."""
    if session_or_project_id in sessions:
        return sessions[session_or_project_id]["project_id"]
    return session_or_project_id


async def require_admin(user: dict = Depends(require_auth)) -> dict:
    """Require admin role - raises 403 if not admin."""
    if not user.get("is_admin"):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Admin privileges required"
        )
    return user


def require_permission(permission: str):
    """Create a dependency that requires a specific permission."""
    async def check_permission(user: dict = Depends(require_auth)) -> dict:
        user_role = user.get("role", "guest")
        if not has_permission(user_role, permission):
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail=f"Permission denied: {permission}"
            )
        return user
    return check_permission



# ============ Rate Limiting ============
# Simple in-memory rate limiter for login attempts
login_attempts: Dict[str, list] = defaultdict(list)
RATE_LIMIT_WINDOW = 300  # 5 minutes
RATE_LIMIT_MAX_ATTEMPTS = 5  # Max login attempts per window
LOCKOUT_DURATION = 900  # 15 minute lockout after exceeding attempts

# Comment rate limiting (anti-spam)
comment_attempts: Dict[str, list] = defaultdict(list)
COMMENT_RATE_LIMIT_WINDOW = 60  # 1 minute
COMMENT_RATE_LIMIT_MAX = 10  # Max comments per minute per IP


def check_rate_limit(identifier: str) -> bool:
    """Check if the identifier is rate limited. Returns True if allowed, False if blocked."""
    now = time.time()
    # Clean up old attempts
    login_attempts[identifier] = [t for t in login_attempts[identifier] if now - t < RATE_LIMIT_WINDOW]

    if len(login_attempts[identifier]) >= RATE_LIMIT_MAX_ATTEMPTS:
        # Check if still in lockout period
        oldest_in_window = min(login_attempts[identifier]) if login_attempts[identifier] else 0
        if now - oldest_in_window < LOCKOUT_DURATION:
            return False
        # Lockout expired, clear attempts
        login_attempts[identifier] = []

    return True


def record_login_attempt(identifier: str):
    """Record a failed login attempt."""
    login_attempts[identifier].append(time.time())


def clear_login_attempts(identifier: str):
    """Clear login attempts after successful login."""
    if identifier in login_attempts:
        del login_attempts[identifier]


def check_comment_rate_limit(identifier: str) -> bool:
    """Check if comment submissions are rate limited. Returns True if allowed."""
    now = time.time()
    # Clean up old attempts
    comment_attempts[identifier] = [t for t in comment_attempts[identifier] if now - t < COMMENT_RATE_LIMIT_WINDOW]
    return len(comment_attempts[identifier]) < COMMENT_RATE_LIMIT_MAX


def record_comment_attempt(identifier: str):
    """Record a comment submission."""
    comment_attempts[identifier].append(time.time())
