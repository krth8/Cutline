/**
 * ReviewModule - Entry point for Review functionality
 * Coordinates WebSocket, comments, video player, and sync
 */
const ReviewModule = (function() {
    // State
    let isInitialized = false;
    let projectId = null;
    let currentClipId = null;
    let unsubscribers = [];

    return {
        // ============ Initialization ============

        /**
         * Initialize the Review module for a project
         * @param {string} projId - Project ID
         * @param {string} clipId - Optional clip ID to select
         */
        async init(projId, clipId = null) {
            if (isInitialized) {
                this.cleanup();
            }

            projectId = projId;
            console.log('ReviewModule: Initializing for project', projectId);

            // Set project access permissions
            if (typeof UserManager !== 'undefined') {
                UserManager.setProjectAccessFromList(projectId);
            }

            // Store project ID in AppState for backwards compatibility
            AppState.projectId = projectId;

            // Initialize CommentManager with review context
            if (typeof CommentManager !== 'undefined') {
                CommentManager.init({
                    projectId: projectId,
                    contextType: 'clip',
                    getPosition: () => typeof getCurrentFrame === 'function' ? getCurrentFrame() : 0,
                    getUserId: () => AppState.userId || UserManager?.getUserId?.(),
                    getUserName: () => AppState.userName || UserManager?.getUsername?.() || 'Anonymous',
                    getProfileImage: () => AppState.adminUser?.profileImage || UserManager?.getProfileImage?.()
                });

                // Subscribe to CommentManager events
                const commentUnsub = CommentManager.subscribe((event, data) => {
                    this._handleCommentEvent(event, data);
                });
                unsubscribers.push(commentUnsub);
            }

            // Initialize ReviewSync
            if (typeof ReviewSync !== 'undefined') {
                ReviewSync.init();
            }

            isInitialized = true;

            // Select initial clip if provided
            if (clipId) {
                await this.selectClip(clipId);
            }

            this._notifyInitialized();
            return { success: true };
        },

        /**
         * Join a sync session
         * @param {string} sessionId - Session ID to join
         */
        joinSession(sessionId) {
            if (!isInitialized) {
                console.warn('ReviewModule: Cannot join session - not initialized');
                return false;
            }

            // Connect WebSocketManager
            if (typeof WebSocketManager !== 'undefined') {
                WebSocketManager.connect(sessionId, {
                    userId: AppState.userId,
                    userName: AppState.userName
                });

                // Store for backwards compatibility
                AppState.sessionId = sessionId;

                // Enable sync in ReviewSync
                if (typeof ReviewSync !== 'undefined') {
                    ReviewSync.setSyncEnabled(true);
                }

                return true;
            }

            // Fallback to legacy websocket
            if (typeof connectWebSocket === 'function') {
                AppState.sessionId = sessionId;
                connectWebSocket();
                return true;
            }

            return false;
        },

        /**
         * Leave current session
         */
        leaveSession() {
            if (typeof WebSocketManager !== 'undefined') {
                WebSocketManager.disconnect();
            } else if (typeof disconnectWebSocket === 'function') {
                disconnectWebSocket();
            }

            AppState.sessionId = null;
            AppState.syncEnabled = false;

            if (typeof ReviewSync !== 'undefined') {
                ReviewSync.setSyncEnabled(false);
            }
        },

        // ============ Clip Management ============

        /**
         * Select a clip for review
         * @param {string} clipId - Clip ID
         * @param {object} options - { baseName, version }
         */
        async selectClip(clipId, options = {}) {
            currentClipId = clipId;

            // Update CommentManager context
            if (typeof CommentManager !== 'undefined') {
                CommentManager.setContext(clipId, {
                    contextName: options.baseName || AppState.currentClip?.baseName,
                    contextVersion: options.version || AppState.currentClip?.version
                });

                // Load comments for this clip
                await CommentManager.loadComments();
            }

            console.log('ReviewModule: Selected clip', clipId);
        },

        /**
         * Get current clip ID
         */
        getCurrentClipId() {
            return currentClipId;
        },

        // ============ Sync Control ============

        /**
         * Enable/disable sync with other users
         */
        setSyncEnabled(enabled) {
            AppState.syncEnabled = enabled;

            if (typeof ReviewSync !== 'undefined') {
                ReviewSync.setSyncEnabled(enabled);
            }

            if (typeof updateSyncUI === 'function') {
                updateSyncUI();
            }
        },

        /**
         * Check if sync is enabled
         */
        isSyncEnabled() {
            return AppState.syncEnabled || ReviewSync?.isSyncEnabled?.() || false;
        },

        /**
         * Set this user as sync leader
         */
        setLeader(isLeader) {
            if (typeof ReviewSync !== 'undefined') {
                ReviewSync.setLeader(isLeader);
            }
        },

        // ============ Comments ============

        /**
         * Add a comment to the current clip
         * @param {string} text - Comment text
         * @param {object} drawing - Optional drawing data
         */
        async addComment(text, drawing = null) {
            if (typeof CommentManager !== 'undefined') {
                return await CommentManager.addComment(text, drawing);
            }

            // Fallback to legacy
            if (typeof submitComment === 'function') {
                return submitComment();
            }

            return { error: 'Comment system not available' };
        },

        /**
         * Delete a comment
         */
        async deleteComment(commentId) {
            if (typeof CommentManager !== 'undefined') {
                return await CommentManager.deleteComment(commentId);
            }

            // Fallback to legacy
            if (typeof deleteComment === 'function') {
                return deleteComment(commentId);
            }

            return { error: 'Comment system not available' };
        },

        /**
         * Get comments for current clip
         */
        getComments() {
            if (typeof CommentManager !== 'undefined') {
                return CommentManager.getCommentsForContext();
            }
            return AppState.comments || [];
        },

        // ============ Cleanup ============

        /**
         * Cleanup and release resources
         */
        cleanup() {
            console.log('ReviewModule: Cleaning up');

            // Leave any active session
            this.leaveSession();

            // Cleanup ReviewSync
            if (typeof ReviewSync !== 'undefined') {
                ReviewSync.cleanup();
            }

            // Reset CommentManager
            if (typeof CommentManager !== 'undefined') {
                CommentManager.reset();
            }

            // Unsubscribe from all events
            unsubscribers.forEach(fn => fn());
            unsubscribers = [];

            isInitialized = false;
            projectId = null;
            currentClipId = null;
        },

        // ============ State ============

        /**
         * Check if module is initialized
         */
        isInitialized() {
            return isInitialized;
        },

        /**
         * Get current project ID
         */
        getProjectId() {
            return projectId;
        },

        // ============ Internal ============

        _handleCommentEvent(event, data) {
            // Re-render comments when they change
            if (['commentAdded', 'commentDeleted', 'commentsLoaded'].includes(event)) {
                if (typeof renderComments === 'function') {
                    renderComments();
                }
            }
        },

        _notifyInitialized() {
            // Dispatch custom event for other code to hook into
            window.dispatchEvent(new CustomEvent('reviewModuleInitialized', {
                detail: { projectId, clipId: currentClipId }
            }));
        }
    };
})();

// Export to global scope
window.ReviewModule = ReviewModule;
