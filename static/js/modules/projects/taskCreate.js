/**
 * Task Create Modal functionality
 * Handles showing and submitting the create task modal
 */

/**
 * Show the create task modal
 */
async function showCreateTask() {
    if (!currentTasksProjectId) {
        alert('Please select a project first');
        return;
    }

    const modal = document.getElementById('createTaskModal');
    if (!modal) {
        console.error('Create task modal not found');
        return;
    }

    // Load project members for assignee dropdown
    await loadProjectMembers(currentTasksProjectId);

    // Populate dropdowns
    populateCreateTaskDropdowns();

    // Reset form
    document.getElementById('newTaskName').value = '';
    document.getElementById('newTaskStatus').value = '';
    document.getElementById('newTaskAssignee').value = '';
    document.getElementById('newTaskDueDate').value = '';
    document.getElementById('newTaskStage').value = '';

    // Show modal
    modal.classList.remove('hidden');

    // Focus name input
    setTimeout(() => {
        document.getElementById('newTaskName')?.focus();
    }, 100);

    // Add keyboard listener
    document.addEventListener('keydown', handleCreateTaskKeydown);
}

/**
 * Hide the create task modal
 */
function hideCreateTaskModal() {
    const modal = document.getElementById('createTaskModal');
    if (modal) {
        modal.classList.add('hidden');
    }
    document.removeEventListener('keydown', handleCreateTaskKeydown);
}

/**
 * Handle keyboard events for create task modal
 */
function handleCreateTaskKeydown(e) {
    if (e.key === 'Escape') {
        hideCreateTaskModal();
    } else if (e.key === 'Enter' && e.target.id === 'newTaskName') {
        submitCreateTask();
    }
}

/**
 * Populate dropdowns in create task modal
 */
function populateCreateTaskDropdowns() {
    // Status dropdown
    const statusSelect = document.getElementById('newTaskStatus');
    if (statusSelect) {
        const statuses = AppState.statuses || [];
        statusSelect.innerHTML = '<option value="">No status</option>';
        statuses.forEach(status => {
            const option = document.createElement('option');
            option.value = status.id;
            option.textContent = status.name;
            statusSelect.appendChild(option);
        });
    }

    // Assignee dropdown
    const assigneeSelect = document.getElementById('newTaskAssignee');
    if (assigneeSelect) {
        const members = TaskState.members || [];
        assigneeSelect.innerHTML = '<option value="">Unassigned</option>';
        members.forEach(member => {
            const option = document.createElement('option');
            option.value = member.id;
            option.textContent = member.username;
            assigneeSelect.appendChild(option);
        });
    }
}

/**
 * Submit the create task form
 */
async function submitCreateTask() {
    const name = document.getElementById('newTaskName')?.value?.trim();

    if (!name) {
        alert('Please enter a task name');
        document.getElementById('newTaskName')?.focus();
        return;
    }

    const taskData = {
        name: name,
        statusId: document.getElementById('newTaskStatus')?.value || null,
        assigneeId: document.getElementById('newTaskAssignee')?.value || null,
        dueDate: document.getElementById('newTaskDueDate')?.value || null,
        stageTag: document.getElementById('newTaskStage')?.value || null
    };

    // Close modal immediately (feels snappier)
    hideCreateTaskModal();

    // Use TaskManager if available
    if (window.TaskManager) {
        const { task, error } = await TaskManager.createTask(taskData);

        if (error) {
            console.error('Failed to create task:', error);
            alert('Failed to create task: ' + error);
            return;
        }

        // Re-render using TaskManager data
        if (typeof renderTaskTable === 'function') {
            renderTaskTable(TaskManager.getTasks(), TaskManager.getProjectId());
        }
    } else {
        // Fallback: Optimistic UI
        const tempId = `temp-${Date.now()}`;
        const tempTask = {
            id: tempId,
            name: name,
            projectId: currentTasksProjectId,
            statusId: taskData.statusId,
            assignees: [],
            dueDate: taskData.dueDate,
            stageTag: taskData.stageTag,
            _isOptimistic: true
        };

        // Add to current tasks and re-render
        if (window.currentTasks && typeof renderTaskTable === 'function') {
            window.currentTasks.push(tempTask);
            renderTaskTable(window.currentTasks, currentTasksProjectId);
        }

        // Create task in background
        const { data, error } = await API.createTask(currentTasksProjectId, taskData);

        if (error) {
            console.error('Failed to create task:', error);
            // Remove optimistic task on error
            if (window.currentTasks) {
                window.currentTasks = window.currentTasks.filter(t => t.id !== tempId);
                if (typeof renderTaskTable === 'function') {
                    renderTaskTable(window.currentTasks, currentTasksProjectId);
                }
            }
            alert('Failed to create task: ' + error);
            return;
        }

        // Replace temp task with real task
        if (window.currentTasks && data?.task) {
            const idx = window.currentTasks.findIndex(t => t.id === tempId);
            if (idx !== -1) {
                window.currentTasks[idx] = data.task;
                if (typeof renderTaskTable === 'function') {
                    renderTaskTable(window.currentTasks, currentTasksProjectId);
                }
            }
        }
    }
}

// Export to global scope
window.showCreateTask = showCreateTask;
window.hideCreateTaskModal = hideCreateTaskModal;
window.submitCreateTask = submitCreateTask;
