"""Export routes (PLAN.md H5): a page as Markdown (or a zip with sub-pages and files), a view as CSV.

Both are plain GET downloads (the login cookie is enough, like media), so a link with the `download`
attribute works. A page as PDF is not a server feature: the browser prints the page (see web/src/pages/print).
"""

import os

from fastapi import APIRouter, Body, Depends, HTTPException, Request
from fastapi.responses import FileResponse, Response, StreamingResponse
from starlette.background import BackgroundTask

from api.auth import can_read_page, require_auth
from api.export_pages import export_page
from api.export_tables import ViewExport, content_disposition, csv_chunks, safe_filename
from api.routes.views import _load as load_view
from api.tables.query import QueryError
from api.tables.source import resolve_source
from database.pages import db_get_page

router = APIRouter()


@router.get("/api/pages/{page_id}/export")
async def export_page_route(page_id: str, request: Request, format: str = "md", subpages: int = 0,
                            user: dict = Depends(require_auth)):
    """The page as a Markdown download; a zip when it has images or files, or with `subpages=1`
    (sub-pages in folders that mirror the tree, attachments in a `files/` folder per page)."""
    if format != "md":
        raise HTTPException(status_code=400, detail="format must be md (a PDF is made by the browser: Print / Save as PDF)")
    page = db_get_page(page_id)
    if not page:
        raise HTTPException(status_code=404, detail="Page not found")
    if not can_read_page(user, page):
        raise HTTPException(status_code=403, detail="Access denied")
    result = await export_page(user, page, str(request.base_url), bool(subpages))
    headers = {"Content-Disposition": content_disposition(result.filename), "Cache-Control": "no-store",
               "X-Content-Type-Options": "nosniff"}
    if result.zip_path:
        return FileResponse(result.zip_path, media_type=result.media_type, headers=headers,
                            background=BackgroundTask(os.remove, result.zip_path))
    return Response(result.markdown, media_type=result.media_type, headers=headers)


def _csv_response(export: ViewExport, name: str) -> StreamingResponse:
    headers = {"Content-Disposition": content_disposition(safe_filename(name, "view") + ".csv"),
               "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff"}
    return StreamingResponse(csv_chunks(export), media_type="text/csv; charset=utf-8", headers=headers)


@router.get("/api/views/{view_id}/export")
async def export_view_csv(view_id: str, format: str = "csv", user: dict = Depends(require_auth)):
    """The view's rows as CSV: the view's filter, sort and search, its visible columns in order (title first),
    every row (not a page). Whoever may read the view and its table's rows may export it."""
    if format != "csv":
        raise HTTPException(status_code=400, detail="format must be csv")
    view = load_view(view_id, user)
    config = view.get("config") or {}
    try:
        export = ViewExport(user, view["tableRef"], config.get("query"), config.get("columns"))
    except QueryError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    return _csv_response(export, view["name"])


@router.post("/api/tables/{ref}/export")
async def export_table_csv(ref: str, data: dict = Body(...), user: dict = Depends(require_auth)):
    """CSV of a view state that may not be saved yet: Body {query, columns?, name?} on a table ref.
    Same rules as the view export; the table's own permissions decide what is listed."""
    resolve_source(ref)   # unknown refs: 404
    query, columns = data.get("query") or {}, data.get("columns")
    if not isinstance(query, dict) or (columns is not None and not isinstance(columns, list)):
        raise HTTPException(status_code=400, detail="query must be an object and columns a list")
    name = data.get("name") if isinstance(data.get("name"), str) else "Export"
    try:
        export = ViewExport(user, ref, query, columns)
    except QueryError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    return _csv_response(export, name)
