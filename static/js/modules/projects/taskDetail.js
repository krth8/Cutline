/**
 * Task Detail Modal functionality
 * Handles opening, editing, and saving task details
 * Includes properties, subtasks, linked clips, and comments
 */

// Current task being edited
let currentTask = null;
let saveTimeout = null;
let taskCommentsInstance = null;
let currentSubtasks = [];
let currentLinkedClips = [];
let currentChecklistItems = [];

/**
 * Open the task detail modal for a specific task
 */
async function openTaskDetail(taskId) {
    console.log('openTaskDetail called with taskId:', taskId);

    const modal = document.getElementById('taskDetailPanel');
    const overlay = document.getElementById('taskDetailOverlay');
    console.log('Modal elements:', { modal: !!modal, overlay: !!overlay });

    if (!modal || !overlay) {
        console.error('Task detail modal elements not found');
        return;
    }

    // Fetch task data
    const { data, error } = await API.getTask(taskId);
    if (error) {
        console.error('Failed to load task:', error);
        alert('Failed to load task: ' + error);
        return;
    }

    currentTask = data.task;
    TaskState.currentTaskId = taskId;
    TaskState.isDetailOpen = true;

    // Populate the modal
    populateTaskDetail(currentTask);

    // Show modal
    overlay.classList.remove('hidden');
    modal.classList.remove('hidden');

    // Load additional data in parallel
    await Promise.all([
        loadSubtasks(taskId),
        loadLinkedClips(taskId),
        loadChecklist(taskId),
        initTaskComments(taskId)
    ]);

    // Add keyboard listener for Escape
    document.addEventListener('keydown', handleTaskDetailKeydown);
}

/**
 * Close the task detail modal
 */
function closeTaskDetail() {
    const modal = document.getElementById('taskDetailPanel');
    const overlay = document.getElementById('taskDetailOverlay');

    if (modal) modal.classList.add('hidden');
    if (overlay) overlay.classList.add('hidden');

    // NOTE: Don't close dropdowns here - user might have one open in the task list
    // and we don't want to interfere with their workflow

    currentTask = null;
    currentSubtasks = [];
    currentLinkedClips = [];
    taskCommentsInstance = null;
    TaskState.currentTaskId = null;
    TaskState.isDetailOpen = false;

    // Remove keyboard listener
    document.removeEventListener('keydown', handleTaskDetailKeydown);

    // NOTE: Don't call loadProjectsTasks() here - it destroys expanded subtasks
    // and causes dropdown issues. Task updates are handled by individual update functions.
}

/**
 * Handle keyboard events for task detail panel
 */
function handleTaskDetailKeydown(e) {
    if (e.key === 'Escape' && TaskState.isDetailOpen) {
        closeTaskDetail();
    }
}

/**
 * Load project members for assignee dropdown
 */
async function loadProjectMembers(projectId) {
    if (TaskState.currentProjectId === projectId && TaskState.members && TaskState.members.length > 0) {
        return;
    }

    const { data, error } = await API.getProjectMembers(projectId);
    if (error) {
        console.error('Failed to load project members:', error);
        TaskState.members = [];
        TaskState.currentProjectId = projectId;
        return;
    }

    TaskState.members = data.members || [];
    TaskState.currentProjectId = projectId;
}

/**
 * Populate the task detail modal with task data
 */
function populateTaskDetail(task) {
    // Name
    const nameInput = document.getElementById('taskDetailName');
    if (nameInput) {
        nameInput.value = task.name || '';
    }

    // Description
    const descTextarea = document.getElementById('taskDetailDescription');
    if (descTextarea) {
        descTextarea.value = task.description || '';
    }

    // Status
    renderStatusProperty(task);

    // Assignees
    renderAssigneesProperty(task);

    // Due Date
    renderDueDateProperty(task);

    // Stage
    renderStageProperty(task);

    // Priority
    renderPriorityProperty(task);
}

/**
 * Render status property
 */
function renderStatusProperty(task) {
    const container = document.getElementById('taskDetailStatus');
    if (!container) return;
    container.innerHTML = PropertyRegistry.renderDetail('status', task);
}

/**
 * Render assignees property
 */
function renderAssigneesProperty(task) {
    const container = document.getElementById('taskDetailAssignees');
    if (!container) return;
    container.innerHTML = PropertyRegistry.renderDetail('assignee', task);
}

/**
 * Render due date property
 */
function renderDueDateProperty(task) {
    const container = document.getElementById('taskDetailDueDate');
    if (!container) return;
    container.innerHTML = PropertyRegistry.renderDetail('dueDate', task);
}

/**
 * Render stage property
 */
function renderStageProperty(task) {
    const container = document.getElementById('taskDetailStage');
    if (!container) return;
    container.innerHTML = PropertyRegistry.renderDetail('stage', task);
}

/**
 * Render priority property
 */
function renderPriorityProperty(task) {
    const container = document.getElementById('taskDetailPriority');
    if (!container) return;
    container.innerHTML = PropertyRegistry.renderDetail('priority', task);
}

// ============ Subtasks ============

/**
 * Load subtasks for the current task
 */
async function loadSubtasks(taskId) {
    const { data, error } = await API.getTasks(currentTasksProjectId, { parentId: taskId });

    if (error) {
        console.error('Failed to load subtasks:', error);
        currentSubtasks = [];
    } else {
        currentSubtasks = data?.tasks || [];
    }

    renderSubtasks();
}

/**
 * Render subtasks list
 */
function renderSubtasks() {
    const container = document.getElementById('taskDetailSubtasks');
    const countEl = document.getElementById('taskDetailSubtasksCount');

    if (countEl) {
        countEl.textContent = `(${currentSubtasks.length})`;
    }

    if (!container) return;

    if (currentSubtasks.length === 0) {
        container.innerHTML = '';
        return;
    }

    container.innerHTML = currentSubtasks.map(subtask => `
        <div class="task-modal-subtask" data-subtask-id="${subtask.id}" onclick="openTaskDetail('${subtask.id}')">
            <span class="subtask-name">${escapeHtml(subtask.name)}</span>
            ${subtask.status ? `<span class="status-badge small" style="background: ${subtask.status.color}">${escapeHtml(subtask.status.name)}</span>` : ''}
            ${subtask.childCount > 0 ? `<span class="subtask-children">${subtask.childCount} subtasks</span>` : ''}
        </div>
    `).join('');
}

/**
 * Handle subtask input keydown
 */
function handleSubtaskInputKeydown(event) {
    if (event.key === 'Enter') {
        event.preventDefault();
        createSubtaskFromInput();
    }
}

/**
 * Create a subtask from the input field
 */
async function createSubtaskFromInput() {
    const input = document.getElementById('taskDetailSubtaskInput');
    if (!input) return;

    const name = input.value.trim();
    if (!name || !currentTask) return;

    // Clear input
    input.value = '';

    // Create subtask
    const { data, error } = await API.createTask(currentTasksProjectId, {
        name,
        parentId: currentTask.id
    });

    if (error) {
        console.error('Failed to create subtask:', error);
        alert('Failed to create subtask: ' + error);
        input.value = name; // Restore input
        return;
    }

    // Add to list and re-render
    if (data?.task) {
        currentSubtasks.push(data.task);
        renderSubtasks();

        // Sync to list view: update parent's childCount
        const parentTask = window.currentTasks?.find(t => t.id === currentTask.id);
        if (parentTask) {
            parentTask.childCount = (parentTask.childCount || 0) + 1;

            // If parent is expanded in list view, add subtask to currentTasks
            const expandedTasks = window.TaskState?.expandedTasks || [];
            if (expandedTasks.includes(currentTask.id)) {
                if (!window.currentTasks.find(t => t.id === data.task.id)) {
                    window.currentTasks.push(data.task);
                }
                // Re-render expanded subtasks
                if (typeof TaskListView !== 'undefined') {
                    // Collapse and re-expand to refresh subtask list
                    TaskListView.toggleSubtasks(currentTask.id, 0);
                    TaskListView.toggleSubtasks(currentTask.id, 0);
                }
            } else {
                // Just update the parent row to show caret
                if (typeof TaskListView !== 'undefined') {
                    TaskListView.updateRow(currentTask.id);
                }
            }
        }
    }
}

// ============ Checklist ============

/**
 * Load checklist items for the current task
 */
async function loadChecklist(taskId) {
    const { data, error } = await API.getTaskChecklist(taskId);

    if (error) {
        console.error('Failed to load checklist:', error);
        currentChecklistItems = [];
    } else {
        currentChecklistItems = data?.items || [];
    }

    renderChecklist();
}

/**
 * Render checklist items
 */
function renderChecklist() {
    const container = document.getElementById('taskDetailChecklist');
    const countEl = document.getElementById('taskDetailChecklistCount');

    if (!container) return;

    const checkedCount = currentChecklistItems.filter(i => i.isChecked).length;
    const totalCount = currentChecklistItems.length;

    if (countEl) {
        countEl.textContent = totalCount > 0 ? `(${checkedCount}/${totalCount})` : '(0)';
    }

    if (currentChecklistItems.length === 0) {
        container.innerHTML = '';
        return;
    }

    container.innerHTML = currentChecklistItems.map(item => `
        <div class="task-checklist-item ${item.isChecked ? 'checked' : ''}" data-item-id="${item.id}">
            <label class="task-checklist-checkbox">
                <input type="checkbox" ${item.isChecked ? 'checked' : ''}
                       onchange="toggleChecklistItem('${item.id}', this.checked)">
                <span class="task-checklist-checkmark"></span>
            </label>
            <span class="task-checklist-text ${item.isChecked ? 'strikethrough' : ''}">${escapeHtml(item.text)}</span>
            <button class="task-checklist-delete" onclick="deleteChecklistItem('${item.id}')" title="Delete">
                <svg class="icon icon-xs"><use href="/static/icons.svg#icon-x"/></svg>
            </button>
        </div>
    `).join('');
}

/**
 * Handle checklist input keydown
 */
function handleChecklistInputKeydown(event) {
    if (event.key === 'Enter') {
        event.preventDefault();
        createChecklistItemFromInput();
    }
}

/**
 * Create a checklist item from the input field (with optimistic UI)
 */
async function createChecklistItemFromInput() {
    const input = document.getElementById('taskDetailChecklistInput');
    if (!input) return;

    const text = input.value.trim();
    if (!text || !currentTask) return;

    // Clear input immediately
    input.value = '';

    // Optimistic: add temp item
    const tempId = 'temp-' + Date.now();
    const tempItem = {
        id: tempId,
        text: text,
        isChecked: false,
        _isOptimistic: true
    };
    currentChecklistItems.push(tempItem);
    renderChecklist();

    // API call
    const { data, error } = await API.createChecklistItem(currentTask.id, text);

    if (error) {
        // Rollback
        currentChecklistItems = currentChecklistItems.filter(i => i.id !== tempId);
        renderChecklist();
        input.value = text;
        showToast?.('Failed to add item', 'error');
        return;
    }

    // Replace temp with real item
    if (data?.item) {
        const idx = currentChecklistItems.findIndex(i => i.id === tempId);
        if (idx > -1) {
            currentChecklistItems[idx] = data.item;
        }
        renderChecklist();
    }
}

/**
 * Toggle checklist item checked state (with optimistic UI)
 */
async function toggleChecklistItem(itemId, isChecked) {
    const item = currentChecklistItems.find(i => i.id === itemId);
    if (!item || !currentTask) return;

    // Optimistic update
    const oldValue = item.isChecked;
    item.isChecked = isChecked;
    renderChecklist();

    // API call
    const { error } = await API.updateChecklistItem(currentTask.id, itemId, { isChecked });

    if (error) {
        // Rollback
        item.isChecked = oldValue;
        renderChecklist();
        showToast?.('Failed to update item', 'error');
    }
}

/**
 * Delete a checklist item (with optimistic UI)
 */
async function deleteChecklistItem(itemId) {
    const item = currentChecklistItems.find(i => i.id === itemId);
    if (!item || !currentTask) return;

    // Optimistic removal
    const oldItems = [...currentChecklistItems];
    currentChecklistItems = currentChecklistItems.filter(i => i.id !== itemId);
    renderChecklist();

    // API call
    const { error } = await API.deleteChecklistItem(currentTask.id, itemId);

    if (error) {
        // Rollback
        currentChecklistItems = oldItems;
        renderChecklist();
        showToast?.('Failed to delete item', 'error');
    }
}

// ============ Linked Clips ============

/**
 * Load linked clips for the current task
 */
async function loadLinkedClips(taskId) {
    const { data, error } = await API.getTaskClips(taskId);

    if (error) {
        console.error('Failed to load linked clips:', error);
        currentLinkedClips = [];
    } else {
        currentLinkedClips = data?.clips || [];
    }

    renderLinkedClips();
}

/**
 * Render linked clips list
 */
function renderLinkedClips() {
    const container = document.getElementById('taskDetailClips');
    const countEl = document.getElementById('taskDetailClipsCount');

    if (countEl) {
        countEl.textContent = `(${currentLinkedClips.length})`;
    }

    if (!container) return;

    if (currentLinkedClips.length === 0) {
        container.innerHTML = '<div class="task-modal-clips-empty">No clips linked</div>';
        return;
    }

    container.innerHTML = currentLinkedClips.map(clip => `
        <div class="task-modal-clip-item" data-clip-id="${clip.id}">
            <div class="task-modal-clip-thumb" onclick="navigateToClip(${clip.id})">
                ${clip.thumbnail
                    ? `<img src="/thumbnail/${clip.thumbnail}" alt="${escapeHtml(clip.baseName)}">`
                    : `<svg class="icon icon-lg"><use href="/static/icons.svg#icon-film-strip"/></svg>`
                }
            </div>
            <div class="task-modal-clip-info">
                <span class="task-modal-clip-name">${escapeHtml(clip.baseName)}</span>
                <span class="task-modal-clip-version">v${String(clip.activeVersion).padStart(2, '0')}</span>
            </div>
            <button class="btn-icon btn-unlink" onclick="event.stopPropagation(); unlinkClip(${clip.id})" title="Unlink">
                <svg class="icon icon-sm"><use href="/static/icons.svg#icon-x"/></svg>
            </button>
        </div>
    `).join('');
}

/**
 * Unlink a clip from the current task
 */
async function unlinkClip(clipId) {
    if (!currentTask) return;

    const { error } = await API.unlinkTaskClip(currentTask.id, clipId);

    if (error) {
        console.error('Failed to unlink clip:', error);
        alert('Failed to unlink clip: ' + error);
        return;
    }

    // Remove from local list and re-render
    currentLinkedClips = currentLinkedClips.filter(c => c.id !== clipId);
    renderLinkedClips();
}

/**
 * Navigate to a clip in the Review tab
 */
function navigateToClip(clipId) {
    // Find clip by ID - look in versions
    let targetClip = null;
    let baseName = null;
    let version = null;

    for (const [name, clipData] of Object.entries(AppState.clips || {})) {
        // Check each version for matching clipId
        for (const v of (clipData.versions || [])) {
            if (v.clipId === clipId) {
                targetClip = clipData;
                baseName = name;
                version = v.version;
                break;
            }
        }
        if (targetClip) break;
    }

    if (!targetClip || !baseName) {
        console.error('Clip not found:', clipId);
        return;
    }

    // Close modal
    closeTaskDetail();

    // Switch to Review tab and select the clip
    if (typeof switchToReviewTab === 'function') {
        switchToReviewTab(() => {
            if (typeof selectClipVersion === 'function') {
                selectClipVersion(baseName, version || targetClip.activeVersion);
            }
        });
    } else if (typeof switchTab === 'function') {
        switchTab('review');
        setTimeout(() => {
            if (typeof selectClipVersion === 'function') {
                selectClipVersion(baseName, version || targetClip.activeVersion);
            }
        }, 100);
    }
}

// Track selected clips in modal
let selectedClipIds = new Set();

/**
 * Open clip link modal with proper UI
 */
function openClipLinkModal() {
    const modal = document.getElementById('clipSelectModal');
    const listEl = document.getElementById('clipSelectList');

    if (!modal || !listEl) return;

    // Reset selection
    selectedClipIds.clear();

    // Pre-select already linked clips (ensure string IDs)
    currentLinkedClips.forEach(clip => selectedClipIds.add(String(clip.id)));

    // Render clip list
    renderClipSelectList();

    // Show modal
    modal.classList.remove('hidden');

    // Focus search
    const searchInput = document.getElementById('clipSelectSearch');
    if (searchInput) {
        searchInput.value = '';
        searchInput.focus();
    }
}

/**
 * Hide clip selection modal
 */
function hideClipSelectModal() {
    const modal = document.getElementById('clipSelectModal');
    if (modal) modal.classList.add('hidden');
}

/**
 * Render the clip selection list
 */
function renderClipSelectList(filter = '') {
    const listEl = document.getElementById('clipSelectList');
    if (!listEl) return;

    const projectClips = Object.entries(AppState.clips || {});

    if (projectClips.length === 0) {
        listEl.innerHTML = '<div class="clip-select-empty">No clips available</div>';
        return;
    }

    // Filter clips
    const filterLower = filter.toLowerCase();
    const filteredClips = projectClips.filter(([baseName]) =>
        !filter || baseName.toLowerCase().includes(filterLower)
    );

    if (filteredClips.length === 0) {
        listEl.innerHTML = '<div class="clip-select-empty">No clips match your search</div>';
        return;
    }

    listEl.innerHTML = filteredClips.map(([baseName, clipData]) => {
        // Get the active version info
        const activeVersion = clipData.versions?.find(v => v.version === clipData.activeVersion);
        const clipId = String(activeVersion?.clipId || clipData.id);
        const thumbnail = activeVersion?.thumbnail;
        const isSelected = selectedClipIds.has(clipId);

        return `
            <div class="clip-select-item ${isSelected ? 'selected' : ''}"
                 data-clip-id="${clipId}"
                 onclick="toggleClipSelection('${clipId}')">
                <div class="clip-select-checkbox">
                    <svg class="icon"><use href="/static/icons.svg#icon-check"/></svg>
                </div>
                <div class="clip-select-thumb">
                    ${thumbnail
                        ? `<img src="/thumbnail/${thumbnail}" alt="${escapeHtml(baseName)}">`
                        : `<svg class="icon"><use href="/static/icons.svg#icon-film-strip"/></svg>`
                    }
                </div>
                <div class="clip-select-info">
                    <div class="clip-select-name">${escapeHtml(baseName)}</div>
                    <div class="clip-select-meta">v${String(clipData.activeVersion).padStart(2, '0')} · ${clipData.versions?.length || 1} version${(clipData.versions?.length || 1) > 1 ? 's' : ''}</div>
                </div>
            </div>
        `;
    }).join('');
}

/**
 * Filter clip select list based on search
 */
function filterClipSelectList() {
    const searchInput = document.getElementById('clipSelectSearch');
    const filter = searchInput?.value || '';
    renderClipSelectList(filter);
}

/**
 * Toggle clip selection
 */
function toggleClipSelection(clipId) {
    // Ensure consistent type (clipId might come as string or number)
    const id = String(clipId);

    if (selectedClipIds.has(id)) {
        selectedClipIds.delete(id);
    } else {
        selectedClipIds.add(id);
    }

    // Update UI
    const item = document.querySelector(`.clip-select-item[data-clip-id="${id}"]`);
    if (item) {
        item.classList.toggle('selected', selectedClipIds.has(id));
    }
}

/**
 * Confirm clip selection and link to task
 */
async function confirmClipSelection() {
    if (!currentTask) return;

    // Get currently linked clip IDs (as strings for comparison)
    const currentlyLinkedIds = new Set(currentLinkedClips.map(c => String(c.id)));

    // Clips to link (newly selected)
    const toLink = [...selectedClipIds].filter(id => !currentlyLinkedIds.has(id));

    // Clips to unlink (no longer selected)
    const toUnlink = [...currentlyLinkedIds].filter(id => !selectedClipIds.has(id));

    // Hide modal immediately (optimistic)
    hideClipSelectModal();

    // Optimistic UI update - build new linked clips list
    const allClips = Object.values(AppState.clips || {});
    const newLinkedClips = [];

    for (const id of selectedClipIds) {
        // Check if already in currentLinkedClips
        const existing = currentLinkedClips.find(c => String(c.id) === id);
        if (existing) {
            newLinkedClips.push(existing);
        } else {
            // Find clip info from AppState
            for (const clipData of allClips) {
                const activeVersion = clipData.versions?.find(v => v.version === clipData.activeVersion);
                const clipId = String(activeVersion?.clipId || clipData.id);
                if (clipId === id) {
                    newLinkedClips.push({
                        id: clipId,
                        baseName: clipData.baseName,
                        thumbnail: activeVersion?.thumbnail,
                        version: clipData.activeVersion
                    });
                    break;
                }
            }
        }
    }

    currentLinkedClips = newLinkedClips;
    renderLinkedClips();

    // Perform API operations in background
    const promises = [];
    for (const clipId of toLink) {
        promises.push(API.linkTaskClip(currentTask.id, clipId));
    }
    for (const clipId of toUnlink) {
        promises.push(API.unlinkTaskClip(currentTask.id, clipId));
    }

    // Wait for all and reload to sync
    await Promise.all(promises);
    await loadLinkedClips(currentTask.id);
}

/**
 * Link a clip to the current task
 */
async function linkClip(clipId) {
    if (!currentTask) return;

    const { error } = await API.linkTaskClip(currentTask.id, clipId);

    if (error) {
        console.error('Failed to link clip:', error);
        alert('Failed to link clip: ' + error);
        return;
    }

    // Reload linked clips
    await loadLinkedClips(currentTask.id);
}

// ============ Comments ============

/**
 * Initialize task comments
 */
async function initTaskComments(taskId) {
    taskCommentsInstance = new TaskComments('taskDetailComments', taskId);
    await taskCommentsInstance.init(taskId);

    // Update count
    const countEl = document.getElementById('taskDetailCommentsCount');
    if (countEl) {
        countEl.textContent = `(${taskCommentsInstance.getCount()})`;
    }
}

// ============ Property Dropdowns ============

/**
 * Get contrast color for text on colored background
 */
function getContrastColor(bgColor) {
    if (!bgColor || bgColor === 'transparent') return 'inherit';
    const hex = bgColor.replace('#', '');
    const r = parseInt(hex.substr(0, 2), 16);
    const g = parseInt(hex.substr(2, 2), 16);
    const b = parseInt(hex.substr(4, 2), 16);
    const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    return luminance > 0.5 ? '#000000' : '#ffffff';
}

/**
 * Close modal dropdowns
 */
function closeModalDropdowns() {
    document.querySelectorAll('.task-modal .custom-dropdown, .status-dropdown, .priority-dropdown, .stage-dropdown').forEach(d => d.remove());
}

/**
 * Open status dropdown in modal
 */
function openTaskDetailStatusDropdown(event) {
    event.stopPropagation();
    if (!currentTask) return;

    const trigger = event.currentTarget;
    const rect = trigger.getBoundingClientRect();

    closeModalDropdowns();
    if (typeof closeAllDropdowns === 'function') closeAllDropdowns();

    const statuses = AppState.statuses || [];

    const dropdown = document.createElement('div');
    dropdown.className = 'custom-dropdown status-dropdown';

    const clearOption = currentTask.statusId ? `
        <div class="dropdown-item status-option clear-option" onclick="selectTaskDetailStatus(null)">
            <span style="color: var(--text-muted)">Clear status</span>
        </div>
    ` : '';

    dropdown.innerHTML = clearOption + statuses.map(status => `
        <div class="dropdown-item status-option ${status.id === currentTask.statusId ? 'selected' : ''}"
             onclick="selectTaskDetailStatus('${status.id}')">
            <span class="status-badge" style="background: ${status.color}; color: ${getContrastColor(status.color)}">${escapeHtml(status.name)}</span>
        </div>
    `).join('');

    dropdown.style.cssText = `position: fixed; top: ${rect.bottom + 4}px; left: ${rect.left}px; z-index: 10001;`;
    document.body.appendChild(dropdown);

    requestAnimationFrame(() => dropdown.classList.add('dropdown-open'));

    setTimeout(() => {
        const closeHandler = (e) => {
            if (!dropdown.contains(e.target)) {
                dropdown.remove();
                document.removeEventListener('click', closeHandler);
            }
        };
        document.addEventListener('click', closeHandler);
    }, 10);
}

async function selectTaskDetailStatus(statusId) {
    closeModalDropdowns();

    if (!currentTask) return;

    // Optimistic update
    const status = statusId ? (AppState.statuses || []).find(s => s.id === statusId) : null;
    currentTask.statusId = statusId;
    currentTask.status = status;
    renderStatusProperty(currentTask);

    // API update (fire and forget)
    API.updateTask(currentTask.id, { statusId: statusId || null });

    // Also update in task table
    if (typeof TaskUpdater !== 'undefined') {
        TaskUpdater.setStatus(currentTask.id, statusId);
    }
}

/**
 * Open assignee dropdown in modal
 */
function openTaskDetailAssigneeDropdown(event) {
    event.stopPropagation();
    if (!currentTask) return;

    const trigger = event.currentTarget;
    trigger.dataset.taskId = currentTask.id;
    trigger.dataset.currentIds = (currentTask.assignees || []).map(a => a.id).join(',');

    if (typeof openAssigneeDropdown === 'function') {
        openAssigneeDropdown(event, currentTask.id);
    }

    // Refresh modal after assignee save
    const refreshOnSave = () => {
        setTimeout(async () => {
            const { data } = await API.getTask(currentTask.id);
            if (data?.task) {
                currentTask = data.task;
                renderAssigneesProperty(currentTask);
            }
        }, 300);
    };

    // Listen for dropdown close
    setTimeout(() => {
        const observer = new MutationObserver((mutations) => {
            const dropdown = document.querySelector('.assignee-dropdown');
            if (!dropdown) {
                refreshOnSave();
                observer.disconnect();
            }
        });
        observer.observe(document.body, { childList: true, subtree: true });
        setTimeout(() => observer.disconnect(), 5000);
    }, 100);
}

/**
 * Open date picker in modal
 */
function openTaskDetailDatePicker(event) {
    event.stopPropagation();
    if (!currentTask) return;

    const trigger = event.currentTarget;
    const rect = trigger.getBoundingClientRect();

    if (typeof DatePicker !== 'undefined') {
        DatePicker.show({
            current: currentTask.dueDate,
            position: { top: rect.bottom + 4, left: rect.left },
            onSelect: async (date) => {
                // Optimistic update
                currentTask.dueDate = date;
                renderDueDateProperty(currentTask);

                // API update
                API.updateTask(currentTask.id, { dueDate: date });

                // Also update task table
                if (typeof TaskUpdater !== 'undefined') {
                    TaskUpdater.setDueDate(currentTask.id, date);
                }
            }
        });
    }
}

/**
 * Open stage dropdown in modal
 */
function openTaskDetailStageDropdown(event) {
    event.stopPropagation();
    if (!currentTask) return;

    const trigger = event.currentTarget;
    const rect = trigger.getBoundingClientRect();

    closeModalDropdowns();
    if (typeof closeAllDropdowns === 'function') closeAllDropdowns();

    // Get stage options dynamically (with colors)
    const stageOptions = typeof PropertyRegistry !== 'undefined'
        ? PropertyRegistry.getStageOptions()
        : {
            'Previz': { label: 'Previz', color: '#8b5cf6' },
            'Layout': { label: 'Layout', color: '#3b82f6' },
            'Animation': { label: 'Animation', color: '#10b981' },
            'Lighting': { label: 'Lighting', color: '#f59e0b' },
            'FX': { label: 'FX', color: '#ef4444' },
            'Comp': { label: 'Comp', color: '#ec4899' },
            'Review': { label: 'Review', color: '#6366f1' }
        };

    const dropdown = document.createElement('div');
    dropdown.className = 'custom-dropdown stage-dropdown';

    const clearOption = currentTask.stageTag ? `
        <div class="dropdown-item stage-option clear-option" onclick="selectTaskDetailStage(null)">
            <span style="color: var(--text-muted)">Clear stage</span>
        </div>
    ` : '';

    dropdown.innerHTML = clearOption + Object.entries(stageOptions).map(([key, config]) => `
        <div class="dropdown-item stage-option ${key === currentTask.stageTag ? 'selected' : ''}"
             onclick="selectTaskDetailStage('${key}')">
            <span class="stage-badge" style="background: ${config.color}; color: ${getContrastColor(config.color)}">${escapeHtml(config.label)}</span>
        </div>
    `).join('');

    dropdown.style.cssText = `position: fixed; top: ${rect.bottom + 4}px; left: ${rect.left}px; z-index: 10001;`;
    document.body.appendChild(dropdown);

    requestAnimationFrame(() => dropdown.classList.add('dropdown-open'));

    setTimeout(() => {
        const closeHandler = (e) => {
            if (!dropdown.contains(e.target)) {
                dropdown.remove();
                document.removeEventListener('click', closeHandler);
            }
        };
        document.addEventListener('click', closeHandler);
    }, 10);
}

async function selectTaskDetailStage(stage) {
    closeModalDropdowns();

    if (!currentTask) return;

    // Optimistic update
    currentTask.stageTag = stage;
    renderStageProperty(currentTask);

    // API update
    API.updateTask(currentTask.id, { stageTag: stage });

    // Also update task table
    if (typeof TaskUpdater !== 'undefined') {
        TaskUpdater.setStage(currentTask.id, stage);
    }
}

/**
 * Open priority dropdown in modal
 */
function openTaskDetailPriorityDropdown(event) {
    event.stopPropagation();
    if (!currentTask) return;

    const trigger = event.currentTarget;
    const rect = trigger.getBoundingClientRect();

    closeModalDropdowns();
    if (typeof closeAllDropdowns === 'function') closeAllDropdowns();

    // Get priority options dynamically
    const priorityOptions = typeof PropertyRegistry !== 'undefined'
        ? PropertyRegistry.getPriorityOptions()
        : { low: { label: 'Low', color: '#6b7280' }, medium: { label: 'Medium', color: '#f59e0b' }, high: { label: 'High', color: '#ef4444' } };

    const dropdown = document.createElement('div');
    dropdown.className = 'custom-dropdown priority-dropdown';

    const clearOption = currentTask.priority ? `
        <div class="dropdown-item priority-option clear-option" onclick="selectTaskDetailPriority(null)">
            <span style="color: var(--text-muted)">Clear priority</span>
        </div>
    ` : '';

    dropdown.innerHTML = clearOption + Object.entries(priorityOptions).map(([key, config]) => `
        <div class="dropdown-item priority-option ${key === currentTask.priority ? 'selected' : ''}"
             onclick="selectTaskDetailPriority('${key}')">
            <span class="priority-pill" style="background-color: ${config.color}20; color: ${config.color}; border: 1px solid ${config.color}40">
                ${config.label}
            </span>
        </div>
    `).join('');

    dropdown.style.cssText = `position: fixed; top: ${rect.bottom + 4}px; left: ${rect.left}px; z-index: 10001;`;
    document.body.appendChild(dropdown);

    requestAnimationFrame(() => dropdown.classList.add('dropdown-open'));

    setTimeout(() => {
        const closeHandler = (e) => {
            if (!dropdown.contains(e.target)) {
                dropdown.remove();
                document.removeEventListener('click', closeHandler);
            }
        };
        document.addEventListener('click', closeHandler);
    }, 10);
}

async function selectTaskDetailPriority(priority) {
    closeModalDropdowns();

    if (!currentTask) return;

    // Optimistic update
    currentTask.priority = priority;
    renderPriorityProperty(currentTask);

    // API update
    API.updateTask(currentTask.id, { priority: priority });

    // Also update task table
    if (typeof TaskUpdater !== 'undefined') {
        TaskUpdater.setPriority(currentTask.id, priority);
    }
}

/**
 * Update a task property (legacy)
 */
async function updateTaskProperty(field, value) {
    if (!currentTask) return;

    const { data, error } = await API.updateTask(currentTask.id, { [field]: value });

    if (error) {
        console.error('Failed to update task:', error);
        return;
    }

    if (data?.task) {
        currentTask = data.task;
    }
}

/**
 * Save task changes from modal (debounced)
 */
function saveTaskChanges() {
    if (saveTimeout) {
        clearTimeout(saveTimeout);
    }

    saveTimeout = setTimeout(async () => {
        if (!currentTask) return;

        const updates = {
            name: document.getElementById('taskDetailName')?.value || '',
            description: document.getElementById('taskDetailDescription')?.value || ''
        };

        const { data, error } = await API.updateTask(currentTask.id, updates);
        if (error) {
            console.error('Failed to save task:', error);
        } else {
            currentTask = data.task;
        }
    }, 500);
}

/**
 * Delete the current task
 */
async function deleteCurrentTask() {
    if (!currentTask) return;

    if (!confirm('Are you sure you want to delete this task? This cannot be undone.')) {
        return;
    }

    const { error } = await API.deleteTask(currentTask.id);
    if (error) {
        alert('Failed to delete task: ' + error);
        return;
    }

    closeTaskDetail();
}

/**
 * Escape HTML
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

// Setup event listeners when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
    // Name input - save on blur
    const nameInput = document.getElementById('taskDetailName');
    if (nameInput) {
        nameInput.addEventListener('blur', saveTaskChanges);
        nameInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.target.blur();
            }
        });
    }

    // Description - save on blur
    const descTextarea = document.getElementById('taskDetailDescription');
    if (descTextarea) {
        descTextarea.addEventListener('blur', saveTaskChanges);
    }
});

// Export to global scope
window.openTaskDetail = openTaskDetail;
window.closeTaskDetail = closeTaskDetail;
window.deleteCurrentTask = deleteCurrentTask;
window.loadProjectMembers = loadProjectMembers;
window.handleSubtaskInputKeydown = handleSubtaskInputKeydown;
window.createSubtaskFromInput = createSubtaskFromInput;
window.handleChecklistInputKeydown = handleChecklistInputKeydown;
window.createChecklistItemFromInput = createChecklistItemFromInput;
window.toggleChecklistItem = toggleChecklistItem;
window.deleteChecklistItem = deleteChecklistItem;
window.unlinkClip = unlinkClip;
window.linkClip = linkClip;
window.navigateToClip = navigateToClip;
window.openClipLinkModal = openClipLinkModal;
window.hideClipSelectModal = hideClipSelectModal;
window.filterClipSelectList = filterClipSelectList;
window.toggleClipSelection = toggleClipSelection;
window.confirmClipSelection = confirmClipSelection;
window.openTaskDetailStatusDropdown = openTaskDetailStatusDropdown;
window.openTaskDetailAssigneeDropdown = openTaskDetailAssigneeDropdown;
window.openTaskDetailDatePicker = openTaskDetailDatePicker;
window.openTaskDetailStageDropdown = openTaskDetailStageDropdown;
window.openTaskDetailPriorityDropdown = openTaskDetailPriorityDropdown;
window.selectTaskDetailStatus = selectTaskDetailStatus;
window.selectTaskDetailStage = selectTaskDetailStage;
window.selectTaskDetailPriority = selectTaskDetailPriority;
