"""Paths and ffmpeg configuration."""

import os
from pathlib import Path


# FFmpeg path - use environment variable or detect platform
FFMPEG_PATH = os.environ.get("FFMPEG_PATH", "ffmpeg" if os.name != "nt" else r"C:\ffmpeg\ffmpeg-8.0.1-essentials_build\bin\ffmpeg.exe")


def _default_ffprobe_path(ffmpeg_path: str) -> str:
    """Derive ffprobe's path from ffmpeg's (works for 'ffmpeg', '/usr/bin/ffmpeg' and 'C:\\...\\ffmpeg.exe')."""
    idx = ffmpeg_path.lower().rfind("ffmpeg")
    if idx == -1:
        return "ffprobe"
    return ffmpeg_path[:idx] + "ffprobe" + ffmpeg_path[idx + len("ffmpeg"):]


FFPROBE_PATH = os.environ.get("FFPROBE_PATH", _default_ffprobe_path(FFMPEG_PATH))

# Storage directories - configurable via environment variables
UPLOAD_DIR = os.environ.get("UPLOAD_DIR", "uploads")
TRANSCODED_DIR = os.environ.get("PROXY_DIR", "transcoded")
THUMBNAILS_DIR = os.environ.get("THUMBNAIL_DIR", "thumbnails")
COVERS_DIR = os.environ.get("COVERS_DIR", "covers")
PROFILES_DIR = os.environ.get("PROFILES_DIR", "profiles")

# Media type detection
IMAGE_EXTENSIONS = {'.jpg', '.jpeg', '.png', '.gif', '.webp', '.tiff', '.tif', '.bmp'}
VIDEO_EXTENSIONS = {'.mp4', '.mov', '.avi', '.mkv', '.webm', '.m4v', '.mxf', '.prores'}

def get_media_type(filename: str) -> str:
    """Determine if file is 'image' or 'video' based on extension."""
    ext = Path(filename).suffix.lower()
    if ext in IMAGE_EXTENSIONS:
        return 'image'
    return 'video'

for dir_path in [UPLOAD_DIR, TRANSCODED_DIR, THUMBNAILS_DIR, COVERS_DIR, PROFILES_DIR]:
    os.makedirs(dir_path, exist_ok=True)
