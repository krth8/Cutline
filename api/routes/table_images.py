"""Images in table cells (image columns): upload one, and serve it to everyone who can read the table.

A cell of an image column stores a path like ``tasks.<projectId>/img_<hex>.jpg`` or ``tbl_<id>/img_<hex>.png``:
the first part names the table the image was uploaded to (``tasks:<projectId>`` written with a dot), the second
the file. The bytes live in UPLOAD_DIR/table_images/<table part>/<file>. Reading an image needs read access to
that table, so a path copied into another table shows nothing to people who cannot see the original.
Files that no cell references any more stay on disk (like page files, there is no garbage collection).
"""

import os
import re

from fastapi import APIRouter, Depends, File, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse

from api.auth import media_principals, require_auth
from api.config import UPLOAD_DIR
from api.routes.page_files import IMAGE_FORMATS, MAX_IMAGE_BYTES, MB, process_image, sniff_image
from api.tables.source import resolve_source

router = APIRouter()

IMAGES_DIR = os.path.join(UPLOAD_DIR, "table_images")
EXTENSIONS = {"JPEG": "jpg", "PNG": "png", "GIF": "gif", "WEBP": "webp"}
MIME_OF_EXT = {ext: IMAGE_FORMATS[fmt] for fmt, ext in EXTENSIONS.items()}

_TABLE_PART = r"(?:tasks\.[A-Za-z0-9_-]+|tbl_[A-Za-z0-9_-]+)"
_FILE_PART = r"img_[0-9a-f]{16}\.(?:jpg|png|gif|webp)"
IMAGE_VALUE = re.compile(rf"^{_TABLE_PART}/{_FILE_PART}$")


def table_part(ref: str) -> str:
    """The folder name of a table ref: ``tasks:p1`` -> ``tasks.p1``; custom tables keep their ref."""
    return ref.replace(":", ".", 1)


def ref_of_part(part: str) -> str:
    return part.replace(".", ":", 1) if part.startswith("tasks.") else part


def _readable(principal: dict, ref: str) -> bool:
    try:
        resolve_source(ref).schema(principal)
        return True
    except HTTPException:
        return False


@router.post("/api/tables/{ref}/images")
def upload_table_image(ref: str, request: Request, file: UploadFile = File(...), user: dict = Depends(require_auth)):
    """Store an image for a cell of the table. Returns ``{value, url}``; the client writes ``value`` into the cell."""
    if ref == "tasks:*":
        raise HTTPException(status_code=400, detail="Images belong to a project: use tasks:<projectId>")
    schema = resolve_source(ref).schema(user)  # 403/404 when the table cannot be read
    if user.get("is_guest") or not schema.get("capabilities", {}).get("create"):
        raise HTTPException(status_code=403, detail="You cannot change this table")
    declared = request.headers.get("content-length")
    if declared and declared.isdigit() and int(declared) > MAX_IMAGE_BYTES + MB:
        raise HTTPException(status_code=413, detail="Image is too large")

    part = table_part(ref)
    folder = os.path.join(IMAGES_DIR, part)
    os.makedirs(folder, exist_ok=True)
    tmp = os.path.join(folder, "upload_" + os.urandom(8).hex())
    try:
        size = 0
        with open(tmp, "wb") as out:
            while True:
                chunk = file.file.read(MB)
                if not chunk:
                    break
                size += len(chunk)
                if size > MAX_IMAGE_BYTES:
                    raise HTTPException(status_code=413, detail="Image is too large")
                out.write(chunk)
        with open(tmp, "rb") as f:
            fmt = sniff_image(f.read(16))
        if not fmt:
            raise HTTPException(status_code=415, detail="Only JPEG, PNG, GIF and WebP images can be used")
        process_image(tmp, fmt)
        name = f"img_{os.urandom(8).hex()}.{EXTENSIONS[fmt]}"
        os.replace(tmp, os.path.join(folder, name))
    finally:
        if os.path.exists(tmp):
            os.remove(tmp)
    value = f"{part}/{name}"
    return {"value": value, "url": f"/api/table-images/{value}"}


@router.get("/api/table-images/{part}/{name}")
def get_table_image(part: str, name: str, request: Request):
    """Serve a cell image to anyone who can read its table (login cookie or header, so <img src> works)."""
    value = f"{part}/{name}"
    if not IMAGE_VALUE.match(value):
        raise HTTPException(status_code=404, detail="Image not found")
    principals = media_principals(request)
    if not principals:
        raise HTTPException(status_code=401, detail="Authentication required")
    ref = ref_of_part(part)
    if not any(_readable(p, ref) for p in principals):
        raise HTTPException(status_code=403, detail="Access denied")
    path = os.path.join(IMAGES_DIR, part, name)
    if not os.path.isfile(path):
        raise HTTPException(status_code=404, detail="Image not found")
    return FileResponse(path, media_type=MIME_OF_EXT[name.rsplit(".", 1)[1]],
                        headers={"X-Content-Type-Options": "nosniff", "Cache-Control": "private, max-age=86400"})
