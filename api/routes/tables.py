"""Table API (PLAN.md 5.6): schema, query and row endpoints for every table source.

``{ref}`` is a table ref such as ``tasks:<projectId>`` or ``tasks:*``; the colon and the
star work both written plainly and URL-encoded. Column endpoints (WP T2) exist for
``tasks:<projectId>`` only.
"""

from fastapi import APIRouter, Body, Depends, HTTPException

from api.auth import require_auth
from api.tables import columns as custom_columns
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


def _column_project(ref: str) -> str:
    """The project id of a ``tasks:<projectId>`` ref; other refs have no custom columns here."""
    resolve_source(ref)  # unknown or malformed refs: 404
    if ref == "tasks:*":
        raise HTTPException(status_code=400, detail="Columns belong to a project: use tasks:<projectId>")
    return ref.split(":", 1)[1]


@router.post("/api/tables/{ref}/columns")
async def create_column(ref: str, data: dict = Body(...), user: dict = Depends(require_auth)):
    return await custom_columns.create_column(user, _column_project(ref), data)


@router.patch("/api/tables/{ref}/columns/{key}")
async def update_column(ref: str, key: str, data: dict = Body(...), user: dict = Depends(require_auth)):
    return await custom_columns.update_column(user, _column_project(ref), key, data)


@router.delete("/api/tables/{ref}/columns/{key}")
async def delete_column(ref: str, key: str, user: dict = Depends(require_auth)):
    await custom_columns.delete_column(user, _column_project(ref), key)
    return {"success": True}
