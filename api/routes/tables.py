"""Table API (PLAN.md 5.6): schema, query and row endpoints for every table source.

``{ref}`` is a table ref such as ``tasks:<projectId>``, ``tasks:*`` or ``tbl_<id>`` (a custom
table); the colon and the star work both written plainly and URL-encoded. Column endpoints (WP T2,
C1) exist for ``tasks:<projectId>`` and custom tables. Custom tables also have table endpoints
(create, list, info, rename, delete; WP C1) next to the row endpoints.
"""

from fastapi import APIRouter, Body, Depends, HTTPException

from api.auth import require_auth
from api.tables import columns as custom_columns
from api.tables import custom_source
from api.tables.custom_source import CustomTableSource
from api.tables.source import QueryError, resolve_source

router = APIRouter()


# ---- custom tables: create, list, info, rename, delete ----

@router.get("/api/tables")
async def list_tables(space: str, user: dict = Depends(require_auth)):
    """Custom tables of a space ('me' or 'p:<projectId>') the caller may read: ``{"tables": [...]}``."""
    return {"tables": custom_source.list_tables(user, space)}


@router.post("/api/tables")
async def create_table(data: dict = Body(...), user: dict = Depends(require_auth)):
    """Body ``{name, space, columns?: [{name, type, options?}]}``; returns the table summary (``ref`` is ``tbl_<id>``)."""
    return await custom_source.create_table(user, data)


def _custom_id(ref: str) -> str:
    if not isinstance(resolve_source(ref), CustomTableSource):
        raise HTTPException(status_code=404, detail="Not a custom table")
    return ref


@router.get("/api/tables/{ref}")
async def table_info(ref: str, user: dict = Depends(require_auth)):
    """A custom table's summary with ``rowCount`` and ``viewCount`` (what deleting it would remove)."""
    return custom_source.table_info(user, _custom_id(ref))


@router.patch("/api/tables/{ref}")
async def rename_table(ref: str, data: dict = Body(...), user: dict = Depends(require_auth)):
    return await custom_source.rename_table(user, _custom_id(ref), data)


@router.delete("/api/tables/{ref}")
async def delete_table(ref: str, user: dict = Depends(require_auth)):
    """Delete the table with its rows, columns and views: ``{success, deletedViews}``."""
    return await custom_source.delete_table(user, _custom_id(ref))


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


@router.get("/api/tables/{ref}/rows/{row_id}")
async def get_row(ref: str, row_id: str, user: dict = Depends(require_auth)):
    """One row; used by the task panel to open a task by id (also through ``tasks:*``)."""
    return resolve_source(ref).get_row(user, row_id)


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
    extra = {"parent_id": data["parentId"]} if "parentId" in data else {}
    return await resolve_source(ref).update_row(user, row_id, data.get("values") or {}, **extra)


@router.delete("/api/tables/{ref}/rows/{row_id}")
async def delete_row(ref: str, row_id: str, user: dict = Depends(require_auth)):
    await resolve_source(ref).delete_row(user, row_id)
    return {"success": True}


# ---- Trash (sources without one answer 400) ----

@router.get("/api/tables/{ref}/trash")
async def list_trash(ref: str, user: dict = Depends(require_auth)):
    """Deleted rows of the table the caller may restore, newest first."""
    return {"items": resolve_source(ref).list_trash(user)}


@router.post("/api/tables/{ref}/rows/restore")
async def restore_rows(ref: str, data: dict = Body(...), user: dict = Depends(require_auth)):
    """Restore several rows: {ids}. Ids that are not in the trash are skipped. Returns {restored: [ids]}."""
    return {"restored": await resolve_source(ref).restore_rows(user, data.get("ids"))}


@router.post("/api/tables/{ref}/rows/{row_id}/restore")
async def restore_row(ref: str, row_id: str, user: dict = Depends(require_auth)):
    """Restore one row (and the subtasks deleted with it). Returns the Row."""
    source = resolve_source(ref)
    if not await source.restore_rows(user, [row_id]):
        raise HTTPException(status_code=404, detail="Row not found in the trash")
    return source.get_row(user, row_id)


@router.delete("/api/tables/{ref}/trash/{row_id}")
async def purge_row(ref: str, row_id: str, user: dict = Depends(require_auth)):
    """Delete one row in the trash for good."""
    if not await resolve_source(ref).purge_rows(user, [row_id]):
        raise HTTPException(status_code=404, detail="Row not found in the trash")
    return {"success": True}


@router.delete("/api/tables/{ref}/trash")
async def empty_trash(ref: str, user: dict = Depends(require_auth)):
    """Delete everything in the table's trash for good (project owner or admin)."""
    return {"removed": await resolve_source(ref).empty_trash(user)}


def _column_host(ref: str) -> custom_columns.ColumnHost:
    """Where the custom columns of a table live: a project's tasks, or a custom table."""
    source = resolve_source(ref)  # unknown or malformed refs: 404
    if isinstance(source, CustomTableSource):
        return source.column_host()
    if ref == "tasks:*":
        raise HTTPException(status_code=400, detail="Columns belong to a project: use tasks:<projectId>")
    return custom_columns.TasksColumnHost(ref.split(":", 1)[1])


@router.post("/api/tables/{ref}/columns")
async def create_column(ref: str, data: dict = Body(...), user: dict = Depends(require_auth)):
    return await custom_columns.create_column_in(_column_host(ref), user, data)


@router.patch("/api/tables/{ref}/columns/{key}")
async def update_column(ref: str, key: str, data: dict = Body(...), user: dict = Depends(require_auth)):
    return await custom_columns.update_column_in(_column_host(ref), user, key, data)


@router.delete("/api/tables/{ref}/columns/{key}")
async def delete_column(ref: str, key: str, user: dict = Depends(require_auth)):
    await custom_columns.delete_column_in(_column_host(ref), user, key)
    return {"success": True}
