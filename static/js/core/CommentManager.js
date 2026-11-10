/**
 * CommentManager - Base comment system with context abstraction
 * Handles generic comment CRUD, optimistic updates, and WebSocket sync
 * Modules configure context (clip, task, doc) and position functions
 */
const CommentManager = (function() {
    // State
    let comments = [];
    let listeners = [];

    // Config - set by module via init()
    let config = {
        projectId: null,
        contextType: 'clip',      // 'clip', 'task', 'doc'
        contextId: null,          // clipId, taskId, docId
        contextName: null,        // Optional: baseName for clips
        contextVersion: null,     // Optional: version for clips
        getPosition: null,        // Function to get current position (frame, paragraph, etc)
        getUserId: null,          // Function to get current user ID
        getUserName: null,        // Function to get current user name
        getProfileImage: null,    // Function to get profile image
    };

    // Drawing state (can be used by modules)
    let pendingDrawing = null;
    let currentStroke = [];

    return {
        // ============ Initialize ============

        /**
         * Initialize CommentManager for a specific context
         * @param {object} moduleConfig - Configuration from module
         */
        init(moduleConfig) {
            config = { ...config, ...moduleConfig };

            // Set defaults from global state if not provided
            if (!config.getUserId) {
                config.getUserId = () => AppState.userId || UserManager?.getUserId?.();
            }
            if (!config.getUserName) {
                config.getUserName = () => AppState.userName || UserManager?.getUsername?.() || 'Anonymous';
            }
            if (!config.getProfileImage) {
                config.getProfileImage = () => AppState.adminUser?.profileImage || UserManager?.getProfileImage?.();
            }

            // Reset state
            comments = [];
            pendingDrawing = null;
            currentStroke = [];

            this.notify('initialized', config);
        },

        /**
         * Reset CommentManager state
         */
        reset() {
            comments = [];
            pendingDrawing = null;
            currentStroke = [];
            config.contextId = null;
            this.notify('reset');
        },

        /**
         * Set context for a new item (e.g., when switching clips)
         */
        setContext(contextId, options = {}) {
            config.contextId = contextId;
            if (options.contextName) config.contextName = options.contextName;
            if (options.contextVersion) config.contextVersion = options.contextVersion;
            comments = [];
            this.notify('contextChanged', { contextId, ...options });
        },

        // ============ Load ============

        /**
         * Load comments from server
         */
        async loadComments() {
            if (!config.projectId || !config.contextId) {
                return { comments: [], error: 'No context set' };
            }

            try {
                // Use API wrapper if available
                if (typeof API !== 'undefined' && API.getComments) {
                    const { data, error } = await API.getComments(
                        config.projectId,
                        config.contextType,
                        config.contextId
                    );
                    if (!error) {
                        comments = data.comments || [];
                        this.notify('commentsLoaded', comments);
                        return { comments };
                    }
                    return { comments: [], error };
                }

                // Fallback to direct fetch
                const url = `/api/projects/${config.projectId}/comments?type=${config.contextType}&id=${config.contextId}`;
                const response = await fetch(url);
                if (response.ok) {
                    const data = await response.json();
                    comments = data.comments || [];
                    this.notify('commentsLoaded', comments);
                    return { comments };
                }

                return { comments: [], error: 'Failed to load comments' };
            } catch (e) {
                console.error('CommentManager: Load error:', e);
                return { comments: [], error: e.message };
            }
        },

        /**
         * Set comments directly (e.g., from WebSocket init)
         */
        setComments(newComments) {
            comments = newComments || [];
            this.notify('commentsLoaded', comments);
        },

        // ============ CRUD ============

        /**
         * Add a new comment
         * @param {string} text - Comment text
         * @param {object} drawingData - Optional drawing data
         */
        async addComment(text, drawingData = null) {
            const hasDrawing = drawingData && drawingData.strokes && drawingData.strokes.length > 0;

            // Must have text or drawing
            if (!text && !hasDrawing) {
                return { error: 'Comment must have text or drawing' };
            }

            if (!config.projectId) {
                return { error: 'No project set' };
            }

            const position = config.getPosition ? config.getPosition() : null;

            const commentData = {
                text,
                contextType: config.contextType,
                contextId: config.contextId,
                position,
                drawing: drawingData,
                // For clips - backwards compatibility
                clipBaseName: config.contextName,
                clipVersion: config.contextVersion,
                // Frame for review module
                frame: position,
            };

            // Create optimistic comment
            const tempId = `temp-${Date.now()}`;
            const tempComment = {
                id: tempId,
                ...commentData,
                user: config.getUserId(),
                userId: config.getUserId(),
                userName: config.getUserName(),
                userProfileImage: config.getProfileImage(),
                timestamp: new Date().toISOString(),
                createdAt: new Date().toISOString(),
                _isOptimistic: true
            };

            // Add locally (optimistic)
            comments.push(tempComment);
            this.notify('commentAdded', tempComment);

            try {
                // Determine endpoint
                const endpoint = AppState.sessionId
                    ? `/api/session/${AppState.sessionId}/comment`
                    : `/api/projects/${config.projectId}/comment`;

                const response = await fetch(endpoint, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(commentData)
                });

                if (!response.ok) {
                    // Rollback
                    comments = comments.filter(c => c.id !== tempId);
                    this.notify('commentAddFailed', { tempId, error: 'Server error' });
                    return { error: 'Failed to save comment' };
                }

                const savedComment = await response.json();

                // Replace temp with real (if not in session - session will receive via WS)
                if (!AppState.sessionId) {
                    const idx = comments.findIndex(c => c.id === tempId);
                    if (idx !== -1) {
                        comments[idx] = savedComment;
                    }
                    this.notify('commentSaved', savedComment);
                }

                return { comment: savedComment };

            } catch (e) {
                // Rollback
                comments = comments.filter(c => c.id !== tempId);
                this.notify('commentAddFailed', { tempId, error: e.message });
                return { error: e.message };
            }
        },

        /**
         * Delete a comment
         */
        async deleteComment(commentId) {
            const comment = comments.find(c => c.id === commentId);
            if (!comment) {
                return { error: 'Comment not found' };
            }

            // Check permission
            const userId = config.getUserId();
            const canDelete = comment.user === userId ||
                              comment.userId === userId ||
                              AppState.isAdmin ||
                              UserManager?.isAdmin?.() ||
                              UserManager?.isProjectOwner?.();

            if (!canDelete) {
                return { error: 'Permission denied' };
            }

            // Remove locally (optimistic)
            comments = comments.filter(c => c.id !== commentId);
            this.notify('commentDeleted', { commentId });

            try {
                const endpoint = AppState.sessionId
                    ? `/api/session/${AppState.sessionId}/comment/${commentId}`
                    : `/api/projects/${config.projectId}/comment/${commentId}`;

                const response = await fetch(endpoint, { method: 'DELETE' });

                if (!response.ok) {
                    // Rollback
                    comments.push(comment);
                    this.notify('commentDeleteFailed', { comment, error: 'Server error' });
                    return { error: 'Failed to delete comment' };
                }

                return { success: true };

            } catch (e) {
                // Rollback
                comments.push(comment);
                this.notify('commentDeleteFailed', { comment, error: e.message });
                return { error: e.message };
            }
        },

        // ============ Getters ============

        getComments() {
            return comments;
        },

        getComment(id) {
            return comments.find(c => c.id === id);
        },

        /**
         * Get comments at a specific position
         */
        getCommentsAtPosition(position) {
            return comments.filter(c =>
                c.position === position ||
                c.frame === position  // For review compatibility
            );
        },

        /**
         * Get comments filtered by current context
         */
        getCommentsForContext() {
            if (config.contextType === 'clip' && config.contextName) {
                // Filter by clip baseName for review
                return comments.filter(c =>
                    c.clipBaseName === config.contextName || !c.clipBaseName
                );
            }
            return comments;
        },

        getConfig() {
            return { ...config };
        },

        // ============ Drawing State ============

        startDrawing(position, color, brushSize, brushType) {
            pendingDrawing = {
                frame: position,
                position: position,
                strokes: [],
                strokeArrays: [],
                color: color || '#ff4444',
                brushSize: brushSize || 6,
                brushType: brushType || 'pen'
            };
            currentStroke = [];
            this.notify('drawingStarted', pendingDrawing);
        },

        addDrawingPoint(point) {
            currentStroke.push(point);
        },

        finishStroke() {
            if (currentStroke.length > 1 && pendingDrawing) {
                pendingDrawing.strokeArrays.push([...currentStroke]);
                pendingDrawing.strokes.push(...currentStroke);
            }
            currentStroke = [];
            this.notify('strokeFinished', pendingDrawing);
        },

        getPendingDrawing() {
            return pendingDrawing;
        },

        clearPendingDrawing() {
            const drawing = pendingDrawing;
            pendingDrawing = null;
            currentStroke = [];
            this.notify('drawingCleared', drawing);
            return drawing;
        },

        // ============ WebSocket Handlers ============

        /**
         * Handle remote comment added (from WebSocket)
         */
        handleRemoteCommentAdded(data) {
            const comment = data.data || data.comment || data;

            // Check if for current context
            if (config.contextType === 'clip') {
                if (comment.clipBaseName && comment.clipBaseName !== config.contextName) {
                    return; // Different clip
                }
            } else if (comment.contextId && comment.contextId !== config.contextId) {
                return; // Different context
            }

            // Don't add if already exists
            if (comments.find(c => c.id === comment.id)) return;

            comments.push(comment);
            this.notify('commentAdded', comment);
        },

        /**
         * Handle remote comment deleted (from WebSocket)
         */
        handleRemoteCommentDeleted(data) {
            const commentId = data.comment_id || data.commentId;
            const idx = comments.findIndex(c => c.id === commentId);
            if (idx !== -1) {
                const removed = comments.splice(idx, 1)[0];
                this.notify('commentDeleted', { commentId, comment: removed });
            }
        },

        // ============ Events ============

        subscribe(callback) {
            listeners.push(callback);
            return () => {
                listeners = listeners.filter(l => l !== callback);
            };
        },

        notify(event, data) {
            listeners.forEach(cb => {
                try {
                    cb(event, data);
                } catch (e) {
                    console.error('CommentManager: Listener error:', e);
                }
            });
        }
    };
})();

// Export to global scope
window.CommentManager = CommentManager;
