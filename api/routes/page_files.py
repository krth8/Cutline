"""Files in pages (PLAN.md 5.7): upload an image or attachment, and serve it to the readers of the page.

Storage: UPLOAD_DIR/pages/<pageId>/<fileId>, one folder per page. The stored name is the random file id;
the client's file name is only kept as a label in the database. Files that the document no longer
references stay on disk (there is no garbage collection).
"""

import mimetypes
import os
import re
import shutil
from typing import Optional, Tuple

from fastapi import APIRouter, Depends, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse
from PIL import Image, ImageOps

from api.auth import can_edit_page, can_read_page, media_principals, require_auth
from api.config import UPLOAD_DIR
from database.page_files import (
    db_add_page_file,
    db_delete_files_of_pages,
    db_get_page_file,
    db_page_subtree_ids,
    new_file_id,
)
from database.pages import db_get_page

router = APIRouter()

MB = 1024 * 1024
MAX_IMAGE_BYTES = int(os.environ.get("PAGE_IMAGE_MAX_MB", "20")) * MB
MAX_FILE_BYTES = int(os.environ.get("PAGE_FILE_MAX_MB", "100")) * MB
MAX_LONG_SIDE = 2560            # larger images are scaled down to this on upload
MAX_PIXELS = 100_000_000        # refuse decompression bombs
MAX_NAME = 200
PAGES_DIR = os.path.join(UPLOAD_DIR, "pages")

# Raster formats that may be shown inline: Pillow format -> mime type
IMAGE_FORMATS = {"JPEG": "image/jpeg", "PNG": "image/png", "GIF": "image/gif", "WEBP": "image/webp"}


# ============ Helpers ============

def _folder(page_id: str) -> str:
    return os.path.join(PAGES_DIR, page_id)


def clean_name(name: Optional[str]) -> str:
    """A display name: no directories, no control characters, limited length."""
    name = re.split(r"[\\/]", name or "")[-1]
    name = re.sub(r"[\x00-\x1f\x7f]", "", name).strip().strip(".").strip()
    return name[:MAX_NAME] or "file"


def sniff_image(head: bytes) -> Optional[str]:
    """The raster image format named by the first bytes of a file, or None. The extension is never used."""
    if head.startswith(b"\xff\xd8\xff"):
        return "JPEG"
    if head.startswith(b"\x89PNG\r\n\x1a\n"):
        return "PNG"
    if head[:6] in (b"GIF87a", b"GIF89a"):
        return "GIF"
    if head[:4] == b"RIFF" and head[8:12] == b"WEBP":
        return "WEBP"
    return None


def process_image(path: str, fmt: str) -> Tuple[int, int]:
    """Check the image and rewrite it in place: EXIF orientation applied, metadata dropped, long side limited.

    Animated GIFs and animated WebPs are kept as they are. Returns (width, height) of what is stored.
    """
    out_path = path + ".out"
    try:
        with Image.open(path) as image:
            if image.format != fmt:
                raise ValueError("format mismatch")
            width, height = image.size
            if width * height > MAX_PIXELS:
                raise HTTPException(status_code=413, detail="Image has too many pixels")
            if fmt == "GIF" or getattr(image, "n_frames", 1) > 1:
                return width, height
            image.load()
            fixed = ImageOps.exif_transpose(image)
            if max(fixed.size) > MAX_LONG_SIDE:
                fixed.thumbnail((MAX_LONG_SIDE, MAX_LONG_SIDE), Image.LANCZOS)
            if fmt == "JPEG":
                if fixed.mode not in ("RGB", "L"):
                    fixed = fixed.convert("RGB")
                fixed.save(out_path, "JPEG", quality=88, optimize=True)
            elif fmt == "PNG":
                fixed.save(out_path, "PNG", optimize=True)
            else:
                fixed.save(out_path, "WEBP", quality=88)
            size = fixed.size
    except HTTPException:
        raise
    except Exception:
        if os.path.exists(out_path):
            os.remove(out_path)
        raise HTTPException(status_code=415, detail="Not a valid image")
    os.replace(out_path, path)
    return size


def _load(page_id: str, user: dict, write: bool) -> dict:
    page = db_get_page(page_id)
    if not page:
        raise HTTPException(status_code=404, detail="Page not found")
    if not can_read_page(user, page) or (write and not can_edit_page(user, page)):
        raise HTTPException(status_code=403, detail="Access denied")
    return page


# ============ Routes ============

@router.post("/api/pages/{page_id}/files")
def upload_page_file(page_id: str, request: Request, file: UploadFile = File(...), kind: str = Form("auto"),
                     user: dict = Depends(require_auth)):
    """Store an uploaded file in the page. Editors only. kind=image refuses anything that is not a raster image."""
    _load(page_id, user, write=True)
    declared = request.headers.get("content-length")
    if declared and declared.isdigit() and int(declared) > MAX_FILE_BYTES + MB:
        raise HTTPException(status_code=413, detail="File is too large")

    folder = _folder(page_id)
    os.makedirs(folder, exist_ok=True)
    file_id = new_file_id()
    path = os.path.join(folder, file_id)
    try:
        size = 0
        with open(path, "wb") as out:
            while True:
                chunk = file.file.read(MB)
                if not chunk:
                    break
                size += len(chunk)
                if size > MAX_FILE_BYTES:
                    raise HTTPException(status_code=413, detail="File is too large")
                out.write(chunk)
        with open(path, "rb") as f:
            fmt = sniff_image(f.read(16))
        if kind == "image" and not fmt:
            raise HTTPException(status_code=415, detail="Only JPEG, PNG, GIF and WebP images can be inserted")
        width = height = None
        if fmt:
            if size > MAX_IMAGE_BYTES:
                raise HTTPException(status_code=413, detail="Image is too large")
            width, height = process_image(path, fmt)
            size = os.path.getsize(path)
            mime = IMAGE_FORMATS[fmt]
        else:
            mime = mimetypes.guess_type(clean_name(file.filename))[0] or "application/octet-stream"
        row = db_add_page_file(file_id, page_id, clean_name(file.filename), mime, size, bool(fmt), width, height,
                               user["id"])
    except BaseException:
        if os.path.exists(path):
            os.remove(path)
        raise

    body = {"id": file_id, "url": f"/api/pages/{page_id}/files/{file_id}", "name": row["name"], "size": size,
            "mime": mime, "kind": "image" if fmt else "file"}
    if fmt:
        body.update(width=width, height=height)
    return body


@router.get("/api/pages/{page_id}/files/{file_id}")
def get_page_file(page_id: str, file_id: str, request: Request):
    """Serve a file to anyone who can read the page (login cookie or header, so <img src> works)."""
    principals = media_principals(request)
    if not principals:
        raise HTTPException(status_code=401, detail="Authentication required")
    page = db_get_page(page_id)
    if not page or not any(can_read_page(p, page) for p in principals):
        raise HTTPException(status_code=403, detail="Access denied")
    row = db_get_page_file(page_id, file_id)
    path = os.path.join(_folder(page_id), file_id)
    if not row or not os.path.isfile(path):
        raise HTTPException(status_code=404, detail="File not found")
    inline = row["isImage"] and row["mime"] in IMAGE_FORMATS.values()
    return FileResponse(
        path, media_type=row["mime"] if inline else "application/octet-stream", filename=row["name"],
        content_disposition_type="inline" if inline else "attachment",
        headers={"X-Content-Type-Options": "nosniff", "Cache-Control": "private, max-age=3600"})


def delete_files_of_page_tree(page_id: str) -> None:
    """Remove the files (disk and rows) of a page and its sub-pages. Call before the pages are deleted."""
    ids = db_page_subtree_ids(page_id)
    db_delete_files_of_pages(ids)
    for pid in ids:
        shutil.rmtree(_folder(pid), ignore_errors=True)
