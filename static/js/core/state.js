/**
 * Reactive State Management for CollabSuite
 * Backwards compatible with existing AppState usage
 */

const AppState = {
    // ============ Existing State (from app.js) ============
    projectId: null,
    sessionId: null,
    userId: 'user_' + Math.random().toString(36).substr(2, 6),
    userName: null,
    ws: null,
    syncEnabled: false,
    fps: 24,
    videoCache: null,

    // In/Out markers
    inPoint: null,
    outPoint: null,
    loopEnabled: true,

    // Cursor sharing
    cursorSharingEnabled: false,

    // Drawing state
    isDrawing: false,
    drawMode: false,
    currentStroke: [],
    pendingDrawing: null,
    drawColor: '#ff4444',

    // Data
    projects: [],
    sessions: [],
    currentProject: null,
    annotations: {},
    comments: [],
    users: {},
    clips: {},
    currentClip: null,

    // Upload
    uploadJobs: [],

    // Playback
    playbackSpeed: 1,

    // Quality/Proxy
    currentQuality: '1080p',
    availableQualities: ['720p', '1080p', '4k'],

    // Expanded projects view
    expandedProjectsView: false,
    selectedGridProject: null,

    // Share link state
    currentShareLinkId: null,
    shareLinks: [],

    // Admin auth state
    isAdmin: false,
    adminUser: null,
    authToken: null,
    permissions: [],

    // Pending share link data
    pendingShareLinkData: null,

    // Share link guest mode
    isShareLinkGuest: false,
    shareLinkedProjectId: null,

    // Clip statuses
    statuses: [],

    // Compare mode
    compareMode: false,
    compareVersion: null,
    wipePosition: 50,

    // ============ Reactive State Management ============
    _listeners: new Map(),
    _batchUpdates: false,
    _pendingNotifications: new Set(),

    /**
     * Subscribe to state changes
     * @param {string|string[]} keys - State key(s) to watch
     * @param {function} callback - Called with (newValue, key, oldValue)
     * @returns {function} Unsubscribe function
     */
    subscribe(keys, callback) {
        const keyArray = Array.isArray(keys) ? keys : [keys];

        keyArray.forEach(key => {
            if (!this._listeners.has(key)) {
                this._listeners.set(key, new Set());
            }
            this._listeners.get(key).add(callback);
        });

        return () => {
            keyArray.forEach(key => {
                this._listeners.get(key)?.delete(callback);
            });
        };
    },

    /**
     * Update state and notify subscribers
     * Use this for reactive updates, or just assign directly for non-reactive
     */
    set(key, value) {
        if (this[key] === value) return;

        const oldValue = this[key];
        this[key] = value;

        if (this._batchUpdates) {
            this._pendingNotifications.add(key);
        } else {
            this._notify(key, value, oldValue);
        }
    },

    /**
     * Batch multiple state updates (single notification)
     */
    batch(updateFn) {
        this._batchUpdates = true;
        try {
            updateFn();
        } finally {
            this._batchUpdates = false;
            this._pendingNotifications.forEach(key => {
                this._notify(key, this[key], undefined);
            });
            this._pendingNotifications.clear();
        }
    },

    /**
     * Get value (optional, can also access directly)
     */
    get(key) {
        return this[key];
    },

    /**
     * Notify subscribers
     */
    _notify(key, newValue, oldValue) {
        const listeners = this._listeners.get(key);
        if (listeners) {
            listeners.forEach(callback => {
                try {
                    callback(newValue, key, oldValue);
                } catch (error) {
                    console.error(`State subscriber error for '${key}':`, error);
                }
            });
        }
    },

    /**
     * Reset to default values (for logout)
     */
    reset() {
        this.batch(() => {
            this.set('projectId', null);
            this.set('sessionId', null);
            this.set('isAdmin', false);
            this.set('adminUser', null);
            this.set('authToken', null);
            this.set('projects', []);
            this.set('currentProject', null);
            this.set('clips', {});
            this.set('currentClip', null);
        });
    }
};

// Export to window for global access
window.AppState = AppState;
