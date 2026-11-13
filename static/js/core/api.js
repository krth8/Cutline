/**
 * API Client for CollabSuite
 * Centralized API calls with error handling
 */

/**
 * Current auth token: logged-in user first, then share-link guest token.
 */
function getAuthToken() {
    if (typeof AppState !== 'undefined' && AppState.authToken) return AppState.authToken;
    if (typeof AppState !== 'undefined' && AppState.guestToken) return AppState.guestToken;
    try {
        return sessionStorage.getItem('guestToken');
    } catch (e) {
        return null;
    }
}

/** The `sub` claim of a token (who it belongs to), or null. */
function tokenSubject(token) {
    try {
        const payload = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
        return JSON.parse(atob(payload)).sub || null;
    } catch (e) {
        return null;
    }
}

/**
 * Store the project-scoped token handed out when a share link is opened.
 */
function setGuestToken(token) {
    if (typeof AppState !== 'undefined') {
        AppState.guestToken = token || null;
        // Guests are known to the server by their token's id; use the same one here
        const sub = tokenSubject(token);
        if (sub && !AppState.authToken) AppState.userId = sub;
    }
    try {
        if (token) sessionStorage.setItem('guestToken', token);
        else sessionStorage.removeItem('guestToken');
    } catch (e) {}
}

/**
 * Add ?token= to same-origin URLs that cannot send headers (WebSockets, <img> sources).
 */
function withAuthToken(url) {
    const token = getAuthToken();
    if (!token) return url;
    return url + (url.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(token);
}

/**
 * Random id for this browser tab. Sent with API requests so live events
 * caused by this tab aren't echoed back to it.
 */
const CLIENT_ID = 'c' + Math.random().toString(36).slice(2, 12) + Date.now().toString(36);
window.CLIENT_ID = CLIENT_ID;

// Every same-origin API request goes through here: it gets the auth token, the
// tab id and how long the user has been idle, and a 401 ends the login.
(function () {
    const originalFetch = window.fetch.bind(window);
    // Endpoints where a 401 does not mean "your login is over"
    const NOT_A_SESSION_CHECK = ['/api/auth/login', '/api/auth/logout'];
    let guestNoticeShown = false;

    window.fetch = function (input, init = {}) {
        let sentToken = null;
        let path = null;
        try {
            const url = typeof input === 'string' ? input : input.url;
            const sameOrigin = url.startsWith('/') || url.startsWith(window.location.origin);
            if (sameOrigin) {
                path = new URL(url, window.location.origin).pathname;
                const headers = new Headers(init.headers || (typeof input !== 'string' ? input.headers : undefined));
                const token = getAuthToken();
                if (token) headers.set('Authorization', `Bearer ${token}`);
                else headers.delete('Authorization');
                sentToken = token;
                headers.set('X-Client-Id', CLIENT_ID);
                if (typeof Auth !== 'undefined' && Auth.isLoggedIn()) {
                    const idle = Auth.idleSeconds();
                    headers.set('X-Idle-Seconds', String(idle));
                    Auth.noteReported(idle);
                }
                init = { ...init, headers };
            }
        } catch (e) {}

        const request = originalFetch(input, init);
        if (!sentToken || !path || NOT_A_SESSION_CHECK.includes(path)) return request;

        return request.then((response) => {
            if (response.status === 401 && sentToken === getAuthToken()) {
                if (typeof Auth !== 'undefined' && Auth.isLoggedIn()) {
                    Auth.end('expired');
                } else if (!guestNoticeShown && typeof Toast !== 'undefined') {
                    guestNoticeShown = true;
                    Toast.error('Your access to this project has ended. Open the share link again to continue.');
                }
            }
            return response;
        });
    };
})();

const API = {
    /**
     * Get auth headers (JWT token if logged in)
     */
    getHeaders() {
        const headers = {
            'Content-Type': 'application/json'
        };
        const token = getAuthToken();
        if (token) {
            headers['Authorization'] = `Bearer ${token}`;
        }
        return headers;
    },

    /**
     * Make API request with error handling
     */
    async request(endpoint, options = {}) {
        const url = endpoint.startsWith('http') ? endpoint : `/api${endpoint}`;

        const config = {
            headers: this.getHeaders(),
            ...options
        };

        // Don't set Content-Type for FormData (let browser set it with boundary)
        if (options.body instanceof FormData) {
            delete config.headers['Content-Type'];
        }

        try {
            const response = await fetch(url, config);

            // A 401 ends the login (handled by the fetch wrapper above)
            if (response.status === 401) {
                return { error: 'Unauthorized', status: 401 };
            }

            // Handle non-JSON responses
            const contentType = response.headers.get('content-type');
            if (!contentType || !contentType.includes('application/json')) {
                if (!response.ok) {
                    return { error: `HTTP ${response.status}`, status: response.status };
                }
                return { data: await response.text(), status: response.status };
            }

            const data = await response.json();

            if (!response.ok) {
                return {
                    error: data.detail || data.error || `HTTP ${response.status}`,
                    status: response.status,
                    data
                };
            }

            return { data, status: response.status };
        } catch (error) {
            console.error('API Error:', error);
            return { error: error.message || 'Network error', status: 0 };
        }
    },

    // ============ Auth Endpoints ============

    async login(username, password) {
        return this.request('/login', {
            method: 'POST',
            body: JSON.stringify({ username, password })
        });
    },

    async register(username, password, inviteLink = null) {
        const body = { username, password };
        if (inviteLink) body.invite_link = inviteLink;
        return this.request('/register', {
            method: 'POST',
            body: JSON.stringify(body)
        });
    },

    async setup(username, password) {
        return this.request('/setup', {
            method: 'POST',
            body: JSON.stringify({ username, password })
        });
    },

    async checkNeedsSetup() {
        return this.request('/needs-setup');
    },

    // ============ Project Endpoints ============

    async getProjects() {
        return this.request('/projects');
    },

    async getProject(projectId) {
        return this.request(`/projects/${projectId}`);
    },

    async createProject(name) {
        return this.request('/projects', {
            method: 'POST',
            body: JSON.stringify({ name })
        });
    },

    async deleteProject(projectId) {
        return this.request(`/projects/${projectId}`, {
            method: 'DELETE'
        });
    },

    async uploadProjectCover(projectId, file) {
        const formData = new FormData();
        formData.append('file', file);
        return this.request(`/projects/${projectId}/cover`, {
            method: 'POST',
            body: formData
        });
    },

    // ============ Clip Endpoints ============

    async uploadClip(projectId, file, onProgress = null) {
        return new Promise((resolve) => {
            const xhr = new XMLHttpRequest();
            const formData = new FormData();
            formData.append('file', file);

            if (onProgress) {
                xhr.upload.addEventListener('progress', (e) => {
                    if (e.lengthComputable) {
                        onProgress(e.loaded / e.total);
                    }
                });
            }

            xhr.addEventListener('load', () => {
                try {
                    const data = JSON.parse(xhr.responseText);
                    resolve({ data, status: xhr.status });
                } catch {
                    resolve({ error: 'Invalid response', status: xhr.status });
                }
            });

            xhr.addEventListener('error', () => {
                resolve({ error: 'Upload failed', status: 0 });
            });

            xhr.open('POST', `/api/projects/${projectId}/clips`);
            const token = getAuthToken();
            if (token) {
                xhr.setRequestHeader('Authorization', `Bearer ${token}`);
            }
            xhr.send(formData);
        });
    },

    async updateClipStatus(projectId, clipName, statusId) {
        return this.request(`/projects/${projectId}/clips/${encodeURIComponent(clipName)}/status`, {
            method: 'PUT',
            body: JSON.stringify({ status_id: statusId })
        });
    },

    async setActiveVersion(projectId, clipName, version) {
        return this.request(`/projects/${projectId}/clips/${encodeURIComponent(clipName)}/version`, {
            method: 'PUT',
            body: JSON.stringify({ version })
        });
    },

    async getUntaggedClips(projectId) {
        return this.request(`/projects/${projectId}/untagged-clips`);
    },

    // ============ Comment Endpoints ============

    async addComment(projectId, comment) {
        return this.request(`/projects/${projectId}/comments`, {
            method: 'POST',
            body: JSON.stringify(comment)
        });
    },

    async deleteComment(projectId, commentId) {
        return this.request(`/projects/${projectId}/comments/${commentId}`, {
            method: 'DELETE'
        });
    },

    // ============ Share Link Endpoints ============

    async createShareLink(projectId, password = null) {
        const body = {};
        if (password) body.password = password;
        return this.request(`/projects/${projectId}/share`, {
            method: 'POST',
            body: JSON.stringify(body)
        });
    },

    async getShareLinks(projectId) {
        return this.request(`/projects/${projectId}/share-links`);
    },

    async getAllShareLinks() {
        return this.request('/share-links');
    },

    async deleteShareLink(linkId) {
        return this.request(`/share/${linkId}`, {
            method: 'DELETE'
        });
    },

    async validateShareLink(linkId, password = null) {
        const body = {};
        if (password) body.password = password;
        return this.request(`/share/${linkId}/validate`, {
            method: 'POST',
            body: JSON.stringify(body)
        });
    },

    async accessShareLink(linkId) {
        return this.request(`/s/${linkId}`);
    },

    // ============ Session Endpoints ============

    async getActiveSession() {
        return this.request('/active-session');
    },

    async createSession(projectId) {
        return this.request('/sessions', {
            method: 'POST',
            body: JSON.stringify({ projectId })
        });
    },

    async endSession(sessionId) {
        return this.request(`/sessions/${sessionId}`, {
            method: 'DELETE'
        });
    },

    // ============ Status Endpoints ============

    async getStatuses() {
        return this.request('/statuses');
    },

    async createStatus(name, color) {
        return this.request('/statuses', {
            method: 'POST',
            body: JSON.stringify({ name, color })
        });
    },

    async updateStatus(statusId, name, color) {
        return this.request(`/statuses/${statusId}`, {
            method: 'PUT',
            body: JSON.stringify({ name, color })
        });
    },

    async deleteStatus(statusId) {
        return this.request(`/statuses/${statusId}`, {
            method: 'DELETE'
        });
    },

    // ============ User Endpoints ============

    async getUsers() {
        return this.request('/admin/users');
    },

    async updateUserRole(userId, isAdmin) {
        return this.request(`/admin/users/${userId}`, {
            method: 'PATCH',
            body: JSON.stringify({ isAdmin: isAdmin })
        });
    },

    async deleteUser(userId) {
        return this.request(`/admin/users/${userId}`, {
            method: 'DELETE'
        });
    },

    async updateUserPassword(userId, newPassword) {
        return this.request(`/admin/users/${userId}`, {
            method: 'PATCH',
            body: JSON.stringify({ newPassword: newPassword })
        });
    },

    async uploadProfileImage(file) {
        const formData = new FormData();
        formData.append('file', file);
        return this.request('/users/me/profile-image', {
            method: 'POST',
            body: formData
        });
    },

    // ============ Guest Endpoints ============

    async trackGuest(name, projectId, shareLinkId = null, email = null) {
        return this.request('/guests/track', {
            method: 'POST',
            body: JSON.stringify({ name, projectId, shareLinkId, email })
        });
    },

    async getGuests() {
        return this.request('/admin/guests');
    },

    async deleteGuest(guestId) {
        return this.request(`/admin/guests/${guestId}`, {
            method: 'DELETE'
        });
    },

    // ============ Invite Link Endpoints ============

    async getInviteLinks() {
        return this.request('/invite-links');
    },

    async createInviteLink(options = {}) {
        return this.request('/invite-links', {
            method: 'POST',
            body: JSON.stringify(options)
        });
    },

    async deleteInviteLink(linkId) {
        return this.request(`/invite-links/${linkId}`, {
            method: 'DELETE'
        });
    },

    async validateInviteLink(linkId) {
        return this.request(`/invite/${linkId}`);
    },

    // ============ Task Endpoints ============

    async getTasks(projectId, options = {}) {
        const params = new URLSearchParams();
        if (options.parentId) params.append('parent_id', options.parentId);
        if (options.sectionId) params.append('section_id', options.sectionId);
        if (options.stageTag) params.append('stage_tag', options.stageTag);
        if (options.statusId) params.append('status_id', options.statusId);
        if (options.assigneeId) params.append('assignee_id', options.assigneeId);
        if (options.priority) params.append('priority', options.priority);
        if (options.view) params.append('view', options.view);

        const queryString = params.toString();
        return this.request(`/projects/${projectId}/tasks${queryString ? '?' + queryString : ''}`);
    },

    async getTaskHierarchy(projectId) {
        return this.request(`/projects/${projectId}/tasks?view=hierarchy`);
    },

    async createTask(projectId, task) {
        return this.request(`/projects/${projectId}/tasks`, {
            method: 'POST',
            body: JSON.stringify(task)
        });
    },

    async getTask(taskId) {
        return this.request(`/tasks/${taskId}`);
    },

    async updateTask(taskId, updates) {
        return this.request(`/tasks/${taskId}`, {
            method: 'PATCH',
            body: JSON.stringify(updates)
        });
    },

    async deleteTask(taskId) {
        return this.request(`/tasks/${taskId}`, {
            method: 'DELETE'
        });
    },

    async reorderTasks(projectId, taskIds) {
        return this.request(`/projects/${projectId}/tasks/reorder`, {
            method: 'POST',
            body: JSON.stringify({ taskIds })
        });
    },

    async getStages(projectId) {
        return this.request(`/projects/${projectId}/tasks/stages`);
    },

    // ============ Task Comments ============

    async getTaskComments(taskId) {
        return this.request(`/tasks/${taskId}/comments`);
    },

    async createTaskComment(taskId, text) {
        return this.request(`/tasks/${taskId}/comments`, {
            method: 'POST',
            body: JSON.stringify({ text })
        });
    },

    async deleteTaskComment(taskId, commentId) {
        return this.request(`/tasks/${taskId}/comments/${commentId}`, {
            method: 'DELETE'
        });
    },

    // ============ Task-Clip Linking ============

    async getTaskClips(taskId) {
        return this.request(`/tasks/${taskId}/clips`);
    },

    async linkTaskClip(taskId, clipId) {
        return this.request(`/tasks/${taskId}/clips`, {
            method: 'POST',
            body: JSON.stringify({ clipId })
        });
    },

    async unlinkTaskClip(taskId, clipId) {
        return this.request(`/tasks/${taskId}/clips/${clipId}`, {
            method: 'DELETE'
        });
    },

    async getClipTasks(clipId) {
        return this.request(`/clips/${clipId}/tasks`);
    },

    // ============ Task Checklist ============

    async getTaskChecklist(taskId) {
        return this.request(`/tasks/${taskId}/checklist`);
    },

    async createChecklistItem(taskId, text) {
        return this.request(`/tasks/${taskId}/checklist`, {
            method: 'POST',
            body: JSON.stringify({ text })
        });
    },

    async updateChecklistItem(taskId, itemId, updates) {
        return this.request(`/tasks/${taskId}/checklist/${itemId}`, {
            method: 'PATCH',
            body: JSON.stringify(updates)
        });
    },

    async deleteChecklistItem(taskId, itemId) {
        return this.request(`/tasks/${taskId}/checklist/${itemId}`, {
            method: 'DELETE'
        });
    },

    // ============ Task Sections ============

    async getSections(projectId) {
        return this.request(`/projects/${projectId}/sections`);
    },

    async createSection(projectId, data) {
        return this.request(`/projects/${projectId}/sections`, {
            method: 'POST',
            body: JSON.stringify(data)
        });
    },

    async getSection(sectionId) {
        return this.request(`/sections/${sectionId}`);
    },

    async updateSection(sectionId, updates) {
        return this.request(`/sections/${sectionId}`, {
            method: 'PATCH',
            body: JSON.stringify(updates)
        });
    },

    async deleteSection(sectionId) {
        return this.request(`/sections/${sectionId}`, {
            method: 'DELETE'
        });
    },

    async reorderSections(projectId, sectionIds) {
        return this.request(`/projects/${projectId}/sections/reorder`, {
            method: 'POST',
            body: JSON.stringify({ sectionIds })
        });
    },

    async getSectionStatuses(sectionId) {
        return this.request(`/sections/${sectionId}/statuses`);
    },

    async addSectionStatus(sectionId, statusId) {
        return this.request(`/sections/${sectionId}/statuses`, {
            method: 'POST',
            body: JSON.stringify({ statusId })
        });
    },

    async createSectionStatus(sectionId, name, color = '#6366f1') {
        return this.request(`/sections/${sectionId}/statuses`, {
            method: 'POST',
            body: JSON.stringify({ name, color })
        });
    },

    async removeSectionStatus(sectionId, statusId) {
        return this.request(`/sections/${sectionId}/statuses/${statusId}`, {
            method: 'DELETE'
        });
    },

    // ============ Project Members ============

    async getProjectMembers(projectId) {
        return this.request(`/projects/${projectId}/members`);
    }
};

// Export to global scope
window.API = API;
