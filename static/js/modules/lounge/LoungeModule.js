/**
 * LoungeModule - Team chat with real-time messaging
 * Inspired by Slack/Discord/ChatScope design patterns
 */

const LoungeModule = {
    // State
    projectId: null,
    currentProject: null,
    roomId: null,
    room: null,
    messages: [],
    onlineUsers: [],
    typingUsers: {},

    // Custom channels (General, Sales, etc.)
    customChannels: [],
    activeChannelId: null,
    activeChannelType: null, // 'custom' or 'project'

    // User info
    userId: null,
    userName: null,
    userImage: null,

    // WebSocket
    ws: null,
    reconnectAttempts: 0,
    maxReconnectAttempts: 5,
    heartbeatInterval: null,

    // UI state
    isAtBottom: true,
    replyingTo: null,
    pendingAttachments: [],
    emojiPickerOpen: false,
    selectedMessageId: null,

    // Common emoji reactions
    quickEmojis: ['👍', '❤️', '😂', '🎉', '🔥', '👀', '🙌', '💯'],

    /**
     * Initialize the lounge module
     */
    async init(projectId = null) {
        // Get user info
        const authData = localStorage.getItem('authData');
        if (authData) {
            try {
                const auth = JSON.parse(authData);
                this.userId = auth.user?.id;
                this.userName = auth.user?.username;
                this.userImage = auth.user?.profileImage;
            } catch (e) {}
        }

        if (!this.userId) {
            this.userId = 'u' + Math.random().toString(36).substr(2, 8);
            this.userName = `User ${this.userId.slice(0, 4)}`;
        }

        // Restore project from localStorage or parameter
        let targetProjectId = projectId || localStorage.getItem('loungeProjectId');

        // Start both operations in parallel - channels and project are independent
        const channelsPromise = this.loadCustomChannels();

        if (targetProjectId) {
            // selectProject runs while channels load
            await Promise.all([channelsPromise, this.selectProject(targetProjectId)]);
        } else {
            await channelsPromise;
            this.render();
        }

        this.attachEventListeners();
    },

    /**
     * Load custom channels from server
     */
    async loadCustomChannels() {
        try {
            const res = await API.request('/chat/channels');
            this.customChannels = res.data?.channels || [];
        } catch (err) {
            console.log('No custom channels loaded');
            this.customChannels = [];
        }
    },

    /**
     * Create a new custom channel
     */
    async createCustomChannel() {
        const name = prompt('Channel name:');
        if (!name || !name.trim()) return;

        try {
            const res = await API.request('/chat/channels', {
                method: 'POST',
                body: JSON.stringify({ name: name.trim() })
            });
            if (res.data) {
                this.customChannels.push(res.data);
                this.render();
            }
        } catch (err) {
            console.error('Failed to create channel:', err);
            showToast('Failed to create channel', 'error');
        }
    },

    /**
     * Select a custom channel
     */
    async selectCustomChannel(channelId) {
        this.activeChannelId = channelId;
        this.activeChannelType = 'custom';
        this.projectId = null;
        this.roomId = channelId;

        // Find the channel
        const channel = this.customChannels.find(c => c.id === channelId);
        if (channel) {
            this.room = channel;
        }

        // Load messages for this channel
        await this.loadMessages();
        this.connectWebSocket();
        this.render();
    },

    /**
     * Select a project and join its chat room
     */
    async selectProject(projectId) {
        this.projectId = projectId;
        this.activeChannelId = projectId;
        this.activeChannelType = 'project';
        localStorage.setItem('loungeProjectId', projectId);

        // Get project info
        if (typeof AppState !== 'undefined' && AppState.projects) {
            this.currentProject = AppState.projects.find(p => p.id === projectId);
        }

        // Get or create chat room for project
        try {
            const res = await API.request(`/projects/${projectId}/chat`);
            if (res.error) throw new Error(res.error);

            this.room = res.data;
            this.roomId = res.data.id;

            // Load messages
            await this.loadMessages();

            // Connect WebSocket
            this.connectWebSocket();

            this.render();
            this.scrollToBottom();
        } catch (err) {
            console.error('Failed to join chat room:', err);
            showToast('Failed to join chat', 'error');
        }
    },

    /**
     * Load messages from server
     */
    async loadMessages(beforeId = null) {
        if (!this.roomId) return;

        try {
            const url = beforeId
                ? `/chat/rooms/${this.roomId}/messages?before=${beforeId}&limit=50`
                : `/chat/rooms/${this.roomId}/messages?limit=50`;
            const res = await API.request(url);

            if (res.error) throw new Error(res.error);

            if (beforeId) {
                // Prepend older messages
                this.messages = [...res.data.messages, ...this.messages];
            } else {
                this.messages = res.data.messages || [];
            }
        } catch (err) {
            console.error('Failed to load messages:', err);
        }
    },

    /**
     * Connect to WebSocket for real-time updates
     */
    async connectWebSocket() {
        this.disconnectWebSocket();

        const roomId = this.roomId;
        if (!roomId) return;
        let socket;
        try {
            socket = await openSocket(`/ws/chat/${encodeURIComponent(roomId)}/${encodeURIComponent(this.userId)}${this.userImage ? '?image=' + encodeURIComponent(this.userImage) : ''}`);
        } catch (e) {
            this.tryReconnect();
            return;
        }
        // Another room may have been opened in the meantime
        if (this.roomId !== roomId || this.ws) {
            socket.close();
            return;
        }
        this.ws = socket;

        this.ws.onopen = () => {
            console.log('Chat WebSocket connected');
            this.reconnectAttempts = 0;
            this.startHeartbeat();
        };

        this.ws.onmessage = (event) => {
            const data = JSON.parse(event.data);
            this.handleWebSocketMessage(data);
        };

        this.ws.onclose = () => {
            console.log('Chat WebSocket disconnected');
            if (this.ws !== socket) return; // closed on purpose or replaced
            this.ws = null;
            this.stopHeartbeat();
            this.tryReconnect();
        };

        this.ws.onerror = (error) => {
            console.error('Chat WebSocket error:', error);
        };
    },

    disconnectWebSocket() {
        this.stopHeartbeat();
        const socket = this.ws;
        this.ws = null;
        if (socket) socket.close();
    },

    startHeartbeat() {
        this.heartbeatInterval = setInterval(() => {
            if (this.ws && this.ws.readyState === WebSocket.OPEN) {
                this.ws.send(JSON.stringify({ type: 'ping' }));
            }
        }, 30000);
    },

    stopHeartbeat() {
        if (this.heartbeatInterval) {
            clearInterval(this.heartbeatInterval);
            this.heartbeatInterval = null;
        }
    },

    tryReconnect() {
        if (this.reconnectAttempts < this.maxReconnectAttempts && this.roomId) {
            this.reconnectAttempts++;
            console.log(`Reconnecting... attempt ${this.reconnectAttempts}`);
            setTimeout(() => {
                if (this.roomId) {
                    this.connectWebSocket();
                }
            }, 1000 * this.reconnectAttempts);
        }
    },

    /**
     * Handle incoming WebSocket messages
     */
    handleWebSocketMessage(data) {
        switch (data.type) {
            case 'init':
                this.onlineUsers = data.users || [];
                this.updateOnlineUsers();
                break;

            case 'message':
                // Check if this is our own message that we already showed optimistically
                const existingIndex = this.messages.findIndex(m =>
                    m.id === data.message.id ||
                    (m.isPending && m.userId === data.message.userId && m.text === data.message.text)
                );

                if (existingIndex !== -1) {
                    // Update the optimistic message with the real one
                    const oldId = this.messages[existingIndex].id;
                    this.messages[existingIndex] = { ...data.message, isPending: false };

                    // Update DOM if ID changed
                    if (oldId !== data.message.id) {
                        const el = document.querySelector(`[data-message-id="${oldId}"]`);
                        if (el) el.setAttribute('data-message-id', data.message.id);
                    }
                } else {
                    // New message from someone else
                    this.messages.push(data.message);
                    this.appendMessage(data.message);
                    if (this.isAtBottom) {
                        this.scrollToBottom();
                    } else {
                        this.showNewMessageIndicator();
                    }
                }
                break;

            case 'message_edited':
                const editIdx = this.messages.findIndex(m => m.id === data.message.id);
                if (editIdx !== -1) {
                    this.messages[editIdx] = { ...this.messages[editIdx], ...data.message };
                    // Use selective update instead of full re-render
                    this.updateMessageContent(data.message.id, data.message);
                }
                break;

            case 'user_joined':
                if (!this.onlineUsers.find(u => u.id === data.user.id)) {
                    this.onlineUsers.push(data.user);
                    this.updateOnlineUsers();
                }
                break;

            case 'user_left':
                this.onlineUsers = this.onlineUsers.filter(u => u.id !== data.userId);
                delete this.typingUsers[data.userId];
                this.updateOnlineUsers();
                this.updateTypingIndicator();
                break;

            case 'typing':
                if (data.isTyping) {
                    this.typingUsers[data.userId] = data.userName;
                } else {
                    delete this.typingUsers[data.userId];
                }
                this.updateTypingIndicator();
                break;

            case 'pong':
                // Heartbeat response
                break;
        }
    },

    /**
     * Render the main view
     */
    render() {
        const container = document.getElementById('viewLounge');
        if (!container) return;

        const projects = (typeof AppState !== 'undefined' && AppState.projects) || [];

        // Build custom channels list
        const channelsList = this.customChannels.map(c => `
            <div class="lounge-channel-item ${this.activeChannelType === 'custom' && this.activeChannelId === c.id ? 'active' : ''}"
                 onclick="LoungeModule.selectCustomChannel('${c.id}')">
                <span class="lounge-channel-hash">#</span>
                <span class="lounge-channel-name">${this.escapeHtml(c.name)}</span>
            </div>
        `).join('');

        // Build project list
        const projectList = projects.map(p => `
            <div class="lounge-room-item ${this.activeChannelType === 'project' && this.activeChannelId === p.id ? 'active' : ''}"
                 onclick="LoungeModule.selectProject('${p.id}')">
                <div class="lounge-room-thumb" ${p.coverImage ? `style="background-image: url('${p.coverImage}')"` : ''}></div>
                <div class="lounge-room-info">
                    <span class="lounge-room-name">${this.escapeHtml(p.name)}</span>
                </div>
            </div>
        `).join('');

        container.innerHTML = `
            <div class="lounge-layout">
                <aside class="lounge-sidebar">
                    <div class="lounge-sidebar-section">
                        <div class="lounge-sidebar-header">
                            <span>Channels</span>
                            <button class="lounge-add-btn" onclick="LoungeModule.createCustomChannel()" title="Add channel">
                                <svg class="icon" viewBox="0 0 256 256"><path fill="currentColor" d="M224 128a8 8 0 0 1-8 8h-80v80a8 8 0 0 1-16 0v-80H40a8 8 0 0 1 0-16h80V40a8 8 0 0 1 16 0v80h80a8 8 0 0 1 8 8"/></svg>
                            </button>
                        </div>
                        <div class="lounge-channel-list">
                            ${channelsList || '<div class="lounge-empty-channels">No channels yet</div>'}
                        </div>
                    </div>
                    <div class="lounge-sidebar-section">
                        <div class="lounge-sidebar-header">
                            <span>Projects</span>
                        </div>
                        <div class="lounge-room-list">
                            ${projectList || '<div class="lounge-empty-projects">No projects</div>'}
                        </div>
                    </div>
                </aside>
                <main class="lounge-main">
                    ${this.roomId ? this.renderChatArea() : this.renderSelectRoom()}
                </main>
                <aside class="lounge-sidebar-right">
                    <div class="lounge-online-section">
                        <div class="lounge-online-header">
                            <span>Online</span>
                            <span class="lounge-online-count">${this.onlineUsers.length}</span>
                        </div>
                        <div class="lounge-online-list" id="loungeOnlineList">
                            ${this.renderOnlineUsers()}
                        </div>
                    </div>
                </aside>
            </div>
        `;

        if (this.roomId) {
            this.renderMessages();
        }
    },

    renderNoProjects() {
        return `
            <div class="lounge-empty">
                <div class="placeholder-icon">
                    <svg class="icon icon-2xl"><use href="/static/icons.svg#icon-chat"/></svg>
                </div>
                <h3>No Projects</h3>
                <p>Create a project in the Projects tab to start chatting</p>
            </div>
        `;
    },

    renderSelectRoom() {
        return `
            <div class="lounge-select-room">
                <div class="placeholder-icon">
                    <svg class="icon icon-2xl"><use href="/static/icons.svg#icon-chat"/></svg>
                </div>
                <h3>Select a channel</h3>
                <p>Choose a project channel from the sidebar to start chatting</p>
            </div>
        `;
    },

    renderChatArea() {
        const roomName = this.room?.name || this.currentProject?.name || 'Chat';

        return `
            <div class="lounge-chat">
                <div class="lounge-chat-header">
                    <div class="lounge-chat-title">
                        <span class="lounge-chat-hash">#</span>
                        <span>${this.escapeHtml(roomName.replace(/^#\s*/, ''))}</span>
                    </div>
                    <div class="lounge-chat-actions">
                        <span class="lounge-member-count">
                            <svg class="icon icon-sm"><use href="/static/icons.svg#icon-users"/></svg>
                            ${this.onlineUsers.length}
                        </span>
                    </div>
                </div>
                <div class="lounge-messages-container" id="loungeMessages" onscroll="LoungeModule.onMessagesScroll()">
                    <div class="lounge-messages-list" id="loungeMessagesList">
                        <!-- Messages rendered here -->
                    </div>
                    <div class="lounge-scroll-bottom hidden" id="loungeScrollBottom" onclick="LoungeModule.scrollToBottom()">
                        <svg class="icon"><use href="/static/icons.svg#icon-caret-down"/></svg>
                        New messages
                    </div>
                </div>
                <div class="lounge-typing-indicator" id="loungeTyping"></div>
                <div class="lounge-input-area">
                    ${this.replyingTo ? this.renderReplyPreview() : ''}
                    <div class="lounge-attachments-preview" id="loungeAttachments"></div>
                    <div class="lounge-input-toolbar">
                        <div class="lounge-toolbar-group">
                            <button class="lounge-toolbar-btn" onclick="LoungeModule.wrapSelection('**', '**')" title="Bold (Ctrl+B)">
                                <strong>B</strong>
                            </button>
                            <button class="lounge-toolbar-btn" onclick="LoungeModule.wrapSelection('*', '*')" title="Italic (Ctrl+I)">
                                <em>I</em>
                            </button>
                            <button class="lounge-toolbar-btn" onclick="LoungeModule.wrapSelection('\`', '\`')" title="Code">
                                <svg class="icon" viewBox="0 0 256 256"><path fill="currentColor" d="M69.12 94.15L28.5 128l40.62 33.85a8 8 0 1 1-10.24 12.29l-48-40a8 8 0 0 1 0-12.29l48-40a8 8 0 0 1 10.24 12.3m176 27.7l-48-40a8 8 0 1 0-10.24 12.3L227.5 128l-40.62 33.85a8 8 0 1 0 10.24 12.29l48-40a8 8 0 0 0 0-12.29m-82.39-89.37a8 8 0 0 0-10.25 4.79l-64 176a8 8 0 0 0 4.79 10.26A8.14 8.14 0 0 0 96 224a8 8 0 0 0 7.52-5.27l64-176a8 8 0 0 0-4.79-10.25"/></svg>
                            </button>
                        </div>
                        <div class="lounge-toolbar-separator"></div>
                        <div class="lounge-toolbar-group">
                            <button class="lounge-toolbar-btn" onclick="LoungeModule.openFilePicker()" title="Attach file">
                                <svg class="icon" viewBox="0 0 256 256"><path fill="currentColor" d="M209.66 122.34a8 8 0 0 1 0 11.32l-82.05 82a56 56 0 0 1-79.2-79.21l99.07-99.06a40 40 0 1 1 56.57 56.56l-99.06 99.06a24 24 0 0 1-33.95-33.95l83.05-83a8 8 0 0 1 11.32 11.32l-83.06 83a8 8 0 0 0 11.32 11.31l99.06-99.06a24 24 0 0 0-33.95-33.94l-99.06 99.06a40 40 0 0 0 56.57 56.56l82.05-82a8 8 0 0 1 11.32 0"/></svg>
                            </button>
                            <button class="lounge-toolbar-btn" onclick="LoungeModule.toggleEmojiPicker()" title="Emoji">
                                <svg class="icon" viewBox="0 0 256 256"><path fill="currentColor" d="M128 24a104 104 0 1 0 104 104A104.11 104.11 0 0 0 128 24m0 192a88 88 0 1 1 88-88a88.1 88.1 0 0 1-88 88M80 108a12 12 0 1 1 12 12a12 12 0 0 1-12-12m96 0a12 12 0 1 1-12-12a12 12 0 0 1 12 12m-1.07 48c-10.29 17.79-27.4 28-46.93 28s-36.63-10.2-46.92-28a8 8 0 1 1 13.84-8c7.47 12.91 19.21 20 33.08 20s25.61-7.1 33.07-20a8 8 0 0 1 13.86 8"/></svg>
                            </button>
                        </div>
                    </div>
                    <div class="lounge-input-row">
                        <div class="lounge-input-wrapper">
                            <textarea class="lounge-input"
                                id="loungeInput"
                                placeholder="Message #${this.escapeHtml(roomName.replace(/^#\s*/, ''))}..."
                                rows="1"
                                oninput="LoungeModule.onInputChange(this)"
                                onkeydown="LoungeModule.onInputKeyDown(event)"></textarea>
                        </div>
                        <button class="lounge-send-btn" onclick="LoungeModule.sendMessage()" title="Send">
                            <svg class="icon"><use href="/static/icons.svg#icon-send"/></svg>
                        </button>
                    </div>
                    <input type="file" id="loungeFileInput" multiple hidden onchange="LoungeModule.onFilesSelected(event)">
                </div>
            </div>
            <div class="lounge-emoji-picker hidden" id="loungeEmojiPicker">
                ${this.renderEmojiPicker()}
            </div>
        `;
    },

    renderReplyPreview() {
        const msg = this.replyingTo;
        return `
            <div class="lounge-reply-preview">
                <div class="lounge-reply-content">
                    <span class="lounge-reply-label">Replying to</span>
                    <span class="lounge-reply-user">${this.escapeHtml(msg.userName)}</span>
                    <span class="lounge-reply-text">${this.escapeHtml(msg.text?.substring(0, 50) || '')}${msg.text?.length > 50 ? '...' : ''}</span>
                </div>
                <button class="lounge-reply-close" onclick="LoungeModule.cancelReply()">
                    <svg class="icon icon-sm"><use href="/static/icons.svg#icon-x"/></svg>
                </button>
            </div>
        `;
    },

    renderOnlineUsers() {
        return this.onlineUsers.map(u => `
            <div class="lounge-online-user">
                <div class="lounge-user-avatar ${u.id === this.userId ? 'is-me' : ''}">
                    ${u.image
                        ? `<img src="${u.image}" alt="">`
                        : `<span>${(u.name || 'U')[0].toUpperCase()}</span>`
                    }
                    <span class="lounge-status-dot online"></span>
                </div>
                <span class="lounge-user-name">${this.escapeHtml(u.name)}${u.id === this.userId ? ' (you)' : ''}</span>
            </div>
        `).join('');
    },

    /**
     * Render messages with grouping (full rebuild - use sparingly)
     */
    renderMessages() {
        const container = document.getElementById('loungeMessagesList');
        if (!container) return;

        if (this.messages.length === 0) {
            container.innerHTML = `
                <div class="lounge-no-messages">
                    <div class="lounge-welcome-icon">👋</div>
                    <h3>Welcome to #${this.escapeHtml(this.room?.name?.replace(/^#\s*/, '') || 'chat')}</h3>
                    <p>This is the beginning of the conversation</p>
                </div>
            `;
            return;
        }

        let html = '';
        let lastUserId = null;
        let lastDate = null;

        for (let i = 0; i < this.messages.length; i++) {
            const msg = this.messages[i];
            const msgDate = new Date(msg.createdAt);
            const dateStr = msgDate.toLocaleDateString();

            // Date separator
            if (dateStr !== lastDate) {
                html += `
                    <div class="lounge-date-separator">
                        <span>${this.formatDateSeparator(msgDate)}</span>
                    </div>
                `;
                lastDate = dateStr;
                lastUserId = null; // Reset grouping on new date
            }

            // Check if this message should be grouped with previous
            const shouldGroup = msg.userId === lastUserId && !msg.replyToId;

            html += this.renderMessage(msg, shouldGroup);
            lastUserId = msg.userId;
        }

        container.innerHTML = html;
    },

    /**
     * Append a single message to the list without full re-render
     */
    appendMessage(msg) {
        const container = document.getElementById('loungeMessagesList');
        if (!container) return;

        // Remove empty state if present
        const emptyState = container.querySelector('.lounge-no-messages');
        if (emptyState) {
            emptyState.remove();
        }

        const msgDate = new Date(msg.createdAt);
        const dateStr = msgDate.toLocaleDateString();

        // Check if we need a date separator
        const lastDateSeparator = container.querySelector('.lounge-date-separator:last-of-type span');
        const lastDateStr = lastDateSeparator?.textContent;
        const todayStr = this.formatDateSeparator(new Date());
        const yesterdayStr = this.formatDateSeparator((() => { const d = new Date(); d.setDate(d.getDate() - 1); return d; })());

        let needsDateSeparator = false;
        if (!lastDateSeparator) {
            needsDateSeparator = true;
        } else {
            // Compare dates
            const formattedDate = this.formatDateSeparator(msgDate);
            if (lastDateStr !== formattedDate && lastDateStr !== 'Today' ||
                (lastDateStr === 'Today' && formattedDate !== 'Today')) {
                needsDateSeparator = true;
            }
        }

        // Check if should group with previous message
        const lastMessage = container.querySelector('.lounge-message:last-child');
        const lastUserId = lastMessage?.dataset?.userId ||
                          lastMessage?.querySelector('[data-user-id]')?.dataset?.userId;
        const shouldGroup = lastMessage &&
                           msg.userId === this.getLastMessageUserId() &&
                           !msg.replyToId &&
                           !needsDateSeparator;

        let html = '';

        if (needsDateSeparator) {
            html += `
                <div class="lounge-date-separator">
                    <span>${this.formatDateSeparator(msgDate)}</span>
                </div>
            `;
        }

        html += this.renderMessage(msg, shouldGroup);
        container.insertAdjacentHTML('beforeend', html);
    },

    /**
     * Get the userId of the last message in the list
     */
    getLastMessageUserId() {
        if (this.messages.length === 0) return null;
        return this.messages[this.messages.length - 1].userId;
    },

    /**
     * Update reactions on a specific message without full re-render
     */
    updateMessageReactions(messageId, reactions) {
        const msgEl = document.querySelector(`[data-message-id="${messageId}"]`);
        if (!msgEl) return;

        const bodyEl = msgEl.querySelector('.lounge-message-body');
        if (!bodyEl) return;

        // Find or create reactions container
        let reactionsEl = bodyEl.querySelector('.lounge-reactions');

        // Build reactions HTML
        const reactionGroups = this.groupReactions(reactions);

        if (reactionGroups.length === 0) {
            // Remove reactions container if no reactions
            if (reactionsEl) reactionsEl.remove();
            return;
        }

        const reactionsHtml = `
            <div class="lounge-reactions">
                ${reactionGroups.map(r => `
                    <button class="lounge-reaction ${r.hasOwn ? 'has-own' : ''}"
                            onclick="LoungeModule.toggleReaction('${messageId}', '${r.emoji}')">
                        <span class="lounge-reaction-emoji">${r.emoji}</span>
                        <span class="lounge-reaction-count">${r.count}</span>
                    </button>
                `).join('')}
                <button class="lounge-reaction lounge-reaction-add" onclick="LoungeModule.showReactionPicker('${messageId}')">
                    <svg class="icon icon-sm"><use href="/static/icons.svg#icon-plus"/></svg>
                </button>
            </div>
        `;

        if (reactionsEl) {
            reactionsEl.outerHTML = reactionsHtml;
        } else {
            // Insert before the closing of message-body
            bodyEl.insertAdjacentHTML('beforeend', reactionsHtml);
        }
    },

    /**
     * Update a single message's content (for edits/deletes)
     */
    updateMessageContent(messageId, updates) {
        const msgEl = document.querySelector(`[data-message-id="${messageId}"]`);
        if (!msgEl) return;

        if (updates.isDeleted) {
            const textEl = msgEl.querySelector('.lounge-message-text');
            if (textEl) {
                textEl.classList.add('deleted');
                textEl.innerHTML = '<em>Message deleted</em>';
            }
        }

        if (updates.text !== undefined && !updates.isDeleted) {
            const textEl = msgEl.querySelector('.lounge-message-text');
            if (textEl) {
                textEl.innerHTML = this.formatMessageText(updates.text);
            }
        }

        if (updates.isEdited) {
            const bodyEl = msgEl.querySelector('.lounge-message-body');
            if (bodyEl && !bodyEl.querySelector('.lounge-edited')) {
                const textEl = bodyEl.querySelector('.lounge-message-text');
                if (textEl) {
                    textEl.insertAdjacentHTML('afterend', '<span class="lounge-edited">(edited)</span>');
                }
            }
        }
    },

    renderMessage(msg, grouped = false) {
        const isOwn = msg.userId === this.userId;
        const time = this.formatTime(new Date(msg.createdAt));

        // Reactions grouped by emoji
        const reactionGroups = this.groupReactions(msg.reactions || []);
        const reactionsHtml = reactionGroups.length > 0 ? `
            <div class="lounge-reactions">
                ${reactionGroups.map(r => `
                    <button class="lounge-reaction ${r.hasOwn ? 'has-own' : ''}"
                            onclick="LoungeModule.toggleReaction('${msg.id}', '${r.emoji}')">
                        <span class="lounge-reaction-emoji">${r.emoji}</span>
                        <span class="lounge-reaction-count">${r.count}</span>
                    </button>
                `).join('')}
                <button class="lounge-reaction lounge-reaction-add" onclick="LoungeModule.showReactionPicker('${msg.id}')">
                    <svg class="icon icon-sm"><use href="/static/icons.svg#icon-plus"/></svg>
                </button>
            </div>
        ` : '';

        // Reply preview
        const replyHtml = msg.replyToId && msg.replyUserName ? `
            <div class="lounge-message-reply">
                <svg class="icon icon-xs"><use href="/static/icons.svg#icon-corner-up-left"/></svg>
                <span class="lounge-reply-author">${this.escapeHtml(msg.replyUserName)}</span>
                <span class="lounge-reply-excerpt">${this.escapeHtml(msg.replyText || '')}</span>
            </div>
        ` : '';

        // Attachments
        const attachmentsHtml = (msg.attachments || []).length > 0 ? `
            <div class="lounge-attachments">
                ${msg.attachments.map(a => this.renderAttachment(a)).join('')}
            </div>
        ` : '';

        if (grouped) {
            return `
                <div class="lounge-message grouped ${isOwn ? 'own' : ''}" data-message-id="${msg.id}">
                    <div class="lounge-message-time-hover">${time}</div>
                    <div class="lounge-message-body">
                        ${replyHtml}
                        <div class="lounge-message-text ${msg.isDeleted ? 'deleted' : ''}">
                            ${msg.isDeleted ? '<em>Message deleted</em>' : this.formatMessageText(msg.text)}
                        </div>
                        ${attachmentsHtml}
                        ${msg.isEdited ? '<span class="lounge-edited">(edited)</span>' : ''}
                        ${reactionsHtml}
                    </div>
                    <div class="lounge-message-actions">
                        ${this.renderMessageActions(msg, isOwn)}
                    </div>
                </div>
            `;
        }

        return `
            <div class="lounge-message ${isOwn ? 'own' : ''}" data-message-id="${msg.id}">
                <div class="lounge-message-avatar">
                    ${msg.userImage
                        ? `<img src="${msg.userImage}" alt="">`
                        : `<span>${(msg.userName || 'U')[0].toUpperCase()}</span>`
                    }
                </div>
                <div class="lounge-message-content">
                    <div class="lounge-message-header">
                        <span class="lounge-message-author">${this.escapeHtml(msg.userName)}</span>
                        <span class="lounge-message-time">${time}</span>
                    </div>
                    <div class="lounge-message-body">
                        ${replyHtml}
                        <div class="lounge-message-text ${msg.isDeleted ? 'deleted' : ''}">
                            ${msg.isDeleted ? '<em>Message deleted</em>' : this.formatMessageText(msg.text)}
                        </div>
                        ${attachmentsHtml}
                        ${msg.isEdited ? '<span class="lounge-edited">(edited)</span>' : ''}
                        ${reactionsHtml}
                    </div>
                </div>
                <div class="lounge-message-actions">
                    ${this.renderMessageActions(msg, isOwn)}
                </div>
            </div>
        `;
    },

    renderMessageActions(msg, isOwn) {
        return `
            <button class="lounge-action-btn" onclick="LoungeModule.showReactionPicker('${msg.id}')" title="Add reaction">
                <svg class="icon icon-sm"><use href="/static/icons.svg#icon-smile"/></svg>
            </button>
            <button class="lounge-action-btn" onclick="LoungeModule.startReply('${msg.id}')" title="Reply">
                <svg class="icon icon-sm"><use href="/static/icons.svg#icon-corner-up-left"/></svg>
            </button>
            ${isOwn ? `
                <button class="lounge-action-btn" onclick="LoungeModule.deleteMessage('${msg.id}')" title="Delete">
                    <svg class="icon icon-sm"><use href="/static/icons.svg#icon-trash"/></svg>
                </button>
            ` : ''}
        `;
    },

    renderAttachment(attachment) {
        if (attachment.fileType === 'image') {
            return `
                <div class="lounge-attachment image">
                    <img src="/chat_uploads/${attachment.filename}" alt="${this.escapeHtml(attachment.originalName)}"
                         onclick="LoungeModule.openImagePreview('/chat_uploads/${attachment.filename}')">
                </div>
            `;
        }

        return `
            <a class="lounge-attachment file" href="/chat_uploads/${attachment.filename}" download="${attachment.originalName}">
                <svg class="icon"><use href="/static/icons.svg#icon-file"/></svg>
                <div class="lounge-attachment-info">
                    <span class="lounge-attachment-name">${this.escapeHtml(attachment.originalName)}</span>
                    <span class="lounge-attachment-size">${this.formatFileSize(attachment.fileSize)}</span>
                </div>
            </a>
        `;
    },

    renderEmojiPicker() {
        const categories = [
            { name: 'Smileys', emojis: ['😀', '😃', '😄', '😁', '😅', '😂', '🤣', '😊', '😇', '🙂', '😉', '😍', '🥰', '😘', '😋', '😛', '🤔', '🤨', '😐', '😑', '😶', '🙄', '😏', '😣', '😥', '😮', '🤐', '😯', '😪', '😫', '😴', '😌', '😷', '🤒', '🤕', '🤢', '🤮', '🤧', '🥵', '🥶', '😱', '😨', '😰', '😢', '😭', '😤', '😠', '😡', '🤬'] },
            { name: 'Gestures', emojis: ['👍', '👎', '👌', '✌️', '🤞', '🤟', '🤘', '🤙', '👋', '🤚', '✋', '🖖', '👏', '🙌', '👐', '🤲', '🙏', '✍️', '💪', '🦵', '🦶', '👂', '👃', '🧠', '🦷', '🦴', '👀', '👁️', '👅', '👄'] },
            { name: 'Objects', emojis: ['❤️', '🧡', '💛', '💚', '💙', '💜', '🖤', '💔', '💕', '💞', '💓', '💗', '💖', '💘', '💝', '💟', '⭐', '🌟', '✨', '💫', '🔥', '💥', '🎉', '🎊', '🏆', '🥇', '🎯', '💯', '✅', '❌'] },
        ];

        return `
            <div class="lounge-emoji-header">
                <span>Pick an emoji</span>
                <button onclick="LoungeModule.toggleEmojiPicker()" class="lounge-emoji-close">
                    <svg class="icon icon-sm"><use href="/static/icons.svg#icon-x"/></svg>
                </button>
            </div>
            <div class="lounge-emoji-quick">
                ${this.quickEmojis.map(e => `
                    <button class="lounge-emoji-btn" onclick="LoungeModule.insertEmoji('${e}')">${e}</button>
                `).join('')}
            </div>
            <div class="lounge-emoji-categories">
                ${categories.map(cat => `
                    <div class="lounge-emoji-category">
                        <div class="lounge-emoji-category-name">${cat.name}</div>
                        <div class="lounge-emoji-grid">
                            ${cat.emojis.map(e => `
                                <button class="lounge-emoji-btn" onclick="LoungeModule.insertEmoji('${e}')">${e}</button>
                            `).join('')}
                        </div>
                    </div>
                `).join('')}
            </div>
        `;
    },

    // ============ Actions ============

    async sendMessage() {
        const input = document.getElementById('loungeInput');
        if (!input) return;

        const text = input.value.trim();
        if (!text && this.pendingAttachments.length === 0) return;

        // Capture reply info before clearing
        const replyToId = this.replyingTo?.id;
        const replyUserName = this.replyingTo?.userName;
        const replyText = this.replyingTo?.text?.substring(0, 50);

        // Clear input immediately for better UX
        input.value = '';
        input.style.height = 'auto';
        const pendingFiles = [...this.pendingAttachments];
        this.pendingAttachments = [];
        this.replyingTo = null;
        this.updateAttachmentsPreview();

        // Create optimistic message IMMEDIATELY (before API call)
        const tempId = 'temp-' + Date.now();
        const optimisticMessage = {
            id: tempId,
            roomId: this.roomId,
            userId: this.userId,
            userName: this.userName,
            userImage: this.userImage,
            text: text,
            replyToId: replyToId,
            replyUserName: replyUserName,
            replyText: replyText,
            attachments: [], // Will be updated after upload
            reactions: [],
            createdAt: new Date().toISOString(),
            isEdited: false,
            isDeleted: false,
            isPending: true // Mark as pending
        };

        // Show message immediately
        this.messages.push(optimisticMessage);
        this.appendMessage(optimisticMessage);
        this.scrollToBottom();

        try {
            // Upload attachments in parallel for speed
            const attachments = await Promise.all(
                pendingFiles.map(async (file) => {
                    const formData = new FormData();
                    formData.append('file', file);
                    const res = await API.request(`/chat/rooms/${this.roomId}/attachments`, {
                        method: 'POST',
                        body: formData
                    });
                    return res.data;
                })
            ).then(results => results.filter(Boolean));

            // Send message to server
            const res = await API.request(`/chat/rooms/${this.roomId}/messages`, {
                method: 'POST',
                body: JSON.stringify({
                    text,
                    replyToId,
                    attachments
                })
            });

            if (res.error) throw new Error(res.error);

            // Update the temporary message with the real ID
            const realMessage = res.data?.message || res.data;
            const tempIndex = this.messages.findIndex(m => m.id === tempId);
            if (tempIndex !== -1 && realMessage?.id) {
                this.messages[tempIndex] = {
                    ...this.messages[tempIndex],
                    id: realMessage.id,
                    attachments: attachments,
                    isPending: false
                };
                // Update DOM element's data-message-id
                const tempEl = document.querySelector(`[data-message-id="${tempId}"]`);
                if (tempEl) {
                    tempEl.setAttribute('data-message-id', realMessage.id);
                }
            }
        } catch (err) {
            console.error('Failed to send message:', err);
            // Remove the optimistic message on error
            const tempIndex = this.messages.findIndex(m => m.id === tempId);
            if (tempIndex !== -1) {
                this.messages.splice(tempIndex, 1);
                const tempEl = document.querySelector(`[data-message-id="${tempId}"]`);
                if (tempEl) tempEl.remove();
            }
            showToast('Failed to send message', 'error');
        }
    },

    async toggleReaction(messageId, emoji) {
        try {
            const res = await API.request(`/chat/messages/${messageId}/reactions`, {
                method: 'POST',
                body: JSON.stringify({ emoji })
            });

            if (res.data) {
                // Update local message reactions
                const msg = this.messages.find(m => m.id === messageId);
                if (msg) {
                    // Rebuild reactions from response
                    msg.reactions = [];
                    for (const group of res.data.reactions) {
                        for (const user of group.users) {
                            msg.reactions.push({
                                emoji: group.emoji,
                                userId: user.userId,
                                userName: user.userName
                            });
                        }
                    }
                    // Use selective update instead of full re-render
                    this.updateMessageReactions(messageId, msg.reactions);
                }
            }
        } catch (err) {
            console.error('Failed to toggle reaction:', err);
        }
    },

    async deleteMessage(messageId) {
        if (!confirm('Delete this message?')) return;

        try {
            await API.request(`/chat/messages/${messageId}`, { method: 'DELETE' });
            const idx = this.messages.findIndex(m => m.id === messageId);
            if (idx !== -1) {
                this.messages[idx].isDeleted = true;
                this.messages[idx].text = null;
                // Use selective update instead of full re-render
                this.updateMessageContent(messageId, { isDeleted: true });
            }
        } catch (err) {
            console.error('Failed to delete message:', err);
        }
    },

    startReply(messageId) {
        const msg = this.messages.find(m => m.id === messageId);
        if (msg) {
            this.replyingTo = msg;
            this.render();
            document.getElementById('loungeInput')?.focus();
        }
    },

    cancelReply() {
        this.replyingTo = null;
        const preview = document.querySelector('.lounge-reply-preview');
        if (preview) preview.remove();
    },

    showReactionPicker(messageId) {
        this.selectedMessageId = messageId;
        // Show quick emoji picker near the message
        const picker = document.createElement('div');
        picker.className = 'lounge-quick-picker';
        picker.innerHTML = this.quickEmojis.map(e => `
            <button onclick="LoungeModule.toggleReaction('${messageId}', '${e}'); this.parentElement.remove();">${e}</button>
        `).join('');

        const msgEl = document.querySelector(`[data-message-id="${messageId}"]`);
        if (msgEl) {
            const existing = document.querySelector('.lounge-quick-picker');
            if (existing) existing.remove();
            msgEl.appendChild(picker);

            // Remove after a delay or on click outside
            setTimeout(() => picker.remove(), 5000);
        }
    },

    /**
     * Wrap selected text with prefix/suffix (for formatting)
     */
    wrapSelection(prefix, suffix) {
        const input = document.getElementById('loungeInput');
        if (!input) return;

        const start = input.selectionStart;
        const end = input.selectionEnd;
        const text = input.value;
        const selectedText = text.substring(start, end);

        // If no selection, just insert the markers
        if (start === end) {
            input.value = text.substring(0, start) + prefix + suffix + text.substring(end);
            input.selectionStart = input.selectionEnd = start + prefix.length;
        } else {
            // Wrap selected text
            input.value = text.substring(0, start) + prefix + selectedText + suffix + text.substring(end);
            input.selectionStart = start + prefix.length;
            input.selectionEnd = end + prefix.length;
        }

        input.focus();
    },

    // ============ Input Handling ============

    onInputChange(textarea) {
        // Auto-resize
        textarea.style.height = 'auto';
        textarea.style.height = Math.min(textarea.scrollHeight, 150) + 'px';

        // Send typing indicator
        this.sendTypingIndicator(true);

        // Clear typing after delay
        clearTimeout(this.typingTimeout);
        this.typingTimeout = setTimeout(() => {
            this.sendTypingIndicator(false);
        }, 2000);
    },

    onInputKeyDown(event) {
        if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            this.sendMessage();
        }
    },

    sendTypingIndicator(isTyping) {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify({ type: 'typing', isTyping }));
        }
    },

    openFilePicker() {
        document.getElementById('loungeFileInput')?.click();
    },

    onFilesSelected(event) {
        const files = Array.from(event.target.files || []);
        this.pendingAttachments = [...this.pendingAttachments, ...files];
        this.updateAttachmentsPreview();
        event.target.value = '';
    },

    updateAttachmentsPreview() {
        const container = document.getElementById('loungeAttachments');
        if (!container) return;

        if (this.pendingAttachments.length === 0) {
            container.innerHTML = '';
            return;
        }

        container.innerHTML = this.pendingAttachments.map((file, i) => `
            <div class="lounge-pending-attachment">
                ${file.type.startsWith('image/')
                    ? `<img src="${URL.createObjectURL(file)}" alt="">`
                    : `<svg class="icon"><use href="/static/icons.svg#icon-file"/></svg>`
                }
                <span>${this.escapeHtml(file.name)}</span>
                <button onclick="LoungeModule.removePendingAttachment(${i})">
                    <svg class="icon icon-sm"><use href="/static/icons.svg#icon-x"/></svg>
                </button>
            </div>
        `).join('');
    },

    removePendingAttachment(index) {
        this.pendingAttachments.splice(index, 1);
        this.updateAttachmentsPreview();
    },

    toggleEmojiPicker() {
        const picker = document.getElementById('loungeEmojiPicker');
        if (picker) {
            picker.classList.toggle('hidden');
            this.emojiPickerOpen = !this.emojiPickerOpen;
        }
    },

    insertEmoji(emoji) {
        const input = document.getElementById('loungeInput');
        if (input) {
            const start = input.selectionStart;
            const end = input.selectionEnd;
            input.value = input.value.substring(0, start) + emoji + input.value.substring(end);
            input.selectionStart = input.selectionEnd = start + emoji.length;
            input.focus();
        }
        this.toggleEmojiPicker();
    },

    // ============ Scroll Handling ============

    onMessagesScroll() {
        const container = document.getElementById('loungeMessages');
        if (!container) return;

        const threshold = 100;
        this.isAtBottom = container.scrollHeight - container.scrollTop - container.clientHeight < threshold;

        // Load more messages when scrolling to top
        if (container.scrollTop < 50 && this.messages.length > 0) {
            this.loadOlderMessages();
        }

        // Hide new message indicator if at bottom
        if (this.isAtBottom) {
            const indicator = document.getElementById('loungeScrollBottom');
            if (indicator) indicator.classList.add('hidden');
        }
    },

    scrollToBottom() {
        const container = document.getElementById('loungeMessages');
        if (container) {
            container.scrollTop = container.scrollHeight;
            this.isAtBottom = true;
        }
        const indicator = document.getElementById('loungeScrollBottom');
        if (indicator) indicator.classList.add('hidden');
    },

    showNewMessageIndicator() {
        const indicator = document.getElementById('loungeScrollBottom');
        if (indicator) indicator.classList.remove('hidden');
    },

    async loadOlderMessages() {
        if (this.loadingOlder || this.messages.length === 0) return;
        this.loadingOlder = true;

        const firstMsgId = this.messages[0]?.id;
        const container = document.getElementById('loungeMessages');
        const oldScrollHeight = container?.scrollHeight || 0;

        await this.loadMessages(firstMsgId);
        this.renderMessages();

        // Maintain scroll position
        if (container) {
            const newScrollHeight = container.scrollHeight;
            container.scrollTop = newScrollHeight - oldScrollHeight;
        }

        this.loadingOlder = false;
    },

    // ============ UI Updates ============

    updateOnlineUsers() {
        const container = document.getElementById('loungeOnlineList');
        if (container) {
            container.innerHTML = this.renderOnlineUsers();
        }
        const count = document.querySelector('.lounge-online-count');
        if (count) {
            count.textContent = this.onlineUsers.length;
        }
        const memberCount = document.querySelector('.lounge-member-count');
        if (memberCount) {
            memberCount.innerHTML = `
                <svg class="icon icon-sm"><use href="/static/icons.svg#icon-users"/></svg>
                ${this.onlineUsers.length}
            `;
        }
    },

    updateTypingIndicator() {
        const container = document.getElementById('loungeTyping');
        if (!container) return;

        const typingNames = Object.values(this.typingUsers);
        if (typingNames.length === 0) {
            container.innerHTML = '';
            return;
        }

        let text;
        if (typingNames.length === 1) {
            text = `${typingNames[0]} is typing...`;
        } else if (typingNames.length === 2) {
            text = `${typingNames[0]} and ${typingNames[1]} are typing...`;
        } else {
            text = `${typingNames.length} people are typing...`;
        }

        container.innerHTML = `
            <div class="lounge-typing-dots">
                <span></span><span></span><span></span>
            </div>
            <span>${text}</span>
        `;
    },

    openImagePreview(src) {
        // Simple image preview in modal
        const modal = document.createElement('div');
        modal.className = 'lounge-image-modal';
        modal.innerHTML = `
            <div class="lounge-image-backdrop" onclick="this.parentElement.remove()"></div>
            <img src="${src}" onclick="event.stopPropagation()">
            <button class="lounge-image-close" onclick="this.parentElement.remove()">
                <svg class="icon"><use href="/static/icons.svg#icon-x"/></svg>
            </button>
        `;
        document.body.appendChild(modal);
    },

    // ============ Utilities ============

    groupReactions(reactions) {
        const groups = {};
        for (const r of reactions) {
            if (!groups[r.emoji]) {
                groups[r.emoji] = { emoji: r.emoji, count: 0, hasOwn: false, users: [] };
            }
            groups[r.emoji].count++;
            groups[r.emoji].users.push(r.userName);
            if (r.userId === this.userId) {
                groups[r.emoji].hasOwn = true;
            }
        }
        return Object.values(groups);
    },

    formatMessageText(text) {
        if (!text) return '';

        // Escape HTML first
        let html = this.escapeHtml(text);

        // Convert URLs to links
        html = html.replace(
            /(https?:\/\/[^\s<]+)/g,
            '<a href="$1" target="_blank" rel="noopener">$1</a>'
        );

        // Convert **bold**
        html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');

        // Convert *italic*
        html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');

        // Convert `code`
        html = html.replace(/`(.+?)`/g, '<code>$1</code>');

        // Convert newlines
        html = html.replace(/\n/g, '<br>');

        return html;
    },

    formatTime(date) {
        return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    },

    formatDateSeparator(date) {
        const today = new Date();
        const yesterday = new Date(today);
        yesterday.setDate(yesterday.getDate() - 1);

        if (date.toDateString() === today.toDateString()) {
            return 'Today';
        } else if (date.toDateString() === yesterday.toDateString()) {
            return 'Yesterday';
        } else {
            return date.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });
        }
    },

    formatFileSize(bytes) {
        if (bytes < 1024) return bytes + ' B';
        if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
        return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
    },

    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text || '';
        return div.innerHTML;
    },

    attachEventListeners() {
        // Close emoji picker on outside click
        document.addEventListener('click', (e) => {
            if (this.emojiPickerOpen && !e.target.closest('.lounge-emoji-picker') && !e.target.closest('.lounge-input-btn')) {
                this.toggleEmojiPicker();
            }
        });
    },

    cleanup() {
        this.disconnectWebSocket();
    }
};

// Make globally available
window.LoungeModule = LoungeModule;
