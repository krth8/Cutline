// ============ Review session socket ============
// Only the things that exist while people review together: synced playback,
// shared cursors and live drawing. Comments, clips and notifications arrive
// over the always-on live connection (core/live.js).

function initWebSocket() {
    // WebSocket will be initialized when session starts
}

async function connectWebSocket() {
    const sessionId = AppState.sessionId;
    const userName = AppState.userName || AppState.userId;
    if (!sessionId) return;

    // Track that we're intentionally connected
    AppState._wsIntentionalConnect = true;

    const stillWanted = () => AppState.sessionId === sessionId && AppState._wsIntentionalConnect;
    const retry = () => {
        const attempts = AppState._wsReconnectAttempts || 0;
        const delay = Math.min(2000 * Math.pow(2, attempts), 30000);
        AppState._wsReconnectAttempts = attempts + 1;
        setTimeout(() => { if (stillWanted()) connectWebSocket(); }, delay);
    };

    let opened;
    try {
        opened = await openSocket(`/ws/${encodeURIComponent(sessionId)}/${encodeURIComponent(AppState.userId)}?name=${encodeURIComponent(userName)}`);
    } catch (e) {
        if (stillWanted()) retry();
        return;
    }
    // The user may have left the session while the socket was being opened
    if (!stillWanted()) {
        opened.close(1000);
        return;
    }
    if (AppState.ws && AppState.ws !== opened) {
        AppState.ws.onclose = null;
        AppState.ws.close(1000);
    }
    AppState.ws = opened;

    const socket = AppState.ws;
    let keepAlive = null;
    socket.onopen = () => {
        console.log('Connected to session');
        AppState._wsReconnectAttempts = 0;
        updateSessionBadgeState(true);
        // Proxies drop sockets that stay silent
        keepAlive = setInterval(() => {
            if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'pong' }));
        }, 25000);
    };
    socket.onmessage = (e) => handleMessage(JSON.parse(e.data));
    socket.onclose = (event) => {
        clearInterval(keepAlive);
        updateSessionBadgeState(false);

        // 4403: access to this project was removed. 4401: the login ended. Don't keep retrying;
        // the live connection (core/live.js) tells the user.
        if (event.code === 4403 || event.code === 4401) {
            AppState._wsIntentionalConnect = false;
            return;
        }

        // Only reconnect if we have an active session AND didn't intentionally disconnect
        if (AppState.ws === socket) AppState.ws = null;
        if (stillWanted() && event.code !== 1000) retry();
    };
    socket.onerror = () => {
        updateSessionBadgeState(false);
    };
}

// Clean disconnect without auto-reconnect
function disconnectWebSocket() {
    if (AppState.ws) {
        AppState._wsIntentionalConnect = false;  // Prevent reconnect
        AppState.ws.close(1000, 'User leaving session');
        AppState.ws = null;
    }
}

function updateSessionBadgeState(connected) {
    const badge = document.getElementById('sessionBadge');
    if (badge) {
        if (connected) {
            badge.classList.add('active');
        } else {
            badge.classList.remove('active');
        }
    }
}

function handleMessage(msg) {
    switch (msg.type) {
        case 'init':
            msg.users.forEach(u => {
                AppState.users[u.id] = u;
                renderUserAvatar(u);
            });
            if (msg.session.comments) {
                AppState.comments = msg.session.comments;
                renderComments();
            }
            if (msg.session.annotations) {
                msg.session.annotations.forEach(a => {
                    if (!AppState.annotations[a.frame]) AppState.annotations[a.frame] = [];
                    AppState.annotations[a.frame].push(a);
                });
            }
            if (msg.session.clips) {
                AppState.clips = msg.session.clips;
                renderClipsSidebar();
                renderClipBin();
            }
            break;

        case 'user_joined':
            AppState.users[msg.user.id] = msg.user;
            renderUserAvatar(msg.user);
            break;

        case 'user_left':
            delete AppState.users[msg.user_id];
            document.querySelector(`[data-user="${msg.user_id}"]`)?.remove();
            document.querySelector(`.remote-cursor[data-user="${msg.user_id}"]`)?.remove();
            break;

        case 'session_ended':
            console.log('Session ended:', msg.reason);

            // Clear session state
            AppState.sessionId = null;
            AppState.syncEnabled = false;
            AppState._wsIntentionalConnect = false;  // Prevent reconnect
            AppState.ws = null;

            // Update UI
            updateSyncUI();
            updateSessionBadgeState(false);

            // Clear remote users and cursors
            AppState.users = {};
            document.querySelectorAll('.user-avatar:not(.self)').forEach(el => el.remove());
            document.querySelectorAll('.remote-cursor').forEach(el => el.remove());

            // Show notification to user
            alert(msg.reason || 'The session has ended.');
            break;

        case 'sync':
            if (AppState.syncEnabled && msg.user_id !== AppState.userId) {
                elements.video.currentTime = msg.frame / AppState.fps;
                if (msg.playing && elements.video.paused) elements.video.play();
                if (!msg.playing && !elements.video.paused) elements.video.pause();
                // Only show toast for sync, no flash on timeline
                showSyncFlash(msg.user_id, 'synced playback');
            }
            break;

        case 'sync_inout':
            if (AppState.syncEnabled && msg.user_id !== AppState.userId) {
                AppState.inPoint = msg.inPoint;
                AppState.outPoint = msg.outPoint;
                AppState.loopEnabled = msg.loopEnabled;
                updateInOutDisplay();
                renderTimelineMarkers();
                updateLoopButton();
                // Flash on in/out change
                showSyncFlash(msg.user_id, 'changed in/out points');
                // Flash specific elements
                const inBtn = document.querySelector('.in-out-btn:first-child');
                const outBtn = document.querySelector('.in-out-btn:nth-child(2)');
                const loopBtn = document.getElementById('loopBtn');
                if (inBtn) triggerElementFlash(inBtn);
                if (outBtn) triggerElementFlash(outBtn);
                if (loopBtn) triggerElementFlash(loopBtn);
            }
            break;

        case 'sync_clip':
            if (AppState.syncEnabled && msg.user_id !== AppState.userId) {
                // Change clip without triggering another sync
                AppState._suppressClipSync = true;
                selectClipVersion(msg.baseName, msg.version);
                AppState._suppressClipSync = false;
                // Flash on clip change
                showSyncFlash(msg.user_id, `switched to ${msg.baseName} v${formatVersion(msg.version)}`);
                flashClipChange(msg.baseName);
                flashVersionChange();
            }
            break;

        case 'sync_quality':
            if (AppState.syncEnabled && msg.user_id !== AppState.userId) {
                // Change quality without triggering another sync
                changeQuality(msg.quality, false);
                // Flash on quality change
                showSyncFlash(msg.user_id, `changed quality to ${msg.quality}`);
                flashQualityChange();
            }
            break;

        case 'sync_zoom':
            if (AppState.syncEnabled && msg.user_id !== AppState.userId) {
                applyZoomFromSync(msg.scale, msg.panX, msg.panY);
                const zoomPercent = Math.round(msg.scale * 100);
                showSyncFlash(msg.user_id, `zoomed to ${zoomPercent}%`);
            }
            break;

        case 'sync_timecode_mode':
            if (AppState.syncEnabled && msg.user_id !== AppState.userId) {
                AppState.showTimecode = msg.showTimecode;
                localStorage.setItem('showTimecode', AppState.showTimecode);
                renderComments();
                updateTimecodeDisplay();
                const modeText = msg.showTimecode ? 'timecode' : 'frame';
                showSyncFlash(msg.user_id, `switched to ${modeText} display`);
            }
            break;

        case 'cursor':
            renderRemoteCursor(msg.user_id, msg.x, msg.y, msg.color);
            break;

        case 'draw':
            drawRemoteStroke(msg.user_id, msg.stroke, msg.color, msg.brushSize, msg.brushType);
            break;

        case 'draw_complete':
            // Clear the remote drawing for this user when they finish/post
            if (typeof clearRemoteDrawing === 'function') {
                clearRemoteDrawing(msg.user_id);
            }
            break;

        case 'annotation_saved':
            const a = msg.annotation;
            if (!AppState.annotations[a.frame]) AppState.annotations[a.frame] = [];
            AppState.annotations[a.frame].push(a);
            renderTimelineMarkers();
            break;

        case 'sync_compare':
            if (AppState.syncEnabled && msg.user_id !== AppState.userId) {
                AppState._suppressCompareSync = true;
                if (msg.compareMode) {
                    AppState.compareMode = true;
                    showCompareUI();
                    if (msg.compareVersion) {
                        selectCompareVersion(msg.compareVersion);
                    }
                    updateWipePosition(msg.wipePosition || 50);
                } else {
                    AppState.compareMode = false;
                    hideCompareUI();
                }
                AppState._suppressCompareSync = false;
                updateCompareButton();
                showSyncFlash(msg.user_id, msg.compareMode ? 'enabled compare mode' : 'disabled compare mode');
            }
            break;

        case 'ping':
            // Respond to server ping with pong
            if (AppState.ws && AppState.ws.readyState === WebSocket.OPEN) {
                AppState.ws.send(JSON.stringify({
                    type: 'pong',
                    timestamp: msg.timestamp
                }));
            }
            break;
    }
}

// ============ Users ============
function renderUserAvatar(user) {
    const existing = document.querySelector(`[data-user="${user.id}"]`);
    if (existing) existing.remove();

    const avatar = document.createElement('div');
    avatar.className = 'user-avatar';
    avatar.dataset.user = user.id;
    avatar.style.background = user.color;

    // Use name initials if available, otherwise user id
    const displayName = user.name || user.id;
    const initials = displayName.split(' ').map(n => n[0]).join('').toUpperCase().substr(0, 2) || user.id.substr(-2).toUpperCase();

    avatar.innerHTML = `${initials}<div class="status-dot"></div>`;
    avatar.title = displayName;
    document.getElementById('usersOnline').appendChild(avatar);
}

function renderCurrentUserAvatar() {
    // Render own avatar based on AppState
    if (!AppState.userId) return;

    const existing = document.querySelector(`[data-user="${AppState.userId}"]`);

    const colors = ['#ef4444', '#f97316', '#f59e0b', '#22c55e', '#14b8a6', '#3b82f6', '#8b5cf6', '#ec4899'];
    const color = colors[Math.abs(AppState.userId.split('').reduce((a, c) => a + c.charCodeAt(0), 0)) % colors.length];

    const displayName = AppState.userName || 'Anonymous';
    const initials = displayName.split(' ').map(n => n[0]).join('').toUpperCase().substr(0, 2) || 'AN';

    // Check for profile image
    const profileImage = AppState.adminUser?.profileImage;

    let avatarContent;
    if (profileImage) {
        avatarContent = `<img src="${profileImage}" alt="${displayName}" class="user-avatar-img"><div class="status-dot"></div>`;
    } else {
        avatarContent = `${initials}<div class="status-dot"></div>`;
    }

    if (existing) {
        // Update existing avatar
        existing.style.background = profileImage ? 'transparent' : color;
        existing.innerHTML = avatarContent;
        return;
    }

    const avatar = document.createElement('div');
    avatar.className = 'user-avatar self';
    avatar.dataset.user = AppState.userId;
    avatar.style.background = profileImage ? 'transparent' : color;
    avatar.innerHTML = avatarContent;
    avatar.title = `${displayName} (you)`;

    document.getElementById('usersOnline').appendChild(avatar);
}

function renderRemoteCursor(userId, x, y, color) {
    let cursor = document.querySelector(`.remote-cursor[data-user="${userId}"]`);
    if (!cursor) {
        const user = AppState.users[userId];
        const displayName = user?.name || userId.substr(-4);

        cursor = document.createElement('div');
        cursor.className = 'remote-cursor';
        cursor.dataset.user = userId;
        cursor.innerHTML = `
            <svg viewBox="0 0 24 24" fill="${color}">
                <path d="M4 4l16 8-8 2-2 8z"/>
            </svg>
            <span class="cursor-label" style="background:${color}">${displayName}</span>
        `;
        document.getElementById('videoWrapper').appendChild(cursor);
    }

    // Respect cursor sharing setting (always show when drawing)
    const shouldShow = AppState.cursorSharingEnabled || AppState.drawMode;
    cursor.style.display = shouldShow ? 'block' : 'none';

    const rect = elements.video.getBoundingClientRect();
    const scaleX = rect.width / elements.video.videoWidth;
    const scaleY = rect.height / elements.video.videoHeight;

    cursor.style.left = (x * scaleX) + 'px';
    cursor.style.top = (y * scaleY) + 'px';
}

// ============ Sync Control ============
function initSyncControl() {
    const control = document.getElementById('syncControl');
    if (control) {
        control.addEventListener('click', toggleSync);
        control.style.cursor = 'pointer';
    }
}

function toggleSync(e) {
    if (e) e.stopPropagation();

    // If not in a session, show sessions popup
    if (!AppState.sessionId || !AppState.ws || AppState.ws.readyState !== WebSocket.OPEN) {
        showSessionsModal();
        return;
    }

    // Already in session - toggle sync
    AppState.syncEnabled = !AppState.syncEnabled;
    updateSyncUI();

    // When enabling sync, send full state to sync others
    if (AppState.syncEnabled) {
        sendSync();
        sendSyncInOut();
        if (AppState.currentClip) {
            sendSyncClip(AppState.currentClip.baseName, AppState.currentClip.version);
        }
        if (AppState.currentQuality) {
            sendSyncQuality(AppState.currentQuality);
        }
    }
}

function updateSyncUI() {
    const toggle = document.getElementById('syncToggle');
    const control = document.getElementById('syncControl');
    toggle?.classList.toggle('active', AppState.syncEnabled);
    control?.classList.toggle('synced', AppState.syncEnabled);
}

function sendSync() {
    if (AppState.ws && AppState.ws.readyState === WebSocket.OPEN) {
        AppState.ws.send(JSON.stringify({
            type: 'sync',
            frame: getCurrentFrame(),
            playing: !elements.video.paused
        }));
    }
}

function sendSyncInOut() {
    if (AppState.ws && AppState.ws.readyState === WebSocket.OPEN && AppState.syncEnabled) {
        AppState.ws.send(JSON.stringify({
            type: 'sync_inout',
            inPoint: AppState.inPoint,
            outPoint: AppState.outPoint,
            loopEnabled: AppState.loopEnabled
        }));
    }
}

function sendSyncClip(baseName, version) {
    if (AppState.ws && AppState.ws.readyState === WebSocket.OPEN && AppState.syncEnabled && !AppState._suppressClipSync) {
        AppState.ws.send(JSON.stringify({
            type: 'sync_clip',
            baseName,
            version
        }));
    }
}

function sendSyncTimecodeMode(showTimecode) {
    if (AppState.ws && AppState.ws.readyState === WebSocket.OPEN && AppState.syncEnabled) {
        AppState.ws.send(JSON.stringify({
            type: 'sync_timecode_mode',
            showTimecode
        }));
    }
}

// Throttle helper - limits function calls to once per interval
function createThrottle(fn, interval) {
    let lastCall = 0;
    let pendingArgs = null;
    let timeoutId = null;

    return function(...args) {
        const now = Date.now();
        pendingArgs = args;

        if (now - lastCall >= interval) {
            lastCall = now;
            fn.apply(this, args);
            pendingArgs = null;
        } else if (!timeoutId) {
            // Schedule final call with latest args
            timeoutId = setTimeout(() => {
                lastCall = Date.now();
                if (pendingArgs) fn.apply(this, pendingArgs);
                pendingArgs = null;
                timeoutId = null;
            }, interval - (now - lastCall));
        }
    };
}

// Raw send functions (internal)
function _sendCursorRaw(x, y) {
    if (AppState.ws && AppState.ws.readyState === WebSocket.OPEN) {
        AppState.ws.send(JSON.stringify({ type: 'cursor', x, y }));
    }
}

// Throttled cursor - max 10 updates/sec (100ms interval)
const sendCursor = createThrottle(_sendCursorRaw, 100);

// Draw buffer for accumulating points between throttle intervals
const drawBuffer = {
    points: [],
    frame: null,
    timeoutId: null,
    lastSend: 0
};

// Flush the draw buffer - sends all accumulated points
function flushDrawBuffer() {
    if (drawBuffer.points.length < 2) return;
    if (!AppState.ws || AppState.ws.readyState !== WebSocket.OPEN) return;

    AppState.ws.send(JSON.stringify({
        type: 'draw',
        frame: drawBuffer.frame,
        stroke: drawBuffer.points,
        brushSize: AppState.brushSize || 6,
        brushType: AppState.brushType || 'pen',
        color: AppState.drawColor || '#ff4444'
    }));

    // Keep last point for continuity overlap
    const lastPoint = drawBuffer.points[drawBuffer.points.length - 1];
    drawBuffer.points = [lastPoint];
    drawBuffer.lastSend = Date.now();
}

// Add point to draw buffer with throttled sending
function sendDraw(frame, point) {
    // If new frame/stroke, flush old and start fresh
    if (drawBuffer.frame !== null && drawBuffer.frame !== frame) {
        flushDrawBuffer();
        drawBuffer.points = [];
    }

    drawBuffer.frame = frame;

    // Add point (can be single point or array)
    if (Array.isArray(point)) {
        drawBuffer.points.push(...point);
    } else {
        drawBuffer.points.push(point);
    }

    const now = Date.now();
    const interval = 100; // 10 updates/sec

    // Clear any pending timeout
    if (drawBuffer.timeoutId) {
        clearTimeout(drawBuffer.timeoutId);
        drawBuffer.timeoutId = null;
    }

    // Send immediately if interval has passed
    if (now - drawBuffer.lastSend >= interval) {
        flushDrawBuffer();
    } else {
        // Schedule send for end of interval
        drawBuffer.timeoutId = setTimeout(() => {
            flushDrawBuffer();
            drawBuffer.timeoutId = null;
        }, interval - (now - drawBuffer.lastSend));
    }
}

// Clear draw buffer (call when stroke ends)
function clearDrawBuffer() {
    if (drawBuffer.timeoutId) {
        clearTimeout(drawBuffer.timeoutId);
        drawBuffer.timeoutId = null;
    }
    // Flush any remaining points before clearing
    if (drawBuffer.points.length >= 2) {
        flushDrawBuffer();
    }
    drawBuffer.points = [];
    drawBuffer.frame = null;
}

function sendDrawComplete(frame, strokes) {
    if (AppState.ws && AppState.ws.readyState === WebSocket.OPEN) {
        AppState.ws.send(JSON.stringify({
            type: 'draw_complete',
            frame,
            strokes
        }));
    }
}

// Make functions globally accessible
window.initWebSocket = initWebSocket;
window.connectWebSocket = connectWebSocket;
window.disconnectWebSocket = disconnectWebSocket;
window.sendSync = sendSync;
window.sendSyncInOut = sendSyncInOut;
window.sendSyncClip = sendSyncClip;
window.sendSyncTimecodeMode = sendSyncTimecodeMode;
window.sendCursor = sendCursor;
window.sendDraw = sendDraw;
window.sendDrawComplete = sendDrawComplete;
window.clearDrawBuffer = clearDrawBuffer;
window.initSyncControl = initSyncControl;
window.toggleSync = toggleSync;
window.updateSyncUI = updateSyncUI;
window.updateSessionBadgeState = updateSessionBadgeState;
window.renderUserAvatar = renderUserAvatar;
window.renderCurrentUserAvatar = renderCurrentUserAvatar;
