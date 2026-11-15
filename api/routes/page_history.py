"""Page history routes (H2): list, view, name, delete and restore versions of a page."""

import asyncio
import base64

from fastapi import APIRouter, Depends, HTTPException
from pycrdt import Doc

from api import pagehistory
from api.pagesync import registry
from api.auth import require_auth
from api.routes.pages import _load, _notify
from database import db_list_users
from database.page_versions import (
    db_delete_version,
    db_get_version,
    db_list_versions,
    db_set_version_name,
)
from database.pages import db_get_page_text, db_load_page_state

router = APIRouter()

MAX_NAME = 120


def _clean_name(data: dict) -> str:
    name = data.get("name") if isinstance(data, dict) else None
    if not isinstance(name, str) or not name.strip():
        raise HTTPException(status_code=400, detail="name is required")
    return name.strip()[:MAX_NAME]


def _present(version: dict, names: dict) -> dict:
    """The API shape of a version: user ids replaced by {id, name}."""
    person = lambda uid: {"id": uid, "name": names.get(uid, "")}  # noqa: E731
    out = {k: v for k, v in version.items() if k not in ("state", "editors", "createdBy")}
    out["createdBy"] = person(version["createdBy"]) if version["createdBy"] else None
    out["editors"] = [person(uid) for uid in version["editors"]]
    return out


def _names() -> dict:
    return {u["id"]: u["username"] for u in db_list_users()}


def _version(page_id: str, version_id: str, with_state: bool = False) -> dict:
    version = db_get_version(page_id, version_id, with_state)
    if not version:
        raise HTTPException(status_code=404, detail="Version not found")
    return version


@router.get("/api/pages/{page_id}/versions")
async def list_versions(page_id: str, user: dict = Depends(require_auth)):
    """Newest first: [{id, kind, name, createdAt, createdBy, editors, textLength, excerpt}]."""
    _load(page_id, user)
    names = _names()
    return [_present(v, names) for v in db_list_versions(page_id)]


@router.get("/api/pages/{page_id}/versions/{version_id}")
async def get_version(page_id: str, version_id: str, user: dict = Depends(require_auth)):
    """One version with its document as base64 in `state` (a Yjs update the client can apply to a new Y.Doc)."""
    _load(page_id, user)
    version = _version(page_id, version_id, with_state=True)
    out = _present(version, _names())
    out["state"] = base64.b64encode(version["state"]).decode("ascii")
    return out


@router.post("/api/pages/{page_id}/versions", status_code=201)
async def create_version(page_id: str, data: dict, user: dict = Depends(require_auth)):
    """Save a named version of the page as it is now, including edits that are still only in the live room."""
    _load(page_id, user, write=True)
    name = _clean_name(data)
    await registry.snapshot(page_id)  # flush the live room into pages.ydoc
    snapshot, _rows = await asyncio.to_thread(db_load_page_state, page_id)
    if not snapshot:
        snapshot = Doc().get_update()
    text = await asyncio.to_thread(db_get_page_text, page_id)
    room = registry.rooms.get(page_id)
    editors = set(room.editors) if room else set()
    editors.add(user["id"])
    created = await pagehistory.save_version(page_id, snapshot, text or "", "named", created_by=user["id"],
                                             name=name, editors=editors)
    if room:
        room.editors = set()
    return _present(db_get_version(page_id, created["id"]), _names())


@router.patch("/api/pages/{page_id}/versions/{version_id}")
async def rename_version(page_id: str, version_id: str, data: dict, user: dict = Depends(require_auth)):
    """Name or rename a version. A named automatic version is no longer thinned out."""
    _load(page_id, user, write=True)
    _version(page_id, version_id)
    db_set_version_name(page_id, version_id, _clean_name(data))
    return _present(_version(page_id, version_id), _names())


@router.delete("/api/pages/{page_id}/versions/{version_id}", status_code=204)
async def delete_version(page_id: str, version_id: str, user: dict = Depends(require_auth)):
    """Delete a named version (unnamed ones are removed by the retention rule only)."""
    _load(page_id, user, write=True)
    if _version(page_id, version_id)["name"] is None:
        raise HTTPException(status_code=400, detail="Only named versions can be deleted")
    db_delete_version(page_id, version_id)


@router.post("/api/pages/{page_id}/versions/{version_id}/restore")
async def restore_version(page_id: str, version_id: str, user: dict = Depends(require_auth)):
    """Replace the page content with a version. The current content is kept as a `before_restore` version."""
    page = _load(page_id, user, write=True)
    if page["archivedAt"]:
        raise HTTPException(status_code=400, detail="Restore the page from the archive first")
    version = _version(page_id, version_id, with_state=True)
    await registry.restore(page_id, version["state"], user["id"])
    await _notify(page, "restored", versionId=version_id)
    return {"ok": True}
