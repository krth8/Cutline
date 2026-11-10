/**
 * Clip Tasks Component
 * Manages tasks linked to clips in the Review tab sidebar
 */

// Current clip ID being viewed
let currentClipIdForTasks = null;

/**
 * Switch sidebar tab between comments and tasks
 */
function switchSidebarTab(tabName) {
    // Update tab buttons
    document.querySelectorAll('.sidebar-tab').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.tab === tabName);
    });

    // Update tab panels
    document.querySelectorAll('.sidebar-tab-panel').forEach(panel => {
        panel.classList.toggle('active', panel.id === `${tabName}TabPanel`);
    });

    // If switching to tasks, refresh the tasks list
    if (tabName === 'tasks') {
        loadClipTasks();
    }
}

/**
 * Load tasks linked to the current clip
 */
async function loadClipTasks() {
    const listEl = document.getElementById('clipTasksList');
    if (!listEl) return;

    // Get current clip ID from AppState
    const clipId = getCurrentClipId();

    if (!clipId) {
        listEl.innerHTML = '<div class="clip-tasks-empty">Select a clip to see linked tasks</div>';
        return;
    }

    currentClipIdForTasks = clipId;
    listEl.innerHTML = '<div class="clip-tasks-loading">Loading tasks...</div>';

    const { data, error } = await API.getClipTasks(clipId);

    if (error) {
        console.error('Failed to load clip tasks:', error);
        listEl.innerHTML = '<div class="clip-tasks-empty">Failed to load tasks</div>';
        return;
    }

    const tasks = data?.tasks || [];

    if (tasks.length === 0) {
        listEl.innerHTML = '<div class="clip-tasks-empty">No tasks linked to this clip</div>';
        return;
    }

    listEl.innerHTML = tasks.map(task => renderClipTaskItem(task)).join('');
}

/**
 * Get the current clip's database ID
 */
function getCurrentClipId() {
    if (!AppState.currentClip) return null;

    const { baseName, version } = AppState.currentClip;
    const clipData = AppState.clips[baseName];
    if (!clipData) return null;

    const versionData = clipData.versions.find(v => v.version === version);
    return versionData?.clipId || null;
}

/**
 * Render a single task item
 */
function renderClipTaskItem(task) {
    const statusStyle = task.statusColor
        ? `background: ${task.statusColor}20; color: ${task.statusColor}`
        : '';

    return `
        <div class="clip-task-item" onclick="openTaskFromClip('${task.id}')">
            <div class="clip-task-name">${escapeHtml(task.name)}</div>
            <div class="clip-task-meta">
                ${task.statusName ? `<span class="clip-task-status" style="${statusStyle}">${escapeHtml(task.statusName)}</span>` : ''}
                ${task.assignees && task.assignees.length > 0
                    ? `<span>${task.assignees.map(a => escapeHtml(a.name || a.username)).join(', ')}</span>`
                    : ''}
            </div>
        </div>
    `;
}

/**
 * Open task detail from clip tasks panel
 */
function openTaskFromClip(taskId) {
    // Switch to Projects tab and open task detail
    if (typeof switchToProjectsTab === 'function') {
        switchToProjectsTab(() => {
            // After switching, open the task detail
            if (typeof openTaskDetail === 'function') {
                openTaskDetail(taskId);
            }
        });
    } else {
        // Fallback: just try to open task detail
        if (typeof openTaskDetail === 'function') {
            openTaskDetail(taskId);
        }
    }
}

/**
 * Create a new task for the current clip
 */
async function createTaskFromClip() {
    const clipId = getCurrentClipId();
    const baseName = AppState.currentClip?.baseName;

    if (!clipId || !baseName) {
        alert('Please select a clip first');
        return;
    }

    // Use the task create modal if available
    if (typeof showCreateTaskModal === 'function') {
        // Pass clip info to the create task modal
        showCreateTaskModal({
            clipId: clipId,
            clipName: baseName,
            defaultName: `Task for ${baseName}`
        });
    } else {
        // Fallback: simple prompt
        const taskName = prompt('Task name:', `Task for ${baseName}`);
        if (!taskName) return;

        const projectId = AppState.currentProject;
        if (!projectId) {
            alert('No project selected');
            return;
        }

        const { data, error } = await API.createTask(projectId, {
            name: taskName,
            clipId: clipId
        });

        if (error) {
            alert('Failed to create task: ' + error);
            return;
        }

        // Link the clip to the task
        if (data?.task?.id) {
            await API.linkTaskClip(data.task.id, clipId);
        }

        // Refresh tasks list
        loadClipTasks();
    }
}

/**
 * Escape HTML special characters
 */
function escapeHtml(str) {
    if (str == null) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

/**
 * Refresh clip tasks when clip selection changes
 */
function onClipSelectionChanged() {
    // Only refresh if tasks tab is active
    const tasksTab = document.querySelector('.sidebar-tab[data-tab="tasks"].active');
    if (tasksTab) {
        loadClipTasks();
    }
}

// Export to global scope
window.switchSidebarTab = switchSidebarTab;
window.loadClipTasks = loadClipTasks;
window.createTaskFromClip = createTaskFromClip;
window.openTaskFromClip = openTaskFromClip;
window.onClipSelectionChanged = onClipSelectionChanged;
