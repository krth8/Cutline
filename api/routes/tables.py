"""Table API (PLAN.md 5.6): schema, query and row endpoints for every table source.

``{ref}`` is a table ref such as ``tasks:<projectId>`` or ``tasks:*``; the colon and the
star work both written plainly and URL-encoded. Column endpoints belong to WP T2.
"""

from fastapi import APIRouter, Body, Depends, HTTPException

from api.auth import require_auth
from api.tables.source import QueryError, resolve_source

router = APIRouter()


@router.get("/api/tables/{ref}/schema")
async def table_schema(ref: str, user: dict = Depends(require_auth)):
    return resolve_source(ref).schema(user)


@router.post("/api/tables/{ref}/query")
async def table_query(ref: str, query: dict = Body(default_factory=dict), user: dict = Depends(require_auth)):
    source = resolve_source(ref)
    try:
        return source.query(user, query)
    except QueryError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.post("/api/tables/{ref}/rows")
async def create_row(ref: str, data: dict = Body(...), user: dict = Depends(require_auth)):
    source = resolve_source(ref)
    return await source.create_row(user, data.get("values") or {}, parent_id=data.get("parentId"),
                                   project_id=data.get("projectId"))


@router.post("/api/tables/{ref}/rows/reorder")
async def reorder_rows(ref: str, data: dict = Body(...), user: dict = Depends(require_auth)):
    await resolve_source(ref).reorder(user, data.get("ids"), data.get("before"))
    return {"success": True}


@router.patch("/api/tables/{ref}/rows/{row_id}")
async def update_row(ref: str, row_id: str, data: dict = Body(...), user: dict = Depends(require_auth)):
    return await resolve_source(ref).update_row(user, row_id, data.get("values") or {})


@router.delete("/api/tables/{ref}/rows/{row_id}")
async def delete_row(ref: str, row_id: str, user: dict = Depends(require_auth)):
    await resolve_source(ref).delete_row(user, row_id)
    return {"success": True}
