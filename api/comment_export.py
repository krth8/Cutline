"""Turn a project's review comments into a downloadable file (Markdown, CSV or JSON)."""

import csv
import io
import json
import re
from datetime import datetime
from typing import Dict, List, Optional, Tuple

FORMATS = {
    "md": "text/markdown; charset=utf-8",
    "csv": "text/csv; charset=utf-8",
    "json": "application/json; charset=utf-8",
}


def _timecode(frame: int, fps: int) -> str:
    seconds, frames = divmod(max(int(frame or 0), 0), fps)
    return f"{seconds // 3600:02d}:{seconds % 3600 // 60:02d}:{seconds % 60:02d}:{frames:02d}"


def _when(iso: Optional[str]) -> str:
    try:
        return datetime.fromisoformat(iso).strftime("%Y-%m-%d %H:%M")
    except (TypeError, ValueError):
        return ""


def _page_hash(comment: dict) -> str:
    """The page location (slide/route hash) an HTML comment belongs to."""
    anchor = comment.get("anchor") or {}
    view = (comment.get("drawing") or {}).get("view") or {}
    return anchor.get("hash") or view.get("hash") or ""


def _location(comment: dict, is_html: bool, fps: int) -> str:
    if is_html:
        page = _page_hash(comment)
        return f"Page {page}" if page else "Whole page"
    return _timecode(comment.get("frame", 0), fps)


def _public(comment: dict) -> dict:
    """A comment without server-internal fields."""
    return {k: v for k, v in comment.items() if not k.startswith("_")}


def _groups(project: dict, clip: Optional[str]) -> List[Tuple[str, int, str, List[dict]]]:
    """Top-level comments grouped per clip version: (clip, version, media type, comments)."""
    media_types: Dict[Tuple[str, int], str] = {}
    for base_name, clip_data in project.get("clips", {}).items():
        for v in clip_data.get("versions", []):
            media_types[(base_name, v.get("version"))] = v.get("mediaType") or "video"

    grouped: Dict[Tuple[str, int], List[dict]] = {}
    for c in project.get("comments", []):
        if c.get("parentId"):
            continue
        base_name = c.get("clipBaseName") or ""
        if clip and base_name != clip:
            continue
        grouped.setdefault((base_name, c.get("clipVersion") or 1), []).append(c)

    out = []
    for (base_name, version), comments in sorted(grouped.items(), key=lambda kv: (kv[0][0].lower(), -kv[0][1])):
        media_type = media_types.get((base_name, version), "video")
        if media_type == "html":
            comments.sort(key=lambda c: (_page_hash(c), c.get("createdAt") or ""))
        else:
            comments.sort(key=lambda c: (c.get("frame") or 0, c.get("createdAt") or ""))
        out.append((base_name, version, media_type, comments))
    return out


def _replies(project: dict) -> Dict[str, List[dict]]:
    replies: Dict[str, List[dict]] = {}
    for c in project.get("comments", []):
        if c.get("parentId"):
            replies.setdefault(c["parentId"], []).append(c)
    for thread in replies.values():
        thread.sort(key=lambda c: c.get("createdAt") or "")
    return replies


def _quote(text: str, indent: str) -> str:
    lines = (text or "").strip().splitlines() or [""]
    return "\n".join(f"{indent}> {line}" for line in lines)


def _markdown(project: dict, groups, replies, fps: int) -> str:
    total = sum(len(g[3]) for g in groups)
    resolved = sum(1 for g in groups for c in g[3] if c.get("resolved"))
    lines = [
        f"# Review comments: {project.get('name', 'Project')}",
        "",
        f"Exported {datetime.now().strftime('%Y-%m-%d %H:%M')}. "
        f"{total} comment{'s' if total != 1 else ''}, {total - resolved} open, {resolved} resolved.",
    ]
    if not groups:
        lines += ["", "No comments."]

    for base_name, version, media_type, comments in groups:
        is_html = media_type == "html"
        lines += ["", f"## {base_name or 'Unknown clip'} (v{version}, {media_type})"]
        last_location = None
        number = 0
        for c in comments:
            location = _location(c, is_html, fps)
            if is_html and location != last_location:
                lines += ["", f"### {location}"]
                last_location = location
            number += 1
            status = "resolved" if c.get("resolved") else "open"
            head = f"{number}. **{c.get('userName') or 'Unknown'}**, {_when(c.get('createdAt'))}, {status}"
            if not is_html:
                head = f"{number}. `{location}` (frame {c.get('frame', 0)}) **{c.get('userName') or 'Unknown'}**, {_when(c.get('createdAt'))}, {status}"
            lines += ["", head, _quote(c.get("text"), "   ")]

            anchor = c.get("anchor") or {}
            if anchor.get("selector"):
                label = f"\"{anchor['label']}\" " if anchor.get("label") else ""
                tag = f"<{anchor['tag']}> " if anchor.get("tag") else ""
                lines.append(f"   - Element: {label}{tag}`{anchor['selector']}`")
            if anchor.get("state") is not None:
                lines.append(f"   - Page state: `{json.dumps(anchor['state'], ensure_ascii=False)}`")
            if c.get("drawing"):
                near = ((c["drawing"] or {}).get("view") or {}).get("sel")
                lines.append(f"   - Drawing attached, drawn over `{near}`" if near
                             else "   - Drawing attached")
            for r in replies.get(c.get("id"), []):
                lines.append(f"   - Reply from **{r.get('userName') or 'Unknown'}**, {_when(r.get('createdAt'))}:")
                lines.append(_quote(r.get("text"), "     "))
    return "\n".join(lines) + "\n"


def _csv(groups, replies, fps: int) -> str:
    buf = io.StringIO()
    writer = csv.writer(buf, lineterminator="\r\n")
    writer.writerow(["Clip", "Version", "Type", "Location", "Frame", "Author", "Created", "Status",
                     "Comment", "Reply to", "Element", "Selector", "Drawing", "Id"])

    def row(c, base_name, version, media_type, parent=None):
        anchor = c.get("anchor") or {}
        located = parent or c
        writer.writerow([
            base_name, f"v{version}", media_type, _location(located, media_type == "html", fps),
            "" if media_type == "html" else located.get("frame", 0),
            c.get("userName") or "", _when(c.get("createdAt")),
            "resolved" if located.get("resolved") else "open",
            c.get("text") or "", parent.get("id") if parent else "",
            anchor.get("label") or "", anchor.get("selector") or "",
            "yes" if c.get("drawing") else "", c.get("id") or "",
        ])

    for base_name, version, media_type, comments in groups:
        for c in comments:
            row(c, base_name, version, media_type)
            for r in replies.get(c.get("id"), []):
                row(r, base_name, version, media_type, parent=c)
    # BOM so Excel reads the file as UTF-8
    return "﻿" + buf.getvalue()


def _json(project_id: str, project: dict, groups, replies, fps: int) -> str:
    clips = []
    for base_name, version, media_type, comments in groups:
        clips.append({
            "clip": base_name,
            "version": version,
            "mediaType": media_type,
            "comments": [{
                **_public(c),
                "location": _location(c, media_type == "html", fps),
                "replies": [_public(r) for r in replies.get(c.get("id"), [])],
            } for c in comments],
        })
    return json.dumps({
        "project": {"id": project_id, "name": project.get("name")},
        "exportedAt": datetime.now().isoformat(timespec="seconds"),
        "fps": fps,
        "clips": clips,
    }, ensure_ascii=False, indent=2)


def export_comments(project_id: str, project: dict, fmt: str, clip: Optional[str] = None,
                    fps: int = 24) -> Tuple[str, str, str]:
    """Returns (body, content type, filename)."""
    fps = min(max(int(fps or 24), 1), 240)
    groups = _groups(project, clip)
    replies = _replies(project)
    if fmt == "csv":
        body = _csv(groups, replies, fps)
    elif fmt == "json":
        body = _json(project_id, project, groups, replies, fps)
    else:
        fmt = "md"
        body = _markdown(project, groups, replies, fps)

    stem = re.sub(r"[^\w\-]+", "_", f"{project.get('name', 'project')}{'_' + clip if clip else ''}").strip("_") or "project"
    filename = f"{stem}_comments_{datetime.now().strftime('%Y-%m-%d')}.{fmt}"
    return body, FORMATS[fmt], filename
