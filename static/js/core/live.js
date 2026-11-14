/**
 * Live - one WebSocket per tab (/ws/live) that brings in what other people do:
 * review comments, clips, tasks, notifications and project list changes.
 *
 *   Live.connect()                 once there is a token (login or share link)
 *   Live.watch('tasks', projectId) follow a project (the review project is followed automatically)
 *   Live.on('comment_added', fn)   handle an event
 *   Live.on('resync', fn)          the line was down: fetch what may have been missed
 *
 * The server does not echo a change back to the tab that made it (X-Client-Id).
 */
const Live = (function () {
    const SESSION_ENDED = 4401;
    const PING_EVERY = 25000;
    const SILENCE_LIMIT = 60000;

    let ws = null;
    let retries = 0;
    let retryTimer = null;
    let lastHeard = 0;
    let wasConnected = false;
    let stopped = false;
    const handlers = {};
    const wanted = {};   // slot ('review', 'tasks') -> project id
    let sent = '';       // the watch list the server last got from us

    function on(type, fn) {
        (handlers[type] = handlers[type] || []).push(fn);
    }

    function emit(type, msg) {
        (handlers[type] || []).forEach(fn => {
            try {
                fn(msg);
            } catch (e) {
                console.error(`Live: handler for ${type} failed`, e);
            }
        });
    }

    function projects() {
        // The review project comes straight from the app state, so every way of opening a project is covered
        const ids = [AppState.projectId, ...Object.values(wanted)].filter(Boolean);
        return [...new Set(ids)];
    }

    function sendWatch(force) {
        if (!ws || ws.readyState !== WebSocket.OPEN) return;
        const list = projects();
        const key = list.join(',');
        if (!force && key === sent) return;
        sent = key;
        ws.send(JSON.stringify({ type: 'watch', projects: list }));
    }

    function watch(slot, projectId) {
        if (projectId) wanted[slot] = projectId;
        else delete wanted[slot];
        sendWatch();
    }

    function connect() {
        stopped = false;
        clearTimeout(retryTimer);
        if (ws && ws.readyState <= WebSocket.OPEN) return;
        const token = typeof getAuthToken === 'function' ? getAuthToken() : null;
        if (!token) return;

        const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
        const socket = new WebSocket(withAuthToken(
            `${protocol}//${location.host}/ws/live?client_id=${encodeURIComponent(window.CLIENT_ID || '')}`
        ));
        ws = socket;

        socket.onopen = () => {
            retries = 0;
            lastHeard = Date.now();
            sendWatch(true);
            // Anything that happened while the line was down (or before it came up) was missed
            emit(wasConnected ? 'resync' : 'connected', {});
            wasConnected = true;
        };
        socket.onmessage = (event) => {
            lastHeard = Date.now();
            let msg;
            try {
                msg = JSON.parse(event.data);
            } catch (e) {
                return;
            }
            if (msg && msg.type && msg.type !== 'pong') emit(msg.type, msg);
        };
        socket.onclose = (event) => {
            if (ws !== socket) return; // replaced or closed on purpose
            ws = null;
            sent = '';
            if (event.code === SESSION_ENDED) {
                // The login (or the guest's access) is over
                if (typeof Auth !== 'undefined' && Auth.isLoggedIn()) Auth.end('expired');
                else emit('guest_access_ended', {});
                return;
            }
            if (stopped) return;
            const delay = Math.min(1000 * 2 ** retries, 30000);
            retries++;
            retryTimer = setTimeout(connect, delay);
        };
    }

    function stop() {
        stopped = true;
        clearTimeout(retryTimer);
        const socket = ws;
        ws = null;
        if (socket) socket.close(1000);
    }

    // Keep the line honest, and follow the app when it moves to another project
    setInterval(() => {
        if (!ws || ws.readyState !== WebSocket.OPEN) return;
        if (Date.now() - lastHeard > SILENCE_LIMIT) {
            ws.close(); // dead line: onclose reconnects
            return;
        }
        sendWatch();
    }, 2000);
    setInterval(() => {
        if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'ping' }));
    }, PING_EVERY);
    // Come back quickly after sleep / network change instead of waiting for the backoff
    window.addEventListener('online', () => { retries = 0; if (!stopped) connect(); });
    document.addEventListener('visibilitychange', () => {
        if (!document.hidden && !ws && !stopped) { retries = 0; connect(); }
    });

    return { connect, stop, watch, on, isConnected: () => !!ws && ws.readyState === WebSocket.OPEN };
})();

window.Live = Live;


// ============ What the app does with live events ============

(function () {
    const isReviewProject = (msg) => !!msg.project && msg.project === AppState.projectId;

    // ----- Review comments -----
    Live.on('comment_added', (msg) => {
        if (!isReviewProject(msg) || !msg.comment) return;
        if (AppState.comments.some(c => c.id === msg.comment.id)) return;
        AppState.comments.push(msg.comment);
        renderComments();
    });

    Live.on('comment_deleted', (msg) => {
        if (isReviewProject(msg)) handleCommentDeleted(msg.commentId);
    });

    Live.on('comment_updated', (msg) => {
        if (!isReviewProject(msg)) return;
        const comment = AppState.comments.find(c => c.id === msg.commentId);
        if (comment && comment.resolved !== msg.resolved) {
            comment.resolved = msg.resolved;
            renderComments();
        }
    });

    // ----- Clips -----
    Live.on('clip_updated', (msg) => {
        if (isReviewProject(msg) && msg.clip) applyClipUpdate(msg.baseName, msg.clip, true);
    });

    Live.on('clip_deleted', (msg) => {
        if (isReviewProject(msg)) removeClipLocally(msg.baseName);
    });

    // ----- Projects and access -----
    function leaveProject(message) {
        if (typeof Toast !== 'undefined') Toast.error(message);
        setTimeout(() => window.location.replace('/'), 1500);
    }

    Live.on('project_deleted', (msg) => {
        if (isReviewProject(msg)) leaveProject('This project was deleted');
    });

    Live.on('access_removed', (msg) => {
        if (isReviewProject(msg)) leaveProject('You no longer have access to this project');
    });

    Live.on('guest_access_ended', () => {
        if (typeof Toast !== 'undefined') {
            Toast.error('Your access to this project has ended. Open the share link again to continue.');
        }
    });

    Live.on('projects_changed', () => {
        if (typeof refreshProjectsList === 'function') refreshProjectsList();
    });

    // ----- Notifications -----
    Live.on('notification', (msg) => {
        if (msg.notification && typeof handleNewNotification === 'function') handleNewNotification(msg.notification);
    });

    // ----- Tasks (list rows: TaskLive; open task panel: taskDetail.js) -----
    ['task_created', 'task_updated', 'task_deleted', 'tasks_reordered'].forEach(type => {
        Live.on(type, (msg) => { if (window.TaskLive) TaskLive.handle(msg); });
    });
    ['comments', 'checklist', 'clips'].forEach(part => {
        Live.on(`task_${part}_changed`, (msg) => {
            if (typeof refreshOpenTaskDetail === 'function') refreshOpenTaskDetail(msg.taskId, part);
        });
    });

    // ----- Catching up -----
    async function resyncReview() {
        const projectId = AppState.projectId;
        if (!projectId) return;
        try {
            const res = await fetch(`/api/projects/${projectId}`);
            if (!res.ok || projectId !== AppState.projectId) return;
            const data = await res.json();
            if (data.error) return;
            AppState.comments = data.comments || [];
            renderComments();
            const clips = data.clips || {};
            Object.keys(AppState.clips).forEach(name => { if (!clips[name]) removeClipLocally(name); });
            Object.entries(clips).forEach(([name, clip]) => applyClipUpdate(name, clip, false));
        } catch (e) {
            console.error('Live: could not catch up on the project', e);
        }
    }

    function loadUserData() {
        if (typeof loadNotifications === 'function') loadNotifications();
    }

    Live.on('connected', loadUserData);
    Live.on('resync', () => {
        resyncReview();
        if (window.TaskLive) TaskLive.reload();
        if (typeof refreshProjectsList === 'function') refreshProjectsList();
        loadUserData();
    });
})();
