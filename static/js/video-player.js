// ============ Video Player Module ============

let frameUpdateId = null;
let lastDisplayedFrame = -1;

// Zoom state
let zoomState = {
    scale: 1,
    panX: 0,
    panY: 0,
    isPanning: false,
    startX: 0,
    startY: 0,
    startPanX: 0,
    startPanY: 0,
    resizeTimeout: null,
    syncTimeout: null,
    _suppressSync: false
};

const ZOOM_MIN = 0.1;  // Allow zooming down to 10% of fit size (for small videos on large screens)
const ZOOM_MAX = 4;
const ZOOM_STEP = 0.1;

function initVideoPlayer() {
    setupTransportControls();
    setupTimeline();
    setupInOutMarkers();
    setupPlaybackSpeed();
    setupVideoEvents();
    setupVideoZoom();
    setupVolumeControl();
    setupFullscreen();
    startFrameUpdateLoop();
}

// Smooth 60fps frame counter update loop
function startFrameUpdateLoop() {
    function updateFrame() {
        const currentFrame = getCurrentFrame();

        // Only update DOM if frame changed
        if (currentFrame !== lastDisplayedFrame) {
            lastDisplayedFrame = currentFrame;
            updateTimecode();
            updateTimeline();
            checkLoopBounds();

            // Show comment drawings for this frame
            if (typeof showFrameDrawings === 'function') {
                showFrameDrawings(currentFrame);
            }
        }

        frameUpdateId = requestAnimationFrame(updateFrame);
    }

    frameUpdateId = requestAnimationFrame(updateFrame);
}

// ============ Transport Controls ============
function setupTransportControls() {
    document.getElementById('playBtn').addEventListener('click', togglePlay);
    document.getElementById('prevFrameBtn').addEventListener('click', () => seekFrames(-1));
    document.getElementById('nextFrameBtn').addEventListener('click', () => seekFrames(1));
    document.getElementById('skipBackBtn').addEventListener('click', () => seekSeconds(-10));
    document.getElementById('skipForwardBtn').addEventListener('click', () => seekSeconds(10));
}

function togglePlay() {
    if (elements.video.paused) {
        elements.video.play();
    } else {
        elements.video.pause();
    }
}

function seekFrames(delta) {
    elements.video.currentTime = Math.max(0, Math.min(elements.video.duration, elements.video.currentTime + delta / AppState.fps));
    sendSync();
}

function seekSeconds(delta) {
    elements.video.currentTime = Math.max(0, Math.min(elements.video.duration, elements.video.currentTime + delta));
    sendSync();
}

// ============ Video Events ============
function setupVideoEvents() {
    elements.video.addEventListener('play', () => {
        const playBtn = document.getElementById('playBtn');
        playBtn.textContent = '⏸';
        playBtn.classList.add('playing');
        sendSync();
    });

    elements.video.addEventListener('pause', () => {
        const playBtn = document.getElementById('playBtn');
        playBtn.textContent = '▶';
        playBtn.classList.remove('playing');
        sendSync();
    });

    // Canvas redraw on timeupdate for annotations (frame updates handled by requestAnimationFrame)
    elements.video.addEventListener('timeupdate', () => {
        redrawCanvas();
    });

    elements.video.addEventListener('ratechange', () => {
        const speedSelect = document.getElementById('speedSelect');
        if (speedSelect) {
            speedSelect.value = elements.video.playbackRate;
        }
    });

    // Update overlay dimensions when video loads
    elements.video.addEventListener('loadedmetadata', () => {
        updateOverlayDimensions();
        renderTimelineMarkers();  // Re-render markers now that duration is available
    });

    // Update cache bar when video buffers new data
    elements.video.addEventListener('progress', () => {
        updateCacheBar();
    });
}

// Update SVG and canvas overlay dimensions to match video
function updateOverlayDimensions() {
    if (AppState.currentMediaType === 'html') return; // HtmlReview sizes the overlay to the page
    const video = elements.video;
    const svg = elements.svgOverlay;
    const canvas = elements.canvas;
    const stillImage = document.getElementById('stillImage');

    // Get native video dimensions
    let width, height;
    if (stillImage && stillImage.style.display !== 'none' && stillImage.naturalWidth) {
        width = stillImage.naturalWidth;
        height = stillImage.naturalHeight;
    } else if (video.videoWidth && video.videoHeight) {
        width = video.videoWidth;
        height = video.videoHeight;
    } else {
        return; // No dimensions available yet
    }

    // Set SVG viewBox to match video dimensions
    // This makes SVG coordinates = video pixel coordinates
    if (svg) {
        svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
        svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
    }

    // Set canvas dimensions to match video
    if (canvas) {
        canvas.width = width;
        canvas.height = height;
    }
}

function resetPlayButton() {
    const playBtn = document.getElementById('playBtn');
    if (playBtn) {
        playBtn.textContent = '▶';
        playBtn.classList.remove('playing');
    }
}

function updateTimecode() {
    const current = formatTimecode(elements.video.currentTime);
    const total = formatTimecode(elements.video.duration || 0);
    document.getElementById('timecode').innerHTML = `<span>${current}</span> / ${total}`;
}

// ============ Timeline ============
let isDraggingTimeline = false;

function setupTimeline() {
    const timelineTrack = document.getElementById('timelineTrack');

    timelineTrack.addEventListener('mousedown', (e) => {
        isDraggingTimeline = true;
        seekToPosition(e);
    });

    document.addEventListener('mousemove', (e) => {
        if (isDraggingTimeline) {
            seekToPosition(e);
            sendSync(); // Live sync while dragging
        }
    });

    document.addEventListener('mouseup', () => {
        if (isDraggingTimeline) {
            isDraggingTimeline = false;
            sendSync();
        }
    });
}

function updateTimeline() {
    const video = elements.video;
    const progress = video.duration ? (video.currentTime / video.duration) * 100 : 0;
    document.getElementById('timelineProgress').style.width = progress + '%';
    document.getElementById('timelineHandle').style.left = progress + '%';

    // Update cache bar based on video.buffered
    updateCacheBar();
}

function updateCacheBar() {
    // Don't overwrite if fetch-based caching is in progress
    if (window.isFetchCaching && window.isFetchCaching()) return;

    const video = elements.video;
    const cacheBar = document.getElementById('timelineCache');
    if (!cacheBar || !video.duration) return;

    // Find the buffered range that contains current playback position
    // or the furthest buffered point
    let maxBuffered = 0;
    for (let i = 0; i < video.buffered.length; i++) {
        const end = video.buffered.end(i);
        if (end > maxBuffered) {
            maxBuffered = end;
        }
    }

    const percent = (maxBuffered / video.duration) * 100;
    cacheBar.style.width = percent + '%';
}

function seekToPosition(e) {
    const timelineTrack = document.getElementById('timelineTrack');
    const rect = timelineTrack.getBoundingClientRect();
    const percent = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    elements.video.currentTime = percent * elements.video.duration;
}

function renderTimelineMarkers() {
    const container = document.getElementById('timelineMarkers');
    if (!container) return;
    container.innerHTML = '';

    // Don't render if video isn't loaded yet (duration would be 0 or NaN)
    if (!elements.video || !elements.video.duration || isNaN(elements.video.duration)) {
        return;
    }

    const totalFrames = Math.floor(elements.video.duration * AppState.fps) || 1;

    // Render in/out region
    if (AppState.inPoint !== null || AppState.outPoint !== null) {
        const inPercent = AppState.inPoint !== null ? (AppState.inPoint / totalFrames) * 100 : 0;
        const outPercent = AppState.outPoint !== null ? (AppState.outPoint / totalFrames) * 100 : 100;

        const region = document.createElement('div');
        region.className = 'timeline-in-out';
        region.style.left = inPercent + '%';
        region.style.width = (outPercent - inPercent) + '%';
        container.appendChild(region);

        if (AppState.inPoint !== null) {
            const inMarker = document.createElement('div');
            inMarker.className = 'timeline-in-marker';
            inMarker.style.left = inPercent + '%';
            inMarker.addEventListener('mousedown', (e) => startInOutDrag(e, 'in', container, totalFrames));
            container.appendChild(inMarker);
        }

        if (AppState.outPoint !== null) {
            const outMarker = document.createElement('div');
            outMarker.className = 'timeline-out-marker';
            outMarker.style.left = outPercent + '%';
            outMarker.addEventListener('mousedown', (e) => startInOutDrag(e, 'out', container, totalFrames));
            container.appendChild(outMarker);
        }
    }

    // Comment markers - filter by current clip (include legacy comments without clipBaseName)
    // Skip comments that have drawings - they'll show as annotation markers instead
    const currentBaseName = AppState.currentClip?.baseName;
    AppState.comments
        .filter(c => !currentBaseName || c.clipBaseName === currentBaseName || !c.clipBaseName)
        .filter(c => !(c.drawing && c.drawing.strokes && c.drawing.strokes.length > 0)) // Skip comments with drawings
        .forEach(c => {
            const marker = document.createElement('div');
            marker.className = `timeline-marker comment${c.resolved ? ' resolved' : ''}`;
            marker.style.left = `${(c.frame / totalFrames) * 100}%`;
            marker.dataset.commentId = c.id;
            marker.dataset.frame = c.frame;
            marker.onclick = () => {
                goToFrame(c.frame);
                highlightCommentFromMarker(c.id, c.frame);
            };
            container.appendChild(marker);
        });

    // Annotation markers (drawings)
    Object.keys(AppState.annotations).forEach(frame => {
        if (AppState.annotations[frame].length === 0) return;

        // Check if all comments with drawings on this frame are resolved
        const frameNum = parseInt(frame);
        const commentsOnFrame = AppState.comments.filter(c =>
            c.frame === frameNum && c.drawing && c.drawing.strokes && c.drawing.strokes.length > 0
        );
        const allResolved = commentsOnFrame.length > 0 && commentsOnFrame.every(c => c.resolved);

        const marker = document.createElement('div');
        marker.className = `timeline-marker annotation${allResolved ? ' resolved' : ''}`;
        marker.style.left = `${(frameNum / totalFrames) * 100}%`;
        marker.dataset.frame = frame;
        marker.onclick = () => {
            goToFrame(frameNum);
            // Highlight comments on this frame (annotations are linked to comments)
            highlightCommentFromMarker(null, frameNum);
        };
        container.appendChild(marker);
    });

    // Update in/out display
    updateInOutDisplay();
}

// ============ In/Out Markers ============
function setupInOutMarkers() {
    // Will be controlled by keyboard shortcuts
}

function setInPoint() {
    AppState.inPoint = getCurrentFrame();
    updateInOutDisplay();
    renderTimelineMarkers();
    sendSyncInOut();
    showNotification('In point set');
}

function setOutPoint() {
    AppState.outPoint = getCurrentFrame();
    updateInOutDisplay();
    renderTimelineMarkers();
    sendSyncInOut();
    showNotification('Out point set');
}

function clearInPoint() {
    AppState.inPoint = null;
    updateInOutDisplay();
    renderTimelineMarkers();
    sendSyncInOut();
}

function clearOutPoint() {
    AppState.outPoint = null;
    updateInOutDisplay();
    renderTimelineMarkers();
    sendSyncInOut();
}

function toggleLoop() {
    AppState.loopEnabled = !AppState.loopEnabled;
    updateLoopButton();
    showNotification(AppState.loopEnabled ? 'Loop enabled' : 'Loop disabled');
}

function clearInOut() {
    AppState.inPoint = null;
    AppState.outPoint = null;
    updateInOutDisplay();
    renderTimelineMarkers();
    sendSyncInOut();
    showNotification('In/Out cleared');
}

// ============ In/Out Marker Dragging ============
let inOutDragState = null;

function startInOutDrag(e, type, container, totalFrames) {
    e.preventDefault();
    e.stopPropagation();

    const containerRect = container.getBoundingClientRect();

    inOutDragState = {
        type,
        container,
        containerRect,
        totalFrames
    };

    document.addEventListener('mousemove', handleInOutDrag);
    document.addEventListener('mouseup', stopInOutDrag);

    // Add dragging class for visual feedback
    document.body.style.cursor = 'ew-resize';
}

function handleInOutDrag(e) {
    if (!inOutDragState) return;

    const { type, containerRect, totalFrames } = inOutDragState;

    // Calculate frame from mouse position
    const x = e.clientX - containerRect.left;
    const percent = Math.max(0, Math.min(1, x / containerRect.width));
    const frame = Math.round(percent * totalFrames);

    // Update the appropriate point, ensuring in < out
    if (type === 'in') {
        const maxFrame = AppState.outPoint !== null ? AppState.outPoint - 1 : totalFrames;
        AppState.inPoint = Math.min(frame, maxFrame);
    } else {
        const minFrame = AppState.inPoint !== null ? AppState.inPoint + 1 : 0;
        AppState.outPoint = Math.max(frame, minFrame);
    }

    updateInOutDisplay();
    renderTimelineMarkers();
}

function stopInOutDrag() {
    if (inOutDragState) {
        sendSyncInOut();
        inOutDragState = null;
    }

    document.removeEventListener('mousemove', handleInOutDrag);
    document.removeEventListener('mouseup', stopInOutDrag);
    document.body.style.cursor = '';
}

function updateLoopButton() {
    const loopBtn = document.getElementById('loopBtn');
    if (loopBtn) loopBtn.classList.toggle('active', AppState.loopEnabled);
}

function checkLoopBounds() {
    if (!AppState.loopEnabled) return;

    const currentFrame = getCurrentFrame();
    const totalFrames = Math.floor(elements.video.duration * AppState.fps);

    // If in/out set, loop within that region
    if (AppState.inPoint !== null && AppState.outPoint !== null) {
        if (currentFrame >= AppState.outPoint) {
            goToFrame(AppState.inPoint);
        }
    } else {
        // Loop entire clip
        if (currentFrame >= totalFrames - 1) {
            goToFrame(0);
        }
    }
}

function updateInOutDisplay() {
    const inBtn = document.querySelector('.in-out-btn:first-child');
    const outBtn = document.querySelector('.in-out-btn:nth-child(2)');
    const inValue = document.getElementById('inPointValue');
    const outValue = document.getElementById('outPointValue');

    if (!inValue || !outValue) return;

    // Show frames with "f" suffix for clarity
    const inFrame = AppState.inPoint !== null ? `${AppState.inPoint}f` : '--';
    const outFrame = AppState.outPoint !== null ? `${AppState.outPoint}f` : '--';

    inValue.textContent = inFrame;
    outValue.textContent = outFrame;

    // Update button states - add active class when point is set
    if (inBtn) inBtn.classList.toggle('active', AppState.inPoint !== null);
    if (outBtn) outBtn.classList.toggle('active', AppState.outPoint !== null);
}

// ============ Playback Speed ============
function setupPlaybackSpeed() {
    const speedSelect = document.getElementById('speedSelect');
    if (speedSelect) {
        speedSelect.addEventListener('change', (e) => {
            const speed = parseFloat(e.target.value);
            elements.video.playbackRate = speed;
            AppState.playbackSpeed = speed;
        });
    }
}

function setPlaybackSpeed(speed) {
    elements.video.playbackRate = speed;
    AppState.playbackSpeed = speed;
    const speedSelect = document.getElementById('speedSelect');
    if (speedSelect) {
        speedSelect.value = speed;
    }
}

// ============ SVG Drawing ============
function redrawCanvas() {
    // Clear saved annotation paths (keep pending strokes)
    elements.svgOverlay.querySelectorAll('.annotation-stroke').forEach(el => el.remove());
    if (AppState.currentMediaType === 'html') return; // frame annotations don't apply to pages

    const frame = getCurrentFrame();
    const frameAnnotations = AppState.annotations[frame] || [];

    frameAnnotations.forEach(ann => {
        if (!ann.strokes || ann.strokes.length < 2) return;

        // Build SVG path data
        let d = `M ${ann.strokes[0].x} ${ann.strokes[0].y}`;
        for (let i = 1; i < ann.strokes.length; i++) {
            d += ` L ${ann.strokes[i].x} ${ann.strokes[i].y}`;
        }

        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('stroke', ann.color || '#ff4444');
        path.setAttribute('stroke-width', '3');
        path.setAttribute('d', d);
        path.classList.add('annotation-stroke');
        elements.svgOverlay.appendChild(path);
    });
}

// ============ Notifications ============
function showNotification(message) {
    // Simple notification - could be enhanced
    console.log(message);
}

// ============ Keyboard Shortcuts ============
function initKeyboardShortcuts() {
    document.addEventListener('keydown', (e) => {
        // Only handle shortcuts when Review tab is active
        if (AppState.activeTab !== 'review') return;

        // Ignore if typing in input or contenteditable (docs editor)
        if (e.target.tagName === 'TEXTAREA' ||
            e.target.tagName === 'INPUT' ||
            e.target.isContentEditable) return;

        switch (e.code) {
            case 'Space':
                e.preventDefault();
                togglePlay();
                break;
            case 'ArrowLeft':
                e.preventDefault();
                seekFrames(e.shiftKey ? -10 : -1);
                break;
            case 'ArrowRight':
                e.preventDefault();
                seekFrames(e.shiftKey ? 10 : 1);
                break;
            case 'KeyD':
                toggleDrawMode();
                break;
            case 'KeyI':
                e.preventDefault();
                setInPoint();
                break;
            case 'KeyO':
                e.preventDefault();
                setOutPoint();
                break;
            case 'KeyL':
                e.preventDefault();
                toggleLoop();
                break;
            case 'Slash':
                if (e.shiftKey) {
                    e.preventDefault();
                    toggleShortcutsOverlay();
                }
                break;
            case 'KeyM':
                e.preventDefault();
                toggleMute();
                break;
            case 'KeyF':
                e.preventDefault();
                toggleFocusMode();
                break;
            case 'Escape':
                if (AppState.drawMode) {
                    toggleDrawMode();
                }
                closeShortcutsOverlay();
                break;
        }
    });
}

function toggleShortcutsOverlay() {
    const overlay = document.getElementById('shortcutsOverlay');
    if (overlay) {
        overlay.classList.toggle('visible');
    }
}

function closeShortcutsOverlay() {
    const overlay = document.getElementById('shortcutsOverlay');
    if (overlay) {
        overlay.classList.remove('visible');
    }
}

// ============ Video Zoom ============
function setupVideoZoom() {
    const wrapper = document.getElementById('videoWrapper');
    if (!wrapper) return;

    // Mouse wheel zoom
    wrapper.addEventListener('wheel', handleZoomWheel, { passive: false });

    // Middle mouse drag for panning
    wrapper.addEventListener('mousedown', handlePanStart);
    document.addEventListener('mousemove', handlePanMove);
    document.addEventListener('mouseup', handlePanEnd);

    // Touch pan and pinch-to-zoom for mobile
    wrapper.addEventListener('touchstart', handleTouchPanStart, { passive: false });
    wrapper.addEventListener('touchmove', handleTouchPanMove, { passive: false });
    wrapper.addEventListener('touchend', handleTouchPanEnd);
    wrapper.addEventListener('touchcancel', handleTouchPanEnd);

    // Double-click to reset
    wrapper.addEventListener('dblclick', resetZoom);

    // Setup zoom dropdown
    const zoomSelect = document.getElementById('zoomSelect');
    if (zoomSelect) {
        zoomSelect.addEventListener('change', (e) => {
            const value = e.target.value;
            if (value === 'fit') {
                resetZoom();
            } else if (value === 'custom') {
                // Do nothing for custom - it's just a display option
            } else {
                // Value is target percentage (0.5 = 50%, 1 = 100%, 2 = 200%)
                // Calculate scale needed to achieve that actual pixel ratio
                const targetRatio = parseFloat(value);
                const baseRatio = getBaseDisplayRatio();
                if (baseRatio && baseRatio > 0) {
                    // scale = targetRatio / baseRatio
                    const neededScale = targetRatio / baseRatio;
                    setZoom(Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, neededScale)));
                } else {
                    // Fallback if we can't calculate
                    setZoom(parseFloat(value));
                }
            }
        });
    }

    // Update zoom UI when container resizes (panels toggle, window resize)
    const playerArea = document.querySelector('.player-area');
    if (playerArea && window.ResizeObserver) {
        const resizeObserver = new ResizeObserver(() => {
            // Debounce the update
            clearTimeout(zoomState.resizeTimeout);
            zoomState.resizeTimeout = setTimeout(() => {
                updateZoomUI();
            }, 100);
        });
        resizeObserver.observe(playerArea);
    }

    // Also update when video metadata loads
    elements.video?.addEventListener('loadedmetadata', () => {
        updateZoomUI();
    });
}

function handleZoomWheel(e) {
    if (AppState.currentMediaType === 'html') return; // pages scroll themselves
    e.preventDefault();

    const wrapper = document.getElementById('videoWrapper');
    if (!wrapper) return;

    // Get mouse position relative to wrapper
    const rect = wrapper.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;

    // Calculate zoom
    const delta = e.deltaY > 0 ? -ZOOM_STEP : ZOOM_STEP;
    const newScale = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, zoomState.scale + delta));

    if (newScale === zoomState.scale) return;

    // Zoom towards mouse position
    // CSS uses transform-origin: center, so we need center-relative coordinates
    const centerX = rect.width / 2;
    const centerY = rect.height / 2;
    const relMouseX = mouseX - centerX;
    const relMouseY = mouseY - centerY;

    const scaleFactor = newScale / zoomState.scale;

    // With center origin, compensate for point movement during scale
    // This keeps the point under the mouse stationary (linear zoom towards mouse)
    zoomState.panX -= relMouseX * (scaleFactor - 1);
    zoomState.panY -= relMouseY * (scaleFactor - 1);
    zoomState.scale = newScale;

    applyZoom();
    updateZoomUI();
}

function handlePanStart(e) {
    if (AppState.currentMediaType === 'html') return;
    // Middle mouse button (button 1) or left button when zoomed
    if (e.button === 1 || (e.button === 0 && zoomState.scale > 1 && !AppState.drawMode)) {
        if (e.button === 1) e.preventDefault();

        // Only allow pan drag with left click when zoomed and not in draw mode
        if (e.button === 0 && zoomState.scale <= 1) return;

        zoomState.isPanning = true;
        zoomState.startX = e.clientX;
        zoomState.startY = e.clientY;
        zoomState.startPanX = zoomState.panX;
        zoomState.startPanY = zoomState.panY;

        document.body.style.cursor = 'grabbing';
    }
}

function handlePanMove(e) {
    if (!zoomState.isPanning) return;

    const deltaX = e.clientX - zoomState.startX;
    const deltaY = e.clientY - zoomState.startY;

    zoomState.panX = zoomState.startPanX + deltaX;
    zoomState.panY = zoomState.startPanY + deltaY;

    applyZoom();
}

function handlePanEnd(e) {
    if (zoomState.isPanning) {
        zoomState.isPanning = false;
        document.body.style.cursor = '';
    }
}

// Touch handlers for mobile pan and pinch-to-zoom
let touchState = {
    lastTouchDistance: 0,
    lastTouchCenter: { x: 0, y: 0 },
    isPinching: false
};

function handleTouchPanStart(e) {
    if (AppState.currentMediaType === 'html') return;
    // Don't interfere with drawing mode
    if (AppState.drawMode) return;

    if (e.touches.length === 1 && zoomState.scale > 1) {
        // Single finger pan (only when zoomed)
        e.preventDefault();
        zoomState.isPanning = true;
        zoomState.startX = e.touches[0].clientX;
        zoomState.startY = e.touches[0].clientY;
        zoomState.startPanX = zoomState.panX;
        zoomState.startPanY = zoomState.panY;
    } else if (e.touches.length === 2) {
        // Two finger pinch-to-zoom
        e.preventDefault();
        touchState.isPinching = true;
        touchState.lastTouchDistance = getTouchDistance(e.touches);
        touchState.lastTouchCenter = getTouchCenter(e.touches);
        zoomState.startPanX = zoomState.panX;
        zoomState.startPanY = zoomState.panY;
    }
}

function handleTouchPanMove(e) {
    // Don't interfere with drawing mode
    if (AppState.drawMode) return;

    if (e.touches.length === 1 && zoomState.isPanning) {
        // Single finger pan
        e.preventDefault();
        const deltaX = e.touches[0].clientX - zoomState.startX;
        const deltaY = e.touches[0].clientY - zoomState.startY;
        zoomState.panX = zoomState.startPanX + deltaX;
        zoomState.panY = zoomState.startPanY + deltaY;
        applyZoom();
    } else if (e.touches.length === 2 && touchState.isPinching) {
        // Pinch to zoom
        e.preventDefault();
        const newDistance = getTouchDistance(e.touches);
        const newCenter = getTouchCenter(e.touches);

        // Calculate zoom change
        const scaleFactor = newDistance / touchState.lastTouchDistance;
        const newScale = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, zoomState.scale * scaleFactor));

        if (newScale !== zoomState.scale) {
            // Zoom towards pinch center
            const wrapper = document.getElementById('videoWrapper');
            if (wrapper) {
                const rect = wrapper.getBoundingClientRect();
                const centerX = rect.width / 2;
                const centerY = rect.height / 2;
                const pinchX = newCenter.x - rect.left - centerX;
                const pinchY = newCenter.y - rect.top - centerY;

                const scaleChange = newScale / zoomState.scale;
                zoomState.panX -= pinchX * (scaleChange - 1);
                zoomState.panY -= pinchY * (scaleChange - 1);
                zoomState.scale = newScale;
            }

            applyZoom();
            updateZoomUI();
        }

        touchState.lastTouchDistance = newDistance;
        touchState.lastTouchCenter = newCenter;
    }
}

function handleTouchPanEnd(e) {
    if (e.touches.length < 2) {
        touchState.isPinching = false;
    }
    if (e.touches.length === 0) {
        zoomState.isPanning = false;
    }
}

function getTouchDistance(touches) {
    const dx = touches[0].clientX - touches[1].clientX;
    const dy = touches[0].clientY - touches[1].clientY;
    return Math.sqrt(dx * dx + dy * dy);
}

function getTouchCenter(touches) {
    return {
        x: (touches[0].clientX + touches[1].clientX) / 2,
        y: (touches[0].clientY + touches[1].clientY) / 2
    };
}

function setZoom(scale) {
    const wrapper = document.getElementById('videoWrapper');
    if (!wrapper) return;

    // Zoom from center
    const rect = wrapper.getBoundingClientRect();
    const centerX = rect.width / 2;
    const centerY = rect.height / 2;

    const scaleFactor = scale / zoomState.scale;
    zoomState.panX = centerX - (centerX - zoomState.panX) * scaleFactor;
    zoomState.panY = centerY - (centerY - zoomState.panY) * scaleFactor;
    zoomState.scale = scale;

    applyZoom();
    updateZoomUI();
}

function resetZoom() {
    zoomState.scale = 1;
    zoomState.panX = 0;
    zoomState.panY = 0;
    applyZoom();
    updateZoomUI();
}

function applyZoom() {
    const video = elements.video;
    const canvas = elements.canvas;
    const svgOverlay = elements.svgOverlay;
    const stillImage = document.getElementById('stillImage');
    const compareVideo = document.getElementById('videoCompare');
    const compareImage = document.getElementById('stillImageCompare');

    // Reset pan when at fit (scale=1), otherwise allow free panning for linear zoom-to-mouse
    if (zoomState.scale <= 1) {
        zoomState.panX = 0;
        zoomState.panY = 0;
    }
    // No pan constraints - allows true linear zoom towards mouse position at any zoom level

    const transform = `scale(${zoomState.scale}) translate(${zoomState.panX / zoomState.scale}px, ${zoomState.panY / zoomState.scale}px)`;
    if (video) video.style.transform = transform;
    if (canvas) canvas.style.transform = transform;
    // HTML pages aren't zoomable: keep the drawing overlay aligned with the page
    if (svgOverlay) svgOverlay.style.transform = AppState.currentMediaType === 'html' ? '' : transform;
    if (stillImage) stillImage.style.transform = transform;
    // Apply same transform to compare elements for wipe mode sync
    if (compareVideo) compareVideo.style.transform = transform;
    if (compareImage) compareImage.style.transform = transform;
    // Note: wipeOverlay is NOT transformed - it stays at container position
    // because clip-path percentages are element-relative and align correctly

    // Send zoom sync (debounced to avoid flooding during wheel zoom)
    if (!zoomState._suppressSync) {
        sendSyncZoomDebounced();
    }
}

// Send zoom state to other users (debounced)
function sendSyncZoomDebounced() {
    if (zoomState.syncTimeout) {
        clearTimeout(zoomState.syncTimeout);
    }
    zoomState.syncTimeout = setTimeout(() => {
        sendSyncZoom();
    }, 100); // 100ms debounce
}

function sendSyncZoom() {
    if (AppState.ws && AppState.ws.readyState === WebSocket.OPEN && AppState.syncEnabled) {
        AppState.ws.send(JSON.stringify({
            type: 'sync_zoom',
            scale: zoomState.scale,
            panX: zoomState.panX,
            panY: zoomState.panY
        }));
    }
}

// Apply zoom from remote user (without re-syncing)
function applyZoomFromSync(scale, panX, panY) {
    zoomState._suppressSync = true;
    zoomState.scale = scale;
    zoomState.panX = panX;
    zoomState.panY = panY;

    const video = elements.video;
    const canvas = elements.canvas;
    const svgOverlay = elements.svgOverlay;
    const stillImage = document.getElementById('stillImage');
    const compareVideo = document.getElementById('videoCompare');
    const compareImage = document.getElementById('stillImageCompare');

    const transform = `scale(${scale}) translate(${panX / scale}px, ${panY / scale}px)`;
    if (video) video.style.transform = transform;
    if (canvas) canvas.style.transform = transform;
    // HTML pages aren't zoomable: keep the drawing overlay aligned with the page
    if (svgOverlay) svgOverlay.style.transform = AppState.currentMediaType === 'html' ? '' : transform;
    if (stillImage) stillImage.style.transform = transform;
    // Apply same transform to compare elements for wipe mode sync
    if (compareVideo) compareVideo.style.transform = transform;
    if (compareImage) compareImage.style.transform = transform;

    updateZoomUI();
    zoomState._suppressSync = false;
}

function getMediaElement() {
    // Returns the active media element (video or still image) and its native dimensions
    const video = elements.video;
    const stillImage = document.getElementById('stillImage');

    // Check if we're in image mode (stillImage visible, video hidden)
    if (stillImage && stillImage.style.display !== 'none' && stillImage.naturalWidth) {
        return {
            element: stillImage,
            nativeWidth: stillImage.naturalWidth,
            nativeHeight: stillImage.naturalHeight
        };
    }

    // Default to video
    if (video && video.videoWidth && video.videoHeight) {
        return {
            element: video,
            nativeWidth: video.videoWidth,
            nativeHeight: video.videoHeight
        };
    }

    return null;
}

function getBaseDisplayRatio() {
    // Returns the CSS object-fit: contain ratio (when scale=1)
    // This is how much the media is scaled to fit the container
    const media = getMediaElement();
    if (!media) return null;

    const wrapper = document.getElementById('videoWrapper');
    if (!wrapper) return null;

    const wrapperRect = wrapper.getBoundingClientRect();

    // Calculate ratio needed to fit media in wrapper (object-fit: contain behavior)
    const widthRatio = wrapperRect.width / media.nativeWidth;
    const heightRatio = wrapperRect.height / media.nativeHeight;

    // Use the smaller ratio (limiting dimension)
    return Math.min(widthRatio, heightRatio);
}

function getActualDisplayRatio() {
    const media = getMediaElement();
    if (!media) return null;

    // Get the displayed size (before our zoom transform)
    // We need to account for object-fit: contain behavior
    const rect = media.element.getBoundingClientRect();

    // The displayed size includes our zoom transform, so divide it out
    const displayedWidth = rect.width / zoomState.scale;
    const displayedHeight = rect.height / zoomState.scale;

    // Calculate ratio of displayed size to native size
    const widthRatio = displayedWidth / media.nativeWidth;
    const heightRatio = displayedHeight / media.nativeHeight;

    // Use the smaller ratio (since object-fit: contain uses the limiting dimension)
    const baseRatio = Math.min(widthRatio, heightRatio);

    // Final ratio = base fit ratio * our zoom
    return baseRatio * zoomState.scale;
}

function updateZoomUI() {
    // Update the new player dropdown UI
    if (typeof updateZoomDropdownUI === 'function') {
        updateZoomDropdownUI();
    }

    const zoomSelect = document.getElementById('zoomSelect');
    if (!zoomSelect) return;

    // Calculate actual display ratio (pixel-accurate)
    const actualRatio = getActualDisplayRatio();
    const actualPercent = actualRatio ? Math.round(actualRatio * 100) : null;

    // Update the Fit option to show actual percentage
    const fitOption = zoomSelect.querySelector('option[value="fit"]');
    if (fitOption && actualPercent && zoomState.scale === 1) {
        fitOption.textContent = `Fit (${actualPercent}%)`;
    } else if (fitOption) {
        fitOption.textContent = 'Fit';
    }

    // Presets represent actual pixel ratios (0.5 = 50%, 1 = 100%, etc.)
    const presets = ['0.5', '0.75', '1', '1.5', '2', '3', '4'];

    // Check if current actual ratio matches a preset
    let matchedPreset = null;
    if (actualRatio) {
        for (const preset of presets) {
            const presetValue = parseFloat(preset);
            // Allow 2% tolerance for matching
            if (Math.abs(actualRatio - presetValue) < 0.02) {
                matchedPreset = preset;
                break;
            }
        }
    }

    // Select the right dropdown value
    if (zoomState.scale === 1) {
        zoomSelect.value = 'fit';
    } else if (matchedPreset) {
        zoomSelect.value = matchedPreset;
    } else {
        zoomSelect.value = 'custom';
    }

    // Update the display text for custom option (show actual pixel ratio)
    const customOption = zoomSelect.querySelector('option[value="custom"]');
    if (customOption) {
        customOption.textContent = actualPercent ? `${actualPercent}%` : 'Custom';
    }

    // Keep preset labels simple - they now represent actual percentages
    presets.forEach(preset => {
        const option = zoomSelect.querySelector(`option[value="${preset}"]`);
        if (option) {
            option.textContent = `${Math.round(parseFloat(preset) * 100)}%`;
        }
    });
}

// ============ Volume Control ============
let previousVolume = 1;

function setupVolumeControl() {
    const volumeBtn = document.getElementById('volumeBtn');
    const volumeSlider = document.getElementById('volumeSlider');
    const volumeControl = document.getElementById('volumeControl');

    if (!volumeBtn || !volumeSlider || !volumeControl) return;

    // Set initial state
    updateVolumeUI(elements.video.volume);

    // Volume button toggles mute
    volumeBtn.addEventListener('click', toggleMute);

    // Volume slider changes volume
    volumeSlider.addEventListener('input', (e) => {
        const volume = parseFloat(e.target.value);
        setVolume(volume);
    });

    // Keep slider expanded while interacting
    volumeSlider.addEventListener('mousedown', () => {
        volumeControl.classList.add('expanded');
    });

    document.addEventListener('mouseup', () => {
        volumeControl.classList.remove('expanded');
    });

    // Sync with video element's volume changes
    elements.video.addEventListener('volumechange', () => {
        updateVolumeUI(elements.video.volume);
    });
}

function setVolume(volume) {
    elements.video.volume = Math.max(0, Math.min(1, volume));
    elements.video.muted = volume === 0;
    if (volume > 0) previousVolume = volume;
    updateVolumeUI(volume);
}

function toggleMute() {
    if (elements.video.muted || elements.video.volume === 0) {
        // Unmute
        elements.video.muted = false;
        setVolume(previousVolume || 1);
    } else {
        // Mute
        previousVolume = elements.video.volume;
        elements.video.muted = true;
        updateVolumeUI(0);
    }
}

function updateVolumeUI(volume) {
    const volumeControl = document.getElementById('volumeControl');
    const volumeSlider = document.getElementById('volumeSlider');
    const volumeBtn = document.getElementById('volumeBtn');

    if (!volumeControl || !volumeSlider || !volumeBtn) return;

    // Update slider value
    volumeSlider.value = elements.video.muted ? 0 : volume;

    // Determine volume level for icon display
    let level = 'high';
    if (elements.video.muted || volume === 0) {
        level = 'muted';
    } else if (volume < 0.5) {
        level = 'low';
    }

    volumeControl.dataset.level = level;
    volumeBtn.classList.toggle('muted', level === 'muted');
}

// ============ Focus Mode (Expanded View) ============
let focusModeState = {
    active: false,
    hideTimer: null,
    controlsVisible: true
};

function setupFullscreen() {
    const fullscreenBtn = document.getElementById('fullscreenBtn');
    if (!fullscreenBtn) return;

    fullscreenBtn.addEventListener('click', toggleFocusMode);
}

// Handle mouse movement in focus mode
function handleFocusModeMouseMove(e) {
    if (!focusModeState.active) return;

    const app = document.querySelector('.app');
    if (!app) return;

    // Show controls
    showFocusModeControls();

    // Reset hide timer
    clearTimeout(focusModeState.hideTimer);
    focusModeState.hideTimer = setTimeout(() => {
        hideFocusModeControls();
    }, 2500); // Hide after 2.5 seconds of no movement
}

function showFocusModeControls() {
    const app = document.querySelector('.app');
    if (!app || !focusModeState.active) return;

    focusModeState.controlsVisible = true;
    app.classList.add('controls-visible', 'toolbar-visible');
}

function hideFocusModeControls() {
    const app = document.querySelector('.app');
    if (!app || !focusModeState.active) return;

    // Don't hide if hovering over controls
    const playerControls = document.querySelector('.player-controls:hover');
    const contextToolbar = document.querySelector('.context-toolbar:hover');
    if (playerControls || contextToolbar) {
        // Restart timer
        focusModeState.hideTimer = setTimeout(() => {
            hideFocusModeControls();
        }, 2500);
        return;
    }

    focusModeState.controlsVisible = false;
    app.classList.remove('controls-visible', 'toolbar-visible');
}

function toggleFocusMode() {
    const app = document.querySelector('.app');
    if (!app) return;

    focusModeState.active = !focusModeState.active;

    if (focusModeState.active) {
        // Add mouse movement listener for auto-hide controls
        document.addEventListener('mousemove', handleFocusModeMouseMove);

        // Delay showing controls until grid animation completes (300ms)
        setTimeout(() => {
            showFocusModeControls();
            focusModeState.hideTimer = setTimeout(() => {
                hideFocusModeControls();
            }, 2500);
        }, 300);
    } else {
        // Remove mouse movement listener
        document.removeEventListener('mousemove', handleFocusModeMouseMove);
        clearTimeout(focusModeState.hideTimer);

        // Remove control visibility classes
        app.classList.remove('controls-visible', 'toolbar-visible');
    }

    // CSS handles hiding/showing panels via .fullscreen class
    // No need to toggle panels - this prevents animation conflicts
    app.classList.toggle('fullscreen', focusModeState.active);
    updateFocusModeUI();
}

function updateFocusModeUI() {
    const fullscreenBtn = document.getElementById('fullscreenBtn');
    if (fullscreenBtn) {
        fullscreenBtn.classList.toggle('active', focusModeState.active);
    }
}

// ============ Comment/Marker Highlighting ============

/**
 * Highlight a comment when its marker is clicked
 * Also highlights all comments on the same frame
 */
function highlightCommentFromMarker(commentId, frame) {
    // Clear any existing marker highlights
    document.querySelectorAll('.timeline-marker.highlighted').forEach(m => {
        m.classList.remove('highlighted');
    });

    // Highlight the clicked marker (and any markers on same frame)
    document.querySelectorAll(`.timeline-marker[data-frame="${frame}"]`).forEach(m => {
        m.classList.add('highlighted');
    });

    // Find and highlight the comment(s) for this frame
    const commentsList = document.getElementById('commentsList');
    if (!commentsList) return;

    // Clear existing comment highlights
    commentsList.querySelectorAll('.comment-item.highlighted').forEach(c => {
        c.classList.remove('highlighted');
    });

    // Get all comments on this frame
    const commentsOnFrame = AppState.comments.filter(c => c.frame === frame);

    commentsOnFrame.forEach(c => {
        const commentEl = commentsList.querySelector(`[data-comment-id="${c.id}"]`);
        if (commentEl) {
            commentEl.classList.add('highlighted');
            // Scroll the first one into view
            if (c.id === commentId) {
                commentEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
            }
        }
    });

    // Auto-clear highlight after 3 seconds
    setTimeout(() => {
        document.querySelectorAll('.timeline-marker.highlighted').forEach(m => {
            m.classList.remove('highlighted');
        });
        commentsList.querySelectorAll('.comment-item.highlighted').forEach(c => {
            c.classList.remove('highlighted');
        });
    }, 3000);
}

/**
 * Highlight a marker when its comment is clicked
 */
function highlightMarkerFromComment(commentId, frame) {
    // Clear any existing highlights
    document.querySelectorAll('.timeline-marker.highlighted').forEach(m => {
        m.classList.remove('highlighted');
    });

    // Highlight the marker for this comment/frame
    document.querySelectorAll(`.timeline-marker[data-frame="${frame}"]`).forEach(m => {
        m.classList.add('highlighted');
    });

    // Auto-clear highlight after 3 seconds
    setTimeout(() => {
        document.querySelectorAll('.timeline-marker.highlighted').forEach(m => {
            m.classList.remove('highlighted');
        });
    }, 3000);
}

// Make functions globally accessible
window.initVideoPlayer = initVideoPlayer;
window.togglePlay = togglePlay;
window.seekFrames = seekFrames;
window.seekSeconds = seekSeconds;
window.updateTimecode = updateTimecode;
window.renderTimelineMarkers = renderTimelineMarkers;
window.highlightCommentFromMarker = highlightCommentFromMarker;
window.highlightMarkerFromComment = highlightMarkerFromComment;
window.redrawCanvas = redrawCanvas;
window.setInPoint = setInPoint;
window.setOutPoint = setOutPoint;
window.clearInPoint = clearInPoint;
window.clearOutPoint = clearOutPoint;
window.toggleLoop = toggleLoop;
window.clearInOut = clearInOut;
window.updateLoopButton = updateLoopButton;
window.setPlaybackSpeed = setPlaybackSpeed;
window.resetPlayButton = resetPlayButton;
window.toggleShortcutsOverlay = toggleShortcutsOverlay;
window.closeShortcutsOverlay = closeShortcutsOverlay;
window.initKeyboardShortcuts = initKeyboardShortcuts;
window.setZoom = setZoom;
window.resetZoom = resetZoom;
window.applyZoomFromSync = applyZoomFromSync;
window.sendSyncZoom = sendSyncZoom;
window.setVolume = setVolume;
window.toggleMute = toggleMute;
window.toggleFocusMode = toggleFocusMode;
window.zoomState = zoomState;
window.updateOverlayDimensions = updateOverlayDimensions;
window.getBaseDisplayRatio = getBaseDisplayRatio;
window.updateCacheBar = updateCacheBar;
