/**
 * Navigation Module for CollabSuite
 * Handles tab switching, user menu, and view management
 */

// ============ Tab Navigation ============

function initNavigation() {
    // There are no tabs: the sidebar navigates and the URL decides the view (Routes.apply)
    AppState.subscribe(['adminUser', 'isAdmin'], updateUserDisplay);
}

function updateTabIndicator() {
    const activeTab = document.querySelector('.main-tab.active');
    const indicator = document.querySelector('.tab-indicator');
    const tabsContainer = document.querySelector('.main-tabs');

    if (!activeTab || !indicator || !tabsContainer) return;

    const containerRect = tabsContainer.getBoundingClientRect();
    const tabRect = activeTab.getBoundingClientRect();

    indicator.style.width = `${tabRect.width}px`;
    indicator.style.transform = `translateX(${tabRect.left - containerRect.left}px)`;
}

/**
 * Show a tab. options.history says what happens to the URL (see Routes.sync):
 * 'push' (default, the user chose the tab), 'replace', or 'none' (the URL chose the tab).
 */
function switchTab(tabName, options) {
    // The Home button is not a tab of its own: it opens /home (Pages tab)
    if (tabName === 'home') { Routes.goHome(); return; }
    // Share-link guests have no Pages tab
    if (tabName === 'pages' && AppState.isShareLinkGuest) tabName = 'review';
    const previousTab = AppState.activeTab;

    // Save docs before switching away from docs tab
    if (AppState.activeTab === 'docs' && typeof DocsModule !== 'undefined') {
        DocsModule.cleanup();
    }

    const app = document.querySelector('.app');
    const tabs = document.querySelectorAll('.main-tab');

    // All views and toolbars
    const views = {
        projects: document.getElementById('viewProjects'),
        review: document.getElementById('viewReview'),
        docs: document.getElementById('viewDocs'),
        lounge: document.getElementById('viewLounge'),
        pages: document.getElementById('viewPages')
    };

    const toolbars = {
        projects: document.getElementById('toolbarProjects'),
        review: document.getElementById('toolbarReview')
    };

    // Update app data attribute (for CSS styling)
    app.dataset.view = tabName;
    if (typeof RightPanel !== 'undefined') RightPanel.apply();

    // Update tab active states
    tabs.forEach(tab => {
        tab.classList.toggle('active', tab.dataset.tab === tabName);
    });

    // Animate tab indicator
    updateTabIndicator();

    // Update all toolbar visibility
    Object.entries(toolbars).forEach(([name, el]) => {
        if (el) el.classList.toggle('hidden', name !== tabName);
    });

    // Update all view visibility
    Object.entries(views).forEach(([name, el]) => {
        if (el) el.classList.toggle('hidden', name !== tabName);
    });

    // Remember the active view (in memory)
    AppState.activeTab = tabName;

    // The URL follows the tab; the Pages bundle is mounted only while its tab is shown
    Routes.sync(tabName, options && options.history, previousTab);
    Routes.afterSwitch(tabName);

    // Load data for the active tab
    if (tabName === 'review') {
        if (typeof UserManager !== 'undefined' && AppState.projectId) {
            UserManager.setProjectAccessFromList(AppState.projectId);
        }

        // Show project selection modal if no project is selected
        if (!AppState.projectId && AppState.projects && AppState.projects.length > 0) {
            // Small delay to ensure UI is ready
            setTimeout(() => {
                if (typeof showProjectSelectionModal === 'function') {
                    showProjectSelectionModal();
                }
            }, 100);
        }
    } else if (tabName === 'docs') {
        // Initialize DocsModule - it handles project selection internally
        if (typeof DocsModule !== 'undefined') {
            const projectId = AppState.projectId;
            DocsModule.init(projectId);
        }
    } else if (tabName === 'lounge') {
        // Initialize LoungeModule for team chat
        if (typeof LoungeModule !== 'undefined') {
            // /p/<id>/lounge opens that project's room, /lounge/c/<id> a channel (the sidebar lists both)
            const route = Routes.current();
            if (route && route.channelId) LoungeModule.init(null, route.channelId);
            else LoungeModule.init((route && route.projectId) || AppState.projectId);
        }
    }
}

function updateUserDisplay() {
    const userAvatar = document.getElementById('userAvatar');
    const userNameDisplay = document.getElementById('userNameDisplay');
    const app = document.querySelector('.app');

    const user = AppState.adminUser;
    const isAdmin = AppState.isAdmin;

    if (user) {
        const initials = getInitials(user.username);
        if (userAvatar) userAvatar.textContent = initials;
        if (userNameDisplay) userNameDisplay.textContent = user.username;

        // Toggle admin class for showing admin-only items
        if (app) app.classList.toggle('is-admin', isAdmin);
    } else if (AppState.isShareLinkGuest) {
        const guestName = AppState.userName || 'Guest';
        const initials = getInitials(guestName);
        if (userAvatar) userAvatar.textContent = initials;
        if (userNameDisplay) userNameDisplay.textContent = guestName;
        if (app) app.classList.remove('is-admin');
    }
}

function getInitials(name) {
    if (!name) return '?';
    const parts = name.split(/[\s_-]+/);
    if (parts.length >= 2) {
        return (parts[0][0] + parts[1][0]).toUpperCase();
    }
    return name.substring(0, 2).toUpperCase();
}

/**
 * Close a modal by ID
 */
function closeModal(modalId) {
    const modal = document.getElementById(modalId);
    if (modal) {
        modal.remove();
    }
}

window.closeModal = closeModal;

// ============ Go Home ============

function goHome() {
    // The logo opens Home (guests have no Home)
    if (AppState.isShareLinkGuest) return;
    Routes.goHome();
}

// ============ Logout ============

function logout() {
    Auth.logout();
}

// ============ Initialize ============

document.addEventListener('DOMContentLoaded', () => {
    initNavigation();
    updateUserDisplay();
});

/**
 * Switch to Review tab and optionally run a callback after
 */
function switchToReviewTab(callback) {
    switchTab('review');
    if (callback) {
        setTimeout(callback, 100);
    }
}

window.switchTab = switchTab;
window.switchToReviewTab = switchToReviewTab;
window.goHome = goHome;
window.logout = logout;
window.getInitials = getInitials;
// window.showCreateTaskFallback available as backup
window.updateUserDisplay = updateUserDisplay;
