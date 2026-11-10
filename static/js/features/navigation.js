/**
 * Navigation Module for CollabSuite
 * Handles tab switching, user menu, and view management
 */

// ============ Tab Navigation ============

function initNavigation() {
    // Tab switching
    document.querySelectorAll('.main-tab').forEach(tab => {
        tab.addEventListener('click', () => switchTab(tab.dataset.tab));
    });

    // Update user display on state change
    AppState.subscribe(['adminUser', 'isAdmin'], updateUserDisplay);

    // Restore saved tab from localStorage
    const savedTab = localStorage.getItem('activeTab');
    if (savedTab && ['projects', 'review', 'docs', 'lounge'].includes(savedTab)) {
        // Delay to ensure DOM is ready
        requestAnimationFrame(() => {
            switchTab(savedTab);
        });
    } else {
        // Initialize tab indicator position for default tab
        requestAnimationFrame(() => updateTabIndicator());
    }
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

function switchTab(tabName) {
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
        lounge: document.getElementById('viewLounge')
    };

    const toolbars = {
        projects: document.getElementById('toolbarProjects'),
        review: document.getElementById('toolbarReview')
    };

    // Update app data attribute (for CSS styling)
    app.dataset.view = tabName;

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

    // Store active tab (in memory and localStorage)
    AppState.activeTab = tabName;
    localStorage.setItem('activeTab', tabName);

    // Load data for the active tab
    if (tabName === 'projects') {
        // Preserve project context: if we have a project selected in review, use it
        if (!currentTasksProjectId && AppState.projectId) {
            currentTasksProjectId = AppState.projectId;
        }
        loadProjectsView();
    } else if (tabName === 'review') {
        // Preserve project context: if we have a project selected in projects tab, use it
        if (!AppState.projectId && currentTasksProjectId) {
            AppState.projectId = currentTasksProjectId;
        }

        // Initialize ReviewModule if available and project is selected
        if (typeof ReviewModule !== 'undefined' && AppState.projectId) {
            ReviewModule.init(AppState.projectId);
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
            const projectId = AppState.projectId || currentTasksProjectId;
            DocsModule.init(projectId);
        }
    } else if (tabName === 'lounge') {
        // Initialize LoungeModule for team chat
        if (typeof LoungeModule !== 'undefined') {
            const projectId = AppState.projectId || currentTasksProjectId;
            LoungeModule.init(projectId);
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

// ============ Projects Tab ============

// Current project selection for tasks view (global for task modules)
window.currentTasksProjectId = null;

async function loadProjectsView() {
    // If a project is selected, show tasks view, otherwise show projects list
    if (currentTasksProjectId) {
        await loadProjectsTasks();
    } else {
        await loadProjectsGrid();
    }
}

async function loadProjectsGrid() {
    const projectsGrid = document.getElementById('projectsGrid');
    const tasksView = document.getElementById('tasksTableContainer');
    const untaggedSection = document.getElementById('untaggedAssetsSection');
    const backBtn = document.getElementById('projectsBackBtn');
    const projectTitle = document.getElementById('projectsCurrentTitle');

    // Show projects grid, hide tasks table and untagged assets
    if (projectsGrid) projectsGrid.classList.remove('hidden');
    if (tasksView) tasksView.classList.add('hidden');
    if (untaggedSection) untaggedSection.classList.add('hidden');
    if (backBtn) backBtn.classList.add('hidden');
    if (projectTitle) projectTitle.textContent = 'Projects';

    // Fetch projects
    const { data, error } = await API.getProjects();

    if (error) {
        console.error('Failed to load projects:', error);
        if (projectsGrid) {
            projectsGrid.innerHTML = `<div class="projects-error">Failed to load projects</div>`;
        }
        return;
    }

    const projects = data?.projects || [];
    renderProjectsGrid(projects);
    renderProjectsSidebarList(projects);
}

function renderProjectsGrid(projects) {
    const container = document.getElementById('projectsGrid');
    if (!container) return;

    if (projects.length === 0) {
        container.innerHTML = `
            <div class="projects-empty-grid">
                <div class="projects-empty-icon"><svg class="icon icon-xl"><use href="/static/icons.svg#icon-folder"/></svg></div>
                <p>No projects yet</p>
                <button class="btn btn-primary" onclick="showCreateProject()"><svg class="icon"><use href="/static/icons.svg#icon-plus"/></svg> Create Project</button>
            </div>
        `;
        return;
    }

    container.innerHTML = projects.map(project => {
        const coverStyle = project.coverImage ? `background-image: url('${project.coverImage}')` : '';
        const clipCount = project.clipCount || Object.keys(project.clips || {}).length;

        return `
            <div class="project-card" onclick="openProjectTasks('${project.id}')">
                <div class="project-card-cover ${project.coverImage ? 'has-cover' : ''}" style="${coverStyle}">
                    ${!project.coverImage ? '<svg class="icon icon-xl project-card-icon"><use href="/static/icons.svg#icon-folder"/></svg>' : ''}
                </div>
                <div class="project-card-info">
                    <h3 class="project-card-name">${escapeHtml(project.name)}</h3>
                    <div class="project-card-meta">
                        <span>${clipCount} clips</span>
                    </div>
                </div>
            </div>
        `;
    }).join('');
}

function renderProjectsSidebarList(projects) {
    const container = document.getElementById('projectsSidebarList');
    if (!container) return;

    if (!projects || projects.length === 0) {
        container.innerHTML = `<div class="projects-sidebar-empty">No projects</div>`;
        return;
    }

    container.innerHTML = projects.map(project => {
        const isActive = project.id === currentTasksProjectId;
        const thumbStyle = project.coverImage ? `background-image: url('${project.coverImage}')` : '';

        return `
            <div class="projects-sidebar-item ${isActive ? 'active' : ''}"
                 onclick="openProjectTasks('${project.id}')"
                 data-project-id="${project.id}">
                <div class="projects-sidebar-item-thumb" style="${thumbStyle}">
                    ${!project.coverImage ? '<svg class="icon icon-sm"><use href="/static/icons.svg#icon-folder"/></svg>' : ''}
                </div>
                <span class="projects-sidebar-item-name">${escapeHtml(project.name)}</span>
            </div>
        `;
    }).join('');
}

async function openProjectTasks(projectId) {
    window.currentTasksProjectId = projectId;

    // Update sidebar active state
    document.querySelectorAll('.projects-sidebar-item').forEach(item => {
        item.classList.toggle('active', item.dataset.projectId === projectId);
    });

    await loadProjectsTasks();
}

function backToProjects() {
    window.currentTasksProjectId = null;
    // Clear TaskManager state
    if (window.TaskManager) {
        TaskManager.clear();
    }
    loadProjectsGrid();
}

async function loadProjectsTasks() {
    const projectsGrid = document.getElementById('projectsGrid');
    const tasksView = document.getElementById('tasksTableContainer');
    const backBtn = document.getElementById('projectsBackBtn');
    const projectTitle = document.getElementById('projectsCurrentTitle');

    // Show tasks view, hide projects grid
    if (projectsGrid) projectsGrid.classList.add('hidden');
    if (tasksView) tasksView.classList.remove('hidden');
    if (backBtn) backBtn.classList.remove('hidden');

    if (!currentTasksProjectId) {
        backToProjects();
        return;
    }

    // Set project title from cached data (instant, no API call needed)
    const cachedProject = AppState.projects?.find(p => p.id === currentTasksProjectId);
    if (projectTitle) {
        projectTitle.textContent = cachedProject?.name || 'Project';
    }

    // Show loading state immediately (non-blocking UI)
    if (typeof renderTaskTable === 'function') {
        renderTaskTable([], currentTasksProjectId, true); // true = loading state
    }

    // Start all operations in parallel (don't block UI)
    const loadMembersPromise = typeof loadProjectMembers === 'function'
        ? loadProjectMembers(currentTasksProjectId)
        : Promise.resolve();

    // Use TaskManager if available
    if (window.TaskManager) {
        // Initialize TaskManager (this loads tasks internally)
        await Promise.all([
            loadMembersPromise,
            TaskManager.init(currentTasksProjectId)
        ]);

        // Render using TaskManager data
        if (typeof renderTaskTable === 'function') {
            renderTaskTable(TaskManager.getTasks(), currentTasksProjectId, false);
        }
    } else {
        // Fallback: direct API call
        const [, tasksResult] = await Promise.all([
            loadMembersPromise,
            API.getTasks(currentTasksProjectId)
        ]);

        const { data, error } = tasksResult;

        if (error) {
            console.error('Failed to load tasks:', error);
            return;
        }

        const tasks = data?.tasks || [];
        window.currentTasks = tasks;

        if (typeof renderTaskTable === 'function') {
            renderTaskTable(tasks, currentTasksProjectId, false);
        }
    }

    // Load untagged assets in background (don't await)
    API.getUntaggedClips(currentTasksProjectId).then(result => {
        renderUntaggedAssets(result.data?.clips || []);
    });
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

function renderProjectsTasks(tasks) {
    const tableBody = document.getElementById('projectsTableBody');
    if (!tableBody) return;

    tableBody.innerHTML = tasks.map(task => `
        <tr class="task-row" data-task-id="${task.id}" onclick="openTaskDetails('${task.id}')">
            <td class="col-name">
                <div class="task-name-cell">
                    ${task.clipId ? '<span class="task-icon clip-icon" title="Linked to clip">🎬</span>' : ''}
                    ${task.childCount > 0 ? `<span class="task-children-count">${task.childCount}</span>` : ''}
                    <span class="task-name">${escapeHtml(task.name)}</span>
                    ${task.stageTag ? `<span class="stage-tag">${escapeHtml(task.stageTag)}</span>` : ''}
                </div>
            </td>
            <td class="col-status">
                ${task.status ? `<span class="status-badge" style="background: ${task.status.color}; color: ${getContrastTextColor(task.status.color)}">${escapeHtml(task.status.name)}</span>` : '<span class="no-status">-</span>'}
            </td>
            <td class="col-assignee">
                ${task.assignee ? `
                    <div class="assignee-cell">
                        ${task.assignee.profileImage ? `<img src="${task.assignee.profileImage}" class="assignee-avatar" alt="">` : `<span class="assignee-initials">${getInitials(task.assignee.name)}</span>`}
                        <span class="assignee-name">${escapeHtml(task.assignee.name)}</span>
                    </div>
                ` : '<span class="no-assignee">-</span>'}
            </td>
            <td class="col-date">
                ${task.dueDate ? `<span class="due-date ${isOverdue(task.dueDate) ? 'overdue' : ''}">${formatDate(task.dueDate)}</span>` : '<span class="no-date">-</span>'}
            </td>
        </tr>
    `).join('');
}

function formatDate(dateStr) {
    const date = new Date(dateStr);
    return date.toLocaleDateString('nb-NO', { day: 'numeric', month: 'short' });
}

function isOverdue(dateStr) {
    const dueDate = new Date(dateStr);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    return dueDate < today;
}

function openTaskDetails(taskId) {
    // Use the task detail panel from taskDetail.js
    if (typeof openTaskDetail === 'function') {
        openTaskDetail(taskId);
    } else {
        console.error('openTaskDetail function not available');
    }
}

// showCreateTask is defined in taskCreate.js - this is a fallback
function showCreateTaskFallback() {
    if (!currentTasksProjectId) {
        alert('Please select a project first');
        return;
    }

    const name = prompt('Task name:');
    if (!name || !name.trim()) return;

    const taskName = name.trim();

    // Optimistic UI: Add temporary task immediately
    const tempId = `temp-${Date.now()}`;
    const tempTask = {
        id: tempId,
        name: taskName,
        projectId: currentTasksProjectId,
        statusId: null,
        assignees: [],
        dueDate: null,
        _isOptimistic: true
    };

    if (window.currentTasks && typeof renderTaskTable === 'function') {
        window.currentTasks.push(tempTask);
        renderTaskTable(window.currentTasks);
    }

    // Create in background
    API.createTask(currentTasksProjectId, { name: taskName }).then(({ data, error }) => {
        if (error) {
            // Remove optimistic task on error
            if (window.currentTasks) {
                window.currentTasks = window.currentTasks.filter(t => t.id !== tempId);
                if (typeof renderTaskTable === 'function') {
                    renderTaskTable(window.currentTasks);
                }
            }
            alert('Failed to create task: ' + error);
            return;
        }

        // Replace temp with real task
        if (window.currentTasks && data?.task) {
            const idx = window.currentTasks.findIndex(t => t.id === tempId);
            if (idx !== -1) {
                window.currentTasks[idx] = data.task;
                if (typeof renderTaskTable === 'function') {
                    renderTaskTable(window.currentTasks);
                }
            }
        }
    });
}

// ============ Go Home ============

function goHome() {
    // Clear project selection and go to projects grid
    window.currentTasksProjectId = null;
    AppState.projectId = null;

    // Clear TaskManager state if available
    if (window.TaskManager) {
        TaskManager.clear();
    }

    // Switch to projects tab and show grid
    switchTab('projects');
}

// ============ Logout ============

function logout() {
    localStorage.removeItem('token');
    AppState.reset();
    window.location.reload();
}

// ============ Initialize ============

document.addEventListener('DOMContentLoaded', () => {
    initNavigation();
    updateUserDisplay();
});

/**
 * Switch to Projects tab and optionally run a callback after
 */
function switchToProjectsTab(callback) {
    switchTab('projects');
    // Run callback after a short delay to let UI update
    if (callback) {
        setTimeout(callback, 100);
    }
}

/**
 * Switch to Review tab and optionally run a callback after
 */
function switchToReviewTab(callback) {
    switchTab('review');
    if (callback) {
        setTimeout(callback, 100);
    }
}

// ============ Untagged Assets ============

let untaggedAssetsExpanded = false;

/**
 * Toggle the untagged assets section open/closed
 */
function toggleUntaggedAssets() {
    untaggedAssetsExpanded = !untaggedAssetsExpanded;
    const list = document.getElementById('untaggedAssetsList');
    const chevron = document.getElementById('untaggedChevron');

    if (list) {
        list.classList.toggle('hidden', !untaggedAssetsExpanded);
    }
    if (chevron) {
        chevron.classList.toggle('expanded', untaggedAssetsExpanded);
    }
}

/**
 * Render untagged assets in the section
 */
function renderUntaggedAssets(clips) {
    const section = document.getElementById('untaggedAssetsSection');
    const list = document.getElementById('untaggedAssetsList');
    const count = document.getElementById('untaggedCount');

    if (!section || !list) return;

    // Update count
    if (count) {
        count.textContent = clips.length;
    }

    // Hide section if no untagged clips
    if (clips.length === 0) {
        section.classList.add('hidden');
        return;
    }

    section.classList.remove('hidden');

    // Render clip cards using same structure as clip bin
    list.innerHTML = clips.map(clip => {
        const isImage = clip.mediaType === 'image';
        const isHtml = clip.mediaType === 'html';
        const placeholderIcon = isHtml ? 'icon-code' : isImage ? 'icon-image' : 'icon-film-strip';
        const typePillClass = isHtml ? 'html' : isImage ? 'image' : 'video';
        const typePillIcon = isHtml ? 'icon-code' : isImage ? 'icon-image' : 'icon-video';

        // Thumbnail HTML
        let thumbnailHtml = `<div class="clip-thumb-placeholder"><svg class="icon icon-xl"><use href="/static/icons.svg#${placeholderIcon}"/></svg></div>`;
        if (clip.thumbnail) {
            thumbnailHtml = `<img src="/thumbnail/${clip.thumbnail}" alt="${escapeHtml(clip.baseName)}" onerror="this.parentElement.innerHTML='<svg class=\\'icon icon-xl\\'><use href=\\'/static/icons.svg#${placeholderIcon}\\'/></svg>'">`;
        }

        // Status bar
        const statusBarHtml = clip.status?.color
            ? `<div class="clip-status-bar" style="background: ${clip.status.color}"></div>`
            : '';

        return `
            <div class="clip-thumbnail untagged" data-clip-id="${clip.id}" data-base-name="${escapeHtml(clip.baseName)}">
                <div class="clip-thumb-image">
                    ${thumbnailHtml}
                    <div class="clip-type-pill ${typePillClass}"><svg class="icon icon-sm"><use href="/static/icons.svg#${typePillIcon}"/></svg></div>
                    <button class="untagged-convert-btn" onclick="event.stopPropagation(); convertClipToTask(${clip.id}, '${escapeHtml(clip.baseName).replace(/'/g, "\\'")}')">
                        <svg class="icon"><use href="/static/icons.svg#icon-plus"/></svg>
                    </button>
                </div>
                <div class="clip-thumb-info">
                    <div class="clip-thumb-name">${escapeHtml(clip.baseName)}</div>
                    <div class="clip-thumb-meta">Untagged</div>
                </div>
                ${statusBarHtml}
            </div>
        `;
    }).join('');
}

/**
 * Parse base name to extract task name (remove version suffix)
 * Examples: "MyAnimation_v001" -> "MyAnimation", "Shot_05_V02" -> "Shot_05"
 */
function parseTaskNameFromClip(baseName) {
    // Remove trailing version suffix like _v001, _v02, _V1, etc.
    return baseName.replace(/[_-][vV]\d+$/, '');
}

/**
 * Convert an untagged clip to a task
 */
async function convertClipToTask(clipId, baseName) {
    if (!currentTasksProjectId) {
        alert('No project selected');
        return;
    }

    const taskName = parseTaskNameFromClip(baseName);

    // Optimistic UI: disable the button
    const btn = document.querySelector(`.untagged-clip-card[data-clip-id="${clipId}"] .untagged-convert-btn`);
    if (btn) {
        btn.disabled = true;
        btn.innerHTML = '<span class="spinner"></span> Creating...';
    }

    try {
        // Create the task
        const { data: taskData, error: taskError } = await API.createTask(currentTasksProjectId, {
            name: taskName
        });

        if (taskError) {
            throw new Error(taskError);
        }

        const taskId = taskData?.task?.id;
        if (!taskId) {
            throw new Error('Failed to get task ID');
        }

        // Link the clip to the task
        const { error: linkError } = await API.linkTaskClip(taskId, clipId);
        if (linkError) {
            console.warn('Failed to link clip to task:', linkError);
        }

        // Refresh the view
        await loadProjectsTasks();

    } catch (error) {
        console.error('Failed to convert clip to task:', error);
        alert('Failed to create task: ' + error.message);

        // Re-enable button on error
        if (btn) {
            btn.disabled = false;
            btn.innerHTML = '<svg class="icon"><use href="/static/icons.svg#icon-plus"/></svg> Convert to Task';
        }
    }
}

/**
 * Refresh untagged assets list
 */
async function refreshUntaggedAssets() {
    if (!currentTasksProjectId) return;

    const { data, error } = await API.getUntaggedClips(currentTasksProjectId);
    if (!error) {
        renderUntaggedAssets(data?.clips || []);
    }
}

// Export functions
window.switchTab = switchTab;
window.switchToProjectsTab = switchToProjectsTab;
window.switchToReviewTab = switchToReviewTab;
window.goHome = goHome;
window.logout = logout;
window.getInitials = getInitials;
// showCreateTask is exported from taskCreate.js (using modal)
// window.showCreateTaskFallback available as backup
window.showCreateTaskFallback = showCreateTaskFallback;
window.updateUserDisplay = updateUserDisplay;
window.loadProjectsView = loadProjectsView;
window.loadProjectsTasks = loadProjectsTasks;
window.openTaskDetails = openTaskDetails;
window.openProjectTasks = openProjectTasks;
window.backToProjects = backToProjects;
window.loadProjectsGrid = loadProjectsGrid;
window.toggleUntaggedAssets = toggleUntaggedAssets;
window.convertClipToTask = convertClipToTask;
window.refreshUntaggedAssets = refreshUntaggedAssets;
// currentTasksProjectId is now declared as window.currentTasksProjectId at the top
