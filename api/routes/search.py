"""GET /api/search: one endpoint for the command palette (logic in api/search.py)."""

from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query

from api.auth import require_auth
from api.search import TYPES, run_search

router = APIRouter()

DEFAULT_LIMIT = 8
MAX_LIMIT = 25
_PLURAL = {"pages": "page", "tasks": "task", "comments": "comment", "clips": "clip"}


@router.get("/api/search")
async def search(q: str = "", types: Optional[str] = None, project: Optional[str] = None,
                 limit: int = Query(DEFAULT_LIMIT, ge=1, le=MAX_LIMIT), user: dict = Depends(require_auth)):
    """Pages, tasks, review comments and clips matching `q` that the caller may see, grouped, at most `limit`
    of each. `types` is a comma-separated subset of page,task,comment,clip; `project` limits to one project."""
    wanted = None
    if types:
        wanted = [_PLURAL.get(t.strip(), t.strip()) for t in types.split(",") if t.strip()]
        unknown = [t for t in wanted if t not in TYPES]
        if unknown:
            raise HTTPException(status_code=400, detail=f"Unknown type: {unknown[0]}")
    return run_search(user, q, wanted, project or None, limit)
