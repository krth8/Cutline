from fastapi import (
    FastAPI,
    WebSocket,
    WebSocketDisconnect,
    UploadFile,
    File,
    Query,
    BackgroundTasks,
    Depends,
    HTTPException,
    Request,
)
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, Response
from fastapi.middleware.cors import CORSMiddleware
import os
import re
import uuid
import shutil
import asyncio
import secrets
import json
from datetime import datetime, timedelta
from typing import Dict, List, Optional
from pathlib import Path
from urllib.parse import quote
from PIL import Image

# Database module for persistence
from database import (
    load_all_projects_to_memory,
    load_all_tasks_to_memory,
    db_create_project,
    db_get_project,
    db_update_project_cover,
    db_delete_project,
    db_create_share_link,
    db_get_share_link,
    db_validate_share_link_password,
    db_list_share_links,
    db_list_all_share_links,
    db_deactivate_share_link,
    db_delete_share_link,
    db_increment_share_link_access,
    db_track_guest,
    db_create_notification,
    db_batch_upsert_comments,
    db_delete_comment,
    db_add_annotation,
    db_get_user_by_id,
    db_init_admin_user,
    db_get_user,
    db_list_statuses,
    db_delete_clip,
    db_check_project_access,
    db_list_accessible_projects,
)

# Cache manager for write-back persistence
from cache import cache_manager
import html_preview
from html_preview import render_html_preview

# Shared modules
from api.auth import (
    JWT_EXPIRATION_HOURS,
    Permission,
    can_view_project,
    clean_email,
    check_comment_rate_limit,
    create_jwt_token,
    get_current_user,
    get_principal,
    has_permission,
    media_principals,
    principal_from_ticket,
    record_comment_attempt,
    require_permission,
    require_project_access,
    require_project_viewer,
    resolve_project_id,
    set_guest_media_cookie,
    verify_jwt_token,
)
from api.config import (
    COVERS_DIR,
    FFMPEG_PATH,
    FFPROBE_PATH,
    MAX_HTML_BYTES,
    PROFILES_DIR,
    THUMBNAILS_DIR,
    TRANSCODED_DIR,
    UPLOAD_DIR,
    get_media_type,
)
from api.media import process_image, safe_upload_name
from api.comment_export import FORMATS as EXPORT_FORMATS, export_comments
from api.state import (
    WS_ACCESS_REMOVED,
    clip_locks,
    close_session_sockets,
    projects,
    sessions,
    tasks,
    track_socket,
    transcode_jobs,
    untrack_socket,
    user_states,
)
from api import sessions as auth_sessions
from api.routes import router as api_router
from api.assets import AssetMiddleware, index_response
from api.events import ClientIdMiddleware, live

app = FastAPI()


# ============ CORS Configuration ============
# Configure allowed origins - in production, replace with specific origins
CORS_ORIGINS = [o.strip() for o in os.environ.get("CORS_ORIGINS", "*").split(",") if o.strip()]

app.add_middleware(
    CORSMiddleware,
    allow_origins=CORS_ORIGINS,
    # Credentials must never be combined with a wildcard origin
    allow_credentials=CORS_ORIGINS != ["*"],
    allow_methods=["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
    allow_headers=["*"],
)


# ============ Static asset caching ============
# Cache-Control for static files + gzip for text responses
app.add_middleware(AssetMiddleware)
# Remembers which browser tab made a request (so live events aren't echoed back)
app.add_middleware(ClientIdMiddleware)
# How long ago the user last did something (idle logout)
app.add_middleware(auth_sessions.IdleHeaderMiddleware)


def load_data_from_db():
    """Load projects and tasks from database on startup."""
    projects.clear()
    projects.update(load_all_projects_to_memory())
    tasks.clear()
    tasks.update(load_all_tasks_to_memory())
    cache_manager.set_projects_ref(projects)
    cache_manager.set_tasks_ref(tasks)
    print(f"Loaded {len(projects)} projects and {len(tasks)} tasks from database")


# Load data on module import
load_data_from_db()

# Initialize admin user
db_init_admin_user()


@app.on_event("startup")
async def startup_event():
    """Start background workers on server startup."""
    await ensure_upload_cleanup_worker()
    print(f"Upload cleanup worker started (interval: {UPLOAD_CLEANUP_INTERVAL_HOURS}h, max age: {UPLOAD_FILE_MAX_AGE_HOURS}h)")
    cache_manager.start()
    print("Cache manager started (write-back persistence enabled)")
    asyncio.create_task(backfill_html_previews())
    asyncio.create_task(end_idle_logins())


async def end_idle_logins():
    """Log out sessions that sat idle too long, closing their open connections."""
    while True:
        await asyncio.sleep(15)
        try:
            await close_session_sockets(auth_sessions.end_expired())
        except Exception as e:
            print(f"Idle logout check failed: {e}")


async def backfill_html_previews():
    """Give HTML clips uploaded before previews existed a thumbnail."""
    await asyncio.sleep(5)
    for project_id, project in list(projects.items()):
        for base_name, clip in list(project.get('clips', {}).items()):
            for version in clip.get('versions', []):
                if version.get('mediaType') != 'html' or version.get('thumbnail'):
                    continue
                html_path = os.path.join(TRANSCODED_DIR, version.get('filename', ''))
                if not os.path.isfile(html_path):
                    continue
                thumbnail = f"{Path(version['filename']).stem}.jpg"
                if not await render_html_preview(html_path, os.path.join(THUMBNAILS_DIR, thumbnail)):
                    if html_preview.ENABLED and not html_preview._unavailable:
                        continue
                    return
                version['thumbnail'] = thumbnail
                cache_manager.mark_clip_dirty(project_id, base_name)
                print(f"HTML preview made for {base_name} v{version.get('version')}")


@app.on_event("shutdown")
async def shutdown_event():
    """Gracefully shutdown background workers and flush cache."""
    print("Shutting down - flushing cache to database...")
    await cache_manager.stop()
    print("Cache flushed successfully")

def get_user_state(session_id: str, user_id: str) -> Optional[dict]:
    """Safely get user state, returning None if session or user doesn't exist."""
    if session_id not in user_states:
        return None
    return user_states[session_id].get(user_id)

# Session cleanup configuration
SESSION_EMPTY_TIMEOUT_MINUTES = 30

# Upload cleanup configuration
UPLOAD_CLEANUP_INTERVAL_HOURS = 24  # Run cleanup once per day
UPLOAD_FILE_MAX_AGE_HOURS = 1  # Delete orphaned files older than 1 hour

# Transcode queue for sequential processing
transcode_queue: asyncio.Queue = None
transcode_worker_running = False

# Session cleanup worker
session_cleanup_running = False

# Upload cleanup worker
upload_cleanup_running = False


async def cleanup_empty_sessions():
    """Remove sessions that have been empty for more than SESSION_EMPTY_TIMEOUT_MINUTES."""
    global session_cleanup_running
    session_cleanup_running = True

    while True:
        await asyncio.sleep(60)  # Check every minute

        now = datetime.now()
        sessions_to_remove = []

        # SAFE: Create a snapshot of session IDs first to avoid modification during iteration
        session_ids = list(sessions.keys())
        for session_id in session_ids:
            session = sessions.get(session_id)
            if session is None:
                continue  # Session was deleted during iteration
            # Check if session is empty
            if len(session.get("users", [])) == 0:
                last_activity = session.get("lastUserActivity")
                if last_activity:
                    last_activity_time = datetime.fromisoformat(last_activity)
                    minutes_empty = (now - last_activity_time).total_seconds() / 60

                    if minutes_empty >= SESSION_EMPTY_TIMEOUT_MINUTES:
                        sessions_to_remove.append(session_id)

        # Remove old empty sessions
        for session_id in sessions_to_remove:
            print(f"Auto-deleting empty session {session_id} (empty for >{SESSION_EMPTY_TIMEOUT_MINUTES} min)")
            del sessions[session_id]
            # Clean up user states for this session
            if session_id in user_states:
                del user_states[session_id]


async def ensure_session_cleanup_worker():
    """Ensure the session cleanup worker is running."""
    global session_cleanup_running
    if not session_cleanup_running:
        asyncio.create_task(cleanup_empty_sessions())


async def cleanup_orphaned_uploads():
    """Periodically remove orphaned files from uploads directory.

    Files in uploads/ are temporary - originals waiting for transcoding.
    After transcoding completes, they should be deleted. This cleanup
    catches any files that weren't deleted due to errors or crashes.
    """
    global upload_cleanup_running
    upload_cleanup_running = True

    while True:
        # Wait for the configured interval
        await asyncio.sleep(UPLOAD_CLEANUP_INTERVAL_HOURS * 3600)

        try:
            now = datetime.now()
            deleted_count = 0
            deleted_size = 0

            if not os.path.exists(UPLOAD_DIR):
                continue

            for filename in os.listdir(UPLOAD_DIR):
                file_path = os.path.join(UPLOAD_DIR, filename)

                # Skip directories
                if os.path.isdir(file_path):
                    continue

                # Check file age
                try:
                    file_mtime = datetime.fromtimestamp(os.path.getmtime(file_path))
                    age_hours = (now - file_mtime).total_seconds() / 3600

                    if age_hours >= UPLOAD_FILE_MAX_AGE_HOURS:
                        file_size = os.path.getsize(file_path)
                        os.remove(file_path)
                        deleted_count += 1
                        deleted_size += file_size
                        print(f"Cleanup: Deleted orphaned upload {filename} (age: {age_hours:.1f}h)")
                except OSError as e:
                    print(f"Cleanup: Could not process {filename}: {e}")

            if deleted_count > 0:
                size_mb = deleted_size / (1024 * 1024)
                print(f"Upload cleanup complete: {deleted_count} files, {size_mb:.1f} MB freed")

        except Exception as e:
            print(f"Upload cleanup error: {e}")


async def ensure_upload_cleanup_worker():
    """Ensure the upload cleanup worker is running."""
    global upload_cleanup_running
    if not upload_cleanup_running:
        asyncio.create_task(cleanup_orphaned_uploads())


def parse_clip_filename(filename: str) -> dict:
    """Parse filename to extract base name and version.

    Only recognizes _v or _V prefix as version indicator.
    Preserves original version formatting (v02 stays v02, v002 stays v002).
    Files without version tag return version=None for auto-versioning.
    """
    # Remove session/project prefix if present (e.g., "abc123_" at start)
    without_prefix = re.sub(r'^[a-f0-9]{8}_', '', filename)

    # Only match _v or _V patterns: name_v001.ext, name_V02.ext
    match = re.match(r'^(.+?)_[vV](\d+)\.(\w+)$', without_prefix)
    if match:
        version_str = match.group(2)
        return {
            'baseName': match.group(1),
            'version': int(version_str),
            'versionStr': f"v{version_str}",  # Preserve original formatting
            'extension': match.group(3),
            'originalFilename': filename,
            'hasExplicitVersion': True
        }

    # No version found - will be auto-versioned
    ext_match = re.match(r'^(.+)\.(\w+)$', without_prefix)
    if ext_match:
        return {
            'baseName': ext_match.group(1),
            'version': None,  # Will be auto-assigned
            'versionStr': None,
            'extension': ext_match.group(2),
            'originalFilename': filename,
            'hasExplicitVersion': False
        }

    return {
        'baseName': without_prefix,
        'version': None,
        'versionStr': None,
        'extension': 'mp4',
        'originalFilename': filename,
        'hasExplicitVersion': False
    }


async def add_clip_to_project(project_id: str, filename: str, thumbnail: str = None, proxies: dict = None, default_quality: str = None, media_type: str = 'video', stored_filename: str = None):
    """Add a clip version to the project with optional proxy information.

    If the file has no explicit version (version=None), auto-assigns the next version number.
    Automatically creates a task for new clips (clip -> task linkage).
    Uses per-clip locking to prevent race conditions on parallel uploads.

    Args:
        media_type: 'video' or 'image'
    """
    if project_id not in projects:
        return

    clip_info = parse_clip_filename(filename)
    base_name = clip_info['baseName']

    # Get or create lock for this clip (prevents race conditions)
    # Use setdefault which is atomic - prevents two coroutines from creating separate locks
    lock_key = f"{project_id}:{base_name}"
    lock = clip_locks.setdefault(lock_key, asyncio.Lock())

    async with lock:
        version = clip_info['version']
        version_str = clip_info.get('versionStr')

        # Use setdefault to atomically create clips dict - prevents race conditions
        # between different clips modifying the same project
        clips = projects[project_id].setdefault('clips', {})

        # Atomically create clip entry if it doesn't exist
        clip_entry = clips.setdefault(base_name, {
            'versions': [],
            'activeVersion': 1
        })

        # Auto-assign version if not explicitly set
        if version is None:
            existing_versions = [v['version'] for v in clip_entry['versions']]
            version = max(existing_versions, default=0) + 1
            version_str = f"v{version}"

        # Check if version exists - if so, replace it
        existing_idx = next((i for i, v in enumerate(clip_entry['versions']) if v['version'] == version), None)

        # stored_filename lets a version keep its own file on disk while
        # `filename` still decides which clip/version it belongs to.
        actual_filename = stored_filename or filename
        actual_default_quality = default_quality

        # Add proxy information if available
        if proxies:
            actual_default_quality = default_quality or list(proxies.keys())[-1]
            # Set actual filename to the default quality proxy
            actual_filename = proxies.get(actual_default_quality, filename)

        version_data = {
            'version': version,
            'versionStr': version_str,
            'filename': actual_filename,
            'thumbnail': thumbnail,
            'uploadedAt': datetime.now().isoformat(),
            'mediaType': media_type
        }

        if proxies:
            version_data['proxies'] = proxies
            version_data['defaultQuality'] = actual_default_quality

        if existing_idx is not None:
            # Replace existing version
            clip_entry['versions'][existing_idx] = version_data
        else:
            # Add new version
            clip_entry['versions'].append(version_data)

        # Sort versions descending
        clip_entry['versions'].sort(key=lambda x: x['version'], reverse=True)

        # Update active version if newer
        if version >= clip_entry['activeVersion']:
            clip_entry['activeVersion'] = version

        # Save now: an upload must survive a crash, and deleting or linking the
        # clip needs it in the database
        cache_manager.mark_clip_dirty(project_id, base_name)
        await cache_manager.persist_now()

        # Show the new version to everyone looking at the project (the uploader too)
        await live.to_project(project_id, {"type": "clip_updated", "baseName": base_name, "clip": clip_entry}, echo=True)


async def get_video_duration(filepath: str) -> float:
    """Get video duration using ffprobe."""
    try:
        ffprobe_path = FFPROBE_PATH
        cmd = [
            ffprobe_path,
            '-v', 'error',
            '-show_entries', 'format=duration',
            '-of', 'default=noprint_wrappers=1:nokey=1',
            filepath
        ]
        process = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE
        )
        stdout, _ = await process.communicate()
        return float(stdout.decode().strip())
    except (OSError, ValueError, AttributeError) as e:
        print(f"Error getting video duration: {e}")
        return 0.0


async def get_video_resolution(filepath: str) -> tuple:
    """Get video resolution (width, height) using ffprobe."""
    try:
        ffprobe_path = FFPROBE_PATH
        cmd = [
            ffprobe_path,
            '-v', 'error',
            '-select_streams', 'v:0',
            '-show_entries', 'stream=width,height',
            '-of', 'csv=p=0',
            filepath
        ]
        process = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE
        )
        stdout, _ = await process.communicate()
        parts = stdout.decode().strip().split(',')
        if len(parts) >= 2:
            return int(parts[0]), int(parts[1])
    except (OSError, ValueError, AttributeError) as e:
        print(f"Error getting video resolution: {e}")
    return 1920, 1080  # Default to 1080p


# Proxy quality presets (All-Intra encoding, optimized for review/scrubbing)
# Note: 2-pass encoding is incompatible with All-Intra (-g 1), so we use CRF single-pass
# CRF values: lower = better quality, ~17-18 is visually lossless for most content
PROXY_PRESETS = {
    '720p':  {'target': 1280, 'crf': 20, 'maxrate': '6M',  'bufsize': '12M', 'preset': 'fast'},
    '1080p': {'target': 1920, 'crf': 18, 'maxrate': '8M',  'bufsize': '16M', 'preset': 'slow'},
    '4k':    {'target': 4096, 'crf': 17, 'maxrate': '10M', 'bufsize': '20M', 'preset': 'slow'},
}


def get_required_proxies(width: int, height: int) -> list:
    """Determine which proxy qualities to generate based on source resolution.
    Uses the longest side to handle both landscape and portrait, plus scope/widescreen formats.
    """
    longest_side = max(width, height)
    proxies = []
    if longest_side >= 720:
        proxies.append('720p')
    if longest_side >= 1080:
        proxies.append('1080p')
    if longest_side >= 2160:
        proxies.append('4k')
    # Always include at least 720p
    if not proxies:
        proxies.append('720p')
    return proxies


async def transcode_video(job_id: str, input_path: str, output_path: str, quality: str = None, progress_offset: int = 0, progress_scale: int = 100, source_width: int = None, source_height: int = None):
    """Transcode video with FFmpeg using All-Intra encoding for frame-accurate scrubbing."""
    try:
        # Get duration for progress calculation
        duration = await get_video_duration(input_path)
        transcode_jobs[job_id]['duration'] = duration
        transcode_jobs[job_id]['status'] = 'transcoding'
        transcode_jobs[job_id]['current_quality'] = quality or 'source'

        # Get preset settings
        preset = PROXY_PRESETS.get(quality, {}) if quality else {}
        encoder_preset = preset.get('preset', 'fast')

        # Build scale filter based on longest side (never upscale)
        if quality and quality in PROXY_PRESETS:
            target = preset['target']
            crf = str(preset['crf'])
            maxrate = preset['maxrate']
            bufsize = preset['bufsize']

            # Calculate actual output dimensions in Python (avoids FFmpeg expression issues on Windows)
            if source_width and source_height:
                longest_side = max(source_width, source_height)
                if longest_side <= target:
                    # Source is smaller than target - no scaling needed
                    vf = None
                elif source_width >= source_height:
                    # Landscape: scale width to target, height auto (divisible by 2)
                    new_width = target
                    new_height = int(source_height * target / source_width)
                    new_height = new_height - (new_height % 2)  # Make divisible by 2
                    vf = f"scale={new_width}:{new_height}"
                else:
                    # Portrait: scale height to target, width auto (divisible by 2)
                    new_height = target
                    new_width = int(source_width * target / source_height)
                    new_width = new_width - (new_width % 2)  # Make divisible by 2
                    vf = f"scale={new_width}:{new_height}"
            else:
                # Fallback - simple scale with auto height
                vf = f"scale={target}:-2"
        else:
            vf = None
            crf = '18'
            maxrate = '20M'
            bufsize = '40M'

        print(f"Transcode {quality}: source={source_width}x{source_height}, target={target}, vf={vf}")

        # Build FFmpeg command (All-Intra encoding for frame-accurate scrubbing)
        cmd = [
            FFMPEG_PATH,
            '-i', input_path,
            '-c:v', 'libx264',
            '-preset', encoder_preset,
            '-crf', crf,
            '-maxrate', maxrate,
            '-bufsize', bufsize,
            '-g', '1',               # Keyframe every frame (All-Intra)
            '-keyint_min', '1',
            '-bf', '0',              # No B-frames
        ]
        if vf:
            cmd.extend(['-vf', vf])
        cmd.extend([
            '-c:a', 'aac',
            '-b:a', '128k',
            '-movflags', '+faststart',
            '-progress', 'pipe:1',
            '-y',
            output_path
        ])

        process = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE
        )

        # Parse progress from stdout
        while True:
            line = await process.stdout.readline()
            if not line:
                break

            line_str = line.decode().strip()
            if line_str.startswith('out_time_ms='):
                try:
                    out_time_ms = int(line_str.split('=')[1])
                    current_time = out_time_ms / 1000000.0
                    if duration > 0:
                        local_progress = min(99, int((current_time / duration) * 100))
                        transcode_jobs[job_id]['progress'] = progress_offset + int(local_progress * progress_scale / 100)
                        transcode_jobs[job_id]['current_time'] = current_time
                except (ValueError, KeyError, ZeroDivisionError):
                    pass

        await process.wait()
        if process.returncode != 0:
            stderr_output = await process.stderr.read()
            print(f"FFmpeg failed for {quality}: {stderr_output.decode()[-500:]}")
            return False
        return True

    except Exception as e:
        transcode_jobs[job_id]['error'] = str(e)
        print(f"Transcode exception for {quality}: {e}")
        return False


async def extract_video_frame(video_path: str, output_path: str, timestamp: str = "00:00:01", max_size: int = 256) -> bool:
    """
    Extract a single frame from video and save as optimized image.

    Args:
        video_path: Path to video file
        output_path: Path for output JPEG file
        timestamp: Time position to extract (default 1 second)
        max_size: Maximum dimension for output, default 256px

    Returns:
        True if successful, False otherwise
    """
    # Scale filter for max dimension while maintaining aspect ratio
    scale_filter = f"scale='if(gt(iw,ih),{max_size},-2)':'if(gt(iw,ih),-2,{max_size})'"

    cmd = [
        FFMPEG_PATH,
        '-i', video_path,
        '-ss', timestamp,
        '-vframes', '1',
        '-vf', scale_filter,
        '-q:v', '2',  # High quality JPEG
        '-y',
        output_path
    ]

    try:
        process = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE
        )
        await process.wait()
        return os.path.exists(output_path)
    except Exception as e:
        print(f"Video frame extraction error: {e}")
        return False


async def generate_thumbnail(video_path: str, clip_id: str, max_size: int = 256) -> str:
    """Generate thumbnail from video using unified processing."""
    thumbnail_path = os.path.join(THUMBNAILS_DIR, f"{clip_id}.jpg")

    success = await extract_video_frame(video_path, thumbnail_path, "00:00:01", max_size)

    if success:
        return f"{clip_id}.jpg"
    return None


async def process_image_upload(job_id: str, original_path: str, project_id: str, original_filename: str):
    """Process uploaded image: resize if needed, generate thumbnail, and save.

    - Resizes to max 4096px on longest side (preserving aspect ratio)
    - Converts to JPG if not already JPG/JPEG or if filesize > 3MB
    - Generates 256px thumbnail
    - No proxies for images - just one full-quality file
    """
    try:
        transcode_jobs[job_id]['status'] = 'processing'
        transcode_jobs[job_id]['progress'] = 10

        # Open image with PIL
        img = Image.open(original_path)

        # Convert to RGB if necessary (handles RGBA, P mode, etc.)
        if img.mode in ('RGBA', 'P', 'LA'):
            # Create white background for transparency
            background = Image.new('RGB', img.size, (255, 255, 255))
            if img.mode == 'P':
                img = img.convert('RGBA')
            background.paste(img, mask=img.split()[-1] if img.mode == 'RGBA' else None)
            img = background
        elif img.mode != 'RGB':
            img = img.convert('RGB')

        transcode_jobs[job_id]['progress'] = 30

        # Get original dimensions
        width, height = img.size
        transcode_jobs[job_id]['source_resolution'] = f"{width}x{height}"

        # Resize if larger than 4096px on longest side
        max_dimension = 4096
        if width > max_dimension or height > max_dimension:
            if width > height:
                new_width = max_dimension
                new_height = int(height * (max_dimension / width))
            else:
                new_height = max_dimension
                new_width = int(width * (max_dimension / height))
            img = img.resize((new_width, new_height), Image.Resampling.LANCZOS)
            transcode_jobs[job_id]['resized'] = f"{new_width}x{new_height}"

        transcode_jobs[job_id]['progress'] = 50

        # Generate output filename
        original_stem = Path(original_filename).stem
        base_filename = f"{project_id[:8]}_{original_stem}"
        output_filename = f"{base_filename}.jpg"
        output_path = os.path.join(TRANSCODED_DIR, output_filename)

        # Save as JPG with good quality
        img.save(output_path, 'JPEG', quality=92, optimize=True)

        transcode_jobs[job_id]['progress'] = 70

        # Generate thumbnail (256px max)
        thumbnail_filename = f"{job_id}.jpg"
        thumbnail_path = os.path.join(THUMBNAILS_DIR, thumbnail_filename)

        thumb_size = 256
        thumb_img = img.copy()
        if thumb_img.width > thumb_size or thumb_img.height > thumb_size:
            thumb_img.thumbnail((thumb_size, thumb_size), Image.Resampling.LANCZOS)
        thumb_img.save(thumbnail_path, 'JPEG', quality=85)

        transcode_jobs[job_id]['progress'] = 90

        # Add to project
        await add_clip_to_project(
            project_id,
            output_filename,
            thumbnail_filename,
            proxies=None,
            default_quality=None,
            media_type='image'
        )

        transcode_jobs[job_id]['status'] = 'done'
        transcode_jobs[job_id]['progress'] = 100
        transcode_jobs[job_id]['final_filename'] = output_filename
        transcode_jobs[job_id]['thumbnail'] = thumbnail_filename
        transcode_jobs[job_id]['media_type'] = 'image'

        # Clean up original file
        try:
            os.remove(original_path)
        except OSError as e:
            print(f"Warning: Could not remove original file {original_path}: {e}")

    except Exception as e:
        print(f"Image processing error: {e}")
        transcode_jobs[job_id]['status'] = 'error'
        transcode_jobs[job_id]['error'] = str(e)


async def process_html_upload(job_id: str, original_path: str, project_id: str, original_filename: str):
    """Store an uploaded single-file HTML page as a reviewable clip.

    The file is kept byte-for-byte. Each upload gets its own file on disk so
    older versions (and the comments made on them) keep pointing at what was reviewed.
    Pages are only ever served through /html/... (sandboxed, token-gated), never /video.
    """
    try:
        transcode_jobs[job_id]['status'] = 'processing'
        transcode_jobs[job_id]['progress'] = 30

        size = os.path.getsize(original_path)
        if size > MAX_HTML_BYTES:
            raise ValueError(f"HTML file is too large ({size // (1024 * 1024)} MB, max {MAX_HTML_BYTES // (1024 * 1024)} MB)")

        original_stem = Path(original_filename).stem
        logical_filename = f"{project_id[:8]}_{original_stem}.html"
        stored_filename = f"{project_id[:8]}_{original_stem}_{job_id}.html"
        shutil.move(original_path, os.path.join(TRANSCODED_DIR, stored_filename))

        transcode_jobs[job_id]['status'] = 'generating_thumbnail'
        transcode_jobs[job_id]['progress'] = 50
        thumbnail = f"{job_id}.jpg"
        if not await render_html_preview(os.path.join(TRANSCODED_DIR, stored_filename),
                                         os.path.join(THUMBNAILS_DIR, thumbnail)):
            thumbnail = None

        transcode_jobs[job_id]['progress'] = 90

        await add_clip_to_project(
            project_id,
            logical_filename,
            thumbnail=thumbnail,
            media_type='html',
            stored_filename=stored_filename,
        )

        transcode_jobs[job_id]['status'] = 'done'
        transcode_jobs[job_id]['progress'] = 100
        transcode_jobs[job_id]['final_filename'] = stored_filename
        transcode_jobs[job_id]['media_type'] = 'html'
        transcode_jobs[job_id]['thumbnail'] = thumbnail

    except Exception as e:
        print(f"HTML processing error: {e}")
        transcode_jobs[job_id]['status'] = 'error'
        transcode_jobs[job_id]['error'] = str(e)
        try:
            os.remove(original_path)
        except OSError:
            pass


async def process_upload(job_id: str, original_path: str, project_id: str, original_filename: str):
    """Process uploaded file: transcode multiple proxies and generate thumbnail."""
    try:
        # Get source resolution to determine which proxies to generate
        width, height = await get_video_resolution(original_path)
        required_proxies = get_required_proxies(width, height)

        transcode_jobs[job_id]['source_resolution'] = f"{width}x{height}"
        transcode_jobs[job_id]['proxies_to_generate'] = required_proxies
        transcode_jobs[job_id]['proxies'] = {}

        # Generate output filename base - preserve original name for versioning
        original_stem = Path(original_filename).stem
        base_filename = f"{project_id[:8]}_{original_stem}"

        # Calculate progress scale for each quality
        num_proxies = len(required_proxies)
        progress_per_proxy = 90 // num_proxies  # 90% for transcoding, 10% for thumbnail

        # Generate each proxy quality
        proxy_files = {}
        default_quality = None

        for i, quality in enumerate(required_proxies):
            progress_offset = i * progress_per_proxy
            output_filename = f"{base_filename}_{quality}.mp4"
            output_path = os.path.join(TRANSCODED_DIR, output_filename)

            transcode_jobs[job_id]['current_quality'] = quality

            success = await transcode_video(
                job_id,
                original_path,
                output_path,
                quality=quality,
                progress_offset=progress_offset,
                progress_scale=progress_per_proxy,
                source_width=width,
                source_height=height
            )

            if success and os.path.exists(output_path):
                proxy_files[quality] = output_filename
                transcode_jobs[job_id]['proxies'][quality] = output_filename

                # Set default quality (highest available)
                if default_quality is None or PROXY_PRESETS[quality]['target'] > PROXY_PRESETS.get(default_quality, {}).get('target', 0):
                    default_quality = quality
            else:
                print(f"Transcode failed for {quality}: success={success}, exists={os.path.exists(output_path)}")

        if proxy_files:
            # Generate thumbnail using highest quality proxy
            transcode_jobs[job_id]['status'] = 'generating_thumbnail'
            transcode_jobs[job_id]['progress'] = 95

            highest_quality_file = proxy_files.get(default_quality, list(proxy_files.values())[0])
            thumbnail_path = os.path.join(TRANSCODED_DIR, highest_quality_file)
            thumbnail = await generate_thumbnail(thumbnail_path, job_id)

            # Add to project with proxy info
            await add_clip_to_project(
                project_id,
                f"{base_filename}.mp4",  # Base filename for clip identification
                thumbnail,
                proxies=proxy_files,
                default_quality=default_quality
            )

            transcode_jobs[job_id]['status'] = 'done'
            transcode_jobs[job_id]['progress'] = 100
            transcode_jobs[job_id]['final_filename'] = f"{base_filename}.mp4"
            transcode_jobs[job_id]['thumbnail'] = thumbnail
            transcode_jobs[job_id]['default_quality'] = default_quality

            # Clean up original file
            try:
                os.remove(original_path)
            except OSError as e:
                print(f"Warning: Could not remove original file {original_path}: {e}")
        else:
            transcode_jobs[job_id]['status'] = 'error'
            transcode_jobs[job_id]['error'] = 'All transcodes failed'

    except Exception as e:
        transcode_jobs[job_id]['status'] = 'error'
        transcode_jobs[job_id]['error'] = str(e)


async def transcode_worker():
    """Worker that processes transcode/processing jobs sequentially."""
    global transcode_queue
    while True:
        job_data = await transcode_queue.get()
        try:
            # Detect media type and route to appropriate processor
            media_type = get_media_type(job_data['original_filename'])

            if media_type == 'image':
                await process_image_upload(
                    job_data['job_id'],
                    job_data['original_path'],
                    job_data['project_id'],
                    job_data['original_filename']
                )
            elif media_type == 'html':
                await process_html_upload(
                    job_data['job_id'],
                    job_data['original_path'],
                    job_data['project_id'],
                    job_data['original_filename']
                )
            else:
                await process_upload(
                    job_data['job_id'],
                    job_data['original_path'],
                    job_data['project_id'],
                    job_data['original_filename']
                )
        except Exception as e:
            print(f"Processing worker error: {e}")
        finally:
            transcode_queue.task_done()


async def ensure_transcode_worker():
    """Ensure the transcode worker is running."""
    global transcode_queue, transcode_worker_running
    if transcode_queue is None:
        transcode_queue = asyncio.Queue()
    if not transcode_worker_running:
        transcode_worker_running = True
        asyncio.create_task(transcode_worker())


class ConnectionManager:
    """Review sessions: synced playback, shared cursors and live drawing.

    A user can have the same session open in several tabs, so connections are
    kept per socket while presence (user_states) is per user.
    """

    def __init__(self):
        # session_id -> {connection id -> (websocket, user_id)}
        self.active_connections: Dict[str, Dict[int, tuple]] = {}

    async def connect(self, websocket: WebSocket, session_id: str, user_id: str, user_name: Optional[str] = None) -> int:
        await websocket.accept()
        conn_id = id(websocket)
        self.active_connections.setdefault(session_id, {})[conn_id] = (websocket, user_id)

        states = user_states.setdefault(session_id, {})
        if user_id in states:
            states[user_id]["name"] = user_name or user_id
        else:
            states[user_id] = {
                "id": user_id,
                "name": user_name or user_id,
                "frame": 0,
                "playing": False,
                "cursor": None,
                "color": f"hsl({hash(user_id) % 360}, 70%, 50%)"
            }

        # Track user in session
        if session_id in sessions and user_id not in sessions[session_id]["users"]:
            sessions[session_id]["users"].append(user_id)
        return conn_id

    def disconnect(self, session_id: str, conn_id: int) -> Optional[str]:
        """Drop a connection. Returns the user id if that was the user's last tab in the session."""
        conns = self.active_connections.get(session_id, {})
        entry = conns.pop(conn_id, None)
        if not conns:
            self.active_connections.pop(session_id, None)
        if entry is None:
            return None
        user_id = entry[1]
        if any(uid == user_id for _, uid in conns.values()):
            return None

        if session_id in user_states:
            user_states[session_id].pop(user_id, None)
        if session_id in sessions and user_id in sessions[session_id]["users"]:
            sessions[session_id]["users"].remove(user_id)
            # Track when session became empty for cleanup
            if len(sessions[session_id]["users"]) == 0:
                sessions[session_id]["lastUserActivity"] = datetime.now().isoformat()
        return user_id

    async def broadcast(self, session_id: str, message: dict, exclude: int = None):
        """Send to every connection in the session, except connection `exclude`."""
        async def safe_send(ws):
            try:
                await ws.send_json(message)
            except Exception:
                pass  # Client disconnected, ignore

        sends = [
            safe_send(ws)
            for conn_id, (ws, _) in list(self.active_connections.get(session_id, {}).items())
            if conn_id != exclude
        ]
        if sends:
            await asyncio.gather(*sends)

    def get_users(self, session_id: str) -> List[dict]:
        if session_id not in user_states:
            return []
        return list(user_states[session_id].values())


manager = ConnectionManager()


@app.get("/")
async def root():
    return index_response()


# ============ Projects API ============

@app.get("/api/projects")
async def list_projects(user: Optional[dict] = Depends(get_current_user)):
    """List projects the user has access to. Admins see all projects."""
    # If not authenticated, return empty list
    if not user:
        return {"projects": []}

    # Use access-controlled project list
    accessible = db_list_accessible_projects(user["id"])

    return {"projects": accessible}


@app.post("/api/projects")
async def create_project(data: dict, user: dict = Depends(require_permission(Permission.PROJECT_CREATE))):
    """Create a new project (requires authentication).

    The creator automatically gets full access (owner) to the project.
    """
    project_id = str(uuid.uuid4())[:8]
    name = data.get("name", "Untitled Project")
    created_by = user.get("id")  # Use user ID for created_by

    # Create in database (this also grants access to creator)
    project = db_create_project(project_id, name, created_by)

    # Also keep in memory
    projects[project_id] = project

    await live.to_all_users({"type": "projects_changed"})

    return {"project_id": project_id, "project": projects[project_id]}


@app.get("/api/projects/{project_id}")
async def get_project(project_id: str, principal: Optional[dict] = Depends(get_principal)):
    """Get a project with all its data (project members or share-link guests)."""
    require_project_viewer(principal, project_id)
    return _project_payload(project_id)


def _project_payload(project_id: str):
    """Build the project response (no access check)."""
    if project_id not in projects:
        return {"error": "Project not found"}

    project = projects[project_id]

    # Get first active video for backwards compatibility
    video = None
    clips = project.get('clips', {})
    for base_name, clip_data in clips.items():
        active_version = clip_data.get('activeVersion', 1)
        version_data = next((v for v in clip_data['versions'] if v['version'] == active_version), None)
        if version_data:
            video = version_data['filename']
            break

    return {
        "id": project_id,
        "name": project["name"],
        "video": video,
        "clips": clips,
        "comments": project.get("comments", []),
        "annotations": project.get("annotations", []),
        "createdAt": project.get("createdAt"),
        "createdBy": project.get("createdBy"),
        "coverImage": project.get("coverImage")
    }


@app.post("/api/projects/{project_id}/cover")
async def upload_cover(project_id: str, file: UploadFile = File(...), user: dict = Depends(require_permission(Permission.PROJECT_UPDATE))):
    """Upload a cover image for a project. Automatically resizes to max 256px. Requires project access."""
    if project_id not in projects:
        raise HTTPException(status_code=404, detail="Project not found")
    require_project_access(user, project_id)

    # Save original file temporarily
    temp_filename = f"temp_{project_id}_{safe_upload_name(file.filename)}"
    temp_path = os.path.join(UPLOAD_DIR, temp_filename)

    with open(temp_path, "wb") as f:
        content = await file.read()
        f.write(content)

    # Process and save cover image (max 256px)
    cover_filename = f"{project_id}_cover.jpg"
    cover_path = os.path.join(COVERS_DIR, cover_filename)

    success = await process_image(temp_path, cover_path, max_size=256, quality=90)

    # Clean up temp file
    try:
        os.remove(temp_path)
    except OSError as e:
        print(f"Warning: Could not remove temp file {temp_path}: {e}")

    if not success:
        return {"error": "Failed to process image"}

    # Update project in memory and database
    cover_url = f"/covers/{cover_filename}"
    projects[project_id]["coverImage"] = cover_url
    db_update_project_cover(project_id, cover_url)

    await live.to_all_users({"type": "projects_changed"})

    return {"coverImage": cover_url}


@app.delete("/api/projects/{project_id}")
async def delete_project(project_id: str, user: dict = Depends(require_permission(Permission.PROJECT_DELETE))):
    """Delete a project and all its files (requires admin permission)."""
    if project_id not in projects:
        raise HTTPException(status_code=404, detail="Project not found")

    # Delete from database and get info about files to delete
    deleted_info = db_delete_project(project_id)

    if not deleted_info.get("deleted"):
        raise HTTPException(status_code=500, detail="Failed to delete project from database")

    # Delete physical clip files
    deleted_files = []
    for clip_file in deleted_info.get("clips", []):
        file_path = os.path.join(TRANSCODED_DIR, clip_file)
        if os.path.exists(file_path):
            try:
                os.remove(file_path)
                deleted_files.append(clip_file)
            except Exception as e:
                print(f"Failed to delete clip file {clip_file}: {e}")

    # Delete thumbnails
    for thumb_file in deleted_info.get("thumbnails", []):
        file_path = os.path.join(THUMBNAILS_DIR, thumb_file)
        if os.path.exists(file_path):
            try:
                os.remove(file_path)
                deleted_files.append(thumb_file)
            except Exception as e:
                print(f"Failed to delete thumbnail {thumb_file}: {e}")

    # Delete cover image
    cover = deleted_info.get("cover")
    if cover:
        # Cover URL is like "/covers/xyz_cover.jpg", extract filename
        cover_filename = cover.split("/")[-1]
        cover_path = os.path.join(COVERS_DIR, cover_filename)
        if os.path.exists(cover_path):
            try:
                os.remove(cover_path)
                deleted_files.append(cover_filename)
            except Exception as e:
                print(f"Failed to delete cover {cover_filename}: {e}")

    # Remove from memory
    if project_id in projects:
        del projects[project_id]

    # Remove any sessions that were using this project
    sessions_to_remove = [sid for sid, sess in sessions.items() if sess["project_id"] == project_id]
    for sid in sessions_to_remove:
        del sessions[sid]

    await live.to_project(project_id, {"type": "project_deleted", "project": project_id})
    await live.to_all_users({"type": "projects_changed"})

    return {
        "success": True,
        "deletedFiles": deleted_files,
        "sessionsRemoved": len(sessions_to_remove)
    }


# ============ Share Links API ============

@app.post("/api/projects/{project_id}/share")
async def create_share_link(project_id: str, data: dict = {}, user: dict = Depends(require_permission(Permission.SHARE_CREATE))):
    """Create a share link for a project (requires project access)."""
    if project_id not in projects:
        raise HTTPException(status_code=404, detail="Project not found")
    require_project_access(user, project_id)

    password = data.get("password")
    created_by = user.get("username")
    expires_at = data.get("expiresAt")

    link = db_create_share_link(project_id, password, created_by, expires_at)

    return {
        "link": link,
        "url": f"/s/{link['id']}"
    }


@app.get("/api/projects/{project_id}/share")
async def get_share_links(project_id: str, user: dict = Depends(require_permission(Permission.SHARE_READ))):
    """Get all share links for a project (requires project access)."""
    if project_id not in projects:
        raise HTTPException(status_code=404, detail="Project not found")
    require_project_access(user, project_id)

    links = db_list_share_links(project_id)
    return {"links": links}


@app.get("/api/share/all")
async def get_all_share_links(user: dict = Depends(require_permission(Permission.SHARE_READ))):
    """Get all share links grouped by project (requires authentication)."""
    all_links = db_list_all_share_links()

    # Group by project
    grouped = {}
    access_cache = {}
    for link in all_links:
        project_id = link["projectId"]
        if project_id not in access_cache:
            access_cache[project_id] = db_check_project_access(user["id"], project_id)
        if not access_cache[project_id]:
            continue
        if project_id not in grouped:
            project = projects.get(project_id, {})
            grouped[project_id] = {
                "projectId": project_id,
                "projectName": project.get("name", "Unknown Project"),
                "links": []
            }
        grouped[project_id]["links"].append(link)

    return {"projects": list(grouped.values())}


@app.get("/api/share/{link_id}")
async def get_share_link_info(link_id: str):
    """Get info about a share link (for access flow)."""
    link = db_get_share_link(link_id)

    if not link:
        return {"error": "Link not found"}

    if not link["isActive"]:
        return {"error": "Link is no longer active"}

    # Check expiration
    if link["expiresAt"]:
        expires_str = link["expiresAt"].replace("Z", "+00:00")
        expires = datetime.fromisoformat(expires_str)
        if datetime.now(expires.tzinfo) > expires:
            return {"error": "Link has expired"}

    # Return safe info (no password hash)
    return {
        "id": link["id"],
        "projectId": link["projectId"],
        "hasPassword": link["hasPassword"],
        "projectName": projects.get(link["projectId"], {}).get("name", "Unknown")
    }


@app.post("/api/share/{link_id}/access")
async def validate_share_link_access(link_id: str, request: Request, response: Response, data: dict = {}):
    """Validate access to a share link (check password if required)."""
    link = db_get_share_link(link_id)

    if not link:
        return {"error": "Link not found", "valid": False}

    if not link["isActive"]:
        return {"error": "Link is no longer active", "valid": False}

    # Check expiration
    if link["expiresAt"]:
        expires_str = link["expiresAt"].replace("Z", "+00:00")
        expires = datetime.fromisoformat(expires_str)
        if datetime.now(expires.tzinfo) > expires:
            return {"error": "Link has expired", "valid": False}

    # Check password if required
    if link["hasPassword"]:
        password = data.get("password", "")
        if not db_validate_share_link_password(link_id, password):
            return {"error": "Invalid password", "valid": False}

    # Increment access count
    db_increment_share_link_access(link_id)

    # Return project info plus a token scoped to this project only. The guest gets a
    # session (max a day) so they are logged out when idle, like users.
    project_id = link["projectId"]
    guest_id = f"guest_{secrets.token_hex(6)}"
    guest_seconds = JWT_EXPIRATION_HOURS * 3600
    guest_token = create_jwt_token(
        user_id=guest_id,
        username="Guest",
        is_admin=False,
        role="guest",
        extra_claims={
            "scope": "share", "project_id": project_id, "share_link_id": link_id,
            "sid": auth_sessions.create(guest_id, max_age=guest_seconds),
        },
    )
    set_guest_media_cookie(response, request, project_id, guest_token)
    return {
        "valid": True,
        "projectId": project_id,
        "project": projects.get(project_id, {}),
        "guestToken": guest_token,
        "idleTimeout": auth_sessions.IDLE_TIMEOUT,
        "idleWarning": auth_sessions.IDLE_WARNING,
    }


@app.delete("/api/share/{link_id}")
async def delete_share_link(link_id: str, permanent: bool = True, user: dict = Depends(require_permission(Permission.SHARE_DELETE))):
    """Delete or deactivate a share link (requires authentication)."""
    if permanent:
        success = db_delete_share_link(link_id)
    else:
        success = db_deactivate_share_link(link_id)

    # Guests who are in through this link right now are shown out at once
    guest_sids = live.guest_sessions(link_id)
    for sid in guest_sids:
        auth_sessions.end(sid)
    await close_session_sockets(guest_sids)

    return {"success": success}


@app.get("/s/{link_id}")
async def share_link_page(link_id: str):
    """Serve the main page for share link access."""
    return index_response()


@app.get("/invite/{invite_id}")
async def invite_link_page(invite_id: str):
    """Serve the main page for invite link registration."""
    return index_response()


@app.get("/dev/ui")
async def dev_ui_page():
    """Serve the main page for the UI component demo (the bundle shows it to admins only)."""
    return index_response()


# Routes of the Pages app (PLAN.md 5.3). The page itself decides what to show from the URL.
@app.get("/me")
@app.get("/me/page/{page_id}")
@app.get("/p/{project_id}/pages")
@app.get("/p/{project_id}/page/{page_id}")
@app.get("/p/{project_id}/review")
async def app_route_page():
    """Serve the main page for the in-app routes."""
    return index_response()


@app.post("/api/guests/track")
async def track_guest(data: dict, principal: Optional[dict] = Depends(get_principal)):
    """Track a guest joining via share link (requires the share-link guest token)."""
    name = data.get("name", "").strip()
    project_id = data.get("projectId")
    share_link_id = data.get("shareLinkId")
    require_project_viewer(principal, project_id)

    if not name or not project_id:
        raise HTTPException(status_code=400, detail="Name and project ID required")

    email = clean_email(data.get("email"))
    token_sub = principal["id"] if principal.get("is_guest") else None
    guest = db_track_guest(name[:80], project_id, share_link_id, email=email, token_sub=token_sub)
    return {"guest": guest}


@app.patch("/api/projects/{project_id}/clips/{base_name}/status")
async def update_clip_status(project_id: str, base_name: str, data: dict, user: dict = Depends(require_permission(Permission.PROJECT_UPDATE))):
    """Update the status of a clip."""
    if project_id not in projects:
        raise HTTPException(status_code=404, detail="Project not found")
    require_project_access(user, project_id, require_review=True)

    # Check if clip exists in memory
    if base_name not in projects[project_id].get("clips", {}):
        raise HTTPException(status_code=404, detail="Clip not found")

    status_id = data.get("statusId")  # Can be None to clear status

    # Update in-memory data
    if status_id:
        # Get status info
        statuses = db_list_statuses()
        status = next((s for s in statuses if s["id"] == status_id), None)
        if status:
            projects[project_id]["clips"][base_name]["status"] = status
            projects[project_id]["clips"][base_name]["statusId"] = status_id
    else:
        # Remove status
        projects[project_id]["clips"][base_name].pop("status", None)
        projects[project_id]["clips"][base_name].pop("statusId", None)

    # Mark for write-back persistence
    cache_manager.mark_clip_dirty(project_id, base_name)

    await live.to_project(project_id, {
        "type": "clip_updated", "baseName": base_name, "clip": projects[project_id]["clips"][base_name]
    })

    return {"success": True}


@app.delete("/api/projects/{project_id}/clips/{base_name}")
async def delete_clip(project_id: str, base_name: str, user: dict = Depends(require_permission(Permission.PROJECT_UPDATE))):
    """Delete a clip and all its versions (requires project access)."""
    if project_id not in projects:
        raise HTTPException(status_code=404, detail="Project not found")
    require_project_access(user, project_id, require_review=True)

    # Delete from database and get file info
    deleted_info = db_delete_clip(project_id, base_name)

    if not deleted_info["success"]:
        raise HTTPException(status_code=404, detail="Clip not found")

    # Delete physical files
    deleted_files = []

    # Delete main files (for images) and proxies (for videos)
    for filename in deleted_info["files"]:
        file_path = os.path.join(TRANSCODED_DIR, filename)
        if os.path.exists(file_path):
            try:
                os.remove(file_path)
                deleted_files.append(filename)
            except Exception as e:
                print(f"Failed to delete file {filename}: {e}")

    # Delete proxy files
    for proxy_file in deleted_info["proxies"]:
        file_path = os.path.join(TRANSCODED_DIR, proxy_file)
        if os.path.exists(file_path):
            try:
                os.remove(file_path)
                deleted_files.append(proxy_file)
            except Exception as e:
                print(f"Failed to delete proxy {proxy_file}: {e}")

    # Delete thumbnails
    for thumb_file in deleted_info["thumbnails"]:
        file_path = os.path.join(THUMBNAILS_DIR, thumb_file)
        if os.path.exists(file_path):
            try:
                os.remove(file_path)
                deleted_files.append(thumb_file)
            except Exception as e:
                print(f"Failed to delete thumbnail {thumb_file}: {e}")

    # Update in-memory data
    if base_name in projects[project_id].get("clips", {}):
        del projects[project_id]["clips"][base_name]

    await live.to_project(project_id, {"type": "clip_deleted", "baseName": base_name})

    return {
        "success": True,
        "deletedFiles": len(deleted_files)
    }


# ============ Sessions API ============

@app.get("/api/sessions")
async def list_sessions(user: Optional[dict] = Depends(get_current_user)):
    """List all active sessions. Requires authentication to see full list."""
    # If not authenticated, return empty list
    if not user:
        return {"sessions": []}

    # Start cleanup worker if not running
    await ensure_session_cleanup_worker()

    active_sessions = []
    for sess_id, sess in sessions.items():
        if not can_view_project(user, sess["project_id"]):
            continue
        project = projects.get(sess["project_id"], {})
        active_sessions.append({
            "id": sess_id,
            "project_id": sess["project_id"],
            "project_name": project.get("name", "Unknown"),
            "session_name": sess.get("name", project.get("name", "Unknown")),
            "user_count": len(sess["users"]),
            "users": [user_states.get(sess_id, {}).get(uid, {"name": uid}) for uid in sess["users"]],
            "startedAt": sess["startedAt"],
            "startedBy": sess["startedBy"]
        })
    return {"sessions": active_sessions}


@app.get("/api/projects/{project_id}/sessions")
async def list_project_sessions(project_id: str, principal: Optional[dict] = Depends(get_principal)):
    """List active sessions for a specific project (members or share-link guests)."""
    if project_id not in projects:
        raise HTTPException(status_code=404, detail="Project not found")
    require_project_viewer(principal, project_id)

    project = projects.get(project_id, {})
    project_sessions = []
    for sess_id, sess in sessions.items():
        if sess["project_id"] == project_id:
            project_sessions.append({
                "id": sess_id,
                "project_id": sess["project_id"],
                "session_name": sess.get("name", project.get("name", "Unknown")),
                "user_count": len(sess["users"]),
                "users": [user_states.get(sess_id, {}).get(uid, {"name": uid}) for uid in sess["users"]],
                "startedAt": sess["startedAt"],
                "startedBy": sess["startedBy"]
            })
    return {"sessions": project_sessions}


@app.post("/api/sessions")
async def create_session(data: dict, user: Optional[dict] = Depends(get_principal)):
    """Create a new session for a project."""
    project_id = data.get("project_id")
    user_name = data.get("name", user.get("username") if user else "Anonymous")
    session_name = data.get("session_name")  # Optional custom session name

    if project_id and project_id in projects:
        require_project_viewer(user, project_id)
    else:
        # No (valid) project given: creating a new project needs a real user with create rights
        if not user or user.get("is_guest") or not has_permission(user.get("role", "guest"), Permission.PROJECT_CREATE):
            raise HTTPException(status_code=403, detail="Permission denied: project:create")
        project_id = str(uuid.uuid4())[:8]
        project_name = data.get("project_name", f"Project {project_id}")
        # Create in database and keep in memory
        project = db_create_project(project_id, project_name, user["id"])
        projects[project_id] = project

    # Use session name if provided, otherwise use project name
    project = projects.get(project_id, {})
    display_name = session_name or project.get("name", f"Session {project_id[:4]}")

    session_id = str(uuid.uuid4())[:8]
    sessions[session_id] = {
        "project_id": project_id,
        "name": display_name,
        "users": [],
        "startedAt": datetime.now().isoformat(),
        "startedBy": user_name,
        "lastUserActivity": None  # Will be set when users leave
    }

    # Start cleanup worker if not running
    await ensure_session_cleanup_worker()

    return {
        "session_id": session_id,
        "project_id": project_id,
        "project": projects[project_id],
        "session_name": display_name
    }


@app.post("/api/sessions/{session_id}/join")
async def join_session(session_id: str, data: dict, principal: Optional[dict] = Depends(get_principal)):
    """Join an existing session."""
    if session_id not in sessions:
        raise HTTPException(status_code=404, detail="Session not found")

    user_name = data.get("name", "Anonymous")
    project_id = sessions[session_id]["project_id"]
    require_project_viewer(principal, project_id)

    # Also verify project exists
    if project_id not in projects:
        raise HTTPException(status_code=404, detail="Project not found")

    return {
        "session_id": session_id,
        "project_id": project_id,
        "project": projects.get(project_id, {})
    }


@app.delete("/api/sessions/{session_id}")
async def end_session(session_id: str, user: dict = Depends(require_permission(Permission.SESSION_DELETE))):
    """End a session (requires authentication)."""
    if session_id in sessions:
        # Broadcast session_ended to all connected users
        await manager.broadcast(session_id, {
            "type": "session_ended",
            "reason": "Session was closed by admin"
        })

        # Close all WebSocket connections for this session
        if session_id in manager.active_connections:
            for ws, _ in list(manager.active_connections[session_id].values()):
                try:
                    await ws.close(code=1000, reason="Session ended")
                except Exception:
                    pass
            del manager.active_connections[session_id]

        # Clean up user states (FIX: prevent memory leak)
        if session_id in user_states:
            del user_states[session_id]

        # Delete session
        del sessions[session_id]

    return {"success": True}


@app.get("/api/active-session")
async def get_active_session(user: Optional[dict] = Depends(get_current_user)):
    """Get an active session the user can access (for quick join)."""
    sess_id = _first_accessible_session(user)
    if sess_id:
        sess = sessions[sess_id]
        project = projects.get(sess["project_id"], {})
        return {
            "active": True,
            "session_id": sess_id,
            "project_id": sess["project_id"],
            "project_name": project.get("name", "Unknown"),
            "session_name": sess.get("name", project.get("name", "Unknown")),
            "user_count": len(sess["users"])
        }
    return {"active": False}


def _first_accessible_session(user: Optional[dict]) -> Optional[str]:
    """First active session whose project the user can access."""
    if not user:
        return None
    for sess_id, sess in sessions.items():
        if can_view_project(user, sess["project_id"]):
            return sess_id
    return None


@app.post("/api/join-session")
async def quick_join_session(data: dict, user: dict = Depends(require_permission(Permission.PROJECT_CREATE))):
    """Quick join - join an accessible active session or create a new one."""
    user_name = data.get("name", "Anonymous")

    # If there's an active session, join it
    sess_id = _first_accessible_session(user)
    if sess_id:
        sess = sessions[sess_id]
        return {
            "session_id": sess_id,
            "project_id": sess["project_id"],
            "project": projects.get(sess["project_id"], {}),
            "is_new": False
        }
    else:
        # Create new project and session
        project_id = str(uuid.uuid4())[:8]
        project_name = f"Project {project_id}"
        # Create in database and keep in memory
        project = db_create_project(project_id, project_name, user["id"])
        projects[project_id] = project

        session_id = str(uuid.uuid4())[:8]
        sessions[session_id] = {
            "project_id": project_id,
            "users": [],
            "startedAt": datetime.now().isoformat(),
            "startedBy": user_name
        }

        return {
            "session_id": session_id,
            "project_id": project_id,
            "project": projects[project_id],
            "is_new": True
        }


# ============ Clips API with Transcoding ============

@app.post("/api/projects/{project_id}/clips")
async def upload_clips(project_id: str, background_tasks: BackgroundTasks, files: List[UploadFile] = File(...), user: dict = Depends(require_permission(Permission.PROJECT_UPDATE))):
    """Upload one or more clips to a project with transcoding. Requires project access."""
    if project_id not in projects:
        raise HTTPException(status_code=404, detail="Project not found")
    require_project_access(user, project_id, require_review=True)

    jobs = []
    for file in files:
        # Save original file using streaming (chunks) to avoid memory issues
        job_id = str(uuid.uuid4())[:8]
        upload_name = safe_upload_name(file.filename)
        original_filename = f"original_{job_id}_{upload_name}"
        original_path = os.path.join(UPLOAD_DIR, original_filename)

        # Stream to disk in 1MB chunks instead of loading entire file into memory
        with open(original_path, "wb") as f:
            while chunk := await file.read(1024 * 1024):  # 1MB chunks
                f.write(chunk)

        # Create transcode job
        transcode_jobs[job_id] = {
            "filename": upload_name,
            "status": "queued",
            "progress": 0,
            "duration": 0,
            "current_time": 0
        }

        # Add to queue for sequential processing
        await ensure_transcode_worker()
        await transcode_queue.put({
            'job_id': job_id,
            'original_path': original_path,
            'project_id': project_id,
            'original_filename': upload_name
        })

        jobs.append({
            "job_id": job_id,
            "filename": upload_name
        })

    return {"jobs": jobs}


@app.get("/api/transcode-status/{job_id}")
async def get_transcode_status(job_id: str):
    """Get status of a transcode job."""
    if job_id in transcode_jobs:
        return transcode_jobs[job_id]
    return {"error": "Job not found"}


@app.get("/api/transcode-status")
async def get_all_transcode_status(job_ids: str = Query(...)):
    """Get status of multiple transcode jobs."""
    ids = job_ids.split(',')
    return {
        "jobs": {
            job_id: transcode_jobs.get(job_id, {"error": "Not found"})
            for job_id in ids
        }
    }


# ============ HTML Review Pages ============

HTML_TOKEN_HOURS = 4
HTML_BRIDGE_TAG = b'<script src="/static/js/html-review-bridge.js?v=3"></script>'


def _find_clip_version(project_id: str, base_name: str, version: int) -> Optional[dict]:
    clip = projects.get(project_id, {}).get("clips", {}).get(base_name)
    if not clip:
        return None
    return next((v for v in clip.get("versions", []) if v.get("version") == version), None)


@app.get("/api/projects/{project_id}/clips/{base_name}/html-url")
async def get_html_review_url(project_id: str, base_name: str, version: int, principal: Optional[dict] = Depends(get_principal)):
    """Hand out a short-lived URL for one HTML clip version.

    The iframe can't send our Authorization header, so the URL carries a token
    that only unlocks this one file (it is rejected everywhere else).
    """
    if project_id not in projects:
        raise HTTPException(status_code=404, detail="Project not found")
    require_project_viewer(principal, project_id)

    clip_version = _find_clip_version(project_id, base_name, version)
    if not clip_version or clip_version.get("mediaType") != "html":
        raise HTTPException(status_code=404, detail="HTML clip not found")

    filename = clip_version["filename"]
    token = create_jwt_token(
        principal["id"],
        principal.get("username") or "viewer",
        False,
        role="media",
        expires_delta=timedelta(hours=HTML_TOKEN_HOURS),
        extra_claims={
            "scope": "media",
            "project_id": project_id,
            "file": filename,
            "guest": bool(principal.get("is_guest")),
        },
    )
    return {"url": f"/html/{quote(filename)}?t={token}", "expiresInHours": HTML_TOKEN_HOURS}


@app.get("/html/{filename}")
async def serve_html_page(filename: str, t: str = Query(...)):
    """Serve an uploaded HTML page for review.

    - Only with a media token for exactly this file.
    - `Content-Security-Policy: sandbox` gives the page an opaque origin, so its
      scripts can never read Cutline's storage or call the API as the viewer,
      even if the URL is opened directly in a tab.
    - A small bridge script is injected so the review UI can pick elements and show pins.
    """
    safe_filename = Path(filename).name
    if safe_filename != filename or '..' in filename or Path(filename).suffix.lower() not in {'.html', '.htm'}:
        raise HTTPException(status_code=400, detail="Invalid filename")

    payload = verify_jwt_token(t)
    if not payload or payload.get("scope") != "media" or payload.get("file") != safe_filename:
        raise HTTPException(status_code=403, detail="Link expired - reload the review page")
    project_id = payload.get("project_id")
    if project_id not in projects:
        raise HTTPException(status_code=404, detail="Project not found")
    # Logged-in users are re-checked so revoked access takes effect right away.
    if not payload.get("guest") and not db_check_project_access(payload.get("sub"), project_id):
        raise HTTPException(status_code=403, detail="Access denied")

    path = os.path.join(TRANSCODED_DIR, safe_filename)
    if not os.path.exists(path):
        raise HTTPException(status_code=404, detail="Page not found")

    with open(path, "rb") as f:
        data = f.read()

    # Inject the bridge as early as possible so it runs before the page's own scripts.
    head = re.search(rb'<head\b[^>]*>', data, re.IGNORECASE)
    if head:
        data = data[:head.end()] + HTML_BRIDGE_TAG + data[head.end():]
    else:
        data = HTML_BRIDGE_TAG + data

    return Response(
        content=data,
        media_type="text/html; charset=utf-8",
        headers={
            "Content-Security-Policy": "sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox allow-forms allow-modals allow-pointer-lock",
            "X-Content-Type-Options": "nosniff",
            # Don't leak the token to fonts/CDNs the page loads.
            "Referrer-Policy": "no-referrer",
            "Cache-Control": "private, no-store",
        },
    )


# ============ Video/Image and Thumbnail Serving ============

_media_owner: Dict[str, str] = {}  # media file name -> project id


def _media_project(name: str) -> Optional[str]:
    """The project a clip file, proxy or thumbnail belongs to."""
    project_id = _media_owner.get(name)
    if project_id in projects:
        return project_id
    # Unknown (or its project is gone): look again, clips may have been added since
    _media_owner.clear()
    for pid, project in projects.items():
        for clip in project.get("clips", {}).values():
            for version in clip.get("versions", []):
                names = [version.get("filename"), version.get("thumbnail"), *(version.get("proxies") or {}).values()]
                for media_name in names:
                    if media_name:
                        _media_owner[media_name] = pid
    return _media_owner.get(name)


def require_media_access(request: Request, name: str) -> None:
    """Media is for people who can open the project it belongs to (members and its share-link guests)."""
    principals = media_principals(request)
    if not principals:
        raise HTTPException(status_code=401, detail="Authentication required")
    project_id = _media_project(name)
    if not project_id:
        raise HTTPException(status_code=404, detail="Media not found")
    if not any(can_view_project(p, project_id) for p in principals):
        raise HTTPException(status_code=403, detail="Access denied")


MEDIA_HEADERS = {"Cache-Control": "private, max-age=3600"}


@app.get("/video/{filename}")
async def serve_media(filename: str, request: Request):
    """Serve transcoded video or processed image."""
    # Sanitize filename to prevent path traversal attacks
    safe_filename = Path(filename).name
    if safe_filename != filename or '..' in filename:
        raise HTTPException(status_code=400, detail="Invalid filename")

    # HTML pages must never be served from Cutline's own origin.
    if Path(safe_filename).suffix.lower() in {'.html', '.htm'}:
        raise HTTPException(status_code=404, detail="Media not found")

    require_media_access(request, safe_filename)

    # Detect media type from file extension
    ext = Path(safe_filename).suffix.lower()
    if ext in {'.jpg', '.jpeg'}:
        media_type = "image/jpeg"
    elif ext in {'.png'}:
        media_type = "image/png"
    elif ext in {'.gif'}:
        media_type = "image/gif"
    elif ext in {'.webp'}:
        media_type = "image/webp"
    else:
        media_type = "video/mp4"

    # Check transcoded directory first
    transcoded_path = os.path.join(TRANSCODED_DIR, safe_filename)
    if os.path.exists(transcoded_path):
        return FileResponse(transcoded_path, media_type=media_type, headers=MEDIA_HEADERS)

    # Fall back to uploads directory
    upload_path = os.path.join(UPLOAD_DIR, safe_filename)
    if os.path.exists(upload_path):
        return FileResponse(upload_path, media_type=media_type, headers=MEDIA_HEADERS)

    raise HTTPException(status_code=404, detail="Media not found")


@app.get("/thumbnail/{clip_id}")
async def serve_thumbnail(clip_id: str, request: Request):
    """Serve clip thumbnail."""
    # Sanitize clip_id to prevent path traversal attacks
    safe_clip_id = Path(clip_id).name
    if safe_clip_id != clip_id or '..' in clip_id:
        raise HTTPException(status_code=400, detail="Invalid clip ID")

    # Try with .jpg extension
    if not safe_clip_id.endswith('.jpg'):
        safe_clip_id = f"{safe_clip_id}.jpg"

    require_media_access(request, safe_clip_id)

    path = os.path.join(THUMBNAILS_DIR, safe_clip_id)
    if os.path.exists(path):
        return FileResponse(path, media_type="image/jpeg", headers=MEDIA_HEADERS)

    raise HTTPException(status_code=404, detail="Thumbnail not found")


# ============ Comments API ============

@app.get("/api/projects/{project_id}/comments/export")
async def export_project_comments(project_id: str, format: str = "md", clip: Optional[str] = None,
                                  fps: int = 24, principal: Optional[dict] = Depends(get_principal)):
    """Download a project's review comments as Markdown, CSV or JSON.

    Open to everyone who can already read the comments (members and share-link guests).
    `clip` limits the export to one clip.
    """
    require_project_viewer(principal, project_id)
    if project_id not in projects:
        raise HTTPException(status_code=404, detail="Project not found")
    if format not in EXPORT_FORMATS:
        raise HTTPException(status_code=400, detail="format must be md, csv or json")

    body, content_type, filename = export_comments(project_id, projects[project_id], format, clip=clip, fps=fps)
    return Response(content=body, media_type=content_type, headers={
        "Content-Disposition": f"attachment; filename*=UTF-8''{quote(filename)}",
        "Cache-Control": "no-store",
    })


def clean_comment_anchor(anchor) -> Optional[dict]:
    """Keep only the known fields of an HTML element anchor, with sane sizes."""
    if not isinstance(anchor, dict):
        return None

    def text(key, limit):
        value = anchor.get(key)
        return value[:limit] if isinstance(value, str) else None

    def num(key):
        value = anchor.get(key)
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            return None
        return max(-1.0, min(2.0, float(value)))  # fractions; small overshoot allowed

    cleaned = {
        "selector": text("selector", 1000),
        "hash": text("hash", 200),
        "state": text("state", 2000),  # page-provided view state (JSON string)
        "tag": text("tag", 40),
        "label": text("label", 120),
        "ox": num("ox"),
        "oy": num("oy"),
        "vx": num("vx"),
        "vy": num("vy"),
    }
    cleaned = {k: v for k, v in cleaned.items() if v is not None}
    return cleaned or None


MAX_COMMENT_TEXT = 10_000
MAX_DRAWING_BYTES = 2_000_000


def _comment_project(session_or_project_id: str, principal: Optional[dict]) -> str:
    """The project a comment request is about, after checking the caller may see it."""
    project_id = resolve_project_id(session_or_project_id)
    require_project_viewer(principal, project_id)
    if project_id not in projects:
        raise HTTPException(status_code=404, detail="Project not found")
    return project_id


def _find_comment(project_id: str, comment_id: str) -> dict:
    comment = next((c for c in projects[project_id]["comments"] if c.get("id") == comment_id), None)
    if not comment:
        raise HTTPException(status_code=404, detail="Comment not found")
    return comment


def _may_delete_comment(principal: dict, comment: dict) -> bool:
    """Admins delete anything, everyone else only what they wrote."""
    if principal.get("is_admin") or comment.get("user") == principal["id"]:
        return True
    # Comments from before logins had a stable id carry a random per-tab id; match those on the name
    return (
        not principal.get("is_guest")
        and str(comment.get("user") or "").startswith("user_")
        and comment.get("userName") == principal["username"]
    )


@app.post("/api/session/{session_id}/comment")
@app.post("/api/projects/{session_id}/comment")
async def add_comment(session_id: str, data: dict, request: Request, principal: Optional[dict] = Depends(get_principal)):
    """Add a review comment (project members and share-link guests).

    Who wrote it comes from the token, never from the request body.
    """
    # Anti-spam: rate limit comments by IP
    client_ip = request.client.host if request.client else "unknown"
    if not check_comment_rate_limit(client_ip):
        raise HTTPException(status_code=429, detail="Too many comments. Please slow down.")
    record_comment_attempt(client_ip)

    project_id = _comment_project(session_id, principal)

    text = data.get("text")
    text = text.strip()[:MAX_COMMENT_TEXT] if isinstance(text, str) else ""
    drawing = data.get("drawing") if isinstance(data.get("drawing"), dict) else None
    if drawing and len(json.dumps(drawing)) > MAX_DRAWING_BYTES:
        raise HTTPException(status_code=413, detail="Drawing is too large")
    if not text and not drawing:
        raise HTTPException(status_code=400, detail="A comment needs text or a drawing")

    if principal.get("is_guest"):
        name = data.get("userName")
        user_name = (name.strip()[:80] if isinstance(name, str) else "") or "Guest"
        profile_image = None
    else:
        user_name = principal["username"]
        profile_image = (db_get_user_by_id(principal["id"]) or {}).get("profileImage")

    def as_int(value, default=None):
        try:
            return int(value)
        except (TypeError, ValueError):
            return default

    def short_text(value, limit):
        return value[:limit] if isinstance(value, str) and value else None

    parent_id = data.get("parentId")
    if not any(c.get("id") == parent_id for c in projects[project_id]["comments"]):
        parent_id = None

    if drawing and not drawing.get("color"):
        drawing["color"] = user_states.get(session_id, {}).get(principal["id"], {}).get("color", "#6366f1")

    comment = {
        "id": str(uuid.uuid4())[:8],
        "frame": as_int(data.get("frame"), 0),
        "user": principal["id"],
        "userName": user_name,
        "userProfileImage": profile_image,
        "text": text,
        "drawing": drawing,
        "color": short_text(data.get("color"), 32),
        "clipBaseName": short_text(data.get("clipBaseName"), 300),
        "clipVersion": as_int(data.get("clipVersion")),
        "parentId": parent_id,
        "anchor": clean_comment_anchor(data.get("anchor")),
        "resolved": False,
        "createdAt": datetime.now().isoformat(),
    }

    # Saved before anyone is told about it
    db_batch_upsert_comments(project_id, [comment])
    projects[project_id]["comments"].append(comment)

    await live.to_project(project_id, {"type": "comment_added", "comment": comment})

    return comment


@app.delete("/api/session/{session_id}/comment/{comment_id}")
@app.delete("/api/projects/{session_id}/comment/{comment_id}")
async def delete_comment(session_id: str, comment_id: str, principal: Optional[dict] = Depends(get_principal)):
    """Delete a comment: your own, or any comment if you are an admin."""
    project_id = _comment_project(session_id, principal)
    comment = _find_comment(project_id, comment_id)

    if not _may_delete_comment(principal, comment):
        raise HTTPException(status_code=403, detail="You can only delete your own comments")

    db_delete_comment(project_id, comment_id)
    projects[project_id]["comments"] = [
        c for c in projects[project_id]["comments"] if c.get("id") != comment_id
    ]

    await live.to_project(project_id, {"type": "comment_deleted", "commentId": comment_id})

    return {"success": True}


@app.patch("/api/session/{session_id}/comment/{comment_id}/resolved")
@app.patch("/api/projects/{session_id}/comment/{comment_id}/resolved")
async def update_comment_resolved(session_id: str, comment_id: str, data: dict, principal: Optional[dict] = Depends(get_principal)):
    """Update the resolved status of a comment."""
    project_id = _comment_project(session_id, principal)
    comment = _find_comment(project_id, comment_id)

    resolved = bool(data.get("resolved", False))
    comment["resolved"] = resolved
    db_batch_upsert_comments(project_id, [comment])

    await live.to_project(project_id, {"type": "comment_updated", "commentId": comment_id, "resolved": resolved})

    return {"success": True, "resolved": resolved}


# ============ WebSocket ============

@app.websocket("/ws/{session_id}/{user_id}")
async def websocket_endpoint(
    websocket: WebSocket,
    session_id: str,
    user_id: str,
    name: Optional[str] = Query(None),
    ticket: Optional[str] = Query(None)
):
    principal = principal_from_ticket(ticket)
    if not can_view_project(principal, resolve_project_id(session_id)):
        await websocket.close(code=WS_ACCESS_REMOVED)
        return

    # Who this is comes from the token; the id in the URL is ignored
    user_id = principal["id"]
    if principal.get("is_guest"):
        name = (name or "").strip()[:80] or "Guest"
    else:
        name = principal["username"]
    conn_id = await manager.connect(websocket, session_id, user_id, name)

    # Get project from session
    project_id = session_id
    if session_id in sessions:
        project_id = sessions[session_id]["project_id"]
    live_socket = track_socket(principal, websocket, project_id)

    # Send current state to new user
    await websocket.send_json({
        "type": "init",
        "users": manager.get_users(session_id),
        "session": sessions.get(session_id, {}),
        "project": projects.get(project_id, {})
    })

    # Broadcast user joined (safely)
    user_state = get_user_state(session_id, user_id)
    if user_state:
        await manager.broadcast(session_id, {
            "type": "user_joined",
            "user": user_state
        }, exclude=conn_id)

    # Create notification for project owner
    try:
        project = db_get_project(project_id)
        if project and project.get("createdBy"):
            owner = db_get_user(project["createdBy"])
            # Only notify if owner exists and is not the joining user
            if owner and owner["id"] != user_id:
                user_state = get_user_state(session_id, user_id)
                joining_user_name = user_state.get("name", "Someone") if user_state else "Someone"
                notification = db_create_notification(
                    user_id=owner["id"],
                    notification_type="session_joined",
                    title="User joined your session",
                    message=f"{joining_user_name} joined {project.get('name', 'your project')}",
                    project_id=project_id
                )
                await live.to_user(owner["id"], {"type": "notification", "notification": notification})
    except Exception as e:
        print(f"Error creating join notification: {e}")

    try:
        while True:
            data = await websocket.receive_json()

            # Check if session/user still exists (could be deleted during session)
            user_state = get_user_state(session_id, user_id)
            if user_state is None:
                break  # Session or user was deleted, exit cleanly

            if data["type"] == "sync":
                user_state.update({
                    "frame": data.get("frame", 0),
                    "playing": data.get("playing", False)
                })
                await manager.broadcast(session_id, {
                    "type": "sync",
                    "user_id": user_id,
                    "frame": data.get("frame"),
                    "playing": data.get("playing")
                }, exclude=conn_id)

            elif data["type"] == "sync_inout":
                await manager.broadcast(session_id, {
                    "type": "sync_inout",
                    "user_id": user_id,
                    "inPoint": data.get("inPoint"),
                    "outPoint": data.get("outPoint"),
                    "loopEnabled": data.get("loopEnabled")
                }, exclude=conn_id)

            elif data["type"] == "sync_clip":
                await manager.broadcast(session_id, {
                    "type": "sync_clip",
                    "user_id": user_id,
                    "baseName": data.get("baseName"),
                    "version": data.get("version")
                }, exclude=conn_id)

            elif data["type"] == "sync_quality":
                await manager.broadcast(session_id, {
                    "type": "sync_quality",
                    "user_id": user_id,
                    "quality": data.get("quality")
                }, exclude=conn_id)

            elif data["type"] == "sync_compare":
                await manager.broadcast(session_id, {
                    "type": "sync_compare",
                    "user_id": user_id,
                    "compareMode": data.get("compareMode"),
                    "compareVersion": data.get("compareVersion"),
                    "wipePosition": data.get("wipePosition")
                }, exclude=conn_id)

            elif data["type"] == "sync_zoom":
                await manager.broadcast(session_id, {
                    "type": "sync_zoom",
                    "user_id": user_id,
                    "scale": data.get("scale"),
                    "panX": data.get("panX"),
                    "panY": data.get("panY")
                }, exclude=conn_id)

            elif data["type"] == "sync_timecode_mode":
                await manager.broadcast(session_id, {
                    "type": "sync_timecode_mode",
                    "user_id": user_id,
                    "showTimecode": data.get("showTimecode")
                }, exclude=conn_id)

            elif data["type"] == "cursor":
                user_state["cursor"] = {
                    "x": data.get("x"),
                    "y": data.get("y")
                }
                await manager.broadcast(session_id, {
                    "type": "cursor",
                    "user_id": user_id,
                    "x": data.get("x"),
                    "y": data.get("y"),
                    "color": user_state.get("color", "#5f5de5")
                }, exclude=conn_id)

            elif data["type"] == "draw":
                await manager.broadcast(session_id, {
                    "type": "draw",
                    "user_id": user_id,
                    "frame": data.get("frame"),
                    "stroke": data.get("stroke"),
                    "color": data.get("color") or user_state.get("color", "#5f5de5"),
                    "brushSize": data.get("brushSize", 6),
                    "brushType": data.get("brushType", "pen")
                }, exclude=conn_id)

            elif data["type"] == "draw_complete":
                # First, notify others to clear the remote drawing preview
                await manager.broadcast(session_id, {
                    "type": "draw_complete",
                    "user_id": user_id
                }, exclude=conn_id)

                annotation = {
                    "id": str(uuid.uuid4())[:8],
                    "frame": data.get("frame"),
                    "user": user_id,
                    "strokes": data.get("strokes"),
                    "color": user_state.get("color", "#5f5de5"),
                    "createdAt": datetime.now().isoformat()
                }
                if project_id in projects:
                    db_add_annotation(project_id, annotation)
                    projects[project_id]["annotations"].append(annotation)

                await manager.broadcast(session_id, {
                    "type": "annotation_saved",
                    "annotation": annotation
                })

            elif data["type"] == "request_control":
                await manager.broadcast(session_id, {
                    "type": "control_requested",
                    "user_id": user_id
                })

            elif data["type"] == "pong":
                # Update last seen timestamp for heartbeat tracking
                if user_state:
                    user_state["lastSeen"] = datetime.now().isoformat()

    except (WebSocketDisconnect, ValueError, RuntimeError, KeyError):
        pass
    finally:
        untrack_socket(principal, live_socket)
        # Tell the others once the user's last tab in the session is gone
        if manager.disconnect(session_id, conn_id):
            await manager.broadcast(session_id, {
                "type": "user_left",
                "user_id": user_id
            })


@app.get("/api/session/{session_id}")
async def get_session(session_id: str, principal: Optional[dict] = Depends(get_principal)):
    """Legacy endpoint - get session/project data."""
    project_id = resolve_project_id(session_id)
    require_project_viewer(principal, project_id)
    return _project_payload(project_id)


@app.get("/favicon.ico", include_in_schema=False)
async def favicon():
    """Browsers and link previews ask for this path no matter what the page says."""
    return FileResponse("static/favicon.ico", media_type="image/x-icon",
                        headers={"Cache-Control": "public, max-age=86400"})


# Serve icons.svg (caching handled by AssetMiddleware)
@app.get("/static/icons.svg")
async def get_icons():
    """Serve icons.svg."""
    return FileResponse("static/icons.svg", media_type="image/svg+xml")


# Routes split into api/routes/ (must be registered before the static mounts)
app.include_router(api_router)


# Mount static files last
app.mount("/covers", StaticFiles(directory=COVERS_DIR), name="covers")
app.mount("/profiles", StaticFiles(directory=PROFILES_DIR), name="profiles")
app.mount("/static", StaticFiles(directory="static"), name="static")


if __name__ == "__main__":
    import uvicorn
    port = int(os.environ.get("PORT", 8099))
    uvicorn.run(app, host="0.0.0.0", port=port)
