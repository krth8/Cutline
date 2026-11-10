/**
 * WebSocketManager - Pluggable WebSocket infrastructure
 * Handles connection, reconnection, and message routing
 * Modules register handlers for specific message types
 */
const WebSocketManager = (function() {
    // Private state
    let ws = null;
    let sessionId = null;
    let userId = null;
    let userName = null;
    let reconnectAttempts = 0;
    let intentionalConnect = false;
    const MAX_RECONNECT_DELAY = 30000;

    // Plugin system
    const messageHandlers = new Map();  // type -> [handlers]
    const connectionListeners = [];

    // Throttle helpers
    const throttleTimers = new Map();

    return {
        // ============ Connection ============

        /**
         * Connect to a WebSocket session
         * @param {string} session - Session ID
         * @param {object} options - { userId, userName }
         */
        connect(session, options = {}) {
            if (ws && ws.readyState === WebSocket.OPEN) {
                this.disconnect();
            }

            sessionId = session;
            userId = options.userId || AppState.userId || this._generateId();
            userName = options.userName || AppState.userName || 'Anonymous';

            intentionalConnect = true;
            reconnectAttempts = 0;

            const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
            const wsUrl = `${protocol}//${window.location.host}/ws/${sessionId}/${userId}?name=${encodeURIComponent(userName)}`;

            ws = new WebSocket(wsUrl);
            ws.onopen = () => this._onOpen();
            ws.onmessage = (e) => this._onMessage(e);
            ws.onclose = (event) => this._onClose(event);
            ws.onerror = (error) => this._onError(error);
        },

        /**
         * Disconnect from WebSocket (clean disconnect, no auto-reconnect)
         */
        disconnect() {
            intentionalConnect = false;
            if (ws) {
                ws.close(1000, 'User leaving session');
                ws = null;
            }
            sessionId = null;
            this._notifyConnectionListeners('disconnected');
        },

        // ============ Send ============

        /**
         * Send a message to the server
         * @param {string} type - Message type
         * @param {object} data - Message data
         */
        send(type, data = {}) {
            if (!ws || ws.readyState !== WebSocket.OPEN) {
                console.warn('WebSocket not connected, cannot send:', type);
                return false;
            }
            ws.send(JSON.stringify({ type, ...data }));
            return true;
        },

        /**
         * Send a message that should be broadcast to other users
         */
        broadcast(type, data = {}) {
            return this.send(type, { ...data, broadcast: true });
        },

        /**
         * Send with throttling (useful for cursor/draw updates)
         * @param {string} type - Message type
         * @param {object} data - Message data
         * @param {number} interval - Min milliseconds between sends
         */
        sendThrottled(type, data = {}, interval = 100) {
            const now = Date.now();
            const lastSend = throttleTimers.get(type) || 0;

            if (now - lastSend >= interval) {
                throttleTimers.set(type, now);
                return this.send(type, data);
            }
            return false;
        },

        // ============ Plugin Registration ============

        /**
         * Register a handler for a message type
         * @param {string} type - Message type (e.g., 'sync', 'comment_added')
         * @param {function} handler - Handler function(data)
         * @returns {function} Unsubscribe function
         */
        on(type, handler) {
            if (!messageHandlers.has(type)) {
                messageHandlers.set(type, []);
            }
            messageHandlers.get(type).push(handler);

            // Return unsubscribe function
            return () => {
                const handlers = messageHandlers.get(type);
                if (handlers) {
                    const idx = handlers.indexOf(handler);
                    if (idx !== -1) handlers.splice(idx, 1);
                }
            };
        },

        /**
         * Register multiple handlers at once (for a plugin/module)
         * @param {object} handlers - { type: handler } mapping
         * @returns {function} Unsubscribe all function
         */
        registerPlugin(handlers) {
            const unsubscribers = [];
            for (const [type, handler] of Object.entries(handlers)) {
                unsubscribers.push(this.on(type, handler));
            }
            // Return function to unsubscribe all
            return () => unsubscribers.forEach(fn => fn());
        },

        /**
         * Listen for connection state changes
         * @param {function} callback - Called with 'connected'|'disconnected'|'reconnecting'
         * @returns {function} Unsubscribe function
         */
        onConnection(callback) {
            connectionListeners.push(callback);
            return () => {
                const idx = connectionListeners.indexOf(callback);
                if (idx !== -1) connectionListeners.splice(idx, 1);
            };
        },

        // ============ State Getters ============

        isConnected() {
            return ws && ws.readyState === WebSocket.OPEN;
        },

        getSessionId() {
            return sessionId;
        },

        getUserId() {
            return userId;
        },

        getWebSocket() {
            return ws;
        },

        // ============ Internal Handlers ============

        _onOpen() {
            console.log('WebSocketManager: Connected to session', sessionId);
            reconnectAttempts = 0;
            this._notifyConnectionListeners('connected');
        },

        _onMessage(event) {
            try {
                const data = JSON.parse(event.data);
                const type = data.type;

                // Route to registered handlers
                const handlers = messageHandlers.get(type) || [];
                handlers.forEach(h => {
                    try {
                        h(data);
                    } catch (e) {
                        console.error(`WebSocketManager: Handler error for ${type}:`, e);
                    }
                });

                // Also emit to wildcard handlers (for logging/debugging)
                const wildcardHandlers = messageHandlers.get('*') || [];
                wildcardHandlers.forEach(h => {
                    try {
                        h(data);
                    } catch (e) {
                        console.error('WebSocketManager: Wildcard handler error:', e);
                    }
                });

            } catch (e) {
                console.error('WebSocketManager: Message parse error:', e);
            }
        },

        _onClose(event) {
            this._notifyConnectionListeners('disconnected');

            // Only reconnect if intentional and not a clean close
            if (sessionId && intentionalConnect && event.code !== 1000) {
                const delay = Math.min(2000 * Math.pow(2, reconnectAttempts), MAX_RECONNECT_DELAY);
                reconnectAttempts++;

                console.log(`WebSocketManager: Reconnecting in ${delay}ms (attempt ${reconnectAttempts})`);
                this._notifyConnectionListeners('reconnecting');

                setTimeout(() => {
                    if (intentionalConnect && sessionId) {
                        this.connect(sessionId, { userId, userName });
                    }
                }, delay);
            }
        },

        _onError(error) {
            console.error('WebSocketManager: Error:', error);
        },

        _notifyConnectionListeners(state) {
            connectionListeners.forEach(cb => {
                try {
                    cb(state);
                } catch (e) {
                    console.error('WebSocketManager: Connection listener error:', e);
                }
            });
        },

        _generateId() {
            return 'user_' + Math.random().toString(36).substr(2, 9);
        }
    };
})();

// Export to global scope
window.WebSocketManager = WebSocketManager;
