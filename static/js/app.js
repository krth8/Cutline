// ============ Global State ============
// AppState is now defined in core/state.js with reactive capabilities
// All existing properties are preserved for backwards compatibility

// ============ Color Helpers ============
function getContrastTextColor(hexColor) {
    // Convert hex to RGB
    const hex = hexColor.replace('#', '');
    const r = parseInt(hex.substr(0, 2), 16) / 255;
    const g = parseInt(hex.substr(2, 2), 16) / 255;
    const b = parseInt(hex.substr(4, 2), 16) / 255;

    // Calculate relative luminance (WCAG formula)
    const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;

    // Only use dark text for very light backgrounds
    return luminance > 0.7 ? '#1a1a2e' : '#ffffff';
}

// ============ Auth Helper ============
function getAuthHeaders() {
    const headers = { 'Content-Type': 'application/json' };
    if (AppState.authToken) {
        headers['Authorization'] = `Bearer ${AppState.authToken}`;
    }
    return headers;
}

// Kept for the many callers: fetch() itself adds the token and handles a
// login that has ended (see core/api.js and core/auth.js).
async function authFetch(url, options = {}) {
    const headers = { ...getAuthHeaders(), ...options.headers };
    return fetch(url, { ...options, headers });
}

function saveAuthToStorage() {
    Auth.save();
}

// Permission helper - checks if current user has a specific permission
function hasPermission(permission) {
    return AppState.permissions && AppState.permissions.includes(permission);
}

// Permission constants (match server-side)
const Permission = {
    PROJECT_CREATE: 'project:create',
    PROJECT_READ: 'project:read',
    PROJECT_UPDATE: 'project:update',
    PROJECT_DELETE: 'project:delete',
    SHARE_CREATE: 'share:create',
    SHARE_READ: 'share:read',
    SHARE_DELETE: 'share:delete',
    SESSION_CREATE: 'session:create',
    SESSION_JOIN: 'session:join',
    SESSION_DELETE: 'session:delete',
    ADMIN_USERS: 'admin:users',
    ADMIN_SETTINGS: 'admin:settings'
};

// Convenience checks
function canCreateProject() {
    return hasPermission(Permission.PROJECT_CREATE);
}

function canDeleteProject() {
    return hasPermission(Permission.PROJECT_DELETE);
}

function canShareProject() {
    return hasPermission(Permission.SHARE_CREATE);
}

// ============ DOM Elements ============
const elements = {
    video: null,
    canvas: null,
    ctx: null,
    svgOverlay: null,
    uploadOverlay: null,
    init() {
        this.video = document.getElementById('video');
        this.canvas = document.getElementById('canvas');
        this.ctx = this.canvas.getContext('2d');
        this.svgOverlay = document.getElementById('svgOverlay');
        this.uploadOverlay = document.getElementById('uploadOverlay');
    }
};

// Resize canvas to match video's native resolution
function resizeCanvasToDisplay() {
    const video = elements.video;
    if (video.videoWidth && video.videoHeight) {
        elements.canvas.width = video.videoWidth;
        elements.canvas.height = video.videoHeight;
        if (typeof redrawCanvas === 'function') redrawCanvas();
    }
}

// ============ Initialization ============
document.addEventListener('DOMContentLoaded', async () => {
    initTheme(); // Apply saved theme early
    elements.init();
    initVideoPlayer();
    initWebSocket();
    initSyncControl();
    initComments();
    initClips();
    initKeyboardShortcuts();
    initUpload();
    initPlayerDropdowns(); // Custom dropdowns for version, status, quality, speed, zoom
    initCursorControl();
    initCompareVideoSync();
    initMobileLayout();

    // App-like: disable context menu (right-click / long-press)
    document.addEventListener('contextmenu', (e) => {
        // Allow context menu on input/textarea for copy/paste
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
        e.preventDefault();
    });

    // Set loop button as active on startup (since loop is default on)
    updateLoopButton();

    // Setup expand projects button
    const expandBtn = document.getElementById('expandProjectsBtn');
    if (expandBtn) {
        expandBtn.addEventListener('click', toggleExpandedProjectsView);
    }

    // Close expanded projects view when clicking outside the projects sidebar
    document.addEventListener('click', (e) => {
        if (!AppState.expandedProjectsView) return;

        const sidebar = document.querySelector('.sidebar-left');
        const expandBtn = document.getElementById('expandProjectsBtn');

        // Check if click is outside sidebar and not on expand button
        if (sidebar && !sidebar.contains(e.target) && !expandBtn?.contains(e.target)) {
            AppState.expandedProjectsView = false;
            AppState.selectedGridProject = null;
            renderProjectsSidebar();
        }
    });

    // Handle enter key on login form
    document.getElementById('loginPassword')?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') mainLogin();
    });

    // Check for share link URL first (/s/{link_id})
    const pathMatch = window.location.pathname.match(/^\/s\/([^\/]+)$/);
    if (pathMatch) {
        const linkId = pathMatch[1];
        // Hide login overlay for share links
        document.getElementById('loginOverlay').classList.add('hidden');
        handleShareLinkAccess(linkId);
        return;  // Don't proceed with normal init
    }

    // Check for invite link URL (/invite/{invite_id})
    const inviteMatch = window.location.pathname.match(/^\/invite\/([^\/]+)$/);
    if (inviteMatch) {
        const inviteId = inviteMatch[1];
        await showRegistrationModal(inviteId);
        return;  // Don't proceed with normal init
    }

    // Check if initial setup is required (no users exist)
    const setupRequired = await checkSetupRequired();
    if (setupRequired) {
        // Clear any stale auth data from previous installs
        localStorage.removeItem('authData');

        document.getElementById('setupOverlay').classList.remove('hidden');
        document.getElementById('loginOverlay').classList.add('hidden');
        document.getElementById('uploadOverlay').classList.add('hidden');
        return;  // Don't proceed until setup is complete
    }

    // Pick up a stored login (checked with the server in the background)
    Auth.restore();

    // If not authenticated, show login overlay
    if (!AppState.authToken) {
        // A share-link guest who reloaded the page goes back through their link
        const guestLink = sessionStorage.getItem('shareLinkId');
        if (guestLink) {
            window.location.replace(`/s/${encodeURIComponent(guestLink)}`);
            return;
        }
        const message = Auth.logoutMessage();
        if (message) {
            const notice = document.getElementById('loginError');
            notice.textContent = message;
            notice.classList.remove('hidden');
        }
        document.getElementById('loginOverlay').classList.remove('hidden');
        document.getElementById('uploadOverlay').classList.add('hidden');
        return;  // Don't proceed until authenticated
    }

    // Authenticated - hide both overlays, go straight to app
    document.getElementById('loginOverlay').classList.add('hidden');
    document.getElementById('uploadOverlay').classList.add('hidden');

    // Load projects in sidebar
    loadProjects();

    // Load clip statuses (await to ensure statuses available before clips render)
    await loadStatuses();

    // Check URL for project/session
    const urlParams = new URLSearchParams(window.location.search);
    const urlSession = urlParams.get('session');
    const urlProject = urlParams.get('project');

    if (urlSession) {
        // Session link - join session (pass project as fallback)
        joinSessionFromUrl(urlSession, urlProject);
    } else if (urlProject) {
        // Direct project link (view only, no session)
        AppState.projectId = urlProject;
        loadProject(urlProject);
    }
});

// Join session from URL parameter
async function joinSessionFromUrl(sessionId, fallbackProjectId = null) {
    try {
        const userName = AppState.userName || 'Guest';
        const res = await authFetch(`/api/sessions/${sessionId}/join`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: userName })
        });

        if (!res.ok) {
            const error = await res.json();

            // Session not found - try to load project directly if we have project ID
            if (fallbackProjectId) {
                console.log('Session expired, loading project instead');
                AppState.projectId = fallbackProjectId;
                loadProject(fallbackProjectId);
                // Clean up URL to just project
                history.replaceState(null, '', `?project=${fallbackProjectId}`);
                return;
            }

            alert(error.detail || 'Session not found');
            loadProjects();
            return;
        }

        const data = await res.json();

        // Set session and project state
        AppState.sessionId = sessionId;
        AppState.projectId = data.project_id;
        AppState.currentProject = data.project;

        // Update URL to include project for clarity
        history.replaceState(null, '', `?project=${data.project_id}&session=${sessionId}`);

        // Switch to review tab when joining session
        if (typeof switchTab === 'function') {
            switchTab('review');
        }

        // Initialize UI with project data
        initSessionUI(data.project);

        // Connect to session WebSocket
        connectWebSocket();

        // Also load projects list in sidebar
        loadProjects();

    } catch (e) {
        console.error('Failed to join session from URL:', e);

        // Network error - try project fallback
        if (fallbackProjectId) {
            AppState.projectId = fallbackProjectId;
            loadProject(fallbackProjectId);
            return;
        }

        alert('Failed to join session');
        loadProjects();
    }
}

// ============ Session Check ============
let selectedWelcomeSession = null;

async function checkActiveSession() {
    // Load sessions for welcome screen
    await loadWelcomeSessions();
}

async function loadWelcomeSessions() {
    const container = document.getElementById('welcomeSessionsList');

    try {
        const res = await authFetch('/api/sessions');
        const data = await res.json();
        AppState.sessions = data.sessions || [];
        renderWelcomeSessions();
    } catch (e) {
        container.innerHTML = '<div class="welcome-sessions-empty">Could not load sessions</div>';
    }
}

function renderWelcomeSessions() {
    const container = document.getElementById('welcomeSessionsList');
    const joinBtn = document.getElementById('joinSessionBtn');

    if (AppState.sessions.length === 0) {
        container.innerHTML = '<div class="welcome-sessions-empty">No active sessions</div>';
        joinBtn.disabled = true;
        return;
    }

    container.innerHTML = AppState.sessions.map(s => {
        // Use session_name if available, fallback to project_name
        const displayName = s.session_name || s.project_name;
        return `
            <div class="welcome-session-item ${selectedWelcomeSession === s.id ? 'selected' : ''}"
                 onclick="selectWelcomeSession('${s.id}')" data-session="${s.id}">
                <div class="welcome-session-radio"></div>
                <div class="welcome-session-info">
                    <div class="welcome-session-name">${escapeHtml(displayName)}</div>
                    <div class="welcome-session-meta">${s.clips_count || 0} clips</div>
                </div>
                <div class="welcome-session-users">${s.user_count} online</div>
            </div>
        `;
    }).join('');
}

function selectWelcomeSession(sessionId) {
    selectedWelcomeSession = sessionId;

    // Update UI
    document.querySelectorAll('.welcome-session-item').forEach(el => {
        el.classList.toggle('selected', el.dataset.session === sessionId);
    });

    // Enable join button
    document.getElementById('joinSessionBtn').disabled = false;
}

async function joinSelectedSession() {
    if (!selectedWelcomeSession) return;

    const name = document.getElementById('nameInput').value.trim() || 'Anonymous';
    AppState.userName = name;

    await joinSessionById(selectedWelcomeSession);
}

// ============ Sessions Modal ============
let sessionsPollingInterval = null;

async function showSessionsModal() {
    document.getElementById('sessionsModal').classList.remove('hidden');
    await loadSessions();

    // Start polling while modal is open
    if (!sessionsPollingInterval) {
        sessionsPollingInterval = setInterval(loadSessions, 5000);
    }
}

function hideSessionsModal() {
    document.getElementById('sessionsModal').classList.add('hidden');

    // Stop polling when modal is closed
    if (sessionsPollingInterval) {
        clearInterval(sessionsPollingInterval);
        sessionsPollingInterval = null;
    }
}

async function loadSessions() {
    try {
        const res = await authFetch('/api/sessions');
        const data = await res.json();
        let sessions = data.sessions || [];

        // Filter to only show sessions for current project if we're in one
        if (AppState.projectId) {
            sessions = sessions.filter(s => s.project_id === AppState.projectId);
        }

        AppState.sessions = sessions;
        renderSessionsList();
    } catch (e) {
        console.error('Failed to load sessions:', e);
    }
}

function renderSessionsList() {
    const container = document.getElementById('sessionsList');

    // Remember which dropdowns are expanded before re-render
    const expandedSessions = new Set();
    container.querySelectorAll('.session-users-dropdown.expanded').forEach(el => {
        const sessionId = el.id.replace('session-users-', '');
        expandedSessions.add(sessionId);
    });

    if (AppState.sessions.length === 0) {
        const emptyMsg = AppState.projectId
            ? 'No active sessions for this project'
            : 'No active sessions';
        container.innerHTML = `<div class="sessions-empty">${emptyMsg}</div>`;
        return;
    }

    container.innerHTML = AppState.sessions.map(s => {
        const isCurrentSession = AppState.sessionId === s.id;
        const buttonClass = isCurrentSession ? 'session-item-btn leave' : 'session-item-btn';
        const buttonText = isCurrentSession ? 'Leave' : 'Join';
        const buttonAction = isCurrentSession
            ? `leaveSession('${s.id}')`
            : `joinSessionById('${s.id}')`;

        // Use session_name if available, fallback to project_name
        const displayName = s.session_name || s.project_name;

        // Render users list for dropdown
        const usersHtml = (s.users || []).map(u => {
            const userName = u.name || u.id?.substr(-4) || 'User';
            const initials = userName.split(' ').map(n => n[0]).join('').toUpperCase().substr(0, 2) || 'U';
            const color = u.color || '#5f5de5';
            return `
                <div class="session-user-item">
                    <span class="session-user-avatar" style="background: ${color}">${initials}</span>
                    <span class="session-user-name">${escapeHtml(userName)}</span>
                </div>
            `;
        }).join('');

        return `
            <div class="session-item ${isCurrentSession ? 'current' : ''}" data-session="${s.id}">
                <div class="session-item-header">
                    <span class="session-expand-icon" onclick="toggleSessionUsers('${s.id}')">▶</span>
                    <div class="session-item-info" onclick="toggleSessionUsers('${s.id}')">
                        <div class="session-item-name">${escapeHtml(displayName)}${isCurrentSession ? ' <span class="session-current-badge">Current</span>' : ''}</div>
                        <div class="session-item-meta">
                            <span class="session-item-users">
                                <span class="session-item-dot"></span>
                                ${s.user_count} user${s.user_count !== 1 ? 's' : ''}
                            </span>
                            <span>Started ${formatTime(s.startedAt)}</span>
                        </div>
                    </div>
                    <div class="session-item-actions">
                        <button class="session-share-btn" onclick="event.stopPropagation(); copySessionLink('${s.id}')" title="Copy session link">
                            <svg class="icon icon-sm"><use href="/static/icons.svg#icon-share"/></svg>
                        </button>
                        <button class="${buttonClass}" onclick="event.stopPropagation(); ${buttonAction}">${buttonText}</button>
                    </div>
                </div>
                <div class="session-users-dropdown" id="session-users-${s.id}">
                    ${usersHtml || '<div class="session-users-empty">No users connected</div>'}
                </div>
            </div>
        `;
    }).join('');

    // Restore expanded state for dropdowns that were open
    expandedSessions.forEach(sessionId => {
        const dropdown = document.getElementById(`session-users-${sessionId}`);
        const sessionItem = dropdown?.closest('.session-item');
        const expandIcon = sessionItem?.querySelector('.session-expand-icon');
        if (dropdown) {
            dropdown.classList.add('expanded');
            if (expandIcon) expandIcon.textContent = '▼';
        }
    });
}

// Toggle the users dropdown for a session
function toggleSessionUsers(sessionId) {
    const dropdown = document.getElementById(`session-users-${sessionId}`);
    const sessionItem = dropdown?.closest('.session-item');
    const expandIcon = sessionItem?.querySelector('.session-expand-icon');

    if (dropdown) {
        const isExpanded = dropdown.classList.toggle('expanded');
        if (expandIcon) {
            expandIcon.textContent = isExpanded ? '▼' : '▶';
        }
    }
}

// Copy session link to clipboard
function copySessionLink(sessionId) {
    // Find session to get project_id for better URL
    const session = AppState.sessions.find(s => s.id === sessionId);
    const projectId = session?.project_id || AppState.projectId;

    // Include both project and session for robustness
    let url = `${window.location.origin}?session=${sessionId}`;
    if (projectId) {
        url = `${window.location.origin}?project=${projectId}&session=${sessionId}`;
    }

    navigator.clipboard.writeText(url).then(() => {
        // Quick flash confirmation
        const btn = document.querySelector(`[data-session="${sessionId}"] .session-share-btn`);
        if (btn) {
            btn.classList.add('copied');
            setTimeout(() => {
                btn.classList.remove('copied');
            }, 400);
        }
    }).catch(err => {
        console.error('Failed to copy:', err);
        alert('Failed to copy link');
    });
}

function formatTime(isoString) {
    const date = new Date(isoString);
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

async function joinSessionById(sessionId) {
    const name = AppState.userName || document.getElementById('nameInput')?.value.trim() || 'Anonymous';

    // Leave current session if already in one
    leaveCurrentSessionSilently();

    AppState.userName = name;

    try {
        const res = await fetch(`/api/sessions/${sessionId}/join`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name })
        });
        const data = await res.json();

        AppState.sessionId = data.session_id;
        AppState.projectId = data.project_id;
        AppState.currentProject = data.project;

        hideSessionsModal();
        initSessionUI(data.project);
        loadProjects();

        // Enable sync after joining
        AppState.syncEnabled = true;
        updateSyncUI();

    } catch (e) {
        console.error('Failed to join session:', e);
        alert('Failed to join session');
    }
}

function leaveSession(sessionId) {
    // Use clean disconnect (prevents auto-reconnect)
    disconnectWebSocket();

    // Clear session state but keep project
    AppState.sessionId = null;
    AppState.syncEnabled = false;
    updateSyncUI();
    updateSessionBadgeState(false);

    // Refresh sessions list
    hideSessionsModal();
    loadSessions().then(() => {
        showSessionsModal();
    });
}

// Leave current session silently (without UI updates) - used when switching sessions
function leaveCurrentSessionSilently() {
    // Use clean disconnect (prevents auto-reconnect)
    disconnectWebSocket();
    AppState.sessionId = null;
    AppState.syncEnabled = false;
}

function startNewSession() {
    // Show the create session modal with empty field
    const sessionNameInput = document.getElementById('sessionNameInput');
    if (sessionNameInput) {
        sessionNameInput.value = '';
    }

    hideSessionsModal();
    showCreateSession();
}

// ============ Join / Create Session ============
async function joinActiveSession() {
    const name = document.getElementById('nameInput').value.trim() || 'Anonymous';
    AppState.userName = name;

    try {
        const res = await fetch('/api/join-session', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name })
        });
        const data = await res.json();

        AppState.projectId = data.project_id;
        AppState.sessionId = data.session_id || data.project_id;
        AppState.currentProject = data.project;

        initSessionUI(data.project);
        loadProjects();

    } catch (e) {
        console.error('Failed to join session:', e);
        alert('Failed to join session');
    }
}

// Project creation modal
let createProjectModal = null;

function showCreateProject() {
    createProjectModal = new Modal({
        title: 'Create New Project',
        content: '<input type="text" id="projectNameInput" placeholder="Project name" class="input-large">',
        footer: `
            <button class="btn btn-ghost" onclick="hideCreateProject()">Cancel</button>
            <button class="btn btn-primary" onclick="createProject()">Create</button>
        `,
        size: 'small',
        onOpen: () => {
            setTimeout(() => document.getElementById('projectNameInput')?.focus(), 50);
        },
        onClose: () => {
            createProjectModal = null;
        }
    });
    createProjectModal.open();
}

function hideCreateProject() {
    if (createProjectModal) {
        createProjectModal.close();
        createProjectModal = null;
    }
}

// Session creation modal
let createSessionModal = null;

function showCreateSession() {
    createSessionModal = new Modal({
        title: 'Create New Session',
        content: '<input type="text" id="sessionNameInput" placeholder="Session name" class="input-large">',
        footer: `
            <button class="btn btn-ghost" onclick="hideCreateSessionModal()">Cancel</button>
            <button class="btn btn-primary" onclick="createSession()">Start Session</button>
        `,
        size: 'small',
        onOpen: () => {
            setTimeout(() => document.getElementById('sessionNameInput')?.focus(), 50);
        },
        onClose: () => {
            createSessionModal = null;
        }
    });
    createSessionModal.open();
}

function hideCreateSessionModal() {
    if (createSessionModal) {
        createSessionModal.close();
        createSessionModal = null;
    }
}

async function createSession() {
    const createBtn = createSessionModal?.getElement()?.querySelector('.btn-primary');

    // Prevent duplicate creation when clicking fast
    if (createBtn && createBtn.disabled) return;

    const sessionName = document.getElementById('sessionNameInput').value.trim();
    const userName = document.getElementById('nameInput')?.value.trim() || AppState.userName || 'Anonymous';

    if (!sessionName) {
        alert('Please enter a session name');
        return;
    }

    // Disable button and show loading state
    if (createBtn) {
        createBtn.disabled = true;
        createBtn.textContent = 'Creating...';
    }

    // Leave current session if already in one
    leaveCurrentSessionSilently();

    AppState.userName = userName;

    try {
        let projectId = AppState.projectId;
        let project = AppState.currentProject;

        // Only create a new project if we're not already in one
        if (!projectId) {
            const res = await authFetch('/api/projects', {
                method: 'POST',
                body: JSON.stringify({ name: sessionName, createdBy: userName })
            });
            const data = await res.json();

            projectId = data.project_id;
            project = data.project;
            AppState.projectId = projectId;
            AppState.currentProject = project;
        }

        // Create a session for the project with the session name
        const sessRes = await authFetch('/api/sessions', {
            method: 'POST',
            body: JSON.stringify({
                project_id: projectId,
                name: userName,
                session_name: sessionName
            })
        });
        const sessData = await sessRes.json();
        AppState.sessionId = sessData.session_id;

        hideCreateSessionModal();
        initSessionUI(project);
        loadProjects();

    } catch (e) {
        console.error('Failed to create session:', e);
        alert('Failed to create session');
    } finally {
        // Re-enable button
        if (createBtn) {
            createBtn.disabled = false;
            createBtn.textContent = 'Create Session';
        }
    }
}

async function createProject() {
    const name = document.getElementById('projectNameInput').value.trim();
    const userName = document.getElementById('nameInput')?.value.trim() || AppState.userName || 'Anonymous';

    if (!name) {
        alert('Please enter a project name');
        return;
    }

    AppState.userName = userName;

    try {
        const res = await authFetch('/api/projects', {
            method: 'POST',
            body: JSON.stringify({ name, createdBy: userName })
        });

        if (!res.ok) {
            const errorData = await res.json().catch(() => ({}));
            throw new Error(errorData.detail || errorData.error || `HTTP ${res.status}`);
        }

        const data = await res.json();

        // Just select the project, don't auto-create session
        AppState.projectId = data.project_id;
        AppState.currentProject = data.project;

        hideCreateProject();
        document.getElementById('projectNameInput').value = ''; // Clear input

        // If we have a session, keep it. Otherwise just load the project
        if (AppState.sessionId) {
            initSessionUI(data.project);
        } else {
            // Hide welcome overlay and load project
            elements.uploadOverlay.classList.add('hidden');
            initSessionUI(data.project);
        }
        loadProjects();

        // Also refresh the projects grid if on Projects tab
        if (typeof loadProjectsGrid === 'function') {
            loadProjectsGrid();
        }

    } catch (e) {
        console.error('Failed to create project:', e);
        alert('Failed to create project');
    }
}

// ============ Load Projects ============
/** The project list changed on the server (new project, access granted or removed, ...). */
async function refreshProjectsList() {
    if (!AppState.authToken) return;
    try {
        const res = await fetch('/api/projects');
        if (!res.ok) return;
        AppState.projects = (await res.json()).projects || [];
        renderProjectsSidebar();
        if (typeof UserManager !== 'undefined' && AppState.projectId) {
            UserManager.setProjectAccessFromList(AppState.projectId);
        }
    } catch (e) {
        console.error('Failed to refresh projects:', e);
    }
}

async function loadProjects() {
    try {
        const res = await authFetch('/api/projects');
        const data = await res.json();
        AppState.projects = data.projects || [];
        renderProjectsSidebar();

        // Show project selection modal if on Review tab with no project selected
        if (!AppState.projectId && AppState.projects.length > 0) {
            const activeTab = AppState.activeTab || 'review';
            if (activeTab === 'review') {
                setTimeout(() => showProjectSelectionModal(), 200);
            }
        }
    } catch (e) {
        console.error('Failed to load projects:', e);
    }
}

async function loadProject(projectId) {
    try {
        // Close existing WebSocket connection if any
        if (AppState.ws) {
            AppState.ws.onclose = null; // Prevent auto-reconnect
            AppState.ws.close();
            AppState.ws = null;
        }

        // Clear session state (we're just viewing, not in a session)
        AppState.sessionId = null;
        updateSessionBadgeState(false);

        const res = await fetch(`/api/projects/${projectId}`);
        const data = await res.json();

        if (data.error) {
            alert('Project not found');
            return;
        }

        AppState.projectId = projectId;
        AppState.currentProject = data;

        // Switch to review tab when loading a project
        if (typeof switchTab === 'function') {
            switchTab('review');
        }

        // What this user may do in the project
        if (typeof UserManager !== 'undefined') {
            UserManager.setProjectAccessFromList(projectId);
        }

        initSessionUI(data);
        loadProjects();

    } catch (e) {
        console.error('Failed to load project:', e);
    }
}

// ============ Session UI ============
function initSessionUI(project) {
    elements.uploadOverlay.classList.add('hidden');

    // Update session badge text (color will be set by WebSocket connection state)
    const badge = document.getElementById('sessionBadge');
    const badgeText = badge.querySelector('.session-badge-text');
    if (badgeText) {
        badgeText.textContent = project.name || `Project: ${AppState.projectId}`;
    }
    // Don't set active here - let WebSocket connection state control it

    // Reset current clip when loading a new project
    AppState.currentClip = null;
    if (typeof HtmlReview !== 'undefined') HtmlReview.unload();

    // Load clips
    if (project.clips) {
        AppState.clips = project.clips;
        renderClipsSidebar();
        renderClipBin();

        // Auto-select first clip if available
        const clipNames = Object.keys(AppState.clips);
        if (clipNames.length > 0) {
            const firstClip = clipNames[0];
            const clipData = AppState.clips[firstClip];
            selectClipVersion(firstClip, clipData.activeVersion || clipData.versions[0].version);
        } else {
            // No clips - show empty state
            showEmptyPlayerState();
        }
    } else {
        AppState.clips = {};
        showEmptyPlayerState();
    }

    // Load comments
    if (project.comments) {
        AppState.comments = project.comments;
        renderComments();
    }

    // Load annotations
    if (project.annotations) {
        project.annotations.forEach(a => {
            if (!AppState.annotations[a.frame]) AppState.annotations[a.frame] = [];
            AppState.annotations[a.frame].push(a);
        });
    }

    elements.video.addEventListener('loadedmetadata', () => {
        resizeCanvasToDisplay();
        updateTimecode();
    });

    // Update canvas size on window resize to maintain proper coordinate mapping
    window.addEventListener('resize', () => {
        resizeCanvasToDisplay();
    });

    // Only connect WebSocket if we have a session
    if (AppState.sessionId) {
        connectWebSocket();
    }

    // Update URL
    history.replaceState(null, '', `?project=${AppState.projectId}`);
}

// ============ Upload with Progress ============
function initUpload() {
    document.getElementById('fileInput').addEventListener('change', handleMultiUpload);
}

function triggerMultiUpload() {
    if (!AppState.projectId) {
        alert('Please join or create a project first');
        return;
    }
    document.getElementById('fileInput').click();
}

async function handleMultiUpload(e) {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    if (!AppState.projectId) {
        alert('Please join or create a project first');
        return;
    }

    // Show upload progress modal
    showUploadProgress();

    // Initialize jobs - all start as "uploading" with 0% progress
    AppState.uploadJobs = Array.from(files).map(f => ({
        filename: f.name,
        file: f,
        status: 'uploading',
        progress: 0,
        jobId: null
    }));
    renderUploadJobs();

    // Upload files using XMLHttpRequest for progress tracking
    const formData = new FormData();
    for (const file of files) {
        formData.append('files', file);
    }

    const xhr = new XMLHttpRequest();

    // Track upload progress
    xhr.upload.onprogress = (event) => {
        if (event.lengthComputable) {
            const percent = Math.round((event.loaded / event.total) * 100);
            // Update all jobs with upload progress (they share the same upload)
            AppState.uploadJobs.forEach(j => {
                if (j.status === 'uploading') {
                    j.progress = percent;
                }
            });
            renderUploadJobs();
        }
    };

    xhr.onload = () => {
        if (xhr.status === 200) {
            try {
                const data = JSON.parse(xhr.responseText);
                console.log('Upload response:', data);
                if (data.jobs && data.jobs.length > 0) {
                    // Map job IDs to our jobs and switch to processing status
                    data.jobs.forEach((job, i) => {
                        if (AppState.uploadJobs[i]) {
                            console.log(`Mapping job ${i}: ${job.job_id} -> ${AppState.uploadJobs[i].filename}`);
                            AppState.uploadJobs[i].jobId = job.job_id;
                            AppState.uploadJobs[i].status = 'processing';
                            AppState.uploadJobs[i].progress = 0; // Reset for processing progress
                        }
                    });
                    renderUploadJobs();

                    // Start polling for processing progress
                    pollTranscodeProgress();
                } else {
                    console.error('No jobs in response:', data);
                    markAllJobsError('No jobs returned');
                }
            } catch (err) {
                console.error('Failed to parse response:', err, xhr.responseText);
                markAllJobsError('Server error');
            }
        } else {
            console.error('Upload failed with status:', xhr.status, xhr.responseText);
            markAllJobsError(`Upload failed (${xhr.status})`);
        }
    };

    xhr.onerror = () => {
        console.error('Upload network error');
        markAllJobsError('Network error');
    };

    xhr.open('POST', `/api/projects/${AppState.projectId}/clips`);
    const uploadToken = getAuthToken();
    if (uploadToken) {
        xhr.setRequestHeader('Authorization', `Bearer ${uploadToken}`);
    }
    xhr.send(formData);

    // Clear input
    e.target.value = '';
}

function markAllJobsError(message) {
    AppState.uploadJobs.forEach(j => {
        j.status = 'error';
        j.error = message;
    });
    renderUploadJobs();
}

function showUploadProgress() {
    document.getElementById('uploadProgressModal').classList.remove('hidden');
    document.getElementById('uploadDoneBtn').disabled = true;
}

function hideUploadProgress() {
    document.getElementById('uploadProgressModal').classList.add('hidden');

    // Refresh clips
    loadProject(AppState.projectId);
}

function renderUploadJobs() {
    const container = document.getElementById('uploadJobsList');
    const summary = document.getElementById('uploadSummary');
    const doneBtn = document.getElementById('uploadDoneBtn');

    container.innerHTML = AppState.uploadJobs.map(job => {
        const statusText = getStatusText(job.status);
        const progressClass = job.status === 'done' ? 'done' : (job.status === 'error' ? 'error' : '');

        return `
            <div class="upload-job-item">
                <div class="upload-job-header">
                    <span class="upload-job-name">${escapeHtml(job.filename)}</span>
                    <span class="upload-job-percent">${job.progress}%</span>
                </div>
                <div class="upload-job-progress">
                    <div class="upload-job-progress-bar ${progressClass}" style="width: ${job.progress}%"></div>
                </div>
                <div class="upload-job-status ${job.status === 'done' ? 'done' : ''} ${job.status === 'error' ? 'error' : ''}" ${job.error ? `title="${escapeHtml(job.error)}"` : ''}>
                    ${job.status === 'done' ? '<svg class="icon icon-sm"><use href="/static/icons.svg#icon-check"/></svg> ' : ''}${statusText}${job.error ? `: ${escapeHtml(job.error.substring(0, 50))}` : ''}
                </div>
            </div>
        `;
    }).join('');

    // Update summary
    const doneCount = AppState.uploadJobs.filter(j => j.status === 'done').length;
    const totalCount = AppState.uploadJobs.length;
    summary.querySelector('.upload-count').textContent = `${doneCount} of ${totalCount} complete`;

    // Enable done button when all complete
    const allDone = AppState.uploadJobs.every(j => j.status === 'done' || j.status === 'error');
    doneBtn.disabled = !allDone;
}

function getStatusText(status) {
    switch (status) {
        case 'waiting': return 'Waiting...';
        case 'queued': return 'Queued...';
        case 'uploading': return 'Uploading...';
        case 'processing': return 'Processing...';
        case 'transcoding': return 'Transcoding...';
        case 'transcoding (pass 1/2)': return 'Analyzing (pass 1/2)...';
        case 'transcoding (pass 2/2)': return 'Encoding (pass 2/2)...';
        case 'generating_thumbnail': return 'Generating thumbnail...';
        case 'done': return 'Done';
        case 'error': return 'Error';
        default: return status;
    }
}

async function pollTranscodeProgress() {
    const activeJobs = AppState.uploadJobs.filter(j => j.jobId && j.status !== 'done' && j.status !== 'error');

    if (activeJobs.length === 0) return;

    const jobIds = activeJobs.map(j => j.jobId).join(',');

    try {
        const res = await fetch(`/api/transcode-status?job_ids=${jobIds}`);
        const data = await res.json();

        if (data.jobs) {
            for (const [jobId, status] of Object.entries(data.jobs)) {
                const job = AppState.uploadJobs.find(j => j.jobId === jobId);
                if (job && status) {
                    job.status = status.status || job.status;
                    job.progress = status.progress || job.progress;
                    // Capture error message if available
                    if (status.error) {
                        job.error = status.error;
                        console.error(`Job ${jobId} error:`, status.error);
                    }
                }
            }
            renderUploadJobs();
        }

        // Continue polling if still processing
        const stillProcessing = AppState.uploadJobs.some(j =>
            j.status !== 'done' && j.status !== 'error'
        );

        if (stillProcessing) {
            setTimeout(pollTranscodeProgress, 1000);
        }
    } catch (e) {
        console.error('Failed to poll status:', e);
        setTimeout(pollTranscodeProgress, 2000);
    }
}

// ============ Video Caching with Progress ============
function clearVideoCache() {
    // Revoke old blob URL to free memory
    if (AppState.videoCache) {
        URL.revokeObjectURL(AppState.videoCache);
        AppState.videoCache = null;
    }
    // Reset cache progress bar
    const cacheBar = document.getElementById('timelineCache');
    if (cacheBar) cacheBar.style.width = '0%';
}

// Track current cache operation
let currentCacheController = null;
let isFetchCaching = false; // Flag to prevent updateCacheBar from overwriting fetch progress

// Show empty player state when no clip is selected
function showEmptyPlayerState() {
    // Clear video source
    elements.video.src = '';
    elements.video.poster = '';

    // Show empty state overlay
    let emptyOverlay = document.getElementById('emptyPlayerOverlay');
    if (!emptyOverlay) {
        emptyOverlay = document.createElement('div');
        emptyOverlay.id = 'emptyPlayerOverlay';
        emptyOverlay.className = 'empty-player-overlay';
        emptyOverlay.innerHTML = `
            <div class="empty-player-content">
                <svg class="icon icon-2xl"><use href="/static/icons.svg#icon-film-strip"/></svg>
                <p>No clip selected</p>
            </div>
        `;
        document.getElementById('videoWrapper').appendChild(emptyOverlay);
    }
    emptyOverlay.classList.add('visible');

    // Clear timeline cache bar
    const cacheBar = document.getElementById('timelineCache');
    if (cacheBar) cacheBar.style.width = '0%';
}

// Hide empty player state when a clip is selected
function hideEmptyPlayerState() {
    const emptyOverlay = document.getElementById('emptyPlayerOverlay');
    if (emptyOverlay) {
        emptyOverlay.classList.remove('visible');
    }
}

async function cacheVideo(url) {
    const cacheBar = document.getElementById('timelineCache');

    // Hide empty player overlay when loading a video
    hideEmptyPlayerState();

    // Cancel any ongoing cache operation
    if (currentCacheController) {
        currentCacheController.abort();
        currentCacheController = null;
    }

    // Clear previous cache
    clearVideoCache();

    // IMMEDIATELY set video src for instant playback
    elements.video.src = url;
    elements.video.load(); // Explicitly trigger loading

    // Wait a moment before starting background cache to avoid connection contention
    // This lets the video element establish its streaming connection first
    await new Promise(resolve => setTimeout(resolve, 500));

    // Start caching in background
    currentCacheController = new AbortController();
    const signal = currentCacheController.signal;
    isFetchCaching = true; // Prevent updateCacheBar from overwriting our progress

    try {
        const response = await fetch(url, { signal });
        const reader = response.body.getReader();
        const contentLength = +response.headers.get('Content-Length');

        let receivedLength = 0;
        const chunks = [];

        while (true) {
            const { done, value } = await reader.read();

            if (done) break;
            if (signal.aborted) {
                isFetchCaching = false;
                return;
            }

            chunks.push(value);
            receivedLength += value.length;

            // Update cache progress bar
            if (contentLength) {
                const percent = (receivedLength / contentLength) * 100;
                cacheBar.style.width = percent + '%';
            }
        }

        // Only swap to cached blob if not aborted
        if (!signal.aborted) {
            const currentTime = elements.video.currentTime;
            const wasPlaying = !elements.video.paused;

            const blob = new Blob(chunks);
            AppState.videoCache = URL.createObjectURL(blob);

            // Wait for blob video to be ready before swapping (prevents blink)
            const onReady = () => {
                elements.video.currentTime = currentTime;
                if (wasPlaying) elements.video.play();
                cacheBar.style.width = '100%';
                isFetchCaching = false;
            };

            elements.video.addEventListener('loadeddata', onReady, { once: true });
            elements.video.src = AppState.videoCache;
        }

    } catch (e) {
        isFetchCaching = false;
        if (e.name === 'AbortError') {
            // Cancelled - ignore
            return;
        }
        console.error('Cache failed:', e);
        cacheBar.style.width = '0%';
    } finally {
        currentCacheController = null;
    }
}

// ============ Utility Functions ============
function formatTimecode(seconds) {
    if (isNaN(seconds) || seconds === 0 && !elements.video?.src) return '--';

    const frame = Math.floor(seconds * AppState.fps);

    // Check if we should show timecode format
    if (AppState.showTimecode) {
        const fps = AppState.fps || 24;
        const totalSeconds = Math.floor(frame / fps);
        const frames = frame % fps;
        const hours = Math.floor(totalSeconds / 3600);
        const minutes = Math.floor((totalSeconds % 3600) / 60);
        const secs = totalSeconds % 60;
        return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}:${String(frames).padStart(2, '0')}`;
    }

    // Default: show frame number
    return frame.toString();
}

function updateTimecodeDisplay() {
    // Re-render timecode in player
    if (typeof updateTimecode === 'function') {
        updateTimecode();
    }
}

function formatFrame(frame) {
    if (frame === null || frame === undefined) return '--';
    return frame.toString();
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function getCurrentFrame() {
    // HTML pages have no timeline; their comments are anchored to elements instead.
    if (AppState.currentMediaType === 'html') return 0;
    return Math.floor(elements.video.currentTime * AppState.fps);
}

function goToFrame(frame) {
    elements.video.currentTime = frame / AppState.fps;
    sendSync();
}

// ============ Parse Clip Filename for Versioning ============
function parseClipFilename(filename) {
    const withoutPrefix = filename.replace(/^[a-f0-9]{8}_/, '');

    const versionPatterns = [
        /^(.+?)_v(\d+)\.(\w+)$/i,
        /^(.+?)_version(\d+)\.(\w+)$/i,
        /^(.+?)[-_](\d+)\.(\w+)$/,
    ];

    for (const pattern of versionPatterns) {
        const match = withoutPrefix.match(pattern);
        if (match) {
            return {
                baseName: match[1],
                version: parseInt(match[2], 10),
                extension: match[3],
                originalFilename: filename
            };
        }
    }

    const extMatch = withoutPrefix.match(/^(.+)\.(\w+)$/);
    if (extMatch) {
        return {
            baseName: extMatch[1],
            version: 1,
            extension: extMatch[2],
            originalFilename: filename
        };
    }

    return {
        baseName: withoutPrefix,
        version: 1,
        extension: 'mp4',
        originalFilename: filename
    };
}

// ============ Projects Sidebar ============
function renderProjectsSidebar() {
    const container = document.getElementById('projectsList');
    const expandBtn = document.getElementById('expandProjectsBtn');
    const sidebar = document.querySelector('.sidebar-left');

    // Update expand button state
    if (expandBtn) {
        expandBtn.classList.toggle('active', AppState.expandedProjectsView);
        expandBtn.innerHTML = AppState.expandedProjectsView
            ? '<svg class="icon"><use href="/static/icons.svg#icon-list"/></svg>'
            : '<svg class="icon"><use href="/static/icons.svg#icon-grid-four"/></svg>';
    }

    // Toggle sidebar expanded class and app grid layout
    if (sidebar) {
        sidebar.classList.toggle('expanded-view', AppState.expandedProjectsView);
    }
    const appContainer = document.querySelector('.app');
    if (appContainer) {
        appContainer.classList.toggle('projects-expanded', AppState.expandedProjectsView);
    }

    // Add project placeholder (shown for users with create permission)
    const addProjectPlaceholder = canCreateProject() ? `
        <div class="project-add" onclick="showCreateProject()">
            <div class="project-add-icon"><svg class="icon icon-lg"><use href="/static/icons.svg#icon-plus"/></svg></div>
            <div class="project-add-text">New project</div>
        </div>
    ` : '';

    // Grid placeholder for grid view
    const addProjectGridPlaceholder = canCreateProject() ? `
        <div class="project-grid-item project-grid-add" onclick="showCreateProject()">
            <div class="project-grid-thumb">
                <span class="project-grid-icon"><svg class="icon icon-xl"><use href="/static/icons.svg#icon-plus"/></svg></span>
            </div>
            <div class="project-grid-info">
                <div class="project-grid-name">New project</div>
                <div class="project-grid-meta">Create new</div>
            </div>
        </div>
    ` : '';

    // Expanded grid view
    if (AppState.expandedProjectsView) {
        // If a project is selected in grid mode, show its clips
        if (AppState.selectedGridProject) {
            renderGridProjectClips();
            return;
        }

        // Otherwise show all projects as grid
        const projectItems = AppState.projects.map(p => {
            const coverStyle = p.coverImage ? `background-image: url('${p.coverImage}')` : '';
            const clipCount = p.clipCount || 0;

            // Action buttons (same as list view)
            const shareBtn = canShareProject() ?
                `<button class="project-grid-action-btn project-grid-share-btn" onclick="event.stopPropagation(); showShareModalForProject('${p.id}')" title="Share project"><svg class="icon"><use href="/static/icons.svg#icon-share"/></svg></button>` : '';
            const coverBtn = `<button class="project-grid-action-btn project-grid-cover-btn" onclick="event.stopPropagation(); triggerCoverUpload('${p.id}')" title="Set cover image"><svg class="icon"><use href="/static/icons.svg#icon-upload"/></svg></button>`;
            const deleteBtn = canDeleteProject() ?
                `<button class="project-grid-action-btn project-grid-delete-btn" onclick="event.stopPropagation(); confirmDeleteProject('${p.id}', '${escapeHtml(p.name).replace(/'/g, "\\'")}')"><svg class="icon"><use href="/static/icons.svg#icon-trash"/></svg></button>` : '';

            return `
                <div class="project-grid-item" data-project="${p.id}" onclick="event.stopPropagation(); selectGridProject('${p.id}')">
                    <div class="project-grid-actions">
                        ${shareBtn}
                        ${coverBtn}
                        ${deleteBtn}
                    </div>
                    <div class="project-grid-thumb ${p.coverImage ? 'has-cover' : ''}" style="${coverStyle}">
                        ${!p.coverImage ? '<span class="project-grid-icon"><svg class="icon icon-xl"><use href="/static/icons.svg#icon-folder"/></svg></span>' : ''}
                    </div>
                    <div class="project-grid-info">
                        <div class="project-grid-name">${escapeHtml(p.name)}</div>
                        <div class="project-grid-meta">${clipCount} clips</div>
                    </div>
                </div>
            `;
        }).join('');

        container.innerHTML = `
            <div class="projects-grid">
                ${addProjectGridPlaceholder}
                ${projectItems}
            </div>
        `;
        return;
    }

    // Normal list view
    const projectItems = AppState.projects.map(p => {
        const isActive = p.id === AppState.projectId;
        const clipCount = p.clipCount || 0;
        const coverStyle = p.coverImage ? `background-image: url('${p.coverImage}')` : '';

        // Show share/delete buttons based on permissions
        const shareBtn = canShareProject() ?
            `<button class="project-share-btn" onclick="event.stopPropagation(); showShareModalForProject('${p.id}')" title="Share project"><svg class="icon"><use href="/static/icons.svg#icon-share"/></svg></button>` : '';
        const deleteBtn = canDeleteProject() ?
            `<button class="project-delete-btn" onclick="event.stopPropagation(); confirmDeleteProject('${p.id}', '${escapeHtml(p.name).replace(/'/g, "\\'")}')"><svg class="icon"><use href="/static/icons.svg#icon-trash"/></svg></button>` : '';

        return `
            <div class="project-item ${isActive ? 'expanded' : ''}" data-project="${p.id}">
                <div class="project-header ${isActive ? 'active' : ''} ${p.coverImage ? 'has-cover' : ''}"
                     style="${coverStyle}"
                     onclick="selectProject('${p.id}')">
                    <span class="project-expand">▶</span>
                    <span class="project-name">${escapeHtml(p.name)}</span>
                    <span class="project-clip-count">${clipCount}</span>
                    ${shareBtn}
                    <button class="project-cover-btn" onclick="event.stopPropagation(); triggerCoverUpload('${p.id}')" title="Set cover image"><svg class="icon"><use href="/static/icons.svg#icon-upload"/></svg></button>
                    ${deleteBtn}
                </div>
                ${isActive && AppState.clips ? renderProjectClips() : ''}
            </div>
        `;
    }).join('');

    container.innerHTML = projectItems + addProjectPlaceholder;
}

function toggleExpandedProjectsView(event) {
    if (event) event.stopPropagation();  // Prevent document click handler from closing
    AppState.expandedProjectsView = !AppState.expandedProjectsView;
    // When expanding, pre-select the currently active project instead of showing root
    AppState.selectedGridProject = AppState.expandedProjectsView ? AppState.projectId : null;
    renderProjectsSidebar();
}

function selectGridProject(projectId) {
    AppState.selectedGridProject = projectId;
    renderProjectsSidebar();
}

function renderGridProjectClips() {
    const container = document.getElementById('projectsList');
    const project = AppState.projects.find(p => p.id === AppState.selectedGridProject);

    if (!project) {
        AppState.selectedGridProject = null;
        renderProjectsSidebar();
        return;
    }

    // Fetch project clips if not already loaded
    fetchProjectClips(AppState.selectedGridProject).then(clips => {
        const clipEntries = Object.entries(clips || {});
        const projectId = AppState.selectedGridProject;

        const clipCards = ClipCard.renderAll(clips || {}, {
            getCardOptions: (baseName, clipData) => ({
                isActive: AppState.currentClip?.baseName === baseName && AppState.projectId === projectId,
                showDelete: canDeleteProject(),
                onDelete: `confirmDeleteClipFromProject('${projectId}', '${ClipCard.escapeHtml(baseName).replace(/'/g, "\\'")}')`,
                onClick: `event.stopPropagation(); selectClipFromGrid('${projectId}', '${baseName}')`
            })
        });

        container.innerHTML = `
            <div class="grid-project-view">
                <div class="grid-project-header">
                    <button class="btn-icon" onclick="event.stopPropagation(); backToProjectsGrid()">←</button>
                    <span class="grid-project-title">${escapeHtml(project.name)}</span>
                </div>
                <div class="clips-grid">
                    ${clipEntries.length === 0 ? '<div class="clips-grid-empty">No clips in this project</div>' : ''}
                    ${clipCards}
                </div>
            </div>
        `;
    });
}

function backToProjectsGrid() {
    AppState.selectedGridProject = null;
    renderProjectsSidebar();
}

// ============ Project Selection Modal ============
let projectSelectionModal = null;

function showProjectSelectionModal() {
    // Don't show if already has a project selected
    if (AppState.projectId) return;

    // Don't show if no projects and no create permission
    if ((!AppState.projects || AppState.projects.length === 0) && !canCreateProject()) return;

    // "New project" placeholder for users with create permission
    const addProjectPlaceholder = canCreateProject() ? `
        <div class="project-selection-item project-selection-add" onclick="showCreateProject(); hideProjectSelectionModal();">
            <div class="project-selection-thumb">
                <span class="project-selection-icon"><svg class="icon icon-xl"><use href="/static/icons.svg#icon-plus"/></svg></span>
            </div>
            <div class="project-selection-info">
                <div class="project-selection-name">New project</div>
                <div class="project-selection-meta">Create new</div>
            </div>
        </div>
    ` : '';

    // Build project grid content
    const projectItems = (AppState.projects || []).map(p => {
        const coverStyle = p.coverImage ? `background-image: url('${p.coverImage}')` : '';
        const clipCount = p.clipCount || 0;

        return `
            <div class="project-selection-item" onclick="selectProjectFromModal('${p.id}')">
                <div class="project-selection-thumb ${p.coverImage ? 'has-cover' : ''}" style="${coverStyle}">
                    ${!p.coverImage ? '<span class="project-selection-icon"><svg class="icon icon-xl"><use href="/static/icons.svg#icon-folder"/></svg></span>' : ''}
                </div>
                <div class="project-selection-info">
                    <div class="project-selection-name">${escapeHtml(p.name)}</div>
                    <div class="project-selection-meta">${clipCount} clips</div>
                </div>
            </div>
        `;
    }).join('');

    const content = `
        <div class="project-selection-grid">
            ${addProjectPlaceholder}
            ${projectItems}
        </div>
    `;

    // Create modal using Modal component
    projectSelectionModal = new Modal({
        title: 'Projects',
        content: content,
        size: 'large',
        closable: false,  // Must select a project
        closeOnOverlay: false,
        closeOnEscape: false
    });

    projectSelectionModal.open();
}

function selectProjectFromModal(projectId) {
    // Close modal
    if (projectSelectionModal) {
        projectSelectionModal.close();
        projectSelectionModal = null;
    }

    // Select the project
    selectProject(projectId);
}

function hideProjectSelectionModal() {
    if (projectSelectionModal) {
        projectSelectionModal.close();
        projectSelectionModal = null;
    }
}

async function fetchProjectClips(projectId) {
    // If this is the current project, we already have the clips
    if (projectId === AppState.projectId && AppState.clips) {
        return AppState.clips;
    }

    // Otherwise fetch from API
    try {
        const res = await fetch(`/api/projects/${projectId}`);
        const data = await res.json();
        return data.clips || {};
    } catch (e) {
        console.error('Failed to fetch project clips:', e);
        return {};
    }
}

async function selectClipFromGrid(projectId, baseName) {
    // First select the project if it's not already selected
    if (projectId !== AppState.projectId) {
        await selectProject(projectId);
    }

    // Then select the clip
    selectClipFromSidebar(baseName);

    // Re-render to update selection state (keep expanded view open)
    renderGridProjectClips();
}

function triggerCoverUpload(projectId) {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.onchange = async (e) => {
        const file = e.target.files[0];
        if (!file) return;

        const formData = new FormData();
        formData.append('file', file);

        try {
            const headers = {};
            if (AppState.authToken) {
                headers['Authorization'] = `Bearer ${AppState.authToken}`;
            }
            const res = await fetch(`/api/projects/${projectId}/cover`, {
                method: 'POST',
                headers,
                body: formData
            });
            const data = await res.json();

            if (data.coverImage) {
                // Update local project data
                const project = AppState.projects.find(p => p.id === projectId);
                if (project) {
                    project.coverImage = data.coverImage;
                }
                if (AppState.currentProject && AppState.currentProject.id === projectId) {
                    AppState.currentProject.coverImage = data.coverImage;
                }
                renderProjectsSidebar();
            }
        } catch (e) {
            console.error('Failed to upload cover:', e);
        }
    };
    input.click();
}

function renderProjectClips() {
    const clipNames = Object.keys(AppState.clips);
    if (clipNames.length === 0) return '';

    return `
        <div class="project-clips">
            ${clipNames.map(baseName => {
                const clipData = AppState.clips[baseName];
                const versionCount = clipData.versions.length;
                const isActive = AppState.currentClip?.baseName === baseName;
                const statusColor = clipData.status?.color || '';
                const iconStyle = statusColor ? `style="color: ${statusColor}"` : '';

                // Icon swap: film-strip normally, trash on hover for admins
                const normalIcon = `<svg class="icon icon-sm"><use href="/static/icons.svg#icon-film-strip"/></svg>`;
                const trashIcon = `<svg class="icon icon-sm"><use href="/static/icons.svg#icon-trash"/></svg>`;

                return `
                    <div class="project-clip-item ${isActive ? 'active' : ''} ${canDeleteProject() ? 'admin-hover' : ''}"
                         onclick="selectClipFromSidebar('${baseName}')">
                        <span class="project-clip-icon" ${iconStyle}>
                            <span class="icon-normal">${normalIcon}</span>
                            ${canDeleteProject() ? `<span class="icon-delete" onclick="event.stopPropagation(); confirmDeleteClip('${escapeHtml(baseName).replace(/'/g, "\\'")}')">${trashIcon}</span>` : ''}
                        </span>
                        <span>${escapeHtml(baseName)}</span>
                        <span class="project-clip-versions">${versionCount} ver${versionCount !== 1 ? 's' : ''}</span>
                    </div>
                `;
            }).join('')}
        </div>
    `;
}

async function selectProject(projectId) {
    if (projectId === AppState.projectId) {
        // Toggle expand
        const item = document.querySelector(`.project-item[data-project="${projectId}"]`);
        item?.classList.toggle('expanded');
        return;
    }

    await loadProject(projectId);
}

function selectClipFromSidebar(baseName) {
    const clipData = AppState.clips[baseName];
    if (!clipData) return;

    selectClipVersion(baseName, clipData.activeVersion);
}

// ============ Quality Control ============
function initQualityControl() {
    const qualitySelect = document.getElementById('qualitySelect');
    if (qualitySelect) {
        qualitySelect.addEventListener('change', (e) => {
            changeQuality(e.target.value, true);
        });
    }
}

function updateQualityDropdown() {
    const qualitySelect = document.getElementById('qualitySelect');
    if (!qualitySelect) return;

    // Get available qualities from current clip
    let availableQualities = [];
    if (AppState.currentClip) {
        const clipData = AppState.clips[AppState.currentClip.baseName];
        if (clipData) {
            const activeVersion = clipData.versions.find(v => v.version === clipData.activeVersion);
            if (activeVersion && activeVersion.proxies) {
                availableQualities = Object.keys(activeVersion.proxies);
            }
        }
    }

    // Update options
    const allQualities = ['720p', '1080p', '4k'];
    qualitySelect.innerHTML = allQualities.map(q => {
        const available = availableQualities.length === 0 || availableQualities.includes(q);
        const label = q === '4k' ? '4K' : q;
        return `<option value="${q}" ${!available ? 'disabled' : ''} ${AppState.currentQuality === q ? 'selected' : ''}>${label}</option>`;
    }).join('');
}

function changeQuality(quality, sendSync = false) {
    if (!AppState.currentClip) return;

    const clipData = AppState.clips[AppState.currentClip.baseName];
    if (!clipData) return;

    const activeVersion = clipData.versions.find(v => v.version === clipData.activeVersion);
    if (!activeVersion || !activeVersion.proxies) return;

    // Check if quality is available
    const proxyFile = activeVersion.proxies[quality];
    if (!proxyFile) {
        console.warn(`Quality ${quality} not available for this clip`);
        return;
    }

    // Remember playback state
    const currentTime = elements.video.currentTime;
    const wasPlaying = !elements.video.paused;

    // Update state
    AppState.currentQuality = quality;

    // Update video source
    cacheVideo(`/video/${proxyFile}`);

    // Restore playback position and state after video loads
    elements.video.addEventListener('loadedmetadata', function onLoad() {
        elements.video.removeEventListener('loadedmetadata', onLoad);
        elements.video.currentTime = currentTime;
        if (wasPlaying) elements.video.play();
    });

    // Update UI
    const qualitySelect = document.getElementById('qualitySelect');
    if (qualitySelect) {
        qualitySelect.value = quality;
    }

    // Sync to other users
    if (sendSync) {
        sendSyncQuality(quality);
    }
}

function sendSyncQuality(quality) {
    if (!AppState.ws || AppState.ws.readyState !== WebSocket.OPEN) return;
    if (!AppState.syncEnabled) return;

    AppState.ws.send(JSON.stringify({
        type: 'sync_quality',
        quality: quality
    }));
}

// Make functions globally accessible
window.selectWelcomeSession = selectWelcomeSession;
window.joinSelectedSession = joinSelectedSession;
window.showCreateProject = showCreateProject;
window.showCreateSession = showCreateSession;
window.hideCreateProject = hideCreateProject;
window.hideCreateSessionModal = hideCreateSessionModal;
window.createProject = createProject;
window.createSession = createSession;
window.triggerMultiUpload = triggerMultiUpload;
window.selectProject = selectProject;
window.selectClipFromSidebar = selectClipFromSidebar;
window.goToFrame = goToFrame;
window.showSessionsModal = showSessionsModal;
window.hideSessionsModal = hideSessionsModal;
window.joinSessionById = joinSessionById;
window.leaveSession = leaveSession;
window.startNewSession = startNewSession;
window.hideUploadProgress = hideUploadProgress;
window.AppState = AppState;
window.elements = elements;
window.resizeCanvasToDisplay = resizeCanvasToDisplay;
window.formatTimecode = formatTimecode;
window.updateTimecodeDisplay = updateTimecodeDisplay;
window.escapeHtml = escapeHtml;
window.getContrastTextColor = getContrastTextColor;
window.getCurrentFrame = getCurrentFrame;
window.parseClipFilename = parseClipFilename;
window.renderProjectsSidebar = renderProjectsSidebar;
window.triggerCoverUpload = triggerCoverUpload;
window.toggleExpandedProjectsView = toggleExpandedProjectsView;
window.selectGridProject = selectGridProject;
window.backToProjectsGrid = backToProjectsGrid;
window.selectClipFromGrid = selectClipFromGrid;
window.showProjectSelectionModal = showProjectSelectionModal;
window.selectProjectFromModal = selectProjectFromModal;
window.hideProjectSelectionModal = hideProjectSelectionModal;
window.cacheVideo = cacheVideo;
window.clearVideoCache = clearVideoCache;
window.isFetchCaching = () => isFetchCaching; // Getter for video-player.js
window.updateQualityDropdown = updateQualityDropdown;
window.changeQuality = changeQuality;
window.sendSyncQuality = sendSyncQuality;
window.confirmDeleteProject = confirmDeleteProject;
window.deleteProject = deleteProject;
window.confirmDeleteClipFromProject = confirmDeleteClipFromProject;
window.deleteClipFromProject = deleteClipFromProject;

// ============ Project Delete ============
async function confirmDeleteProject(projectId, projectName) {
    const confirmed = await Confirm.danger(
        `Er du sikker på at du vil slette prosjektet "${projectName}"?\n\nDette vil slette:\n• Alle klipp og videoer\n• Alle kommentarer og annotasjoner\n• Alle share-lenker\n\nDenne handlingen kan ikke angres!`,
        'Slett prosjekt'
    );

    if (confirmed) {
        deleteProject(projectId);
    }
}

async function deleteProject(projectId) {
    try {
        const response = await fetch(`/api/projects/${projectId}`, {
            method: 'DELETE',
            headers: getAuthHeaders()
        });

        if (!response.ok) {
            const data = await response.json();
            throw new Error(data.detail || 'Failed to delete project');
        }

        const result = await response.json();
        console.log('Project deleted:', result);

        // If we deleted the currently active project, clear state
        if (AppState.projectId === projectId) {
            AppState.projectId = null;
            AppState.clips = {};
            AppState.currentClip = null;
            if (typeof HtmlReview !== 'undefined') HtmlReview.unload();
            if (elements.videoPlayer) {
                elements.videoPlayer.src = '';
            }
        }

        // Refresh projects list
        await loadProjects();

        // Show success toast
        showToast(`Prosjekt slettet. ${result.deletedFiles?.length || 0} filer fjernet.`);
    } catch (error) {
        console.error('Error deleting project:', error);
        alert('Kunne ikke slette prosjektet: ' + error.message);
    }
}

function showToast(message, type = 'success') {
    // Use the new Toast component
    if (typeof Toast !== 'undefined') {
        Toast[type](message);
    } else {
        // Fallback to old toast
        const existing = document.querySelector('.delete-toast');
        if (existing) existing.remove();

        const toast = document.createElement('div');
        toast.className = 'delete-toast';
        toast.textContent = message;
        document.body.appendChild(toast);

        setTimeout(() => toast.classList.add('visible'), 10);
        setTimeout(() => {
            toast.classList.remove('visible');
            setTimeout(() => toast.remove(), 300);
        }, 3000);
    }
}

// ============ Clip Delete from Grid ============
async function confirmDeleteClipFromProject(projectId, baseName) {
    const confirmed = await Confirm.danger(
        `Er du sikker på at du vil slette "${baseName}"?\n\nDette vil slette alle versjoner og tilhørende filer.\n\nDenne handlingen kan ikke angres!`,
        'Slett klipp'
    );

    if (confirmed) {
        deleteClipFromProject(projectId, baseName);
    }
}

async function deleteClipFromProject(projectId, baseName) {
    try {
        const response = await fetch(`/api/projects/${projectId}/clips/${encodeURIComponent(baseName)}`, {
            method: 'DELETE',
            headers: {
                'Authorization': `Bearer ${AppState.authToken}`
            }
        });

        if (!response.ok) {
            const data = await response.json();
            throw new Error(data.detail || 'Kunne ikke slette klipp');
        }

        // If this is the current project, update AppState
        if (projectId === AppState.projectId) {
            delete AppState.clips[baseName];

            // If this was the current clip, clear selection
            if (AppState.currentClip?.baseName === baseName) {
                AppState.currentClip = null;
                if (typeof HtmlReview !== 'undefined') HtmlReview.unload();
                const remainingClips = Object.keys(AppState.clips);
                if (remainingClips.length > 0) {
                    const firstClip = AppState.clips[remainingClips[0]];
                    selectClipVersion(remainingClips[0], firstClip.activeVersion);
                }
            }

            renderClipsSidebar();
            renderClipBin();
        }

        // Refresh grid view
        renderGridProjectClips();

        showToast('Klipp slettet');
    } catch (error) {
        console.error('Error deleting clip:', error);
        alert('Feil ved sletting av klipp: ' + error.message);
    }
}

// ============ Cursor Sharing Control ============
function initCursorControl() {
    const cursorToggle = document.getElementById('cursorToggle');
    if (cursorToggle) {
        cursorToggle.addEventListener('click', toggleCursorSharing);
    }
    updateCursorUI();
}

function toggleCursorSharing() {
    AppState.cursorSharingEnabled = !AppState.cursorSharingEnabled;
    updateCursorUI();

    // Show/hide existing remote cursors
    document.querySelectorAll('.remote-cursor').forEach(cursor => {
        cursor.style.display = AppState.cursorSharingEnabled ? 'block' : 'none';
    });
}

function updateCursorUI() {
    const cursorToggle = document.getElementById('cursorToggle');
    const cursorControl = document.getElementById('cursorControl');
    cursorToggle?.classList.toggle('active', AppState.cursorSharingEnabled);
    cursorControl?.classList.toggle('active', AppState.cursorSharingEnabled);
}

window.initCursorControl = initCursorControl;
window.toggleCursorSharing = toggleCursorSharing;
window.updateCursorUI = updateCursorUI;

// ============ Version Selector in Player Bar ============
// NOTE: Version dropdown is now handled by playerDropdowns.js
// The updateVersionDropdown function is exported from there

// ============ Status Selector in Player Bar ============
function initStatusControl() {
    const statusSelect = document.getElementById('statusSelect');
    if (statusSelect) {
        statusSelect.addEventListener('change', (e) => {
            const statusId = e.target.value;
            if (AppState.currentClip) {
                updateClipStatus(AppState.currentClip.baseName, statusId);
                updateStatusDropdownUI();
            }
        });
    }
}

function updateStatusDropdownUI() {
    const statusSelect = document.getElementById('statusSelect');
    if (!statusSelect) return;

    const statuses = AppState.statuses || [];

    // Build options
    let optionsHtml = '<option value="">No status</option>';
    statuses.forEach(s => {
        optionsHtml += `<option value="${s.id}">${escapeHtml(s.name)}</option>`;
    });
    statusSelect.innerHTML = optionsHtml;

    // Set current value and pill color
    if (AppState.currentClip) {
        const clipData = AppState.clips[AppState.currentClip.baseName];
        if (clipData && clipData.status) {
            statusSelect.value = clipData.status.id;
            statusSelect.style.backgroundColor = clipData.status.color;
            statusSelect.style.color = getContrastTextColor(clipData.status.color);
            statusSelect.classList.add('has-status');
        } else {
            statusSelect.value = '';
            statusSelect.style.backgroundColor = '';
            statusSelect.style.color = '';
            statusSelect.classList.remove('has-status');
        }
    } else {
        statusSelect.value = '';
        statusSelect.style.backgroundColor = '';
        statusSelect.style.color = '';
        statusSelect.classList.remove('has-status');
    }
}

window.initStatusControl = initStatusControl;
window.updateStatusDropdownUI = updateStatusDropdownUI;

// ============ Sync Flash Glow System ============
// Shows a visual flash/toast when other users make changes

let syncToastTimeout = null;

function showSyncFlash(userId, action, targetElement = null) {
    // Get user info
    const user = AppState.users[userId];
    if (!user) return;

    const displayName = user.name || userId.substr(-4);
    const initials = displayName.split(' ').map(n => n[0]).join('').toUpperCase().substr(0, 2) || userId.substr(-2).toUpperCase();

    // Show toast notification
    const toast = document.getElementById('syncToast');
    const toastAvatar = document.getElementById('syncToastAvatar');
    const toastUser = document.getElementById('syncToastUser');
    const toastAction = document.getElementById('syncToastAction');

    if (toast && toastAvatar && toastUser && toastAction) {
        toastAvatar.textContent = initials;
        toastAvatar.style.background = user.color || '#5f5de5';
        toastUser.textContent = displayName;
        toastAction.textContent = action;

        // Show toast
        toast.classList.add('visible');

        // Clear previous timeout
        if (syncToastTimeout) {
            clearTimeout(syncToastTimeout);
        }

        // Hide after 2 seconds
        syncToastTimeout = setTimeout(() => {
            toast.classList.remove('visible');
        }, 2000);
    }

    // Flash the target element if provided
    if (targetElement) {
        triggerElementFlash(targetElement);
    }
}

function triggerElementFlash(element) {
    if (!element) return;

    // Remove class first to allow re-triggering
    element.classList.remove('sync-flash');

    // Force reflow
    void element.offsetWidth;

    // Add class to trigger animation
    element.classList.add('sync-flash');

    // Remove class after animation completes
    setTimeout(() => {
        element.classList.remove('sync-flash');
    }, 800);
}

// Specific flash functions for different sync events
function flashClipChange(baseName) {
    const thumbnail = document.querySelector(`.clip-thumbnail[onclick*="${baseName}"]`);
    if (thumbnail) {
        triggerElementFlash(thumbnail);
    }
}

function flashQualityChange() {
    // Flash the parent container for better visual effect
    const qualityControl = document.getElementById('qualityControl');
    if (qualityControl) {
        triggerElementFlash(qualityControl);
    }
}

function flashVersionChange() {
    // Flash the parent container for better visual effect
    const versionControl = document.getElementById('versionControl');
    if (versionControl) {
        triggerElementFlash(versionControl);
    }
}

function flashSpeedChange() {
    // Flash the parent container for better visual effect
    const speedControl = document.getElementById('speedControl');
    if (speedControl) {
        triggerElementFlash(speedControl);
    }
}

function flashPlaybackSync() {
    // Flash the timeline instead of video wrapper
    const timeline = document.getElementById('timelineTrack');
    if (timeline) {
        triggerElementFlash(timeline);
    }
}

function flashTimelineSeek() {
    const timeline = document.getElementById('timelineTrack');
    if (timeline) {
        triggerElementFlash(timeline);
    }
}

window.showSyncFlash = showSyncFlash;
window.triggerElementFlash = triggerElementFlash;
window.flashClipChange = flashClipChange;
window.flashQualityChange = flashQualityChange;
window.flashVersionChange = flashVersionChange;
window.flashSpeedChange = flashSpeedChange;
window.flashPlaybackSync = flashPlaybackSync;
window.flashTimelineSeek = flashTimelineSeek;

// ============ Panel Toggle System ============

// Check if we're on mobile
function isMobile() {
    return window.innerWidth <= 800;
}

function togglePanel(panel) {
    const app = document.querySelector('.app');
    const btn = document.getElementById(`toggle${panel.charAt(0).toUpperCase() + panel.slice(1)}Btn`);

    // Mobile: Use bottom sheet pattern
    if (isMobile()) {
        toggleMobileSheet(panel);
        return;
    }

    // Desktop: Toggle panel visibility
    app.classList.toggle(`${panel}-hidden`);
    btn?.classList.toggle('active');

    // Collapse expanded projects view when hiding projects panel
    if (panel === 'projects' && app.classList.contains('projects-hidden')) {
        AppState.expandedProjectsView = false;
        AppState.selectedGridProject = null;
        app.classList.remove('projects-expanded');
        document.querySelector('.sidebar-left')?.classList.remove('expanded-view');
        const expandBtn = document.getElementById('expandProjectsBtn');
        if (expandBtn) {
            expandBtn.classList.remove('active');
            expandBtn.innerHTML = '<svg class="icon"><use href="/static/icons.svg#icon-grid-four"/></svg>';
        }
    }
}

// Mobile bottom sheet toggle
function toggleMobileSheet(panel) {
    const overlay = document.getElementById('mobileSheetOverlay');
    const sidebarLeft = document.querySelector('.sidebar-left');
    const sidebarRight = document.querySelector('.sidebar-right');
    const btn = document.getElementById(`toggle${panel.charAt(0).toUpperCase() + panel.slice(1)}Btn`);

    // Determine which sidebar
    let targetSidebar = null;
    if (panel === 'projects') {
        targetSidebar = sidebarLeft;
    } else if (panel === 'comments') {
        targetSidebar = sidebarRight;
    } else if (panel === 'clips') {
        // Clips panel - already visible at bottom on mobile, no toggle needed
        return;
    }

    if (!targetSidebar) return;

    const isOpen = targetSidebar.classList.contains('mobile-open');

    if (isOpen) {
        // Close this sheet
        targetSidebar.classList.remove('mobile-open');
        btn?.classList.remove('active');

        // Hide overlay if no sheets open
        const anyOpen = sidebarLeft?.classList.contains('mobile-open') ||
                        sidebarRight?.classList.contains('mobile-open');
        if (!anyOpen && overlay) {
            overlay.classList.remove('visible');
        }
    } else {
        // Close other sheets first
        sidebarLeft?.classList.remove('mobile-open');
        sidebarRight?.classList.remove('mobile-open');
        document.getElementById('toggleProjectsBtn')?.classList.remove('active');
        document.getElementById('toggleCommentsBtn')?.classList.remove('active');

        // Open this sheet
        targetSidebar.classList.add('mobile-open');
        btn?.classList.add('active');
        overlay?.classList.add('visible');
    }
}

// Close all mobile sheets (called from overlay click)
function closeMobileSheets() {
    const overlay = document.getElementById('mobileSheetOverlay');
    const sidebarLeft = document.querySelector('.sidebar-left');
    const sidebarRight = document.querySelector('.sidebar-right');

    sidebarLeft?.classList.remove('mobile-open');
    sidebarRight?.classList.remove('mobile-open');
    overlay?.classList.remove('visible');

    // Update toggle buttons
    document.getElementById('toggleProjectsBtn')?.classList.remove('active');
    document.getElementById('toggleCommentsBtn')?.classList.remove('active');
}

// Initialize mobile layout
function initMobileLayout() {
    // Handle initial state based on screen size
    handleMobileResize();

    // Listen for window resize
    let resizeTimeout;
    window.addEventListener('resize', () => {
        clearTimeout(resizeTimeout);
        resizeTimeout = setTimeout(handleMobileResize, 100);
    });
}

// Handle resize between mobile/desktop
function handleMobileResize() {
    const wasMobile = AppState._wasMobile;
    const nowMobile = isMobile();

    // Only act on actual breakpoint changes
    if (wasMobile === nowMobile) return;
    AppState._wasMobile = nowMobile;

    const projectsBtn = document.getElementById('toggleProjectsBtn');
    const commentsBtn = document.getElementById('toggleCommentsBtn');
    const clipsBtn = document.getElementById('toggleClipsBtn');
    const sidebarLeft = document.querySelector('.sidebar-left');
    const sidebarRight = document.querySelector('.sidebar-right');

    if (nowMobile) {
        // Switching to mobile: reset panel toggles to not-active (except clips)
        projectsBtn?.classList.remove('active');
        commentsBtn?.classList.remove('active');
        clipsBtn?.classList.add('active');

        // Close any open bottom sheets
        closeMobileSheets();
    } else {
        // Switching to desktop: restore active states and clear mobile classes
        projectsBtn?.classList.add('active');
        commentsBtn?.classList.add('active');
        clipsBtn?.classList.add('active');

        sidebarLeft?.classList.remove('mobile-open');
        sidebarRight?.classList.remove('mobile-open');
        document.getElementById('mobileSheetOverlay')?.classList.remove('visible');
    }
}

window.isMobile = isMobile;
window.togglePanel = togglePanel;
window.toggleMobileSheet = toggleMobileSheet;
window.closeMobileSheets = closeMobileSheets;
window.initMobileLayout = initMobileLayout;
window.handleMobileResize = handleMobileResize;

// ============ Color Palette System ============
AppState.drawColor = '#ff4444'; // Default red

function initColorPalette() {
    const drawBtn = document.getElementById('drawToggleBtn');
    const palette = document.getElementById('colorPalette');

    if (!drawBtn || !palette) return;

    // Show palette on draw button click (toggle both)
    drawBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        palette.classList.toggle('visible');
    });

    // Color swatch selection
    palette.querySelectorAll('.color-swatch').forEach(swatch => {
        swatch.addEventListener('click', (e) => {
            e.stopPropagation();
            const color = swatch.dataset.color;
            AppState.drawColor = color;

            // Update active state
            palette.querySelectorAll('.color-swatch').forEach(s => s.classList.remove('active'));
            swatch.classList.add('active');

        });
    });

    // Close palette when clicking outside
    document.addEventListener('click', (e) => {
        if (!e.target.closest('.draw-tool-wrapper')) {
            palette.classList.remove('visible');
        }
    });
}

// Initialize color palette on DOM ready
document.addEventListener('DOMContentLoaded', initColorPalette);

window.initColorPalette = initColorPalette;

// ============ Share Link System ============

async function handleShareLinkAccess(linkId) {
    // Store link ID (sessionStorage: a reload sends the guest back through the link)
    AppState.currentShareLinkId = linkId;
    try {
        sessionStorage.setItem('shareLinkId', linkId);
    } catch (e) {}

    // Fetch link info
    try {
        const res = await fetch(`/api/share/${linkId}`);
        const data = await res.json();

        if (data.error) {
            // Link not found or expired
            alert(data.error);
            window.location.href = '/';
            return;
        }

        if (data.hasPassword) {
            // Show password modal
            showPasswordModal(data.projectName);
        } else {
            // No password needed - validate and load
            await validateAndLoadShareLink(linkId);
        }
    } catch (e) {
        console.error('Failed to check share link:', e);
        alert('Failed to access share link');
        window.location.href = '/';
    }
}

let passwordModal = null;

function showPasswordModal(projectName) {
    passwordModal = new Modal({
        title: 'Password Required',
        content: `
            <p class="password-project-name" id="passwordProjectName">${escapeHtml(projectName)}</p>
            <p class="password-hint">This project is password protected. Enter the password to continue.</p>
            <input type="password" id="shareLinkPassword" placeholder="Enter password" class="input-large" autocomplete="off">
            <p class="password-error hidden" id="passwordError">Invalid password</p>
        `,
        footer: '<button class="btn btn-primary" id="passwordSubmitBtn" onclick="submitShareLinkPassword()">Access Project</button>',
        size: 'small',
        closable: false,
        closeOnOverlay: false,
        closeOnEscape: false,
        className: 'password-modal',
        onOpen: () => {
            setTimeout(() => {
                const passwordInput = document.getElementById('shareLinkPassword');
                passwordInput?.focus();
                passwordInput?.addEventListener('keydown', (e) => {
                    if (e.key === 'Enter') {
                        submitShareLinkPassword();
                    }
                });
            }, 50);
        },
        onClose: () => {
            passwordModal = null;
        }
    });
    passwordModal.open();
}

function hidePasswordModal() {
    if (passwordModal) {
        passwordModal.close();
        passwordModal = null;
    }
}

async function submitShareLinkPassword() {
    const passwordInput = document.getElementById('shareLinkPassword');
    const errorEl = document.getElementById('passwordError');
    const password = passwordInput?.value || '';

    if (!password) {
        errorEl?.classList.remove('hidden');
        return;
    }

    try {
        const res = await fetch(`/api/share/${AppState.currentShareLinkId}/access`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ password })
        });
        const data = await res.json();

        if (data.valid) {
            setGuestToken(data.guestToken);
            // Success - hide password modal and show name prompt
            hidePasswordModal();
            AppState.pendingShareLinkData = data;
            const projectName = data.project?.name || 'Project';
            showNamePromptModal(projectName);
        } else {
            // Wrong password
            errorEl?.classList.remove('hidden');
            passwordInput.value = '';
            passwordInput.focus();
        }
    } catch (e) {
        console.error('Failed to validate password:', e);
        errorEl?.classList.remove('hidden');
    }
}

async function validateAndLoadShareLink(linkId) {
    try {
        const res = await fetch(`/api/share/${linkId}/access`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({})
        });
        const data = await res.json();

        if (data.valid) {
            setGuestToken(data.guestToken);
            // Store data and show name prompt
            AppState.pendingShareLinkData = data;
            const projectName = data.project?.name || 'Project';
            showNamePromptModal(projectName);
        } else {
            alert(data.error || 'Failed to access project');
            window.location.href = '/';
        }
    } catch (e) {
        console.error('Failed to validate share link:', e);
        alert('Failed to access project');
        window.location.href = '/';
    }
}

async function loadProjectFromShareLink(data) {
    // Set project data
    AppState.projectId = data.projectId;
    AppState.sessionId = data.sessionId || data.projectId;  // Use specific session if provided
    AppState.currentProject = data.project;

    // Mark as share link guest - restricted to this project only
    AppState.isShareLinkGuest = true;
    AppState.shareLinkedProjectId = data.projectId;

    // Hide welcome overlay
    elements.uploadOverlay.classList.add('hidden');

    // Guests come for the review; a fresh browser would otherwise open on the projects tab
    if (typeof switchTab === 'function') switchTab('review');

    // Hide projects sidebar for guests (they can only access their shared project)
    document.querySelector('.app')?.classList.add('projects-hidden');
    document.getElementById('toggleProjectsBtn')?.classList.add('hidden');

    // Hide user menu for guests (no settings access)
    document.getElementById('userMenuBtn')?.classList.add('hidden');

    // Update URL to project URL (cleaner)
    history.replaceState(null, '', `?project=${data.projectId}`);

    // Load project data
    const project = data.project;

    // Update session badge text (color will be set by WebSocket connection state)
    const badge = document.getElementById('sessionBadge');
    const badgeText = badge?.querySelector('.session-badge-text');
    if (badgeText) {
        badgeText.textContent = project.name || `Project: ${AppState.projectId}`;
    }
    // Don't set active here - let WebSocket connection state control it

    // Load clips
    if (project.clips) {
        AppState.clips = project.clips;
        renderClipsSidebar();
        renderClipBin();

        if (project.video) {
            cacheVideo(`/video/${project.video}`);
        }
    }

    // Load comments
    if (project.comments) {
        AppState.comments = project.comments;
        renderComments();
    }

    // Load annotations
    if (project.annotations) {
        project.annotations.forEach(a => {
            if (!AppState.annotations[a.frame]) AppState.annotations[a.frame] = [];
            AppState.annotations[a.frame].push(a);
        });
    }

    // Load projects list
    await loadProjects();

    // Connect to WebSocket
    connectWebSocket();
}

// ============ Share Modal Functions ============

function showShareModal() {
    if (!AppState.projectId) {
        alert('Please select a project first');
        return;
    }

    const modal = document.getElementById('shareModal');
    modal.classList.remove('hidden');

    // Reset form
    document.getElementById('sharePasswordToggle').checked = false;
    document.getElementById('sharePasswordInputWrapper').classList.add('hidden');
    document.getElementById('sharePasswordInput').value = '';
    document.getElementById('shareResult').classList.add('hidden');
    document.getElementById('shareCopied').classList.add('hidden');

    // Load existing links
    loadExistingShareLinks();
}

function hideShareModal() {
    document.getElementById('shareModal').classList.add('hidden');
}

function toggleSharePassword() {
    const checked = document.getElementById('sharePasswordToggle').checked;
    const wrapper = document.getElementById('sharePasswordInputWrapper');
    wrapper.classList.toggle('hidden', !checked);
}

async function createShareLink() {
    const usePassword = document.getElementById('sharePasswordToggle').checked;
    const password = usePassword ? document.getElementById('sharePasswordInput').value : null;
    const expiryDays = document.getElementById('shareExpirySelect').value;

    if (usePassword && !password) {
        alert('Please enter a password');
        return;
    }

    // Calculate expiry date
    let expiresAt = null;
    if (expiryDays) {
        const expiry = new Date();
        expiry.setDate(expiry.getDate() + parseInt(expiryDays));
        expiresAt = expiry.toISOString();
    }

    try {
        const res = await authFetch(`/api/projects/${AppState.projectId}/share`, {
            method: 'POST',
            body: JSON.stringify({
                password,
                createdBy: AppState.userName,
                expiresAt
            })
        });
        const data = await res.json();

        if (data.link) {
            // Show result
            const fullUrl = window.location.origin + data.url;
            document.getElementById('shareLinkUrl').value = fullUrl;
            document.getElementById('shareResult').classList.remove('hidden');
            document.getElementById('shareCopied').classList.add('hidden');

            // Reset form
            document.getElementById('sharePasswordToggle').checked = false;
            document.getElementById('sharePasswordInputWrapper').classList.add('hidden');
            document.getElementById('sharePasswordInput').value = '';
            document.getElementById('shareExpirySelect').value = '7';

            // Reload links list
            loadExistingShareLinks();
        }
    } catch (e) {
        console.error('Failed to create share link:', e);
        alert('Failed to create share link');
    }
}

function copyShareLink() {
    const input = document.getElementById('shareLinkUrl');
    input.select();
    document.execCommand('copy');

    // Show copied message
    document.getElementById('shareCopied').classList.remove('hidden');
    setTimeout(() => {
        document.getElementById('shareCopied').classList.add('hidden');
    }, 2000);
}

function copyLinkToClipboard(url) {
    navigator.clipboard.writeText(url).then(() => {
        // Show a brief toast or visual feedback
        const toast = document.createElement('div');
        toast.className = 'copy-toast';
        toast.textContent = 'Copied!';
        document.body.appendChild(toast);
        setTimeout(() => toast.remove(), 1500);
    }).catch(err => {
        console.error('Failed to copy:', err);
        // Fallback
        const input = document.createElement('input');
        input.value = url;
        document.body.appendChild(input);
        input.select();
        document.execCommand('copy');
        document.body.removeChild(input);
    });
}

async function loadExistingShareLinks() {
    const container = document.getElementById('shareLinksList');

    try {
        const res = await authFetch(`/api/projects/${AppState.projectId}/share`);
        const data = await res.json();

        if (data.links && data.links.length > 0) {
            container.innerHTML = data.links.map(link => {
                const isExpired = link.expiresAt && new Date(link.expiresAt) < new Date();
                const expiryText = formatExpiry(link.expiresAt);
                return `
                    <div class="share-link-item ${!link.isActive || isExpired ? 'inactive' : ''}">
                        <div class="share-link-info">
                            <span class="share-link-url">/s/${link.id.substr(0, 8)}...</span>
                            <span class="share-link-meta">
                                ${link.hasPassword ? '<span class="share-link-badge protected"><svg class="icon icon-xs"><use href="/static/icons.svg#icon-lock"/></svg> Protected</span>' : ''}
                                <span>${link.accessCount} views</span>
                                ${expiryText ? `<span class="share-link-expiry ${isExpired ? 'expired' : ''}">${expiryText}</span>` : ''}
                            </span>
                        </div>
                        <button class="btn btn-ghost btn-small" onclick="deleteShareLink('${link.id}')" title="Delete link"><svg class="icon"><use href="/static/icons.svg#icon-trash"/></svg></button>
                    </div>
                `;
            }).join('');
        } else {
            container.innerHTML = '<div class="share-links-empty">No links created yet</div>';
        }
    } catch (e) {
        console.error('Failed to load share links:', e);
        container.innerHTML = '<div class="share-links-empty">Failed to load links</div>';
    }
}

function formatExpiry(expiresAt) {
    if (!expiresAt) return null;

    const expiry = new Date(expiresAt);
    const now = new Date();
    const diffMs = expiry - now;
    const diffDays = Math.ceil(diffMs / (1000 * 60 * 60 * 24));

    if (diffMs < 0) {
        return 'Expired';
    } else if (diffDays === 0) {
        return 'Expires today';
    } else if (diffDays === 1) {
        return 'Expires tomorrow';
    } else if (diffDays <= 7) {
        return `${diffDays}d left`;
    } else {
        return `Expires ${expiry.toLocaleDateString()}`;
    }
}

async function deleteShareLink(linkId) {
    const confirmed = await Confirm.danger('Delete this share link? This cannot be undone.', 'Delete');
    if (!confirmed) return;

    try {
        const res = await authFetch(`/api/share/${linkId}`, { method: 'DELETE' });
        if (res.ok) {
            loadExistingShareLinks();
            loadSettingsShareLinks();
            Toast.success('Share link deleted');
        } else {
            console.error('Failed to delete share link');
        }
    } catch (e) {
        console.error('Failed to delete share link:', e);
    }
}

// Export share link functions
window.handleShareLinkAccess = handleShareLinkAccess;
window.showPasswordModal = showPasswordModal;
window.submitShareLinkPassword = submitShareLinkPassword;
window.showShareModal = showShareModal;
window.hideShareModal = hideShareModal;
window.toggleSharePassword = toggleSharePassword;
window.createShareLink = createShareLink;
window.copyShareLink = copyShareLink;
window.copyLinkToClipboard = copyLinkToClipboard;
window.deleteShareLink = deleteShareLink;

// ============ Settings Panel ============

function showSettingsPanel(initialTab = 'profile') {
    // Block guests from opening settings
    if (AppState.isShareLinkGuest) {
        return;
    }

    const modal = document.getElementById('settingsModal');
    modal.classList.remove('hidden');

    // Show/hide admin-only tabs based on admin status
    const usersTab = document.querySelector('.settings-tab[data-settings-tab="users"]');
    if (usersTab) {
        usersTab.style.display = AppState.isAdmin ? 'block' : 'none';
    }

    // Initialize tab switching
    initSettingsTabs();

    // Switch to initial tab
    switchSettingsTab(initialTab);

    // Update profile info
    updateSettingsProfileUI();

    // Load data for current tab
    loadSettingsTabData(initialTab);
}

function hideSettingsPanel() {
    document.getElementById('settingsModal').classList.add('hidden');
}

function initSettingsTabs() {
    const tabs = document.querySelectorAll('.settings-tab');
    tabs.forEach(tab => {
        tab.onclick = () => switchSettingsTab(tab.dataset.settingsTab);
    });
}

function switchSettingsTab(tabName) {
    // Update tab active states
    document.querySelectorAll('.settings-tab').forEach(tab => {
        tab.classList.toggle('active', tab.dataset.settingsTab === tabName);
    });

    // Update content visibility
    document.querySelectorAll('.settings-tab-content').forEach(content => {
        content.classList.remove('active');
    });

    const tabContent = document.getElementById(`settingsTab${tabName.charAt(0).toUpperCase() + tabName.slice(1)}`);
    if (tabContent) {
        tabContent.classList.add('active');
    }

    // Load data for the tab
    loadSettingsTabData(tabName);
}

function loadSettingsTabData(tabName) {
    switch (tabName) {
        case 'profile':
            updateSettingsProfileUI();
            break;
        case 'users':
            loadSettingsUsers();
            loadSettingsGuests();
            loadInviteLinks();
            loadProjectsForInvite();
            updateInviteAccessVisibility();
            break;
        case 'sharing':
            loadSettingsShareLinks();
            break;
        case 'settings':
            loadStatuses();
            break;
    }
}

// Users and guests lists live in features/usersAdmin.js

function formatRelativeTime(dateStr) {
    if (!dateStr) return 'unknown';
    const date = new Date(dateStr);
    const now = new Date();
    const diffMs = now - date;
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);

    if (diffMins < 1) return 'just now';
    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    if (diffDays === 1) return 'yesterday';
    if (diffDays < 7) return `${diffDays}d ago`;
    return date.toLocaleDateString();
}

function updateSettingsProfileUI() {
    const usernameEl = document.getElementById('profileUsername');
    const roleEl = document.getElementById('profileRole');

    if (AppState.adminUser) {
        if (usernameEl) usernameEl.textContent = AppState.adminUser.username;
        if (roleEl) roleEl.textContent = AppState.isAdmin ? 'Administrator' : 'User';
        updateProfilePictureUI();
    }
}

function updateProfilePictureUI() {
    const preview = document.getElementById('profilePicturePreview');
    const initials = document.getElementById('profileInitials');
    const deleteBtn = document.getElementById('deleteProfileBtn');

    if (!preview || !AppState.adminUser) return;

    const profileImage = AppState.adminUser.profileImage;
    const username = AppState.adminUser.username || 'User';

    if (profileImage) {
        // Show profile image
        preview.innerHTML = `<img src="${profileImage}" alt="Profile">`;
        if (deleteBtn) deleteBtn.style.display = 'inline-flex';
    } else {
        // Show initials
        const userInitials = username.split(' ').map(n => n[0]).join('').toUpperCase().substr(0, 2) || 'U';
        preview.innerHTML = `<span class="profile-initials">${userInitials}</span>`;
        if (deleteBtn) deleteBtn.style.display = 'none';
    }
}

async function uploadProfileImage(input) {
    if (!input.files || !input.files[0]) return;

    const file = input.files[0];
    const formData = new FormData();
    formData.append('file', file);

    try {
        // Use fetch directly with only Authorization header (no Content-Type for FormData)
        const headers = {};
        if (AppState.authToken) {
            headers['Authorization'] = `Bearer ${AppState.authToken}`;
        }

        const res = await fetch('/api/users/me/profile-image', {
            method: 'POST',
            headers,
            body: formData
        });

        if (!res.ok) {
            const error = await res.json().catch(() => ({ detail: 'Failed to upload profile image' }));
            alert(typeof error.detail === 'string' ? error.detail : 'Failed to upload profile image');
            return;
        }

        const data = await res.json();

        // Update AppState with new profile image
        if (AppState.adminUser) {
            AppState.adminUser.profileImage = data.profileImage;
            saveAuthToStorage();
        }

        // Update UI
        updateProfilePictureUI();

        // Update avatar in header if function exists
        if (typeof renderCurrentUserAvatar === 'function') {
            renderCurrentUserAvatar();
        }
    } catch (e) {
        console.error('Profile image upload failed:', e);
        alert('Failed to upload profile image');
    }

    // Clear input
    input.value = '';
}

async function deleteProfileImage() {
    const confirmed = await Confirm.show({
        title: 'Remove Profile Picture',
        message: 'Remove your profile picture?',
        confirmText: 'Remove',
        type: 'warning'
    });
    if (!confirmed) return;

    try {
        const res = await authFetch('/api/users/me/profile-image', {
            method: 'DELETE'
        });

        if (!res.ok) {
            Toast.error('Failed to delete profile image');
            return;
        }

        // Update AppState
        if (AppState.adminUser) {
            AppState.adminUser.profileImage = null;
            saveAuthToStorage();
        }

        // Update UI
        updateProfilePictureUI();

        // Update avatar in header
        if (typeof renderCurrentUserAvatar === 'function') {
            renderCurrentUserAvatar();
        }
    } catch (e) {
        console.error('Profile image delete failed:', e);
        alert('Failed to delete profile image');
    }
}

// ============ Theme Functions ============
function setTheme(theme) {
    // Store current theme
    localStorage.setItem('theme', theme);

    // Apply theme to document
    if (theme === 'custom') {
        // Load custom colors
        const customColors = JSON.parse(localStorage.getItem('customTheme') || '{}');
        applyCustomTheme(customColors);
        document.documentElement.setAttribute('data-theme', 'custom');

        // Show custom options
        const customOptions = document.getElementById('themeCustomOptions');
        if (customOptions) customOptions.classList.remove('hidden');
    } else {
        // Apply dark or light theme
        document.documentElement.setAttribute('data-theme', theme);

        // Hide custom options
        const customOptions = document.getElementById('themeCustomOptions');
        if (customOptions) customOptions.classList.add('hidden');

        // Remove any custom CSS properties
        document.documentElement.style.removeProperty('--bg-dark');
        document.documentElement.style.removeProperty('--bg-panel');
        document.documentElement.style.removeProperty('--accent');
        document.documentElement.style.removeProperty('--text');
    }

    // Update radio button
    const radio = document.querySelector(`input[name="theme"][value="${theme}"]`);
    if (radio) radio.checked = true;
}

function applyCustomTheme(colors) {
    if (colors.background) {
        document.documentElement.style.setProperty('--bg-dark', colors.background);
    }
    if (colors.panels) {
        document.documentElement.style.setProperty('--bg-panel', colors.panels);
        document.documentElement.style.setProperty('--bg-secondary', colors.panels);
    }
    if (colors.accent) {
        document.documentElement.style.setProperty('--accent', colors.accent);
        document.documentElement.style.setProperty('--accent-hover', adjustColor(colors.accent, 20));
        document.documentElement.style.setProperty('--accent-bg', colors.accent + '1a');
    }
    if (colors.text) {
        document.documentElement.style.setProperty('--text', colors.text);
    }
}

function updateCustomTheme() {
    const bgColor = document.getElementById('customBgColor')?.value || '#0f0c14';
    const panelsColor = document.getElementById('customPanelsColor')?.value || '#1e1a2e';
    const accentColor = document.getElementById('customAccentColor')?.value || '#5f5de5';
    const textColor = document.getElementById('customTextColor')?.value || '#f0ebd8';

    const customColors = {
        background: bgColor,
        panels: panelsColor,
        accent: accentColor,
        text: textColor
    };

    localStorage.setItem('customTheme', JSON.stringify(customColors));
    applyCustomTheme(customColors);
}

function resetCustomTheme() {
    const defaults = {
        background: '#0f0c14',
        panels: '#1e1a2e',
        accent: '#5f5de5',
        text: '#f0ebd8'
    };

    // Update color pickers
    const bgPicker = document.getElementById('customBgColor');
    const panelsPicker = document.getElementById('customPanelsColor');
    const accentPicker = document.getElementById('customAccentColor');
    const textPicker = document.getElementById('customTextColor');

    if (bgPicker) bgPicker.value = defaults.background;
    if (panelsPicker) panelsPicker.value = defaults.panels;
    if (accentPicker) accentPicker.value = defaults.accent;
    if (textPicker) textPicker.value = defaults.text;

    localStorage.setItem('customTheme', JSON.stringify(defaults));
    applyCustomTheme(defaults);
}

function adjustColor(hex, percent) {
    // Lighten or darken a hex color
    const num = parseInt(hex.replace('#', ''), 16);
    const amt = Math.round(2.55 * percent);
    const R = Math.min(255, Math.max(0, (num >> 16) + amt));
    const G = Math.min(255, Math.max(0, ((num >> 8) & 0x00FF) + amt));
    const B = Math.min(255, Math.max(0, (num & 0x0000FF) + amt));
    return '#' + (0x1000000 + R * 0x10000 + G * 0x100 + B).toString(16).slice(1);
}

function initTheme() {
    const savedTheme = localStorage.getItem('theme') || 'dark';
    setTheme(savedTheme);

    // Load custom colors into pickers if available
    const customColors = JSON.parse(localStorage.getItem('customTheme') || '{}');
    const bgPicker = document.getElementById('customBgColor');
    const panelsPicker = document.getElementById('customPanelsColor');
    const accentPicker = document.getElementById('customAccentColor');
    const textPicker = document.getElementById('customTextColor');

    if (bgPicker) bgPicker.value = customColors.background || '#0f0c14';
    if (panelsPicker) panelsPicker.value = customColors.panels || '#1e1a2e';
    if (accentPicker) accentPicker.value = customColors.accent || '#5f5de5';
    if (textPicker) textPicker.value = customColors.text || '#f0ebd8';
}

async function loadSettingsShareLinks() {
    const container = document.getElementById('settingsShareLinks');

    try {
        const res = await authFetch('/api/share/all');
        const data = await res.json();

        if (data.projects && data.projects.length > 0) {
            container.innerHTML = data.projects.map(project => `
                <div class="share-links-project">
                    <div class="share-links-project-header">${escapeHtml(project.projectName)}</div>
                    <div class="share-links-project-links">
                        ${project.links.map(link => {
                            const fullUrl = window.location.origin + '/s/' + link.id;
                            const isExpired = link.expiresAt && new Date(link.expiresAt) < new Date();
                            const expiryText = formatExpiry(link.expiresAt);
                            return `
                                <div class="share-link-item ${!link.isActive || isExpired ? 'inactive' : ''}">
                                    <div class="share-link-info">
                                        <span class="share-link-url">/s/${link.id.substring(0, 8)}...</span>
                                        <span class="share-link-meta">
                                            ${link.hasPassword ? '<span class="share-link-badge protected"><svg class="icon icon-xs"><use href="/static/icons.svg#icon-lock"/></svg> Protected</span>' : ''}
                                            <span>${link.accessCount} views</span>
                                            ${expiryText ? `<span class="share-link-expiry ${isExpired ? 'expired' : ''}">${expiryText}</span>` : ''}
                                        </span>
                                    </div>
                                    <div class="share-link-actions">
                                        <button class="btn btn-ghost btn-small" onclick="copyLinkToClipboard('${fullUrl}')" title="Copy link"><svg class="icon"><use href="/static/icons.svg#icon-copy"/></svg></button>
                                        <button class="btn btn-ghost btn-small" onclick="deleteShareLink('${link.id}')" title="Delete link"><svg class="icon"><use href="/static/icons.svg#icon-trash"/></svg></button>
                                    </div>
                                </div>
                            `;
                        }).join('')}
                    </div>
                </div>
            `).join('');
        } else {
            container.innerHTML = '<div class="share-links-empty">No share links</div>';
        }
    } catch (e) {
        console.error('Failed to load share links:', e);
        container.innerHTML = '<div class="share-links-empty">Failed to load</div>';
    }
}

function updateSettingsOnlineUsers() {
    const container = document.getElementById('settingsOnlineUsers');
    const usersList = Object.values(AppState.users);

    if (usersList.length === 0) {
        container.innerHTML = '<div class="online-users-empty">No users online</div>';
        return;
    }

    container.innerHTML = usersList.map(user => `
        <div class="online-user-item">
            <div class="online-user-avatar" style="background: ${user.color || '#5f5de5'}">
                ${(user.name || 'U').substring(0, 2).toUpperCase()}
            </div>
            <span class="online-user-name">${escapeHtml(user.name || 'Anonymous')}</span>
        </div>
    `).join('');
}

// ============ Clip Statuses ============

async function loadStatuses() {
    try {
        const { data, error } = await API.getStatuses();
        if (error) {
            console.error('Failed to load statuses:', error);
            return;
        }
        AppState.statuses = data?.statuses || [];
        renderStatusList();

        // Re-render clip bin to show status dropdowns (in case clips loaded before statuses)
        if (typeof renderClipBin === 'function' && Object.keys(AppState.clips).length > 0) {
            renderClipBin();
        }

        // Also update player status dropdown
        if (typeof updateStatusDropdownUI === 'function') {
            updateStatusDropdownUI();
        }
    } catch (err) {
        console.error('Failed to load statuses:', err);
    }
}

function renderStatusList() {
    const container = document.getElementById('settingsStatusList');
    if (!container) return;

    if (AppState.statuses.length === 0) {
        container.innerHTML = '<div class="status-list-empty">No statuses defined</div>';
        return;
    }

    container.innerHTML = AppState.statuses.map(status => `
        <div class="status-item" data-status-id="${status.id}">
            <div class="status-color-dot" style="background: ${status.color}"></div>
            <span class="status-name">${escapeHtml(status.name)}</span>
            <button class="status-delete" onclick="deleteStatus('${status.id}')" title="Delete status">×</button>
        </div>
    `).join('');
}

async function addStatus() {
    const nameInput = document.getElementById('newStatusName');
    const colorInput = document.getElementById('newStatusColor');

    const name = nameInput.value.trim();
    const color = colorInput.value;

    if (!name) {
        nameInput.focus();
        return;
    }

    try {
        const res = await authFetch('/api/statuses', {
            method: 'POST',
            body: JSON.stringify({ name, color })
        });

        if (res.ok) {
            const data = await res.json();
            AppState.statuses.push(data.status);
            renderStatusList();
            nameInput.value = '';
            colorInput.value = '#6366f1';

            // Re-render clip bin to update dropdowns
            if (typeof renderClipBin === 'function') {
                renderClipBin();
            }
        } else {
            const error = await res.json();
            alert(error.detail || 'Failed to create status');
        }
    } catch (err) {
        console.error('Failed to add status:', err);
        alert('Failed to create status');
    }
}

async function deleteStatus(statusId) {
    const confirmed = await Confirm.danger(
        'Delete this status? Clips with this status will become unmarked.',
        'Delete'
    );
    if (!confirmed) return;

    try {
        const res = await authFetch(`/api/statuses/${statusId}`, {
            method: 'DELETE'
        });

        if (res.ok) {
            AppState.statuses = AppState.statuses.filter(s => s.id !== statusId);
            renderStatusList();

            // Remove status from clips in memory
            Object.values(AppState.clips).forEach(clip => {
                if (clip.status && clip.status.id === statusId) {
                    delete clip.status;
                }
            });

            // Re-render clip bin
            if (typeof renderClipBin === 'function') {
                renderClipBin();
            }
            Toast.success('Status deleted');
        } else {
            Toast.error('Failed to delete status');
        }
    } catch (err) {
        console.error('Failed to delete status:', err);
        alert('Failed to delete status');
    }
}

async function updateClipStatus(baseName, statusId) {
    if (!AppState.projectId) return;

    try {
        const res = await fetch(`/api/projects/${AppState.projectId}/clips/${encodeURIComponent(baseName)}/status`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ statusId: statusId || null })
        });

        if (res.ok) {
            // Update local state
            if (AppState.clips[baseName]) {
                if (statusId) {
                    const status = AppState.statuses.find(s => s.id === statusId);
                    if (status) {
                        AppState.clips[baseName].status = status;
                    }
                } else {
                    delete AppState.clips[baseName].status;
                }
            }

            // Re-render clip bin to show updated status
            if (typeof renderClipBin === 'function') {
                renderClipBin();
            }

            // Update status dropdown in player bar
            updateStatusDropdownUI();
        }
    } catch (err) {
        console.error('Failed to update clip status:', err);
    }
}

async function updateClipStatusInGrid(projectId, baseName, statusId) {
    if (!projectId) return;

    try {
        const res = await fetch(`/api/projects/${projectId}/clips/${encodeURIComponent(baseName)}/status`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ statusId: statusId || null })
        });

        if (res.ok) {
            // If this is the current project, update local state too
            if (projectId === AppState.projectId && AppState.clips[baseName]) {
                if (statusId) {
                    const status = AppState.statuses.find(s => s.id === statusId);
                    if (status) {
                        AppState.clips[baseName].status = status;
                    }
                } else {
                    delete AppState.clips[baseName].status;
                }
                // Re-render clip bin
                if (typeof renderClipBin === 'function') {
                    renderClipBin();
                }
            }

            // Re-render grid view to show updated status
            renderGridProjectClips();
        }
    } catch (err) {
        console.error('Failed to update clip status in grid:', err);
    }
}

// Make status functions globally accessible
window.loadStatuses = loadStatuses;
window.addStatus = addStatus;
window.deleteStatus = deleteStatus;
window.updateClipStatus = updateClipStatus;
window.updateClipStatusInGrid = updateClipStatusInGrid;

// ============ Name Prompt for Share Links ============

let namePromptModal = null;

function showNamePromptModal(projectName) {
    namePromptModal = new Modal({
        title: 'Join Project',
        content: `
            <p class="name-prompt-project" id="namePromptProject">${escapeHtml(projectName || 'Project')}</p>
            <div class="share-name-section">
                <label class="share-section-label">Your name</label>
                <input type="text" id="shareNameInput" placeholder="Enter your name" class="input-large" autocomplete="off">
            </div>
            <div class="share-name-section">
                <label class="share-section-label">Email <span class="label-optional">(optional)</span></label>
                <input type="email" id="shareEmailInput" placeholder="name@example.com" class="input-large" autocomplete="email">
            </div>
            <div class="register-error hidden" id="shareNameError"></div>
            <button class="btn btn-primary btn-large" style="width: 100%; margin-top: 16px;" onclick="submitShareLinkName()">Join</button>
        `,
        size: 'small',
        closable: false,
        closeOnOverlay: false,
        closeOnEscape: false,
        className: 'name-prompt-modal',
        onOpen: () => {
            setTimeout(() => {
                const nameInput = document.getElementById('shareNameInput');
                nameInput?.focus();
                [nameInput, document.getElementById('shareEmailInput')].forEach(input => {
                    input?.addEventListener('keydown', (e) => {
                        if (e.key === 'Enter') {
                            submitShareLinkName();
                        }
                    });
                });
            }, 50);
        },
        onClose: () => {
            namePromptModal = null;
        }
    });
    namePromptModal.open();
}

async function loadShareProjectSessions() {
    const container = document.getElementById('shareSessionsList');
    const projectId = AppState.pendingShareLinkData?.projectId;

    if (!projectId) {
        container.innerHTML = '<div class="share-sessions-empty">No sessions available</div>';
        return;
    }

    try {
        const res = await fetch(`/api/projects/${projectId}/sessions`);
        const data = await res.json();

        if (data.sessions && data.sessions.length > 0) {
            container.innerHTML = data.sessions.map(sess => {
                // Use session_name if available
                const displayName = sess.session_name || `Session by ${sess.startedBy || 'Unknown'}`;
                return `
                    <div class="share-session-item ${selectedShareSession === sess.id ? 'selected' : ''}"
                         onclick="selectShareSession('${sess.id}')">
                        <div class="share-session-info">
                            <span class="share-session-name">${escapeHtml(displayName)}</span>
                            <span class="share-session-users">${sess.user_count} user${sess.user_count !== 1 ? 's' : ''}</span>
                        </div>
                        <button class="btn btn-primary btn-small" onclick="event.stopPropagation(); joinShareSession('${sess.id}')">Join</button>
                    </div>
                `;
            }).join('');
        } else {
            container.innerHTML = '<div class="share-sessions-empty">No active sessions</div>';
        }
    } catch (e) {
        console.error('Failed to load project sessions:', e);
        container.innerHTML = '<div class="share-sessions-empty">Failed to load sessions</div>';
    }
}

function selectShareSession(sessionId) {
    selectedShareSession = sessionId;
    // Update visual selection
    document.querySelectorAll('.share-session-item').forEach(item => {
        item.classList.remove('selected');
    });
    event.currentTarget.classList.add('selected');
}

async function joinShareSession(sessionId) {
    const nameInput = document.getElementById('shareNameInput');
    const name = nameInput.value.trim() || 'Anonymous';

    if (!name) {
        alert('Please enter your name');
        nameInput.focus();
        return;
    }

    AppState.userName = name;

    // Set the session ID
    if (AppState.pendingShareLinkData) {
        AppState.pendingShareLinkData.sessionId = sessionId;
    }

    // Hide modal and load project with specific session
    hideNamePromptModal();

    if (AppState.pendingShareLinkData) {
        await loadProjectFromShareLink(AppState.pendingShareLinkData);
        AppState.pendingShareLinkData = null;
    }
}

async function createSessionForSharedProject() {
    const nameInput = document.getElementById('shareNameInput');
    const name = nameInput.value.trim() || 'Anonymous';

    if (!name) {
        alert('Please enter your name');
        nameInput.focus();
        return;
    }

    // Leave current session if already in one
    leaveCurrentSessionSilently();

    AppState.userName = name;

    const projectId = AppState.pendingShareLinkData?.projectId;
    if (!projectId) return;

    // Generate session name based on project name and time
    const projectName = AppState.pendingShareLinkData?.projectName || 'Shared Project';
    const timeStr = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const sessionName = `${projectName} - ${timeStr}`;

    try {
        // Create a new session for this project
        const res = await fetch('/api/sessions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                project_id: projectId,
                name: name,
                session_name: sessionName
            })
        });
        const data = await res.json();

        if (data.session_id) {
            AppState.pendingShareLinkData.sessionId = data.session_id;
        }

        hideNamePromptModal();

        if (AppState.pendingShareLinkData) {
            await loadProjectFromShareLink(AppState.pendingShareLinkData);
            AppState.pendingShareLinkData = null;
        }
    } catch (e) {
        console.error('Failed to create session:', e);
        alert('Failed to create session');
    }
}

function hideNamePromptModal() {
    if (namePromptModal) {
        namePromptModal.close();
        namePromptModal = null;
    }
}

const EMAIL_PATTERN = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

// Join project with name from share link
async function submitShareLinkName() {
    const nameInput = document.getElementById('shareNameInput');
    const name = nameInput.value.trim() || 'Anonymous';
    const email = (document.getElementById('shareEmailInput')?.value || '').trim();
    if (email && !EMAIL_PATTERN.test(email)) {
        const errorEl = document.getElementById('shareNameError');
        errorEl.textContent = "That doesn't look like an email address";
        errorEl.classList.remove('hidden');
        return;
    }

    AppState.userName = name;
    hideNamePromptModal();

    if (AppState.pendingShareLinkData) {
        // Track guest in database
        const projectId = AppState.pendingShareLinkData.projectId;
        const shareLinkId = AppState.currentShareLinkId;
        API.trackGuest(name, projectId, shareLinkId, email).catch(e => {
            console.error('Failed to track guest:', e);
        });

        await loadProjectFromShareLink(AppState.pendingShareLinkData);
        AppState.pendingShareLinkData = null;
    }
}

// ============ Main Login (from login overlay) ============
async function mainLogin() {
    const username = document.getElementById('loginUsername').value.trim();
    const password = document.getElementById('loginPassword').value;
    const errorEl = document.getElementById('loginError');

    if (!username || !password) {
        errorEl.classList.remove('hidden');
        errorEl.textContent = 'Please enter username and password';
        return;
    }

    try {
        const res = await fetch('/api/auth/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password })
        });
        const data = await res.json();

        if (data.valid) {
            Auth.start(data);
            await Auth.refresh(); // permissions

            // Hide both overlays - admin goes straight to app
            document.getElementById('loginOverlay').classList.add('hidden');
            document.getElementById('uploadOverlay').classList.add('hidden');
            errorEl.classList.add('hidden');

            // Clear form
            document.getElementById('loginUsername').value = '';
            document.getElementById('loginPassword').value = '';

            // Load projects in sidebar
            loadProjects();

            // Update user display in header
            if (typeof updateUserDisplay === 'function') {
                updateUserDisplay();
            }

            // Update settings UI (if function exists)
            if (typeof updateSettingsAuthUI === 'function') {
                updateSettingsAuthUI();
            }
        } else {
            errorEl.classList.remove('hidden');
            errorEl.textContent = data.error || 'Invalid credentials';
        }
    } catch (e) {
        console.error('Login failed:', e);
        errorEl.classList.remove('hidden');
        errorEl.textContent = 'Login failed. Please try again.';
    }
}

// Export settings functions
window.showSettingsPanel = showSettingsPanel;
window.hideSettingsPanel = hideSettingsPanel;
window.switchSettingsTab = switchSettingsTab;
window.mainLogin = mainLogin;
window.showNamePromptModal = showNamePromptModal;
window.hideNamePromptModal = hideNamePromptModal;
window.submitShareLinkName = submitShareLinkName;
window.selectShareSession = selectShareSession;
window.joinShareSession = joinShareSession;
window.createSessionForSharedProject = createSessionForSharedProject;
window.uploadProfileImage = uploadProfileImage;
window.deleteProfileImage = deleteProfileImage;

// ============ Share Modal for Specific Project ============

function showShareModalForProject(projectId) {
    // Store current project to restore after
    const currentProjectId = AppState.projectId;

    // Temporarily set project ID for share modal
    AppState.projectId = projectId;

    showShareModal();

    // The modal will use AppState.projectId for API calls
}

window.showShareModalForProject = showShareModalForProject;

// ============ Invite Links System ============

// Store invite ID for registration
let pendingInviteId = null;

async function loadInviteLinks() {
    const container = document.getElementById('inviteLinksList');
    if (!container) return;

    try {
        const res = await authFetch('/api/admin/invites');
        const data = await res.json();

        if (data.invites && data.invites.length > 0) {
            container.innerHTML = data.invites.map(invite => {
                const url = `${window.location.origin}/invite/${invite.id}`;
                const usesText = invite.maxUses === 0
                    ? `${invite.uses} uses`
                    : `${invite.uses}/${invite.maxUses} uses`;

                // Role badge with pill styling
                const role = invite.role || (invite.isAdmin ? 'admin' : 'viewer');
                const roleBadge = `<span class="invite-link-role-badge ${role}">${role.charAt(0).toUpperCase() + role.slice(1)}</span>`;

                // Project info if linked
                const projectInfo = invite.projectName
                    ? `<span class="invite-link-project">${escapeHtml(invite.projectName)}</span>`
                    : '';

                // Access info for viewers with pill styling
                let accessInfo = '';
                if (role === 'viewer') {
                    accessInfo = `
                        <div class="invite-link-access">
                            <span class="invite-link-access-pill ${invite.canReview ? 'active' : ''}">
                                <svg class="icon"><use href="/static/icons.svg#icon-eye"/></svg>
                                Review
                            </span>
                            <span class="invite-link-access-pill ${invite.canTasks ? 'active' : ''}">
                                <svg class="icon"><use href="/static/icons.svg#icon-check"/></svg>
                                Tasks
                            </span>
                        </div>
                    `;
                }

                return `
                    <div class="invite-link-item">
                        <div class="invite-link-info">
                            <span class="invite-link-url">${url}</span>
                            <div class="invite-link-meta">
                                ${roleBadge}
                                ${projectInfo}
                                ${accessInfo}
                                <span class="invite-link-uses">${usesText}</span>
                            </div>
                        </div>
                        <div class="invite-link-actions">
                            <button class="btn btn-ghost btn-small" onclick="copyInviteLink('${invite.id}')" title="Copy link">
                                <svg class="icon icon-sm"><use href="/static/icons.svg#icon-link"/></svg>
                            </button>
                            <button class="btn btn-ghost btn-small" onclick="deleteInviteLink('${invite.id}')" title="Delete">
                                <svg class="icon icon-sm"><use href="/static/icons.svg#icon-trash"/></svg>
                            </button>
                        </div>
                    </div>
                `;
            }).join('');
        } else {
            container.innerHTML = '<div class="invite-links-empty">No invite links</div>';
        }
    } catch (e) {
        console.error('Failed to load invite links:', e);
        container.innerHTML = '<div class="invite-links-empty">Failed to load invite links</div>';
    }
}

async function createInviteLink() {
    const roleSelect = document.getElementById('inviteRole');
    const projectSelect = document.getElementById('inviteProject');
    const canReviewCheckbox = document.getElementById('inviteCanReview');
    const canTasksCheckbox = document.getElementById('inviteCanTasks');
    const maxUsesSelect = document.getElementById('inviteMaxUses');

    // Get values (with fallbacks for elements that might not exist yet)
    const role = roleSelect ? roleSelect.value : 'viewer';
    const projectId = projectSelect ? projectSelect.value : '';
    const canReview = canReviewCheckbox ? canReviewCheckbox.checked : true;
    const canTasks = canTasksCheckbox ? canTasksCheckbox.checked : false;
    const maxUses = maxUsesSelect ? parseInt(maxUsesSelect.value, 10) : 1;

    // Legacy support: check old isAdmin checkbox if role select doesn't exist
    const isAdminCheckbox = document.getElementById('inviteIsAdmin');
    const isAdmin = role === 'admin' || (isAdminCheckbox ? isAdminCheckbox.checked : false);

    try {
        const payload = {
            role: role,
            maxUses: maxUses
        };

        // Only include project-related fields if a project is selected
        if (projectId) {
            payload.projectId = projectId;
            payload.canReview = canReview;
            payload.canTasks = canTasks;
        }

        const res = await authFetch('/api/admin/invites', {
            method: 'POST',
            body: JSON.stringify(payload)
        });

        if (res.ok) {
            const data = await res.json();
            // Copy the link to clipboard
            const url = `${window.location.origin}/invite/${data.invite.id}`;
            await navigator.clipboard.writeText(url);
            alert('Invite link created and copied to clipboard!');

            // Reset form
            if (roleSelect) roleSelect.value = 'viewer';
            if (projectSelect) projectSelect.value = '';
            if (canReviewCheckbox) canReviewCheckbox.checked = true;
            if (canTasksCheckbox) canTasksCheckbox.checked = false;
            if (maxUsesSelect) maxUsesSelect.value = '1';
            if (isAdminCheckbox) isAdminCheckbox.checked = false;

            // Update visibility of access options
            updateInviteAccessVisibility();

            // Reload list
            loadInviteLinks();
        } else {
            const error = await res.json();
            alert(error.detail || 'Failed to create invite link');
        }
    } catch (e) {
        console.error('Failed to create invite link:', e);
        alert('Failed to create invite link');
    }
}

// Update visibility of access checkboxes based on role selection
function updateInviteAccessVisibility() {
    const roleSelect = document.getElementById('inviteRole');
    const accessOptions = document.getElementById('inviteAccessOptions');

    if (!roleSelect || !accessOptions) return;

    const role = roleSelect.value;
    // Only show access options for viewers
    if (role === 'viewer') {
        accessOptions.classList.remove('hidden');
    } else {
        accessOptions.classList.add('hidden');
    }
}

// Load projects for invite dropdown
async function loadProjectsForInvite() {
    const projectSelect = document.getElementById('inviteProject');
    if (!projectSelect) return;

    try {
        const res = await authFetch('/api/projects');
        const data = await res.json();

        if (data.projects && data.projects.length > 0) {
            projectSelect.innerHTML = '<option value="">No specific project</option>' +
                data.projects.map(p =>
                    `<option value="${p.id}">${escapeHtml(p.name)}</option>`
                ).join('');
        }
    } catch (e) {
        console.error('Failed to load projects for invite:', e);
    }
}

async function copyInviteLink(inviteId) {
    const url = `${window.location.origin}/invite/${inviteId}`;
    try {
        await navigator.clipboard.writeText(url);
        Toast.success('Invite link copied to clipboard!');
    } catch (e) {
        console.error('Failed to copy:', e);
        // Fallback
        prompt('Copy this link:', url);
    }
}

async function deleteInviteLink(inviteId) {
    const confirmed = await Confirm.danger('Delete this invite link?', 'Delete');
    if (!confirmed) return;

    try {
        const res = await authFetch(`/api/admin/invites/${inviteId}`, {
            method: 'DELETE'
        });

        if (res.ok) {
            loadInviteLinks();
            Toast.success('Invite link deleted');
        } else {
            const error = await res.json();
            Toast.error(error.detail || 'Failed to delete invite link');
        }
    } catch (e) {
        console.error('Failed to delete invite link:', e);
        Toast.error('Failed to delete invite link');
    }
}

// Check for invite link in URL on page load
async function checkInviteLink() {
    const path = window.location.pathname;
    if (path.startsWith('/invite/')) {
        const inviteId = path.split('/invite/')[1];
        if (inviteId) {
            await showRegistrationModal(inviteId);
        }
    }
}

let registerModal = null;

async function showRegistrationModal(inviteId) {
    // Validate the invite first
    try {
        const res = await fetch(`/api/invite/${inviteId}`);
        if (!res.ok) {
            const error = await res.json();
            alert(error.detail || 'Invalid or expired invite link');
            window.location.href = '/';
            return;
        }

        // Store invite ID and show modal
        pendingInviteId = inviteId;

        // Hide other overlays
        document.getElementById('loginOverlay').classList.add('hidden');
        document.getElementById('uploadOverlay').classList.add('hidden');

        // Show registration modal
        registerModal = new Modal({
            title: 'Create Account',
            content: `
                <p class="register-description">You've been invited to join Cutline. Create your account to get started.</p>
                <div class="register-form">
                    <div class="form-group">
                        <label class="form-label">Username</label>
                        <input type="text" id="registerUsername" placeholder="Choose a username" class="input-large" autocomplete="off">
                    </div>
                    <div class="form-group">
                        <label class="form-label">Email <span class="label-optional">(optional)</span></label>
                        <input type="email" id="registerEmail" placeholder="name@example.com" class="input-large" autocomplete="email">
                    </div>
                    <div class="form-group">
                        <label class="form-label">Password</label>
                        <input type="password" id="registerPassword" placeholder="At least 12 characters" class="input-large">
                    </div>
                    <div class="form-group">
                        <label class="form-label">Confirm Password</label>
                        <input type="password" id="registerPasswordConfirm" placeholder="Confirm your password" class="input-large">
                    </div>
                    <div class="register-error hidden" id="registerError"></div>
                    <button class="btn btn-primary btn-large" onclick="submitRegistration()">Create Account</button>
                </div>
            `,
            size: 'small',
            closable: false,
            closeOnOverlay: false,
            closeOnEscape: false,
            className: 'register-modal',
            onOpen: () => {
                setTimeout(() => document.getElementById('registerUsername')?.focus(), 50);
            },
            onClose: () => {
                registerModal = null;
            }
        });
        registerModal.open();
    } catch (e) {
        console.error('Failed to validate invite:', e);
        alert('Failed to validate invite link');
        window.location.href = '/';
    }
}

function hideRegisterModal() {
    if (registerModal) {
        registerModal.close();
        registerModal = null;
    }
}

async function submitRegistration() {
    const username = document.getElementById('registerUsername').value.trim();
    const email = document.getElementById('registerEmail').value.trim();
    const password = document.getElementById('registerPassword').value;
    const passwordConfirm = document.getElementById('registerPasswordConfirm').value;
    const errorDiv = document.getElementById('registerError');

    // Clear previous errors
    errorDiv.classList.add('hidden');
    errorDiv.textContent = '';

    // Validation
    if (!username) {
        errorDiv.textContent = 'Please enter a username';
        errorDiv.classList.remove('hidden');
        return;
    }

    if (username.length < 3) {
        errorDiv.textContent = 'Username must be at least 3 characters';
        errorDiv.classList.remove('hidden');
        return;
    }

    if (!password) {
        errorDiv.textContent = 'Please enter a password';
        errorDiv.classList.remove('hidden');
        return;
    }

    if (password.length < 12) {
        errorDiv.textContent = 'Password must be at least 12 characters';
        errorDiv.classList.remove('hidden');
        return;
    }

    if (password !== passwordConfirm) {
        errorDiv.textContent = 'Passwords do not match';
        errorDiv.classList.remove('hidden');
        return;
    }

    if (email && !EMAIL_PATTERN.test(email)) {
        errorDiv.textContent = "That doesn't look like an email address";
        errorDiv.classList.remove('hidden');
        return;
    }

    try {
        const res = await fetch(`/api/auth/register/${pendingInviteId}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password, email })
        });

        const data = await res.json();

        if (res.ok && data.success) {
            Auth.start(data);

            // Hide modal and redirect
            hideRegisterModal();

            // Redirect to home without the invite path
            window.location.href = '/';
        } else {
            errorDiv.textContent = data.detail || 'Registration failed';
            errorDiv.classList.remove('hidden');
        }
    } catch (e) {
        console.error('Registration failed:', e);
        errorDiv.textContent = 'Registration failed. Please try again.';
        errorDiv.classList.remove('hidden');
    }
}

// Make functions globally available
window.createInviteLink = createInviteLink;
window.copyInviteLink = copyInviteLink;
window.deleteInviteLink = deleteInviteLink;
window.submitRegistration = submitRegistration;
window.loadInviteLinks = loadInviteLinks;
window.checkInviteLink = checkInviteLink;

// ============ Setup Wizard ============

async function checkSetupRequired() {
    try {
        const res = await fetch('/api/setup/status');
        const data = await res.json();
        return data.needsSetup === true;
    } catch (e) {
        console.error('Failed to check setup status:', e);
        return false;
    }
}

async function completeSetup() {
    const username = document.getElementById('setupUsername').value.trim();
    const password = document.getElementById('setupPassword').value;
    const passwordConfirm = document.getElementById('setupPasswordConfirm').value;
    const errorDiv = document.getElementById('setupError');

    // Clear previous errors
    errorDiv.classList.add('hidden');

    // Validation
    if (!username) {
        errorDiv.textContent = 'Please enter a username';
        errorDiv.classList.remove('hidden');
        return;
    }

    if (username.length < 3) {
        errorDiv.textContent = 'Username must be at least 3 characters';
        errorDiv.classList.remove('hidden');
        return;
    }

    if (!password) {
        errorDiv.textContent = 'Please enter a password';
        errorDiv.classList.remove('hidden');
        return;
    }

    if (password.length < 12) {
        errorDiv.textContent = 'Password must be at least 12 characters';
        errorDiv.classList.remove('hidden');
        return;
    }

    if (password !== passwordConfirm) {
        errorDiv.textContent = 'Passwords do not match';
        errorDiv.classList.remove('hidden');
        return;
    }

    try {
        const res = await fetch('/api/setup/complete', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password })
        });

        const data = await res.json();

        if (res.ok && data.success) {
            Auth.start(data);

            // Reload the page to start fresh with the new account
            window.location.reload();
        } else {
            errorDiv.textContent = data.detail || 'Setup failed';
            errorDiv.classList.remove('hidden');
        }
    } catch (e) {
        console.error('Setup failed:', e);
        errorDiv.textContent = 'Setup failed. Please try again.';
        errorDiv.classList.remove('hidden');
    }
}

window.completeSetup = completeSetup;

// ============ Notifications System ============

let notificationsPanelOpen = false;

async function loadNotifications() {
    if (!AppState.authToken || AppState.isShareLinkGuest) return;

    try {
        const res = await fetch('/api/notifications', {
            headers: { 'Authorization': `Bearer ${AppState.authToken}` }
        });
        const data = await res.json();

        AppState.notifications = data.notifications || [];
        AppState.unreadNotificationCount = data.unreadCount || 0;

        updateNotificationsBadge();
        renderNotificationsList();
    } catch (e) {
        console.error('Failed to load notifications:', e);
    }
}

function updateNotificationsBadge() {
    const badge = document.getElementById('notificationsBadge');
    if (!badge) return;

    const count = AppState.unreadNotificationCount || 0;
    badge.textContent = count > 99 ? '99+' : count;
    badge.classList.toggle('hidden', count === 0);
}

function renderNotificationsList() {
    const container = document.getElementById('notificationsList');
    if (!container) return;

    const notifications = AppState.notifications || [];

    if (notifications.length === 0) {
        container.innerHTML = '<div class="notifications-empty">No notifications</div>';
        return;
    }

    container.innerHTML = notifications.map(n => `
        <div class="notification-item ${n.isRead ? '' : 'unread'}" data-notification-id="${n.id}">
            <div class="notification-icon">
                <svg class="icon"><use href="/static/icons.svg#icon-bell"/></svg>
            </div>
            <div class="notification-content">
                <div class="notification-title">${escapeHtml(n.title)}</div>
                <div class="notification-time">${formatRelativeTime(n.createdAt)}</div>
            </div>
        </div>
    `).join('');

    // Bind click handlers
    container.querySelectorAll('.notification-item').forEach(item => {
        item.addEventListener('click', () => {
            handleNotificationClick(item.dataset.notificationId);
        });
    });
}

function openNotificationsPanel() {
    // Close other dropdowns first
    Dropdown.closeAll();
    DatePicker.closeAll();

    const panel = document.getElementById('notificationsPanel');
    if (!panel) return;

    notificationsPanelOpen = true;
    panel.classList.remove('hidden');

    // Animate in
    requestAnimationFrame(() => {
        panel.classList.add('notifications-panel-visible');
    });

    loadNotifications();

    // Close handlers
    setTimeout(() => {
        document.addEventListener('click', closeNotificationsPanelOnClickOutside);
        document.addEventListener('keydown', closeNotificationsPanelOnEscape);
    }, 10);
}

function closeNotificationsPanel() {
    const panel = document.getElementById('notificationsPanel');
    if (!panel || !notificationsPanelOpen) return;

    panel.classList.remove('notifications-panel-visible');

    setTimeout(() => {
        panel.classList.add('hidden');
    }, 150);

    notificationsPanelOpen = false;
    document.removeEventListener('click', closeNotificationsPanelOnClickOutside);
    document.removeEventListener('keydown', closeNotificationsPanelOnEscape);
}

function toggleNotificationsPanel() {
    if (notificationsPanelOpen) {
        closeNotificationsPanel();
    } else {
        openNotificationsPanel();
    }
}

function closeNotificationsPanelOnClickOutside(e) {
    const menu = document.getElementById('notificationsMenu');
    if (menu && !menu.contains(e.target)) {
        closeNotificationsPanel();
    }
}

function closeNotificationsPanelOnEscape(e) {
    if (e.key === 'Escape') {
        closeNotificationsPanel();
    }
}

async function handleNotificationClick(notificationId) {
    // Mark as read
    try {
        await fetch(`/api/notifications/${notificationId}/read`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${AppState.authToken}` }
        });

        // Update local state
        const notification = AppState.notifications?.find(n => n.id === notificationId);
        if (notification && !notification.isRead) {
            notification.isRead = true;
            AppState.unreadNotificationCount = Math.max(0, (AppState.unreadNotificationCount || 0) - 1);
            updateNotificationsBadge();
            renderNotificationsList();
        }
    } catch (e) {
        console.error('Failed to mark notification as read:', e);
    }
}

async function markAllNotificationsRead() {
    try {
        await fetch('/api/notifications/read-all', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${AppState.authToken}` }
        });

        // Update local state
        AppState.notifications?.forEach(n => n.isRead = true);
        AppState.unreadNotificationCount = 0;
        updateNotificationsBadge();
        renderNotificationsList();
    } catch (e) {
        console.error('Failed to mark all as read:', e);
    }
}

// Handle incoming notification via WebSocket
function handleNewNotification(notification) {
    // Add to front of list
    AppState.notifications = [notification, ...(AppState.notifications || [])];
    AppState.unreadNotificationCount = (AppState.unreadNotificationCount || 0) + 1;

    updateNotificationsBadge();
    if (notificationsPanelOpen) {
        renderNotificationsList();
    }
}

// Notifications are loaded when the live connection comes up (core/live.js)
// and new ones arrive over it.

window.toggleNotificationsPanel = toggleNotificationsPanel;
window.closeNotificationsPanel = closeNotificationsPanel;
window.handleNotificationClick = handleNotificationClick;
window.markAllNotificationsRead = markAllNotificationsRead;
window.loadNotifications = loadNotifications;
window.handleNewNotification = handleNewNotification;

// ============ Compare Mode ============
function toggleCompareMode() {
    const clipData = AppState.clips[AppState.currentClip?.baseName];
    if (!clipData || clipData.versions.length < 2) {
        return;
    }

    AppState.compareMode = !AppState.compareMode;

    if (AppState.compareMode) {
        showCompareUI();
        // Default to previous version
        const currentVersion = clipData.activeVersion;
        const otherVersions = clipData.versions.filter(v => v.version !== currentVersion);
        if (otherVersions.length > 0) {
            // Select closest lower version, or first available
            const prevVersion = otherVersions.find(v => v.version < currentVersion) || otherVersions[0];
            selectCompareVersion(prevVersion.version);
        }
    } else {
        hideCompareUI();
    }

    updateCompareButton();
    sendSyncCompare();
}

function updateCompareDropdown() {
    // Update the compare version dropdown UI
    if (typeof updateCompareVersionDropdownUI === 'function') {
        updateCompareVersionDropdownUI();
    }
}

function updateCompareButton() {
    const btn = document.getElementById('compareBtn');
    const control = document.getElementById('compareControl');
    const clipData = AppState.clips[AppState.currentClip?.baseName];

    if (btn) {
        btn.classList.toggle('active', AppState.compareMode);
    }

    // Hide if only one version
    if (control && clipData) {
        control.classList.toggle('single-version', clipData.versions.length < 2);
    }
}

function selectCompareVersion(version) {
    const baseName = AppState.currentClip?.baseName;
    const clipData = AppState.clips[baseName];
    if (!clipData) return;

    const compareClip = clipData.versions.find(v => v.version === parseInt(version));
    if (!compareClip) return;

    AppState.compareVersion = parseInt(version);

    const mediaType = compareClip.mediaType || 'video';

    if (mediaType === 'image') {
        loadCompareImage(`/video/${compareClip.filename}`);
    } else {
        // Use same quality as main video
        let videoFile = compareClip.filename;
        if (compareClip.proxies && compareClip.proxies[AppState.currentQuality]) {
            videoFile = compareClip.proxies[AppState.currentQuality];
        } else if (compareClip.proxies) {
            // Use first available proxy
            const availableQualities = Object.keys(compareClip.proxies);
            if (availableQualities.length > 0) {
                videoFile = compareClip.proxies[availableQualities[0]];
            }
        }
        loadCompareVideo(`/video/${videoFile}`);
    }

    // Update labels (OLD/compare on LEFT, NEW/current on RIGHT)
    const leftLabel = document.getElementById('wipeLabelLeft');
    const rightLabel = document.getElementById('wipeLabelRight');
    if (leftLabel) leftLabel.textContent = `v${formatVersion(version)}`;
    if (rightLabel) rightLabel.textContent = `v${formatVersion(clipData.activeVersion)}`;

    // Update dropdown selection
    updateCompareDropdown();

    sendSyncCompare();
}

// Cache for compare video blob URL
let _compareVideoCache = null;
let _compareVideoCacheSrc = null;

async function loadCompareVideo(src) {
    const compareVideo = document.getElementById('videoCompare');
    const compareImage = document.getElementById('stillImageCompare');
    const mainVideo = document.getElementById('video');

    if (compareImage) compareImage.style.display = 'none';
    if (!compareVideo || !mainVideo) return;

    // Store current playback state
    const wasPlaying = !mainVideo.paused;
    const targetTime = mainVideo.currentTime;

    compareVideo.muted = true;
    compareVideo.style.display = 'block';

    // Check if we already have this video cached
    if (_compareVideoCacheSrc === src && _compareVideoCache) {
        compareVideo.src = _compareVideoCache;
        compareVideo.currentTime = targetTime;
        if (wasPlaying) {
            compareVideo.play().catch(() => {});
        }
        return;
    }

    // Revoke old cache if different source
    if (_compareVideoCache && _compareVideoCacheSrc !== src) {
        URL.revokeObjectURL(_compareVideoCache);
        _compareVideoCache = null;
    }

    // Fetch video as blob for better seeking (same as main video)
    try {
        console.log(`[COMPARE] Fetching as blob: ${src}`);
        const response = await fetch(src);
        const blob = await response.blob();
        _compareVideoCache = URL.createObjectURL(blob);
        _compareVideoCacheSrc = src;

        compareVideo.src = _compareVideoCache;

        compareVideo.oncanplay = () => {
            compareVideo.oncanplay = null;
            compareVideo.currentTime = targetTime;
            if (wasPlaying) {
                mainVideo.pause();
                setTimeout(() => {
                    mainVideo.currentTime = targetTime;
                    compareVideo.currentTime = targetTime;
                    mainVideo.play().catch(() => {});
                    compareVideo.play().catch(() => {});
                }, 50);
            }
        };

        compareVideo.load();
    } catch (e) {
        console.error('[COMPARE] Failed to load as blob, falling back to direct URL:', e);
        compareVideo.src = src;
        compareVideo.load();
    }
}

function loadCompareImage(src) {
    const compareVideo = document.getElementById('videoCompare');
    const compareImage = document.getElementById('stillImageCompare');

    if (compareVideo) {
        compareVideo.pause();
        compareVideo.style.display = 'none';
    }
    if (compareImage) {
        compareImage.src = src;
        compareImage.style.display = 'block';
    }
}

function showCompareUI() {
    const wipeOverlay = document.getElementById('wipeOverlay');
    const compareTrigger = document.getElementById('compareVersionTrigger');

    if (wipeOverlay) wipeOverlay.style.display = 'block';
    if (compareTrigger) compareTrigger.classList.add('visible');

    updateCompareDropdown();
    initWipeDrag();
    updateWipePosition(AppState.wipePosition);
}

function hideCompareUI() {
    const wipeOverlay = document.getElementById('wipeOverlay');
    const compareTrigger = document.getElementById('compareVersionTrigger');
    const compareVideo = document.getElementById('videoCompare');
    const compareImage = document.getElementById('stillImageCompare');

    if (wipeOverlay) wipeOverlay.style.display = 'none';
    if (compareTrigger) compareTrigger.classList.remove('visible');
    if (compareVideo) {
        compareVideo.pause();
        compareVideo.style.display = 'none';
    }
    if (compareImage) compareImage.style.display = 'none';

    AppState.compareVersion = null;
}

// Wipe slider drag
let wipeDragActive = false;

function initWipeDrag() {
    const wipeSlider = document.getElementById('wipeSlider');
    const wipeOverlay = document.getElementById('wipeOverlay');

    if (!wipeSlider || !wipeOverlay) return;

    // Remove old listeners
    wipeSlider.onmousedown = null;
    wipeSlider.ontouchstart = null;

    wipeSlider.addEventListener('mousedown', startWipeDrag);
    wipeSlider.addEventListener('touchstart', startWipeDrag, { passive: false });
}

function startWipeDrag(e) {
    e.preventDefault();
    wipeDragActive = true;

    document.addEventListener('mousemove', onWipeDrag);
    document.addEventListener('mouseup', stopWipeDrag);
    document.addEventListener('touchmove', onWipeDrag, { passive: false });
    document.addEventListener('touchend', stopWipeDrag);
}

function onWipeDrag(e) {
    if (!wipeDragActive) return;

    const wipeOverlay = document.getElementById('wipeOverlay');
    if (!wipeOverlay) return;

    const rect = wipeOverlay.getBoundingClientRect();
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const percent = Math.max(5, Math.min(95,
        ((clientX - rect.left) / rect.width) * 100
    ));

    updateWipePosition(percent);
}

function stopWipeDrag() {
    wipeDragActive = false;
    document.removeEventListener('mousemove', onWipeDrag);
    document.removeEventListener('mouseup', stopWipeDrag);
    document.removeEventListener('touchmove', onWipeDrag);
    document.removeEventListener('touchend', stopWipeDrag);

    // Send sync after drag ends
    sendSyncCompare();
}

function updateWipePosition(percent) {
    AppState.wipePosition = percent;

    const slider = document.getElementById('wipeSlider');
    const compareVideo = document.getElementById('videoCompare');
    const compareImage = document.getElementById('stillImageCompare');

    if (slider) slider.style.left = `${percent}%`;

    // Update clip-path on compare elements (OLD version on LEFT)
    // Clip from right side: inset(top right bottom left)
    const clipPath = `inset(0 ${100 - percent}% 0 0)`;
    if (compareVideo) compareVideo.style.clipPath = clipPath;
    if (compareImage) compareImage.style.clipPath = clipPath;
}

// Sync compare video with main video
let _compareSeeking = false;

function syncCompareVideo() {
    if (!AppState.compareMode) return;

    const mainVideo = document.getElementById('video');
    const compareVideo = document.getElementById('videoCompare');
    if (!mainVideo || !compareVideo || compareVideo.style.display === 'none') return;

    // Don't sync if compare video isn't ready (still loading blob)
    // readyState: 0=HAVE_NOTHING, 1=HAVE_METADATA, 2=HAVE_CURRENT_DATA, 3=HAVE_FUTURE_DATA, 4=HAVE_ENOUGH_DATA
    if (compareVideo.readyState < 1) return;

    // Don't sync while compare video is already seeking
    if (_compareSeeking || compareVideo.seeking) return;

    const targetTime = mainVideo.currentTime;
    const drift = compareVideo.currentTime - targetTime;

    // Sync time if drifted
    if (Math.abs(drift) > 0.1) {
        _compareSeeking = true;

        // Use fastSeek if available (better for scrubbing)
        if (compareVideo.fastSeek) {
            compareVideo.fastSeek(targetTime);
        } else {
            compareVideo.currentTime = targetTime;
        }

        // Wait for seek to complete
        compareVideo.onseeked = () => {
            compareVideo.onseeked = null;
            _compareSeeking = false;

            // Resume if main is playing
            if (!mainVideo.paused && compareVideo.paused) {
                compareVideo.play().catch(() => {});
            }
        };

        // Timeout fallback in case seeked never fires
        setTimeout(() => {
            _compareSeeking = false;
        }, 500);

        return;
    }

    // Sync play state
    if (!mainVideo.paused && compareVideo.paused) {
        compareVideo.play().catch(() => {});
    } else if (mainVideo.paused && !compareVideo.paused) {
        compareVideo.pause();
    }
}

// Reset compare when changing clips
function resetCompareMode() {
    if (AppState.compareMode) {
        AppState.compareMode = false;
        hideCompareUI();
        updateCompareButton();
    }
}

// WebSocket sync for compare mode
function sendSyncCompare() {
    if (AppState.ws && AppState.ws.readyState === WebSocket.OPEN
        && AppState.syncEnabled && !AppState._suppressCompareSync) {
        AppState.ws.send(JSON.stringify({
            type: 'sync_compare',
            compareMode: AppState.compareMode,
            compareVersion: AppState.compareVersion,
            wipePosition: AppState.wipePosition
        }));
    }
}

// Initialize compare button state on clip change
function initCompareControl() {
    updateCompareButton();
}

// Initialize video sync for compare mode - must be called after elements.init()
function initCompareVideoSync() {
    const video = document.getElementById('video');
    if (!video) {
        console.warn('initCompareVideoSync: video element not found');
        return;
    }

    video.addEventListener('play', () => {
        const compareVideo = document.getElementById('videoCompare');
        if (AppState.compareMode && compareVideo && compareVideo.style.display !== 'none') {
            compareVideo.play().catch(() => {});
        }
    });

    video.addEventListener('pause', () => {
        const compareVideo = document.getElementById('videoCompare');
        if (AppState.compareMode && compareVideo) {
            compareVideo.pause();
        }
    });

    video.addEventListener('seeked', () => {
        syncCompareVideo();
    });

    video.addEventListener('timeupdate', () => {
        syncCompareVideo();
    });
}

window.toggleCompareMode = toggleCompareMode;
window.selectCompareVersion = selectCompareVersion;
window.updateCompareButton = updateCompareButton;
window.updateCompareDropdown = updateCompareDropdown;
window.initCompareControl = initCompareControl;
window.initCompareVideoSync = initCompareVideoSync;
window.resetCompareMode = resetCompareMode;
window.sendSyncCompare = sendSyncCompare;
window.updateWipePosition = updateWipePosition;
window.showCompareUI = showCompareUI;
window.hideCompareUI = hideCompareUI;
