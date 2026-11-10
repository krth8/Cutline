/**
 * ReviewSync - WebSocket plugin for video review synchronization
 * Handles video playback sync, clip switching, quality changes, etc.
 * Registers handlers with WebSocketManager
 */
const ReviewSync = (function() {
    // State
    let isLeader = false;
    let syncEnabled = false;
    let unsubscribers = [];

    // Throttle state for sync broadcasts
    let lastSyncTime = 0;
    const SYNC_THROTTLE_MS = 100;

    return {
        // ============ Handler Registration ============

        /**
         * Get all message handlers for WebSocketManager.registerPlugin()
         */
        getHandlers() {
            return {
                'init': (data) => this.handleInit(data),
                'user_joined': (data) => this.handleUserJoined(data),
                'user_left': (data) => this.handleUserLeft(data),
                'session_ended': (data) => this.handleSessionEnded(data),
                'sync': (data) => this.handleSync(data),
                'sync_inout': (data) => this.handleSyncInOut(data),
                'sync_clip': (data) => this.handleSyncClip(data),
                'sync_quality': (data) => this.handleSyncQuality(data),
                'sync_zoom': (data) => this.handleSyncZoom(data),
                'sync_timecode_mode': (data) => this.handleSyncTimecodeMode(data),
                'sync_compare': (data) => this.handleSyncCompare(data),
                'cursor': (data) => this.handleCursor(data),
                'draw': (data) => this.handleDraw(data),
                'comment': (data) => this.handleComment(data),
                'comment_deleted': (data) => this.handleCommentDeleted(data),
                'annotation_saved': (data) => this.handleAnnotationSaved(data),
                'clip_added': (data) => this.handleClipAdded(data),
                'notification': (data) => this.handleNotification(data),
                'ping': (data) => this.handlePing(data),
            };
        },

        /**
         * Initialize sync with WebSocketManager
         */
        init() {
            // Register all handlers
            const unsubscribe = WebSocketManager.registerPlugin(this.getHandlers());
            unsubscribers.push(unsubscribe);

            // Listen for connection state changes
            const connUnsub = WebSocketManager.onConnection((state) => {
                if (state === 'connected') {
                    this._onConnected();
                } else if (state === 'disconnected') {
                    this._onDisconnected();
                }
            });
            unsubscribers.push(connUnsub);
        },

        /**
         * Cleanup - unregister all handlers
         */
        cleanup() {
            unsubscribers.forEach(fn => fn());
            unsubscribers = [];
            isLeader = false;
            syncEnabled = false;
        },

        // ============ State Control ============

        setLeader(value) {
            isLeader = value;
        },

        isLeader() {
            return isLeader;
        },

        setSyncEnabled(value) {
            syncEnabled = value;

            // When enabling sync, broadcast current state
            if (value) {
                this.broadcastFullState();
            }
        },

        isSyncEnabled() {
            return syncEnabled;
        },

        // ============ Broadcast Methods ============

        /**
         * Broadcast current playback state
         */
        broadcastSync() {
            if (!syncEnabled) return;

            const now = Date.now();
            if (now - lastSyncTime < SYNC_THROTTLE_MS) return;
            lastSyncTime = now;

            WebSocketManager.send('sync', {
                frame: typeof getCurrentFrame === 'function' ? getCurrentFrame() : 0,
                playing: elements?.video ? !elements.video.paused : false
            });
        },

        /**
         * Broadcast in/out points
         */
        broadcastInOut() {
            if (!syncEnabled) return;

            WebSocketManager.send('sync_inout', {
                inPoint: AppState.inPoint,
                outPoint: AppState.outPoint,
                loopEnabled: AppState.loopEnabled
            });
        },

        /**
         * Broadcast clip change
         */
        broadcastClipChange(baseName, version) {
            if (!syncEnabled || AppState._suppressClipSync) return;

            WebSocketManager.send('sync_clip', {
                baseName,
                version
            });
        },

        /**
         * Broadcast quality change
         */
        broadcastQualityChange(quality) {
            if (!syncEnabled) return;

            WebSocketManager.send('sync_quality', { quality });
        },

        /**
         * Broadcast zoom state
         */
        broadcastZoom(scale, panX, panY) {
            if (!syncEnabled) return;

            WebSocketManager.send('sync_zoom', { scale, panX, panY });
        },

        /**
         * Broadcast timecode mode toggle
         */
        broadcastTimecodeMode(showTimecode) {
            if (!syncEnabled) return;

            WebSocketManager.send('sync_timecode_mode', { showTimecode });
        },

        /**
         * Broadcast compare mode state
         */
        broadcastCompare(compareMode, compareVersion, wipePosition) {
            if (!syncEnabled || AppState._suppressCompareSync) return;

            WebSocketManager.send('sync_compare', {
                compareMode,
                compareVersion,
                wipePosition
            });
        },

        /**
         * Broadcast cursor position
         */
        broadcastCursor(x, y) {
            WebSocketManager.sendThrottled('cursor', { x, y }, 100);
        },

        /**
         * Broadcast full state when sync is enabled
         */
        broadcastFullState() {
            this.broadcastSync();
            this.broadcastInOut();

            if (AppState.currentClip) {
                this.broadcastClipChange(AppState.currentClip.baseName, AppState.currentClip.version);
            }
            if (AppState.currentQuality) {
                this.broadcastQualityChange(AppState.currentQuality);
            }
        },

        // ============ Message Handlers ============

        handleInit(data) {
            // Handle session initialization
            if (data.users) {
                data.users.forEach(u => {
                    AppState.users[u.id] = u;
                    if (typeof renderUserAvatar === 'function') {
                        renderUserAvatar(u);
                    }
                });
            }

            if (data.session?.comments) {
                AppState.comments = data.session.comments;
                CommentManager?.setComments?.(data.session.comments);
                if (typeof renderComments === 'function') {
                    renderComments();
                }
            }

            if (data.session?.annotations) {
                data.session.annotations.forEach(a => {
                    if (!AppState.annotations[a.frame]) AppState.annotations[a.frame] = [];
                    AppState.annotations[a.frame].push(a);
                });
            }

            if (data.session?.clips) {
                AppState.clips = data.session.clips;
                if (typeof renderClipsSidebar === 'function') renderClipsSidebar();
                if (typeof renderClipBin === 'function') renderClipBin();
            }
        },

        handleUserJoined(data) {
            AppState.users[data.user.id] = data.user;
            if (typeof renderUserAvatar === 'function') {
                renderUserAvatar(data.user);
            }
            if (typeof showToast === 'function') {
                showToast(`${data.user.name || data.user.id} joined`);
            }
        },

        handleUserLeft(data) {
            delete AppState.users[data.user_id];
            document.querySelector(`[data-user="${data.user_id}"]`)?.remove();
            document.querySelector(`.remote-cursor[data-user="${data.user_id}"]`)?.remove();
        },

        handleSessionEnded(data) {
            console.log('Session ended:', data.reason);

            AppState.sessionId = null;
            syncEnabled = false;
            AppState.syncEnabled = false;
            AppState._wsIntentionalConnect = false;
            AppState.ws = null;

            if (typeof updateSyncUI === 'function') updateSyncUI();
            if (typeof updateSessionBadgeState === 'function') updateSessionBadgeState(false);

            AppState.users = {};
            document.querySelectorAll('.user-avatar:not(.self)').forEach(el => el.remove());
            document.querySelectorAll('.remote-cursor').forEach(el => el.remove());

            alert(data.reason || 'The session has ended.');
        },

        handleSync(data) {
            if (!syncEnabled || data.user_id === AppState.userId) return;

            if (elements?.video) {
                elements.video.currentTime = data.frame / (AppState.fps || 24);
                if (data.playing && elements.video.paused) elements.video.play();
                if (!data.playing && !elements.video.paused) elements.video.pause();
            }

            if (typeof showSyncFlash === 'function') {
                showSyncFlash(data.user_id, 'synced playback');
            }
        },

        handleSyncInOut(data) {
            if (!syncEnabled || data.user_id === AppState.userId) return;

            AppState.inPoint = data.inPoint;
            AppState.outPoint = data.outPoint;
            AppState.loopEnabled = data.loopEnabled;

            if (typeof updateInOutDisplay === 'function') updateInOutDisplay();
            if (typeof renderTimelineMarkers === 'function') renderTimelineMarkers();
            if (typeof updateLoopButton === 'function') updateLoopButton();
            if (typeof showSyncFlash === 'function') showSyncFlash(data.user_id, 'changed in/out points');
        },

        handleSyncClip(data) {
            if (!syncEnabled || data.user_id === AppState.userId) return;

            AppState._suppressClipSync = true;
            if (typeof selectClipVersion === 'function') {
                selectClipVersion(data.baseName, data.version);
            }
            AppState._suppressClipSync = false;

            if (typeof showSyncFlash === 'function') {
                showSyncFlash(data.user_id, `switched to ${data.baseName} v${formatVersion?.(data.version) || data.version}`);
            }
            if (typeof flashClipChange === 'function') flashClipChange(data.baseName);
            if (typeof flashVersionChange === 'function') flashVersionChange();
        },

        handleSyncQuality(data) {
            if (!syncEnabled || data.user_id === AppState.userId) return;

            if (typeof changeQuality === 'function') {
                changeQuality(data.quality, false);
            }
            if (typeof showSyncFlash === 'function') {
                showSyncFlash(data.user_id, `changed quality to ${data.quality}`);
            }
            if (typeof flashQualityChange === 'function') flashQualityChange();
        },

        handleSyncZoom(data) {
            if (!syncEnabled || data.user_id === AppState.userId) return;

            if (typeof applyZoomFromSync === 'function') {
                applyZoomFromSync(data.scale, data.panX, data.panY);
            }
            if (typeof showSyncFlash === 'function') {
                const zoomPercent = Math.round(data.scale * 100);
                showSyncFlash(data.user_id, `zoomed to ${zoomPercent}%`);
            }
        },

        handleSyncTimecodeMode(data) {
            if (!syncEnabled || data.user_id === AppState.userId) return;

            AppState.showTimecode = data.showTimecode;
            localStorage.setItem('showTimecode', AppState.showTimecode);

            if (typeof renderComments === 'function') renderComments();
            if (typeof updateTimecodeDisplay === 'function') updateTimecodeDisplay();
            if (typeof showSyncFlash === 'function') {
                const modeText = data.showTimecode ? 'timecode' : 'frame';
                showSyncFlash(data.user_id, `switched to ${modeText} display`);
            }
        },

        handleSyncCompare(data) {
            if (!syncEnabled || data.user_id === AppState.userId) return;

            AppState._suppressCompareSync = true;
            if (data.compareMode) {
                AppState.compareMode = true;
                if (typeof showCompareUI === 'function') showCompareUI();
                if (data.compareVersion && typeof selectCompareVersion === 'function') {
                    selectCompareVersion(data.compareVersion);
                }
                if (typeof updateWipePosition === 'function') {
                    updateWipePosition(data.wipePosition || 50);
                }
            } else {
                AppState.compareMode = false;
                if (typeof hideCompareUI === 'function') hideCompareUI();
            }
            AppState._suppressCompareSync = false;

            if (typeof updateCompareButton === 'function') updateCompareButton();
            if (typeof showSyncFlash === 'function') {
                showSyncFlash(data.user_id, data.compareMode ? 'enabled compare mode' : 'disabled compare mode');
            }
        },

        handleCursor(data) {
            if (typeof renderRemoteCursor === 'function') {
                renderRemoteCursor(data.user_id, data.x, data.y, data.color);
            }
        },

        handleDraw(data) {
            if (typeof drawRemoteStroke === 'function') {
                drawRemoteStroke(data.user_id, data.stroke, data.color, data.brushSize, data.brushType);
            }
        },

        handleComment(data) {
            AppState.comments.push(data.data);
            CommentManager?.handleRemoteCommentAdded?.(data);
            if (typeof renderComments === 'function') renderComments();
        },

        handleCommentDeleted(data) {
            if (typeof handleCommentDeleted === 'function') {
                handleCommentDeleted(data.comment_id);
            }
            CommentManager?.handleRemoteCommentDeleted?.(data);
        },

        handleAnnotationSaved(data) {
            const a = data.annotation;
            if (!AppState.annotations[a.frame]) AppState.annotations[a.frame] = [];
            AppState.annotations[a.frame].push(a);
            if (typeof renderTimelineMarkers === 'function') renderTimelineMarkers();
        },

        handleClipAdded(data) {
            if (data.clip && typeof parseClipFilename === 'function' && typeof addClipVersion === 'function') {
                const clipInfo = parseClipFilename(data.clip.filename);
                addClipVersion(clipInfo.baseName, clipInfo.version, data.clip.filename);
            }
        },

        handleNotification(data) {
            if (data.notification && window.handleNewNotification) {
                window.handleNewNotification(data.notification);
            }
        },

        handlePing(data) {
            WebSocketManager.send('pong', { timestamp: data.timestamp });
        },

        // ============ Internal ============

        _onConnected() {
            if (typeof updateSessionBadgeState === 'function') {
                updateSessionBadgeState(true);
            }
        },

        _onDisconnected() {
            if (typeof updateSessionBadgeState === 'function') {
                updateSessionBadgeState(false);
            }
        }
    };
})();

// Export to global scope
window.ReviewSync = ReviewSync;
