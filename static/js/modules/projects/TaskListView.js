/**
 * TaskListView - Complete list/table view for tasks
 *
 * This is THE view file for task list rendering.
 * All rendering, inline editing, column management, and dropdowns are here.
 *
 * Other views (GanttView, BoardView, CalendarView) will follow
 * the same pattern with their own files.
 */
const TaskListView = (function() {

    // ============ Column Types - from PropertyRegistry ============
    const ColumnTypes = PropertyRegistry.Types;

    // ============ Default column configuration - from PropertyRegistry ============
    const defaultColumns = PropertyRegistry.getDefaultColumns();

    // ============ State ============
    let currentColumns = [...defaultColumns];
    let saveTimer = null;
    let resizing = null;

    // Selection state for multi-select
    let selectedTaskIds = new Set();
    let selectModeActive = false;

    // Dropdown states
    let activeAssigneeDropdown = null;
    let activeAssigneeTaskId = null;
    let selectedAssigneeIds = [];
    let activeStatusDropdown = null;
    let activeStatusTaskId = null;
    let activeStageDropdown = null;
    let activeStageTaskId = null;
    let activeSelectDropdown = null;
    let activeSelectTaskId = null;
    let activeSelectField = null;
    let activeDatePicker = null;
    let configColumnsModal = null;

    // ============ Helper Functions ============

    function escapeHtml(str) {
        if (str == null) return '';
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }

    function getContrastTextColor(bgColor) {
        if (!bgColor || bgColor === 'transparent') return 'inherit';
        const hex = bgColor.replace('#', '');
        if (hex.length !== 6) return 'inherit';
        const r = parseInt(hex.substr(0, 2), 16);
        const g = parseInt(hex.substr(2, 2), 16);
        const b = parseInt(hex.substr(4, 2), 16);
        const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
        return luminance > 0.5 ? '#000000' : '#ffffff';
    }

    function getInitials(name) {
        if (!name) return '?';
        return name.split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2);
    }

    // ============ Column Management ============

    function getColumns(projectId) {
        const key = `taskColumns_${projectId}`;
        const stored = localStorage.getItem(key);
        if (stored) {
            try {
                return JSON.parse(stored);
            } catch (e) {
                console.error('Failed to parse stored columns:', e);
            }
        }
        return [...defaultColumns];
    }

    function saveColumns(projectId, columns) {
        const key = `taskColumns_${projectId}`;
        localStorage.setItem(key, JSON.stringify(columns));
    }

    // ============ Header Rendering ============

    function renderTaskTableHeader(columns) {
        const selectHeader = `
            <th class="col-select">
                <input type="checkbox"
                       class="task-select-all cb-dark"
                       id="taskSelectAll"
                       onchange="TaskListView.toggleSelectAll(this.checked)"
                       title="Select all">
            </th>`;
        const expandHeader = `
            <th class="col-actions" style="width: 32px">
                <button class="btn-icon btn-toggle-select ${selectModeActive ? 'active' : ''}"
                        onclick="TaskListView.toggleSelectMode()"
                        title="${selectModeActive ? 'Exit select mode' : 'Select tasks'}">
                    <svg class="icon icon-sm"><use href="/static/icons.svg#icon-check"/></svg>
                </button>
            </th>`;
        const configBtn = `
            <th class="col-config" style="width: 32px">
                <button class="btn-icon btn-config-columns" onclick="TaskListView.showConfigureColumns()" title="Configure columns">
                    <svg class="icon icon-sm"><use href="/static/icons.svg#icon-plus"/></svg>
                </button>
            </th>
        `;

        const sortState = window.TaskFilters ? TaskFilters.getState() : null;
        const sortable = { name: 'name', status: 'status', priority: 'priority', dueDate: 'dueDate' };
        const colHeaders = columns.map(col => {
            const sortField = sortable[col.id];
            const isSorted = sortState && sortField && sortState.sort === sortField;
            const arrow = isSorted ? `<span class="th-sort-arrow">${sortState.dir === 'desc' ? '↓' : '↑'}</span>` : '';
            const labelAttrs = sortField && window.TaskFilters
                ? `class="th-label th-sortable${isSorted ? ' sorted' : ''}" onclick="TaskFilters.sortBy('${sortField}')" title="Sort by ${escapeHtml(col.label)}"`
                : 'class="th-label"';
            return `
            <th class="col-${col.id}" style="width: ${col.width}px; min-width: ${col.minWidth}px">
                <div class="th-content">
                    <span ${labelAttrs}>${escapeHtml(col.label)}${arrow}</span>
                    <div class="resize-handle" data-col="${col.id}"></div>
                </div>
            </th>
        `;
        }).join('');

        return selectHeader + expandHeader + colHeaders + configBtn;
    }

    // ============ Task Hierarchy (delegates to PropertyRegistry) ============

    function getTaskDepth(task) {
        return PropertyRegistry.getDepth(task);
    }

    function hasChildren(task) {
        return PropertyRegistry.hasChildren(task);
    }

    function isSubtask(task) {
        return PropertyRegistry.isSubtask(task);
    }

    // ============ Row Rendering ============

    function renderTaskRow(task, columns, isSubtask = false, depth = 0) {
        const cells = columns.map(col => renderTaskCell(task, col, depth)).join('');
        const isSelected = selectedTaskIds.has(task.id);
        const taskHasChildren = hasChildren(task);
        const isExpanded = (TaskState.expandedTasks || []).includes(task.id);

        const selectCell = `
            <td class="col-select" onclick="event.stopPropagation()">
                <input type="checkbox"
                       class="task-select-checkbox cb-dark"
                       data-task-id="${task.id}"
                       ${isSelected ? 'checked' : ''}
                       onchange="TaskListView.toggleTaskSelection('${task.id}', this.checked)">
            </td>
        `;

        // Col-actions inneholder subtask caret (kun hvis har children)
        const actionsCell = taskHasChildren
            ? `<td class="col-actions" onclick="event.stopPropagation()">
                   <span class="task-expand-caret" onclick="TaskListView.toggleSubtasks('${task.id}', ${depth})" title="${task.childCount} subtask${task.childCount > 1 ? 's' : ''}">
                       <svg class="icon ${isExpanded ? 'rotated' : ''}"><use href="/static/icons.svg#icon-caret-right"/></svg>
                   </span>
               </td>`
            : `<td class="col-actions"></td>`;

        const configCell = `<td class="col-config"></td>`;

        return `
            <tr class="task-row ${isSubtask ? 'subtask-row' : ''} ${isSelected ? 'selected' : ''}" data-task-id="${task.id}" data-parent="${task.parentId || ''}" data-depth="${depth}">
                ${selectCell}
                ${actionsCell}
                ${cells}
                ${configCell}
            </tr>
        `;
    }

    // ============ Cell Rendering ============

    function renderTaskCell(task, col, depth = 0) {
        const value = getTaskValue(task, col.id);

        switch (col.type) {
            case 'text':
                return renderTextCell(task, col, value, depth);
            case 'status':
                return renderStatusCell(task, col, value);
            case 'priority':
                return renderPriorityCell(task, col, value);
            case 'person':
                return renderPersonCell(task, col, value);
            case 'date':
                return renderDateCell(task, col, value);
            case 'select':
                return renderSelectCell(task, col, value);
            default:
                return `<td class="col-${col.id}">${escapeHtml(value || '-')}</td>`;
        }
    }

    function getTaskValue(task, colId) {
        switch (colId) {
            case 'name': return task.name;
            case 'status': return task.status;
            case 'priority': return task.priority || null;
            case 'assignee': return task.assignee;
            case 'dueDate': return task.dueDate;
            case 'stage': return task.stageTag;
            default: return task[colId];
        }
    }

    function renderTextCell(task, col, value, depth = 0) {
        const hasClip = task.clipId;

        // Indent på TD-nivå - kun for subtasks, 24px per depth level
        const indentStyle = depth > 0 ? `padding-left: ${depth * 24}px;` : '';

        // Expand-detail knapp (åpner task detail modal)
        const expandBtn = `
            <button class="btn-icon btn-expand-detail"
                    onclick="event.stopPropagation(); openTaskDetail('${task.id}')"
                    title="Open details">
                <svg class="icon"><use href="/static/icons.svg#icon-arrows-out"/></svg>
            </button>`;

        return `
            <td class="col-${col.id}" style="${indentStyle}" onclick="event.stopPropagation()">
                <div class="task-name-cell">
                    ${hasClip ? '<span class="task-icon clip-icon" title="Linked to clip">🎬</span>' : ''}
                    <input type="text"
                           class="task-inline-input task-name-input"
                           value="${escapeHtml(value || '')}"
                           data-task-id="${task.id}"
                           data-field="name"
                           onblur="TaskListView.saveField(this)"
                           onkeydown="TaskListView.handleKeydown(event, this)">
                    ${expandBtn}
                </div>
            </td>
        `;
    }

    function renderStatusCell(task, col, value) {
        const currentStatus = value;

        let bgColor = 'transparent';
        let textColor = 'var(--text-muted)';
        let displayText = '-';

        if (currentStatus) {
            bgColor = currentStatus.color || 'transparent';
            textColor = getContrastTextColor(bgColor);
            displayText = currentStatus.name;
        }

        return `
            <td class="col-${col.id}" onclick="event.stopPropagation()">
                <div class="dropdown-trigger status-trigger ${currentStatus ? 'has-status' : ''}"
                     data-task-id="${task.id}"
                     data-current-id="${currentStatus?.id || ''}"
                     style="background-color: ${bgColor}; color: ${textColor}"
                     onclick="TaskListView.openStatusDropdown(event, '${task.id}')">
                    ${escapeHtml(displayText)}
                </div>
            </td>
        `;
    }

    function renderPersonCell(task, col, value) {
        const assignees = task.assignees || (value ? [value] : []);

        let displayHtml = '';
        if (assignees.length > 0) {
            const avatars = assignees.slice(0, 3).map(a => {
                if (a.profileImage) {
                    return `<img src="${a.profileImage}" class="assignee-avatar" alt="${escapeHtml(a.name)}" title="${escapeHtml(a.name)}">`;
                } else {
                    return `<span class="assignee-avatar assignee-initials" title="${escapeHtml(a.name)}">${getInitials(a.name)}</span>`;
                }
            }).join('');

            const overflow = assignees.length > 3 ? `<span class="assignee-overflow">+${assignees.length - 3}</span>` : '';
            displayHtml = avatars + overflow;
        } else {
            displayHtml = `<span class="assignee-placeholder" title="Unassigned">
                <svg class="icon icon-sm"><use href="/static/icons.svg#icon-user"/></svg>
            </span>`;
        }

        const currentIds = assignees.map(a => a.id).join(',');

        return `
            <td class="col-${col.id}" onclick="event.stopPropagation()">
                <div class="assignee-cell"
                     data-task-id="${task.id}"
                     data-current-ids="${currentIds}"
                     onclick="TaskListView.openAssigneeDropdown(event, '${task.id}')">
                    ${displayHtml}
                </div>
            </td>
        `;
    }

    function renderDateCell(task, col, value) {
        const isOverdue = value && new Date(value) < new Date().setHours(0,0,0,0);
        const displayText = value ? DatePicker.formatDisplay(value) : '-';

        return `
            <td class="col-${col.id}" onclick="event.stopPropagation()">
                <div class="dropdown-trigger date-trigger ${value ? 'has-value' : ''} ${isOverdue ? 'overdue' : ''}"
                     data-task-id="${task.id}"
                     data-current-date="${value || ''}"
                     onclick="TaskListView.openDateDropdown(event, '${task.id}')">
                    ${escapeHtml(displayText)}
                </div>
            </td>
        `;
    }

    function renderSelectCell(task, col, value) {
        const displayText = value || '-';
        const optionsJson = JSON.stringify(col.options || []).replace(/"/g, '&quot;');

        return `
            <td class="col-${col.id}" onclick="event.stopPropagation()">
                <div class="dropdown-trigger stage-trigger ${value ? 'has-value' : ''}"
                     data-task-id="${task.id}"
                     data-field="${col.id === 'stage' ? 'stageTag' : col.id}"
                     data-current-value="${escapeHtml(value || '')}"
                     data-options="${optionsJson}"
                     onclick="TaskListView.openSelectDropdown(event, '${task.id}', '${col.id}')">
                    ${escapeHtml(displayText)}
                </div>
            </td>
        `;
    }

    function getPriorityConfig() {
        return PropertyRegistry.getPriorityOptions();
    }

    function renderPriorityCell(task, col, value) {
        const priority = value || null;

        if (!priority) {
            return `
                <td class="col-${col.id}" onclick="event.stopPropagation()">
                    <div class="dropdown-trigger priority-trigger priority-none"
                         data-task-id="${task.id}"
                         data-current-value=""
                         onclick="TaskListView.openPriorityDropdown(event, '${task.id}')">
                        <span class="priority-placeholder">-</span>
                    </div>
                </td>
            `;
        }

        const priorityOptions = getPriorityConfig();
        const config = priorityOptions[priority] || priorityOptions.medium || { label: priority, color: '#6b7280' };

        return `
            <td class="col-${col.id}" onclick="event.stopPropagation()">
                <div class="dropdown-trigger priority-trigger priority-${priority}"
                     data-task-id="${task.id}"
                     data-current-value="${priority}"
                     onclick="TaskListView.openPriorityDropdown(event, '${task.id}')">
                    <span class="priority-pill" style="background-color: ${config.color}20; color: ${config.color}; border-color: ${config.color}">
                        ${config.label}
                    </span>
                </div>
            </td>
        `;
    }

    // ============ Quick Add Row ============

    function renderQuickAddRow(columns) {
        return `
            <tr class="task-row task-add-row" onclick="TaskListView.focusQuickAdd()">
                <td class="col-select"></td>
                <td class="col-actions">
                    <span class="quick-add-icon">
                        <svg class="icon icon-sm"><use href="/static/icons.svg#icon-plus"/></svg>
                    </span>
                </td>
                <td colspan="${columns.length}">
                    <input type="text"
                           class="quick-add-input"
                           id="quickAddTaskInput"
                           placeholder="Add new task..."
                           onkeydown="TaskListView.handleQuickAddKeydown(event)">
                </td>
                <td class="col-config"></td>
            </tr>
        `;
    }

    // ============ Main Render ============

    function render(tasks, projectId, isLoading = false) {
        const tableBody = document.getElementById('projectsTableBody');
        const tableHeader = document.getElementById('projectsTableHeader');
        const emptyState = document.getElementById('projectsEmpty');
        const taskTable = document.getElementById('projectsTable');

        if (!tableBody) return;

        // Show loading state immediately
        if (isLoading) {
            if (emptyState) emptyState.classList.add('hidden');
            if (taskTable) taskTable.classList.remove('hidden');

            currentColumns = getColumns(projectId);
            if (tableHeader) {
                tableHeader.innerHTML = renderTaskTableHeader(currentColumns);
                setupResizeHandlers();
            }

            tableBody.innerHTML = `
                <tr class="task-row loading-row">
                    <td colspan="${currentColumns.length + 3}" style="text-align: center; padding: 40px; opacity: 0.6;">
                        <span class="spinner-sm" style="margin-right: 8px;"></span>
                        Loading tasks...
                    </td>
                </tr>
            `;
            return;
        }

        const hasTasks = tasks && tasks.length > 0;
        if (emptyState) {
            emptyState.classList.toggle('hidden', hasTasks);
        }
        if (taskTable) {
            taskTable.classList.toggle('hidden', !hasTasks);
        }

        currentColumns = getColumns(projectId);

        if (tableHeader) {
            tableHeader.innerHTML = renderTaskTableHeader(currentColumns);
            setupResizeHandlers();
        }

        // The task array also holds subtasks of expanded rows; only top-level tasks are rows here
        const allTasks = tasks || [];
        const topLevel = allTasks.filter(t => !t.parentId);
        // Forget expanded state for tasks whose subtasks aren't loaded (e.g. after a reload)
        if (window.TaskState && TaskState.expandedTasks) {
            TaskState.expandedTasks = TaskState.expandedTasks.filter(id => allTasks.some(t => t.parentId === id));
        }
        const view = window.TaskFilters ? TaskFilters.apply(topLevel, projectId) : null;
        if (window.TaskFilters) {
            TaskFilters.renderToolbar(document.getElementById('tasksTableContainer'), view);
            document.getElementById('taskToolbar')?.classList.toggle('hidden', !hasTasks);
        }

        const totalCols = currentColumns.length + 3;
        let rows;
        if (view && view.total > 0 && view.shown === 0) {
            rows = `
                <tr class="task-filter-empty">
                    <td colspan="${totalCols}">
                        No tasks match the current filters.
                        <button class="btn btn-ghost btn-small" onclick="TaskFilters.clear()">Clear filters</button>
                    </td>
                </tr>`;
        } else if (view && view.groups) {
            rows = view.groups.map(group => {
                const collapsed = TaskFilters.isCollapsed(group.key);
                const header = `
                    <tr class="task-group-row ${collapsed ? 'collapsed' : ''}">
                        <td colspan="${totalCols}">
                            <button class="task-group-toggle" onclick="TaskFilters.toggleGroup('${escapeHtml(String(group.key))}')" aria-expanded="${!collapsed}">
                                <svg class="icon icon-sm task-group-caret"><use href="/static/icons.svg#icon-caret-right"/></svg>
                                ${group.color ? `<span class="task-group-dot" style="background:${escapeHtml(group.color)}"></span>` : ''}
                                <span class="task-group-label">${escapeHtml(group.label)}</span>
                                <span class="task-group-count">${group.tasks.length}</span>
                            </button>
                        </td>
                    </tr>`;
                return header + (collapsed ? '' : group.tasks.map(task => renderTaskRow(task, currentColumns)).join(''));
            }).join('');
        } else {
            rows = (view ? view.tasks : topLevel).map(task => renderTaskRow(task, currentColumns)).join('');
        }
        const quickAddRow = renderQuickAddRow(currentColumns);

        tableBody.innerHTML = rows + quickAddRow;
        restoreExpandedSubtasks(tableBody, allTasks);

        // Update bulk action bar visibility
        updateBulkActionBar();
    }

    /**
     * Re-insert subtask rows for tasks that were expanded before a full re-render,
     * using the subtasks already loaded into the task array.
     */
    function restoreExpandedSubtasks(tableBody, allTasks) {
        const expanded = (window.TaskState && TaskState.expandedTasks) || [];
        if (!expanded.length) return;
        const insertChildren = (parentId) => {
            if (!expanded.includes(parentId)) return;
            const parentRow = tableBody.querySelector(`tr.task-row[data-task-id="${parentId}"]`);
            if (!parentRow) return;
            const depth = parseInt(parentRow.dataset.depth || '0', 10) + 1;
            const children = allTasks.filter(t => t.parentId === parentId);
            parentRow.insertAdjacentHTML('afterend', children.map(c => renderTaskRow(c, currentColumns, true, depth)).join(''));
            children.forEach(c => insertChildren(c.id));
        };
        expanded.forEach(id => {
            const task = allTasks.find(t => t.id === id);
            if (task && !task.parentId) insertChildren(id);
        });
    }

    // ============ Bulk Action Bar ============

    function renderBulkActionBar() {
        let bar = document.getElementById('bulkActionBar');
        if (!bar) {
            bar = document.createElement('div');
            bar.id = 'bulkActionBar';
            bar.className = 'bulk-action-bar';
            bar.innerHTML = `
                <div class="bulk-action-info">
                    <span class="bulk-count">0</span> selected
                </div>
                <div class="bulk-actions">
                    <button class="btn btn-ghost btn-sm" onclick="TaskListView.selectAll()">
                        All
                    </button>
                    <button class="btn btn-ghost btn-sm" onclick="TaskListView.clearSelection()">
                        Clear
                    </button>
                    <button class="btn btn-danger btn-sm" onclick="TaskListView.bulkDelete()">
                        <svg class="icon icon-sm"><use href="/static/icons.svg#icon-trash"/></svg>
                        Delete
                    </button>
                </div>
            `;

            // Insert after the task table container
            const tasksContainer = document.querySelector('.tasks-table-container');
            if (tasksContainer) {
                tasksContainer.parentNode.insertBefore(bar, tasksContainer);
            } else {
                // Fallback: insert at beginning of project content
                const projectContent = document.querySelector('.project-content');
                if (projectContent) {
                    projectContent.insertBefore(bar, projectContent.firstChild);
                }
            }
        }
        return bar;
    }

    function updateBulkActionBar() {
        const count = selectedTaskIds.size;
        const bar = renderBulkActionBar();

        if (count > 0) {
            bar.classList.add('visible');
            bar.querySelector('.bulk-count').textContent = count;
        } else {
            bar.classList.remove('visible');
        }

        // Update select all checkbox state
        const selectAllCheckbox = document.getElementById('taskSelectAll');
        if (selectAllCheckbox && window.currentTasks) {
            const visibleTaskIds = window.currentTasks
                .filter(t => !t.parentId)  // Only top-level tasks
                .map(t => t.id);
            const allSelected = visibleTaskIds.length > 0 && visibleTaskIds.every(id => selectedTaskIds.has(id));
            const someSelected = visibleTaskIds.some(id => selectedTaskIds.has(id));

            selectAllCheckbox.checked = allSelected;
            selectAllCheckbox.indeterminate = someSelected && !allSelected;
        }
    }

    // ============ Selection Functions ============

    function toggleTaskSelection(taskId, selected) {
        if (selected) {
            selectedTaskIds.add(taskId);
        } else {
            selectedTaskIds.delete(taskId);
        }

        // Update row styling
        const row = document.querySelector(`tr[data-task-id="${taskId}"]`);
        if (row) {
            row.classList.toggle('selected', selected);
        }

        updateBulkActionBar();
    }

    function toggleSelectAll(checked) {
        if (!window.currentTasks) return;

        // Get all visible task IDs (top-level tasks + expanded subtasks)
        const visibleRows = document.querySelectorAll('tr.task-row[data-task-id]:not(.task-add-row)');

        visibleRows.forEach(row => {
            const taskId = row.dataset.taskId;
            const checkbox = row.querySelector('.task-select-checkbox');

            if (checked) {
                selectedTaskIds.add(taskId);
                row.classList.add('selected');
            } else {
                selectedTaskIds.delete(taskId);
                row.classList.remove('selected');
            }

            if (checkbox) {
                checkbox.checked = checked;
            }
        });

        updateBulkActionBar();
    }

    function selectAll() {
        toggleSelectAll(true);
    }

    function clearSelection() {
        selectedTaskIds.clear();

        // Uncheck all checkboxes
        document.querySelectorAll('.task-select-checkbox').forEach(cb => {
            cb.checked = false;
        });

        // Remove selected class from all rows
        document.querySelectorAll('tr.task-row.selected').forEach(row => {
            row.classList.remove('selected');
        });

        // Uncheck the select-all checkbox
        const selectAllCb = document.getElementById('taskSelectAll');
        if (selectAllCb) {
            selectAllCb.checked = false;
            selectAllCb.indeterminate = false;
        }

        updateBulkActionBar();
    }

    function toggleSelectMode() {
        selectModeActive = !selectModeActive;
        const table = document.getElementById('projectsTable');

        if (table) {
            table.classList.toggle('select-mode-active', selectModeActive);

            // Also directly toggle visibility on all col-select cells as backup
            const selectCells = table.querySelectorAll('.col-select');
            selectCells.forEach(cell => {
                if (selectModeActive) {
                    cell.style.width = '32px';
                    cell.style.minWidth = '32px';
                    cell.style.opacity = '1';
                    cell.style.overflow = 'visible';
                    cell.style.padding = '0 4px';
                    // Show checkbox
                    const checkbox = cell.querySelector('input[type="checkbox"]');
                    if (checkbox) {
                        checkbox.style.visibility = 'visible';
                        checkbox.style.width = '16px';
                        checkbox.style.height = '16px';
                        checkbox.style.display = 'inline-block';
                    }
                } else {
                    cell.style.width = '0';
                    cell.style.minWidth = '0';
                    cell.style.opacity = '0';
                    cell.style.overflow = 'hidden';
                    cell.style.padding = '0';
                    // Hide checkbox
                    const checkbox = cell.querySelector('input[type="checkbox"]');
                    if (checkbox) {
                        checkbox.style.visibility = 'hidden';
                        checkbox.style.width = '0';
                        checkbox.style.display = 'none';
                    }
                }
            });
        }

        // Update the toggle button state
        const toggleBtn = document.querySelector('.btn-toggle-select');
        if (toggleBtn) {
            toggleBtn.classList.toggle('active', selectModeActive);
            toggleBtn.title = selectModeActive ? 'Exit select mode' : 'Select tasks';
        }

        // Clear selection when exiting select mode
        if (!selectModeActive) {
            clearSelection();
        }
    }

    function isSelectModeActive() {
        return selectModeActive;
    }

    // ============ Bulk Delete ============

    async function bulkDelete() {
        const count = selectedTaskIds.size;
        if (count === 0) return;

        // Show confirmation dialog
        const confirmed = await showConfirmDialog(
            'Delete Tasks',
            `Are you sure you want to delete ${count} task${count > 1 ? 's' : ''}? This action cannot be undone.`,
            'Delete',
            'danger'
        );

        if (!confirmed) return;

        const taskIds = Array.from(selectedTaskIds);
        let successCount = 0;
        let errorCount = 0;

        // Delete each task
        for (const taskId of taskIds) {
            const { error } = await API.deleteTask(taskId);
            if (error) {
                console.error('Failed to delete task:', taskId, error);
                errorCount++;
            } else {
                successCount++;
                // Remove from currentTasks
                if (window.currentTasks) {
                    window.currentTasks = window.currentTasks.filter(t => t.id !== taskId);
                }
            }
        }

        // Clear selection
        selectedTaskIds.clear();

        // Re-render
        if (window.currentTasks && currentTasksProjectId) {
            render(window.currentTasks, currentTasksProjectId);
        }

        // Show feedback
        if (typeof showToast === 'function') {
            if (errorCount === 0) {
                showToast(`Deleted ${successCount} task${successCount > 1 ? 's' : ''}`, 'success');
            } else {
                showToast(`Deleted ${successCount}, failed to delete ${errorCount}`, 'warning');
            }
        }
    }

    // Simple confirm dialog helper
    function showConfirmDialog(title, message, confirmText = 'Confirm', variant = 'danger') {
        return new Promise((resolve) => {
            if (typeof Modal === 'undefined') {
                // Fallback to native confirm
                resolve(confirm(message));
                return;
            }

            const modal = new Modal({
                title: title,
                content: `<p style="margin: 0; color: var(--text-secondary)">${message}</p>`,
                footer: `
                    <button class="btn btn-ghost" onclick="this.closest('.modal').modal.close(); this.closest('.modal').modal._resolve(false)">Cancel</button>
                    <button class="btn btn-${variant}" onclick="this.closest('.modal').modal.close(); this.closest('.modal').modal._resolve(true)">${confirmText}</button>
                `,
                size: 'small',
                onClose: () => {
                    resolve(false);
                }
            });

            modal._resolve = resolve;
            modal.open();

            // Store modal reference on element
            const modalEl = document.querySelector('.modal');
            if (modalEl) {
                modalEl.modal = modal;
            }
        });
    }

    // ============ Field Saving ============

    function saveField(element) {
        const taskId = element.dataset.taskId;
        const field = element.dataset.field;
        let value = element.value;

        if (value === '' && field !== 'name') {
            value = null;
        }

        if (saveTimer) {
            clearTimeout(saveTimer);
        }

        saveTimer = setTimeout(async () => {
            const updates = { [field]: value };
            const { error } = await API.updateTask(taskId, updates);

            if (error) {
                console.error('Failed to save task:', error);
            }
        }, 300);
    }

    function handleKeydown(event, element) {
        if (event.key === 'Enter') {
            event.preventDefault();
            element.blur();
        } else if (event.key === 'Escape') {
            event.preventDefault();
            element.blur();
        } else if (event.key === 'Tab') {
            saveField(element);
        }
    }

    // ============ Quick Add ============

    async function handleQuickAddKeydown(event) {
        if (event.key === 'Enter') {
            event.preventDefault();
            const input = event.target;
            const name = input.value.trim();

            if (!name) return;

            input.value = '';

            if (window.TaskManager) {
                const { task, error } = await TaskManager.createTask({ name });
                if (error) {
                    console.error('Failed to create task:', error);
                    return;
                }
                render(TaskManager.getTasks(), TaskManager.getProjectId());
            } else {
                const tempId = `temp-${Date.now()}`;
                const tempTask = {
                    id: tempId,
                    name: name,
                    projectId: currentTasksProjectId,
                    statusId: null,
                    assignees: [],
                    dueDate: null,
                    _isOptimistic: true
                };

                if (window.currentTasks) {
                    window.currentTasks.push(tempTask);
                    render(window.currentTasks, currentTasksProjectId);
                }

                const { data, error } = await API.createTask(currentTasksProjectId, { name });

                if (error) {
                    console.error('Failed to create task:', error);
                    if (window.currentTasks) {
                        window.currentTasks = window.currentTasks.filter(t => t.id !== tempId);
                        render(window.currentTasks, currentTasksProjectId);
                    }
                    return;
                }

                if (window.currentTasks && data?.task) {
                    const idx = window.currentTasks.findIndex(t => t.id === tempId);
                    if (idx !== -1) {
                        window.currentTasks[idx] = data.task;
                        render(window.currentTasks, currentTasksProjectId);
                    }
                }
            }
        } else if (event.key === 'Escape') {
            event.target.blur();
        }
    }

    function focusQuickAdd() {
        const input = document.getElementById('quickAddTaskInput');
        if (input) {
            input.focus();
        }
    }

    // ============ Priority Dropdown ============

    function openPriorityDropdown(event, taskId) {
        event.stopPropagation();
        closeAllDropdowns();

        const trigger = event.currentTarget;
        const currentValue = trigger.dataset.currentValue || '';

        const priorityOptions = getPriorityConfig();
        const options = Object.entries(priorityOptions).map(([key, config]) => `
            <div class="dropdown-item priority-option ${key === currentValue ? 'selected' : ''}"
                 data-value="${key}"
                 onclick="TaskListView.selectPriority('${taskId}', '${key}')">
                <span class="priority-pill" style="background-color: ${config.color}20; color: ${config.color}; border-color: ${config.color}">
                    ${config.label}
                </span>
            </div>
        `).join('');

        const clearOption = currentValue ? `
            <div class="dropdown-item priority-option clear-option"
                 onclick="TaskListView.selectPriority('${taskId}', null)">
                <span class="priority-placeholder">Clear priority</span>
            </div>
        ` : '';

        const dropdown = document.createElement('div');
        dropdown.className = 'custom-dropdown priority-dropdown';
        dropdown.innerHTML = clearOption + options;

        const rect = trigger.getBoundingClientRect();
        dropdown.style.position = 'fixed';
        dropdown.style.top = rect.bottom + 4 + 'px';
        dropdown.style.left = rect.left + 'px';

        document.body.appendChild(dropdown);

        document.addEventListener('click', handlePriorityDropdownOutsideClick);
        document.addEventListener('keydown', handleDropdownKeydown);
    }

    function handlePriorityDropdownOutsideClick(event) {
        const dropdown = document.querySelector('.priority-dropdown');
        if (dropdown && !dropdown.contains(event.target)) {
            closeAllDropdowns();
        }
    }

    function selectPriority(taskId, priority) {
        closeAllDropdowns();
        TaskUpdater.setPriority(taskId, priority);
    }

    // ============ Assignee Dropdown ============

    function openAssigneeDropdown(event, taskId) {
        event.stopPropagation();
        closeAllDropdowns();

        const cell = event.currentTarget;
        const currentIds = (cell.dataset.currentIds || '').split(',').filter(id => id);
        const members = TaskState.members || [];

        activeAssigneeTaskId = taskId;
        selectedAssigneeIds = [...currentIds];

        const dropdown = document.createElement('div');
        dropdown.className = 'assignee-dropdown';
        dropdown.id = 'assigneeDropdown';

        const memberItems = members.map(m => {
            const isSelected = currentIds.includes(m.id);
            const avatar = m.profileImage
                ? `<img src="${m.profileImage}" class="assignee-dropdown-avatar" alt="">`
                : `<span class="assignee-dropdown-avatar assignee-initials">${getInitials(m.username)}</span>`;

            return `
                <div class="assignee-dropdown-item ${isSelected ? 'selected' : ''}"
                     data-user-id="${m.id}"
                     onclick="TaskListView.toggleAssignee('${m.id}')">
                    <span class="assignee-checkbox">${isSelected ? '☑' : '☐'}</span>
                    ${avatar}
                    <span class="assignee-dropdown-name">${escapeHtml(m.username)}</span>
                </div>
            `;
        }).join('');

        dropdown.innerHTML = `
            <div class="assignee-dropdown-search">
                <input type="text" placeholder="Search..." oninput="TaskListView.filterAssigneeDropdown(this.value)" autofocus>
            </div>
            <div class="assignee-dropdown-list">
                ${currentIds.length > 0 ? `
                    <div class="assignee-dropdown-item unassign"
                         onclick="TaskListView.clearAllAssignees()">
                        <span class="assignee-checkbox"></span>
                        <span class="assignee-dropdown-avatar">
                            <svg class="icon icon-sm"><use href="/static/icons.svg#icon-x"/></svg>
                        </span>
                        <span class="assignee-dropdown-name">Clear all</span>
                    </div>
                ` : ''}
                ${memberItems || '<div class="assignee-dropdown-empty">No users found</div>'}
            </div>
        `;

        const rect = cell.getBoundingClientRect();
        dropdown.style.position = 'fixed';
        dropdown.style.top = rect.bottom + 4 + 'px';
        dropdown.style.left = rect.left + 'px';

        document.body.appendChild(dropdown);
        activeAssigneeDropdown = dropdown;
        dropdown.querySelector('input')?.focus();

        document.addEventListener('click', handleAssigneeDropdownOutsideClick);
        document.addEventListener('keydown', handleAssigneeDropdownKeydown);
    }

    function closeAssigneeDropdown(save = true) {
        if (activeAssigneeDropdown) {
            if (save && activeAssigneeTaskId) {
                saveAssigneeChanges();
            }
            activeAssigneeDropdown.remove();
            activeAssigneeDropdown = null;
        }
        activeAssigneeTaskId = null;
        selectedAssigneeIds = [];
        document.removeEventListener('click', handleAssigneeDropdownOutsideClick);
        document.removeEventListener('keydown', handleAssigneeDropdownKeydown);
    }

    function toggleAssignee(userId) {
        const index = selectedAssigneeIds.indexOf(userId);
        if (index > -1) {
            selectedAssigneeIds.splice(index, 1);
        } else {
            selectedAssigneeIds.push(userId);
        }

        const item = activeAssigneeDropdown?.querySelector(`[data-user-id="${userId}"]`);
        if (item) {
            const isSelected = selectedAssigneeIds.includes(userId);
            item.classList.toggle('selected', isSelected);
            const checkbox = item.querySelector('.assignee-checkbox');
            if (checkbox) {
                checkbox.textContent = isSelected ? '☑' : '☐';
            }
        }
    }

    function clearAllAssignees() {
        selectedAssigneeIds = [];
        closeAssigneeDropdown(true);
    }

    function saveAssigneeChanges() {
        if (!activeAssigneeTaskId) return;
        TaskUpdater.setAssignees(activeAssigneeTaskId, [...selectedAssigneeIds]);
    }

    function handleAssigneeDropdownOutsideClick(event) {
        if (activeAssigneeDropdown && !activeAssigneeDropdown.contains(event.target)) {
            closeAssigneeDropdown();
        }
    }

    function handleAssigneeDropdownKeydown(event) {
        if (event.key === 'Escape') {
            closeAssigneeDropdown();
        }
    }

    function filterAssigneeDropdown(query) {
        if (!activeAssigneeDropdown) return;

        const items = activeAssigneeDropdown.querySelectorAll('.assignee-dropdown-item:not(.unassign)');
        const lowerQuery = query.toLowerCase();

        items.forEach(item => {
            const name = item.querySelector('.assignee-dropdown-name')?.textContent || '';
            item.style.display = name.toLowerCase().includes(lowerQuery) ? '' : 'none';
        });
    }

    // ============ Status Dropdown ============

    function openStatusDropdown(event, taskId) {
        event.stopPropagation();
        closeAllDropdowns();

        const trigger = event.currentTarget;
        const currentId = trigger.dataset.currentId || '';
        const statuses = AppState.statuses || [];

        activeStatusTaskId = taskId;

        const dropdown = document.createElement('div');
        dropdown.className = 'custom-dropdown status-dropdown';
        dropdown.id = 'statusDropdown';

        const statusItems = statuses.map(s => {
            const isSelected = s.id === currentId;
            return `
                <div class="custom-dropdown-item ${isSelected ? 'selected' : ''}"
                     data-status-id="${s.id}">
                    <span class="status-dropdown-color" style="background-color: ${s.color}"></span>
                    <span class="status-dropdown-name">${escapeHtml(s.name)}</span>
                </div>
            `;
        }).join('');

        dropdown._taskId = taskId;

        dropdown.innerHTML = `
            <div class="custom-dropdown-list">
                ${currentId ? `
                    <div class="custom-dropdown-item clear-option" data-clear="true">
                        <span class="status-dropdown-color" style="background: var(--border)"></span>
                        <span class="status-dropdown-name">Clear status</span>
                    </div>
                ` : ''}
                ${statusItems || '<div class="custom-dropdown-empty">No statuses defined</div>'}
            </div>
        `;

        dropdown.addEventListener('click', handleStatusDropdownClick);

        const rect = trigger.getBoundingClientRect();
        dropdown.style.position = 'fixed';
        dropdown.style.top = rect.bottom + 4 + 'px';
        dropdown.style.left = rect.left + 'px';

        document.body.appendChild(dropdown);
        activeStatusDropdown = dropdown;

        document.addEventListener('click', handleStatusDropdownOutsideClick);
        document.addEventListener('keydown', handleDropdownKeydown);
    }

    function handleStatusDropdownClick(event) {
        const item = event.target.closest('.custom-dropdown-item');
        if (!item || !activeStatusDropdown) return;

        const taskId = activeStatusDropdown._taskId;

        if (item.dataset.clear) {
            selectStatus(taskId, '');
        } else if (item.dataset.statusId) {
            selectStatus(taskId, item.dataset.statusId);
        }
    }

    function selectStatus(taskId, statusId) {
        closeAllDropdowns();
        TaskUpdater.setStatus(taskId, statusId);
    }

    function handleStatusDropdownOutsideClick(event) {
        if (activeStatusDropdown && !activeStatusDropdown.contains(event.target)) {
            closeAllDropdowns();
        }
    }

    // ============ Stage Dropdown ============

    function openStageDropdown(event, taskId) {
        event.stopPropagation();
        closeAllDropdowns();

        const trigger = event.currentTarget;
        const task = window.currentTasks?.find(t => t.id === taskId);
        const currentValue = task?.stageTag || '';

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

        activeStageTaskId = taskId;

        const dropdown = document.createElement('div');
        dropdown.className = 'custom-dropdown stage-dropdown';
        dropdown.id = 'stageDropdown';

        const stageItems = Object.entries(stageOptions).map(([key, config]) => {
            const isSelected = key === currentValue;
            return `
                <div class="custom-dropdown-item stage-option ${isSelected ? 'selected' : ''}"
                     data-stage-value="${escapeHtml(key)}">
                    <span class="stage-badge" style="background: ${config.color}; color: ${getContrastTextColor(config.color)}">${escapeHtml(config.label)}</span>
                </div>
            `;
        }).join('');

        dropdown._taskId = taskId;

        dropdown.innerHTML = `
            <div class="custom-dropdown-list">
                ${currentValue ? `
                    <div class="custom-dropdown-item clear-option" data-clear="true">
                        <span style="color: var(--text-muted)">Clear stage</span>
                    </div>
                ` : ''}
                ${stageItems}
            </div>
        `;

        dropdown.addEventListener('click', handleStageDropdownClick);

        const rect = trigger.getBoundingClientRect();
        dropdown.style.position = 'fixed';
        dropdown.style.top = rect.bottom + 4 + 'px';
        dropdown.style.left = rect.left + 'px';

        document.body.appendChild(dropdown);
        activeStageDropdown = dropdown;

        document.addEventListener('click', handleStageDropdownOutsideClick);
    }

    function handleStageDropdownClick(event) {
        const item = event.target.closest('.custom-dropdown-item');
        if (!item || !activeStageDropdown) return;

        const taskId = activeStageDropdown._taskId;

        if (item.dataset.clear) {
            selectStage(taskId, null);
        } else {
            const value = item.dataset.stageValue;
            selectStage(taskId, value);
        }

        closeStageDropdown();
    }

    function handleStageDropdownOutsideClick(event) {
        if (activeStageDropdown && !activeStageDropdown.contains(event.target)) {
            closeStageDropdown();
        }
    }

    function closeStageDropdown() {
        if (activeStageDropdown) {
            activeStageDropdown.remove();
            activeStageDropdown = null;
            activeStageTaskId = null;
            document.removeEventListener('click', handleStageDropdownOutsideClick);
        }
    }

    async function selectStage(taskId, value) {
        const task = window.currentTasks?.find(t => t.id === taskId);
        if (!task) return;

        task.stageTag = value;
        render(window.currentTasks, currentTasksProjectId);

        const { error } = await API.updateTask(taskId, { stageTag: value });
        if (error) {
            console.error('Failed to update stage:', error);
            showToast?.('Failed to update stage', 'error');
        }
    }

    // ============ Select Dropdown ============

    function openSelectDropdown(event, taskId, colId) {
        event.stopPropagation();
        closeAllDropdowns();

        const trigger = event.currentTarget;
        const currentValue = trigger.dataset.currentValue || '';
        const field = trigger.dataset.field || colId;

        let options = [];
        try {
            options = JSON.parse(trigger.dataset.options || '[]');
        } catch (e) {
            const col = currentColumns.find(c => c.id === colId);
            options = col?.options || [];
        }

        activeSelectTaskId = taskId;
        activeSelectField = field;

        const dropdown = document.createElement('div');
        dropdown.className = 'custom-dropdown select-dropdown';
        dropdown.id = 'selectDropdown';

        const optionItems = options.map((opt, index) => {
            const isSelected = opt === currentValue;
            return `
                <div class="custom-dropdown-item ${isSelected ? 'selected' : ''}"
                     data-option-index="${index}"
                     data-option-value="${escapeHtml(opt)}">
                    <span>${escapeHtml(opt)}</span>
                </div>
            `;
        }).join('');

        dropdown._options = options;
        dropdown._taskId = taskId;
        dropdown._field = field;

        dropdown.innerHTML = `
            <div class="custom-dropdown-list">
                ${currentValue ? `
                    <div class="custom-dropdown-item clear-option" data-clear="true">
                        <span>Clear</span>
                    </div>
                ` : ''}
                ${optionItems || '<div class="custom-dropdown-empty">No options</div>'}
            </div>
        `;

        dropdown.addEventListener('click', handleSelectDropdownClick);

        const rect = trigger.getBoundingClientRect();
        dropdown.style.position = 'fixed';
        dropdown.style.top = rect.bottom + 4 + 'px';
        dropdown.style.left = rect.left + 'px';

        document.body.appendChild(dropdown);
        activeSelectDropdown = dropdown;

        document.addEventListener('click', handleSelectDropdownOutsideClick);
        document.addEventListener('keydown', handleDropdownKeydown);
    }

    function handleSelectDropdownClick(event) {
        const item = event.target.closest('.custom-dropdown-item');
        if (!item || !activeSelectDropdown) return;

        const taskId = activeSelectDropdown._taskId;
        const field = activeSelectDropdown._field;

        if (item.dataset.clear) {
            selectOption(taskId, field, '');
        } else if (item.dataset.optionIndex !== undefined) {
            const index = parseInt(item.dataset.optionIndex);
            const value = activeSelectDropdown._options[index];
            selectOption(taskId, field, value);
        }
    }

    function selectOption(taskId, field, value) {
        closeAllDropdowns();
        TaskUpdater.updateAsync(taskId, field, value || null);
    }

    function handleSelectDropdownOutsideClick(event) {
        if (activeSelectDropdown && !activeSelectDropdown.contains(event.target)) {
            closeAllDropdowns();
        }
    }

    // ============ Date Picker Dropdown ============

    function openDateDropdown(event, taskId) {
        event.stopPropagation();
        closeAllDropdowns();

        const trigger = event.currentTarget;
        const currentDate = trigger.dataset.currentDate || null;

        activeDatePicker = new DatePicker({
            id: 'taskDatePicker',
            value: currentDate,
            onSelect: (date) => TaskUpdater.setDueDate(taskId, date),
            onClose: () => { activeDatePicker = null; }
        });

        activeDatePicker.open(trigger);
    }

    // ============ Close All Dropdowns ============

    function closeAllDropdowns() {
        if (activeStatusDropdown) {
            activeStatusDropdown.remove();
            activeStatusDropdown = null;
            activeStatusTaskId = null;
        }

        const priorityDropdown = document.querySelector('.priority-dropdown');
        if (priorityDropdown) {
            priorityDropdown.remove();
        }
        document.removeEventListener('click', handlePriorityDropdownOutsideClick);

        if (activeStageDropdown) {
            activeStageDropdown.remove();
            activeStageDropdown = null;
            activeStageTaskId = null;
        }
        document.removeEventListener('click', handleStageDropdownOutsideClick);

        if (activeSelectDropdown) {
            activeSelectDropdown.remove();
            activeSelectDropdown = null;
            activeSelectTaskId = null;
            activeSelectField = null;
        }

        if (activeAssigneeDropdown) {
            closeAssigneeDropdown(false);
        }

        if (activeDatePicker) {
            activeDatePicker.close();
            activeDatePicker = null;
        }

        if (typeof DatePicker !== 'undefined') {
            DatePicker.closeAll();
        }

        document.removeEventListener('click', handleStatusDropdownOutsideClick);
        document.removeEventListener('click', handleSelectDropdownOutsideClick);
        document.removeEventListener('keydown', handleDropdownKeydown);
    }

    function handleDropdownKeydown(event) {
        if (event.key === 'Escape') {
            closeAllDropdowns();
        }
    }

    // ============ Subtask Expansion ============

    async function toggleSubtasks(taskId, depth = 1) {
        const expandedTasks = TaskState.expandedTasks || [];
        const isExpanded = expandedTasks.includes(taskId);

        if (isExpanded) {
            collapseTaskAndDescendants(taskId);
        } else {
            TaskState.expandedTasks = [...expandedTasks, taskId];

            const { data, error } = await API.getTasks(currentTasksProjectId, { parentId: taskId });
            if (error) {
                console.error('Failed to load subtasks:', error);
                return;
            }

            const subtasks = data?.tasks || [];
            if (subtasks.length === 0) return;

            // Add subtasks to currentTasks so TaskUpdater can find them
            if (window.currentTasks) {
                subtasks.forEach(subtask => {
                    if (!window.currentTasks.find(t => t.id === subtask.id)) {
                        window.currentTasks.push(subtask);
                    }
                });
            }

            const parentRow = document.querySelector(`tr[data-task-id="${taskId}"]`);
            if (parentRow) {
                const childDepth = depth + 1;
                const subtaskHtml = subtasks.map(task => renderTaskRow(task, currentColumns, true, childDepth)).join('');
                parentRow.insertAdjacentHTML('afterend', subtaskHtml);
            }

            const caret = document.querySelector(`tr[data-task-id="${taskId}"] .task-expand-caret`);
            if (caret) caret.classList.add('expanded');
        }
    }

    function collapseTaskAndDescendants(taskId) {
        const expandedTasks = TaskState.expandedTasks || [];

        const subtaskRows = document.querySelectorAll(`tr[data-parent="${taskId}"]`);

        subtaskRows.forEach(row => {
            const subtaskId = row.dataset.taskId;
            if (expandedTasks.includes(subtaskId)) {
                collapseTaskAndDescendants(subtaskId);
            }
            row.remove();

            // Remove subtask from currentTasks
            if (window.currentTasks) {
                window.currentTasks = window.currentTasks.filter(t => t.id !== subtaskId);
            }
        });

        TaskState.expandedTasks = expandedTasks.filter(id => id !== taskId);

        const caret = document.querySelector(`tr[data-task-id="${taskId}"] .task-expand-caret`);
        if (caret) caret.classList.remove('expanded');
    }

    // ============ Column Configuration ============

    function showConfigureColumns() {
        const allColumns = [...defaultColumns];
        currentColumns.forEach(col => {
            if (col.custom && !allColumns.some(c => c.id === col.id)) {
                allColumns.push(col);
            }
        });

        const columnsHtml = allColumns.map(col => {
            const isActive = currentColumns.some(c => c.id === col.id);
            const isFixed = col.fixed;
            const isCustom = col.custom;

            return `
                <label class="column-config-item ${isFixed ? 'disabled' : ''}" ${isFixed ? 'title="This column cannot be hidden"' : ''}>
                    <input type="checkbox"
                           ${isActive ? 'checked' : ''}
                           ${isFixed ? 'disabled' : ''}
                           data-col-id="${col.id}"
                           onchange="TaskListView.toggleColumn('${col.id}', this.checked)">
                    <span class="column-config-label">${escapeHtml(col.label)}</span>
                    <span class="column-config-type">${col.type}</span>
                    ${isCustom ? `<button class="btn-icon btn-delete-col" onclick="event.preventDefault(); TaskListView.deleteCustomColumn('${col.id}')" title="Delete column">
                        <svg class="icon icon-xs"><use href="/static/icons.svg#icon-x"/></svg>
                    </button>` : ''}
                </label>
            `;
        }).join('');

        configColumnsModal = new Modal({
            title: 'Configure Columns',
            content: `
                <div class="columns-list" id="columnsConfigList">
                    ${columnsHtml}
                </div>
                <div class="add-column-section">
                    <div class="add-column-header">Add New Column</div>
                    <div class="add-column-form">
                        <input type="text" id="newColumnName" placeholder="Column name" class="add-column-input">
                        <select id="newColumnType" class="add-column-select">
                            <option value="text">Text</option>
                            <option value="number">Number</option>
                            <option value="date">Date</option>
                            <option value="select">Dropdown</option>
                            <option value="checkbox">Checkbox</option>
                        </select>
                        <button class="btn btn-ghost btn-sm" onclick="TaskListView.addNewColumn()">
                            <svg class="icon icon-sm"><use href="/static/icons.svg#icon-plus"/></svg>
                        </button>
                    </div>
                </div>
            `,
            footer: `
                <button class="btn btn-ghost" onclick="TaskListView.resetColumnsToDefault()">Reset</button>
                <button class="btn btn-primary" onclick="TaskListView.hideConfigColumnsModal()">Done</button>
            `,
            size: 'small',
            onClose: () => {
                configColumnsModal = null;
            }
        });
        configColumnsModal.open();
    }

    function hideConfigColumnsModal() {
        if (configColumnsModal) {
            configColumnsModal.close();
            configColumnsModal = null;
        }
    }

    function toggleColumn(colId, enabled) {
        const col = defaultColumns.find(c => c.id === colId);
        if (!col || col.fixed) return;

        if (enabled) {
            if (!currentColumns.some(c => c.id === colId)) {
                const defaultIndex = defaultColumns.findIndex(c => c.id === colId);
                let insertIndex = currentColumns.length;

                for (let i = 0; i < currentColumns.length; i++) {
                    const currentDefaultIndex = defaultColumns.findIndex(c => c.id === currentColumns[i].id);
                    if (currentDefaultIndex > defaultIndex) {
                        insertIndex = i;
                        break;
                    }
                }

                currentColumns.splice(insertIndex, 0, { ...col });
            }
        } else {
            currentColumns = currentColumns.filter(c => c.id !== colId);
        }

        if (currentTasksProjectId) {
            saveColumns(currentTasksProjectId, currentColumns);
            loadProjectsTasks();
        }
    }

    function resetColumnsToDefault() {
        currentColumns = [...defaultColumns];

        if (currentTasksProjectId) {
            const key = `taskColumns_${currentTasksProjectId}`;
            localStorage.removeItem(key);
            loadProjectsTasks();
        }

        hideConfigColumnsModal();
    }

    function deleteCustomColumn(colId) {
        currentColumns = currentColumns.filter(c => c.id !== colId);

        if (currentTasksProjectId) {
            saveColumns(currentTasksProjectId, currentColumns);
            loadProjectsTasks();
        }

        showConfigureColumns();
    }

    function addNewColumn() {
        const nameInput = document.getElementById('newColumnName');
        const typeSelect = document.getElementById('newColumnType');

        const name = nameInput?.value?.trim();
        const type = typeSelect?.value;

        if (!name) {
            nameInput?.focus();
            return;
        }

        const id = 'custom_' + name.toLowerCase().replace(/\s+/g, '_') + '_' + Date.now();

        const newCol = {
            id: id,
            label: name,
            type: type,
            width: 120,
            minWidth: 80,
            custom: true
        };

        if (type === 'select') {
            newCol.options = ['Option 1', 'Option 2', 'Option 3'];
        }

        currentColumns.push(newCol);

        if (currentTasksProjectId) {
            saveColumns(currentTasksProjectId, currentColumns);
            loadProjectsTasks();
        }

        nameInput.value = '';

        showConfigureColumns();
    }

    // ============ Resize Handlers ============

    function setupResizeHandlers() {
        const handles = document.querySelectorAll('.resize-handle');

        handles.forEach(handle => {
            handle.addEventListener('mousedown', startResize);
        });
    }

    function startResize(e) {
        e.preventDefault();
        const colId = e.target.dataset.col;
        const th = e.target.closest('th');

        resizing = {
            colId,
            th,
            startX: e.clientX,
            startWidth: th.offsetWidth
        };

        document.addEventListener('mousemove', doResize);
        document.addEventListener('mouseup', stopResize);
        document.body.style.cursor = 'col-resize';
    }

    function doResize(e) {
        if (!resizing) return;

        const diff = e.clientX - resizing.startX;
        const col = currentColumns.find(c => c.id === resizing.colId);

        if (col) {
            const newWidth = Math.max(col.minWidth, resizing.startWidth + diff);
            resizing.th.style.width = newWidth + 'px';
            col.width = newWidth;
        }
    }

    function stopResize() {
        if (resizing && currentTasksProjectId) {
            saveColumns(currentTasksProjectId, currentColumns);
        }

        resizing = null;
        document.removeEventListener('mousemove', doResize);
        document.removeEventListener('mouseup', stopResize);
        document.body.style.cursor = '';
    }

    // ============ Single Row Update (for optimistic UI without full re-render) ============

    /**
     * Update a single row in the table without re-rendering everything.
     * This preserves expanded subtasks and their indent.
     *
     * @param {string} taskId - The task ID to update
     */
    function updateRow(taskId) {
        const row = document.querySelector(`tr.task-row[data-task-id="${taskId}"]`);
        if (!row) return;

        const task = window.currentTasks?.find(t => t.id === taskId);
        if (!task) return;

        // Get depth from data attribute (preserved from original render)
        const depth = parseInt(row.dataset.depth || '0', 10);
        const isSubtaskRow = row.classList.contains('subtask-row');

        // Re-render just this row
        const newRowHtml = renderTaskRow(task, currentColumns, isSubtaskRow, depth);

        // Create a temp container to parse the HTML
        const temp = document.createElement('tbody');
        temp.innerHTML = newRowHtml;
        const newRow = temp.firstElementChild;

        // Replace the old row with the new one
        row.replaceWith(newRow);
    }

    /**
     * Refresh the parent task's childCount display after subtask changes
     * @param {string} parentId - The parent task ID
     */
    function refreshParentRow(parentId) {
        if (!parentId) return;

        const parentTask = window.currentTasks?.find(t => t.id === parentId);
        if (parentTask) {
            updateRow(parentId);
        }
    }

    // ============ Public API ============

    return {
        // Main
        render,
        updateRow,
        refreshParentRow,
        ColumnTypes,

        // Field editing
        saveField,
        handleKeydown,
        handleQuickAddKeydown,
        focusQuickAdd,

        // Subtasks
        toggleSubtasks,

        // Multi-select
        toggleSelectMode,
        isSelectModeActive,
        toggleTaskSelection,
        toggleSelectAll,
        selectAll,
        clearSelection,
        bulkDelete,

        // Priority dropdown
        openPriorityDropdown,
        selectPriority,

        // Assignee dropdown
        openAssigneeDropdown,
        closeAssigneeDropdown,
        toggleAssignee,
        clearAllAssignees,
        filterAssigneeDropdown,

        // Status dropdown
        openStatusDropdown,
        selectStatus,

        // Stage dropdown
        openStageDropdown,
        selectStage,

        // Select dropdown
        openSelectDropdown,
        selectOption,

        // Date dropdown
        openDateDropdown,

        // Utilities
        closeAllDropdowns,

        // Column configuration
        showConfigureColumns,
        hideConfigColumnsModal,
        toggleColumn,
        resetColumnsToDefault,
        deleteCustomColumn,
        addNewColumn
    };

})();

// Export to global scope
window.TaskListView = TaskListView;

// Legacy compatibility - map old function names to TaskListView
window.renderTaskTable = function(tasks, projectId, isLoading) {
    TaskListView.render(tasks, projectId, isLoading);
};
window.saveTaskField = function(el) { TaskListView.saveField(el); };
window.handleInlineKeydown = function(e, el) { TaskListView.handleKeydown(e, el); };
window.handleQuickAddKeydown = function(e) { TaskListView.handleQuickAddKeydown(e); };
window.focusQuickAdd = function() { TaskListView.focusQuickAdd(); };
window.toggleSubtasks = function(id, d) { TaskListView.toggleSubtasks(id, d); };
window.showConfigureColumns = function() { TaskListView.showConfigureColumns(); };
window.hideConfigColumnsModal = function() { TaskListView.hideConfigColumnsModal(); };
window.toggleColumn = function(id, e) { TaskListView.toggleColumn(id, e); };
window.resetColumnsToDefault = function() { TaskListView.resetColumnsToDefault(); };
window.deleteCustomColumn = function(id) { TaskListView.deleteCustomColumn(id); };
window.addNewColumn = function() { TaskListView.addNewColumn(); };
window.openAssigneeDropdown = function(e, id) { TaskListView.openAssigneeDropdown(e, id); };
window.closeAssigneeDropdown = function(s) { TaskListView.closeAssigneeDropdown(s); };
window.filterAssigneeDropdown = function(q) { TaskListView.filterAssigneeDropdown(q); };
window.toggleAssignee = function(id) { TaskListView.toggleAssignee(id); };
window.clearAllAssignees = function() { TaskListView.clearAllAssignees(); };
window.openStatusDropdown = function(e, id) { TaskListView.openStatusDropdown(e, id); };
window.selectStatus = function(id, sid) { TaskListView.selectStatus(id, sid); };
window.openStageDropdown = function(e, id) { TaskListView.openStageDropdown(e, id); };
window.selectStage = function(id, v) { TaskListView.selectStage(id, v); };
window.openSelectDropdown = function(e, id, c) { TaskListView.openSelectDropdown(e, id, c); };
window.selectOption = function(id, f, v) { TaskListView.selectOption(id, f, v); };
window.openDateDropdown = function(e, id) { TaskListView.openDateDropdown(e, id); };
window.closeAllDropdowns = function() { TaskListView.closeAllDropdowns(); };
window.openPriorityDropdown = function(e, id) { TaskListView.openPriorityDropdown(e, id); };
window.selectPriority = function(id, p) { TaskListView.selectPriority(id, p); };
window.ColumnTypes = TaskListView.ColumnTypes;
