"""Page history (H2): automatic versions, retention and restoring a version into a live document.

Called from api/pagesync.py: `after_snapshot` and `on_last_editor_left` from the snapshot path,
`replace_content` from `PageRegistry.restore`. All pycrdt access stays on the event-loop thread;
only database calls go to a thread.
"""

import asyncio
from datetime import datetime, timedelta
from typing import Dict, Iterable, List, Optional

from pycrdt import Doc, XmlElement, XmlFragment, XmlText

from database.page_versions import (
    db_create_version,
    db_delete_versions,
    db_latest_auto_time,
    db_latest_version_state,
    db_thinnable_versions,
)

FRAGMENT = "default"

# An automatic version is taken by a snapshot when the document changed since the last version AND the
# last automatic version is older than this.
AUTO_VERSION_INTERVAL = timedelta(minutes=10)

# Retention of versions without a name (named versions are never removed):
#   - everything younger than 24 hours is kept,
#   - from 24 hours to 30 days the newest version of each calendar day is kept,
#   - older than 30 days the newest version of each ISO week is kept,
#   - at most MAX_UNNAMED_VERSIONS are kept per page (the newest ones).
KEEP_ALL_FOR = timedelta(hours=24)
KEEP_DAILY_FOR = timedelta(days=30)
MAX_UNNAMED_VERSIONS = 200


def now() -> datetime:
    return datetime.now()


def versions_to_thin(rows: List[dict], at: datetime) -> List[str]:
    """Ids to delete from unnamed versions [{id, createdAt}] (newest first), by the retention rule above."""
    keep: List[str] = []
    seen_buckets = set()
    for row in rows:
        created = datetime.fromisoformat(row["createdAt"])
        age = at - created
        if age < KEEP_ALL_FOR:
            keep.append(row["id"])
            continue
        bucket = ("day", created.date()) if age < KEEP_DAILY_FOR else ("week", created.isocalendar()[:2])
        if bucket in seen_buckets:
            continue
        seen_buckets.add(bucket)
        keep.append(row["id"])
    keep = set(keep[:MAX_UNNAMED_VERSIONS])
    return [row["id"] for row in rows if row["id"] not in keep]


async def thin_versions(page_id: str) -> None:
    rows = await asyncio.to_thread(db_thinnable_versions, page_id)
    doomed = versions_to_thin(rows, now())
    if doomed:
        await asyncio.to_thread(db_delete_versions, page_id, doomed)


async def save_version(page_id: str, state: bytes, text: str, kind: str, created_by: Optional[str] = None,
                       name: Optional[str] = None, editors: Iterable[str] = ()) -> dict:
    version = await asyncio.to_thread(db_create_version, page_id, state, text, kind, created_by, name,
                                      list(editors), now().isoformat())
    if kind != "named":
        try:
            await thin_versions(page_id)
        except Exception as exc:  # thinning is housekeeping and must not fail a snapshot
            print(f"Could not thin the versions of page {page_id}: {exc}")
    return version


def _is_empty(state: bytes) -> bool:
    doc = Doc()
    doc.apply_update(state)
    return len(doc.get(FRAGMENT, type=XmlFragment).children) == 0


async def _maybe_version(page_id: str, state: bytes, text: str, editors: set, respect_interval: bool) -> bool:
    last = await asyncio.to_thread(db_latest_version_state, page_id)
    if last is None:
        if _is_empty(state):
            return False
    elif last["state"] == state:
        return False  # nothing changed since the last version
    if respect_interval:
        last_auto = await asyncio.to_thread(db_latest_auto_time, page_id)
        if last_auto and now() - datetime.fromisoformat(last_auto) < AUTO_VERSION_INTERVAL:
            return False
    await save_version(page_id, state, text, "auto", editors=editors)
    return True


async def after_snapshot(page_id: str, state: bytes, text: str, editors: set) -> bool:
    """Called after a snapshot merged rows. Takes an automatic version if the rule allows; True if it did.
    Never raises (a snapshot must not fail over history)."""
    try:
        return await _maybe_version(page_id, state, text, editors, respect_interval=True)
    except Exception as exc:
        print(f"Could not take a version of page {page_id}: {exc}")
        return False


async def on_last_editor_left(page_id: str, state: bytes, text: str, editors: set) -> bool:
    """The last editor left: take a version if anything changed since the last one, whatever its age."""
    try:
        return await _maybe_version(page_id, state, text, editors, respect_interval=False)
    except Exception as exc:
        print(f"Could not take a version of page {page_id}: {exc}")
        return False


# ============ Restoring into a live document ============

def _copy_text(source: XmlText, target: XmlText) -> None:
    """Copy the runs of a text node with their formatting (marks)."""
    position = 0
    for run, attrs in source.diff():
        if isinstance(run, str):
            target.insert(position, run, dict(attrs) if attrs else None)
            position += len(run)


def _copy_children(source, target) -> None:
    for child in source.children:
        if isinstance(child, XmlText):
            copy = XmlText()
            target.children.append(copy)  # integrate first: formatting needs a document
            _copy_text(child, copy)
        elif isinstance(child, XmlElement):
            copy = XmlElement(child.tag)
            target.children.append(copy)
            for key, value in dict(child.attributes).items():
                copy.attributes[key] = value
            _copy_children(child, copy)


def replace_content(doc: Doc, state: bytes) -> bytes:
    """Make the content of `doc` equal to the document encoded in `state`, as one ordinary change.

    The shared fragment is emptied and rebuilt from a copy of the old document (elements, attributes,
    text with its marks), all in one transaction, so connected clients receive one normal update and
    keep their sessions. Returns that update (empty if nothing changed)."""
    old = Doc()
    old.apply_update(state)
    source = old.get(FRAGMENT, type=XmlFragment)
    target = doc.get(FRAGMENT, type=XmlFragment)
    before = doc.get_state()
    with doc.transaction():
        count = len(target.children)
        if count:
            del target.children[0:count]
        _copy_children(source, target)
    return doc.get_update(before)
