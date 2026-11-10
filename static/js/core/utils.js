/**
 * Utility Functions for CollabSuite
 */

/**
 * Format frame number as timecode (HH:MM:SS:FF)
 * @param {number} frame - Frame number
 * @param {number} fps - Frames per second (default from AppState)
 * @returns {string} Formatted timecode
 */
function formatTimecode(frame, fps = AppState?.videoFps || 25) {
    if (frame === undefined || frame === null || isNaN(frame)) return '00:00:00:00';

    const totalSeconds = Math.floor(frame / fps);
    const frames = Math.floor(frame % fps);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;

    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}:${String(frames).padStart(2, '0')}`;
}

/**
 * Parse timecode string to frame number
 * @param {string} timecode - Timecode string (HH:MM:SS:FF)
 * @param {number} fps - Frames per second
 * @returns {number} Frame number
 */
function parseTimecode(timecode, fps = AppState?.videoFps || 25) {
    const parts = timecode.split(':').map(Number);
    if (parts.length !== 4 || parts.some(isNaN)) return 0;

    const [hours, minutes, seconds, frames] = parts;
    return (hours * 3600 + minutes * 60 + seconds) * fps + frames;
}

/**
 * Escape HTML to prevent XSS
 * @param {string} text - Raw text
 * @returns {string} Escaped HTML
 */
function escapeHtml(text) {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

/**
 * Get contrasting text color (black or white) for a background color
 * @param {string} hexColor - Hex color code
 * @returns {string} '#000000' or '#ffffff'
 */
function getContrastTextColor(hexColor) {
    if (!hexColor) return '#000000';

    // Remove # if present
    const hex = hexColor.replace('#', '');

    // Parse RGB
    const r = parseInt(hex.substr(0, 2), 16);
    const g = parseInt(hex.substr(2, 2), 16);
    const b = parseInt(hex.substr(4, 2), 16);

    // Calculate luminance
    const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;

    return luminance > 0.5 ? '#000000' : '#ffffff';
}

/**
 * Generate a unique ID
 * @param {string} prefix - Optional prefix
 * @returns {string} Unique ID
 */
function generateId(prefix = '') {
    const timestamp = Date.now().toString(36);
    const random = Math.random().toString(36).substr(2, 9);
    return prefix ? `${prefix}_${timestamp}${random}` : `${timestamp}${random}`;
}

/**
 * Debounce function calls
 * @param {function} func - Function to debounce
 * @param {number} wait - Wait time in ms
 * @returns {function} Debounced function
 */
function debounce(func, wait) {
    let timeout;
    return function executedFunction(...args) {
        const later = () => {
            clearTimeout(timeout);
            func(...args);
        };
        clearTimeout(timeout);
        timeout = setTimeout(later, wait);
    };
}

/**
 * Throttle function calls
 * @param {function} func - Function to throttle
 * @param {number} limit - Time limit in ms
 * @returns {function} Throttled function
 */
function throttle(func, limit) {
    let inThrottle;
    return function executedFunction(...args) {
        if (!inThrottle) {
            func(...args);
            inThrottle = true;
            setTimeout(() => inThrottle = false, limit);
        }
    };
}

/**
 * Format relative time (e.g., "2 hours ago")
 * @param {string|Date} date - Date to format
 * @returns {string} Relative time string
 */
function formatRelativeTime(date) {
    const now = new Date();
    const then = new Date(date);
    const diffMs = now - then;
    const diffSeconds = Math.floor(diffMs / 1000);
    const diffMinutes = Math.floor(diffSeconds / 60);
    const diffHours = Math.floor(diffMinutes / 60);
    const diffDays = Math.floor(diffHours / 24);

    if (diffSeconds < 60) return 'just now';
    if (diffMinutes < 60) return `${diffMinutes}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    if (diffDays < 7) return `${diffDays}d ago`;

    return then.toLocaleDateString();
}

/**
 * Format file size
 * @param {number} bytes - Size in bytes
 * @returns {string} Formatted size
 */
function formatFileSize(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

/**
 * Copy text to clipboard
 * @param {string} text - Text to copy
 * @returns {Promise<boolean>} Success status
 */
async function copyToClipboard(text) {
    try {
        await navigator.clipboard.writeText(text);
        return true;
    } catch (err) {
        // Fallback for older browsers
        const textarea = document.createElement('textarea');
        textarea.value = text;
        textarea.style.position = 'fixed';
        textarea.style.opacity = '0';
        document.body.appendChild(textarea);
        textarea.select();
        try {
            document.execCommand('copy');
            return true;
        } catch (e) {
            console.error('Failed to copy:', e);
            return false;
        } finally {
            document.body.removeChild(textarea);
        }
    }
}

/**
 * Format version number with leading zeros (e.g., 1 -> "001")
 * @param {number} version - Version number
 * @param {number} digits - Number of digits (default 3)
 * @returns {string} Formatted version string
 */
function formatVersion(version, digits = 3) {
    return String(version).padStart(digits, '0');
}

/**
 * Parse clip filename for versioning
 * @param {string} filename - Original filename
 * @returns {object} Parsed info {baseName, version, versionStr, extension}
 */
function parseClipFilename(filename) {
    // Remove path if present
    const name = filename.split('/').pop();

    // Remove common prefixes like project IDs
    const withoutPrefix = name.replace(/^[a-zA-Z0-9]{8,}_/, '');

    // Match pattern: baseName_v1.ext or baseName_V01.ext
    const versionMatch = withoutPrefix.match(/^(.+?)_[vV](\d+)\.(\w+)$/);
    if (versionMatch) {
        const versionNum = parseInt(versionMatch[2], 10);
        // Preserve original version format (v1, v01, v001, etc.)
        const originalVersionStr = withoutPrefix.match(/_([vV]\d+)\./)[1];
        return {
            baseName: versionMatch[1],
            version: versionNum,
            versionStr: originalVersionStr,
            extension: versionMatch[3],
            originalFilename: filename
        };
    }

    // No version pattern - extract extension
    const extMatch = withoutPrefix.match(/^(.+)\.(\w+)$/);
    if (extMatch) {
        return {
            baseName: extMatch[1],
            version: 1,
            versionStr: 'v1',
            extension: extMatch[2],
            originalFilename: filename
        };
    }

    // Fallback
    return {
        baseName: withoutPrefix,
        version: 1,
        versionStr: 'v1',
        extension: 'mp4',
        originalFilename: filename
    };
}

// Export to global scope
window.formatTimecode = formatTimecode;
window.parseTimecode = parseTimecode;
window.escapeHtml = escapeHtml;
window.getContrastTextColor = getContrastTextColor;
window.generateId = generateId;
window.debounce = debounce;
window.throttle = throttle;
window.formatRelativeTime = formatRelativeTime;
window.formatFileSize = formatFileSize;
window.copyToClipboard = copyToClipboard;
window.parseClipFilename = parseClipFilename;
window.formatVersion = formatVersion;
