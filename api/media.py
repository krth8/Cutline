"""Image processing and upload filename helpers."""

import re

import asyncio
import os
from api.config import FFMPEG_PATH


async def process_image(input_path: str, output_path: str, max_size: int = 256, quality: int = 85) -> bool:
    """
    Process an image file: resize to max dimension while maintaining aspect ratio.
    Uses FFmpeg for consistent processing across image and video sources.

    Args:
        input_path: Path to input image file
        output_path: Path for output JPEG file
        max_size: Maximum dimension (width or height), default 256px
        quality: JPEG quality (1-100), default 85

    Returns:
        True if successful, False otherwise
    """
    # FFmpeg scale filter: scale to fit within max_size while maintaining aspect ratio
    # -2 ensures dimensions are divisible by 2 (required for some codecs)
    scale_filter = f"scale='if(gt(iw,ih),{max_size},-2)':'if(gt(iw,ih),-2,{max_size})'"

    cmd = [
        FFMPEG_PATH,
        '-i', input_path,
        '-vf', scale_filter,
        '-q:v', str(int((100 - quality) / 100 * 31 + 1)),  # Convert quality to FFmpeg scale (1-31, lower is better)
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
        print(f"Image processing error: {e}")
        return False


def safe_upload_name(filename: str) -> str:
    """Strip directories and unsafe characters from a client-supplied filename."""
    name = re.split(r"[\\/]", filename or "")[-1]
    name = re.sub(r'[\x00-\x1f<>:"|?*]', "_", name).strip().lstrip(".")
    return name or "upload"
