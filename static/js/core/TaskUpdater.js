/**
 * TaskUpdater - Optimistic UI updates for tasks
 *
 * Abstracts the pattern of:
 * 1. Update in-memory immediately
 * 2. Re-render UI
 * 3. API call in background
 * 4. Revert on error
 *
 * Usage:
 *   TaskUpdater.update(taskId, 'priority', 'high');
 *   TaskUpdater.update(taskId, 'status', { id: 'abc', name: 'Done', color: '#22c55e' });
 *   TaskUpdater.update(taskId, 'assignees', [user1, user2]);
 */
const TaskUpdater = (function() {

    // ============ Configuration ============

    // Field transformations for API calls
    const fieldConfig = {
        priority: {
            apiField: 'priority',
            getValue: (task) => task.priority,
            setValue: (task, value) => { task.priority = value; }
        },
        status: {
            apiField: 'statusId',
            getValue: (task) => task.status,
            setValue: (task, value) => {
                if (typeof value === 'string') {
                    // Just an ID - look up the status
                    task.statusId = value || null;
                    task.status = value ? (AppState.statuses?.find(s => s.id === value) || null) : null;
                } else {
                    // Full status object
                    task.status = value;
                    task.statusId = value?.id || null;
                }
            },
            transformForApi: (value) => {
                if (typeof value === 'string') return value || null;
                return value?.id || null;
            }
        },
        assignees: {
            apiField: 'assigneeIds',
            getValue: (task) => task.assignees ? [...task.assignees] : [],
            setValue: (task, value) => {
                if (Array.isArray(value) && value.length > 0 && typeof value[0] === 'string') {
                    // Array of IDs - look up members
                    const members = window.TaskState?.members || [];
                    task.assignees = value.map(id => members.find(m => m.id === id)).filter(Boolean);
                } else {
                    // Array of user objects
                    task.assignees = value || [];
                }
            },
            transformForApi: (value) => {
                if (!value || !Array.isArray(value)) return [];
                if (value.length > 0 && typeof value[0] === 'string') return value;
                return value.map(a => a.id);
            }
        },
        dueDate: {
            apiField: 'dueDate',
            getValue: (task) => task.dueDate,
            setValue: (task, value) => { task.dueDate = value; }
        },
        stageTag: {
            apiField: 'stageTag',
            getValue: (task) => task.stageTag,
            setValue: (task, value) => { task.stageTag = value || null; }
        },
        name: {
            apiField: 'name',
            getValue: (task) => task.name,
            setValue: (task, value) => { task.name = value; }
        },
        description: {
            apiField: 'description',
            getValue: (task) => task.description,
            setValue: (task, value) => { task.description = value; }
        }
    };

    // ============ Core Functions ============

    /**
     * Get task from TaskManager or fallback
     */
    function getTask(taskId) {
        return TaskManager?.getTask(taskId) || window.currentTasks?.find(t => t.id === taskId);
    }

    /**
     * Get all tasks
     */
    function getTasks() {
        return TaskManager?.getTasks() || window.currentTasks || [];
    }

    /**
     * Get current project ID
     */
    function getProjectId() {
        return TaskManager?.getProjectId() || window.currentTasksProjectId;
    }

    /**
     * Re-render the full task table (use sparingly - prefer updateRow)
     */
    function render() {
        if (typeof renderTaskTable === 'function') {
            renderTaskTable(getTasks(), getProjectId());
        }
    }

    /**
     * Update just a single row (preserves expanded subtasks)
     */
    function updateRow(taskId) {
        if (typeof TaskListView !== 'undefined' && TaskListView.updateRow) {
            TaskListView.updateRow(taskId);
        } else {
            // Fallback to full render if updateRow not available
            render();
        }
    }

    /**
     * Main update function with optimistic UI
     *
     * @param {string} taskId - The task ID to update
     * @param {string} field - The field name (e.g., 'priority', 'status', 'assignees')
     * @param {any} value - The new value
     * @param {Object} options - Optional settings
     * @param {boolean} options.skipRender - Don't re-render after update
     * @param {Function} options.onSuccess - Callback on successful API update
     * @param {Function} options.onError - Callback on API error
     * @returns {Promise<{success: boolean, error?: string}>}
     */
    function notifySaveError(error) {
        if (typeof Toast !== 'undefined' && Toast.error) {
            Toast.error(`Couldn't save change: ${error}`);
        }
    }

    async function update(taskId, field, value, options = {}) {
        const config = fieldConfig[field];
        if (!config) {
            console.warn(`TaskUpdater: Unknown field "${field}"`);
            // Fallback to generic update
            return updateGeneric(taskId, field, value, options);
        }

        const task = getTask(taskId);
        if (!task) {
            console.error(`TaskUpdater: Task not found: ${taskId}`);
            return { success: false, error: 'Task not found' };
        }

        // Store old value for rollback
        const oldValue = config.getValue(task);

        // Optimistic update
        config.setValue(task, value);

        // Update just this row (preserves expanded subtasks)
        if (!options.skipRender) {
            updateRow(taskId);
        }

        // Prepare API payload
        const apiValue = config.transformForApi ? config.transformForApi(value) : value;
        const payload = { [config.apiField]: apiValue };

        // API call in background
        try {
            let result;
            if (window.TaskManager) {
                // Use TaskManager's updateField which has its own logic
                result = await API.updateTask(taskId, payload);
            } else {
                result = await API.updateTask(taskId, payload);
            }

            if (result.error) {
                // Revert on error
                config.setValue(task, oldValue);
                if (!options.skipRender) updateRow(taskId);
                notifySaveError(result.error);
                if (options.onError) options.onError(result.error);
                return { success: false, error: result.error };
            }

            if (options.onSuccess) options.onSuccess(result);
            return { success: true };

        } catch (error) {
            // Revert on exception
            config.setValue(task, oldValue);
            if (!options.skipRender) updateRow(taskId);
            console.error(`TaskUpdater: Failed to update ${field}:`, error);
            if (options.onError) options.onError(error);
            return { success: false, error: error.message };
        }
    }

    /**
     * Fire-and-forget update (no await needed)
     * Returns immediately after optimistic update
     */
    function updateAsync(taskId, field, value, options = {}) {
        update(taskId, field, value, options);
    }

    /**
     * Generic update for unknown fields
     */
    async function updateGeneric(taskId, field, value, options = {}) {
        const task = getTask(taskId);
        if (!task) {
            return { success: false, error: 'Task not found' };
        }

        const oldValue = task[field];
        task[field] = value;

        if (!options.skipRender) render();

        try {
            const result = await API.updateTask(taskId, { [field]: value });
            if (result.error) {
                task[field] = oldValue;
                if (!options.skipRender) render();
                return { success: false, error: result.error };
            }
            return { success: true };
        } catch (error) {
            task[field] = oldValue;
            if (!options.skipRender) render();
            return { success: false, error: error.message };
        }
    }

    /**
     * Batch update multiple fields at once
     */
    async function updateBatch(taskId, updates, options = {}) {
        const task = getTask(taskId);
        if (!task) {
            return { success: false, error: 'Task not found' };
        }

        // Store old values
        const oldValues = {};
        const apiPayload = {};

        for (const [field, value] of Object.entries(updates)) {
            const config = fieldConfig[field];
            if (config) {
                oldValues[field] = config.getValue(task);
                config.setValue(task, value);
                const apiValue = config.transformForApi ? config.transformForApi(value) : value;
                apiPayload[config.apiField] = apiValue;
            } else {
                oldValues[field] = task[field];
                task[field] = value;
                apiPayload[field] = value;
            }
        }

        if (!options.skipRender) render();

        try {
            const result = await API.updateTask(taskId, apiPayload);
            if (result.error) {
                // Revert all
                for (const [field, oldValue] of Object.entries(oldValues)) {
                    const config = fieldConfig[field];
                    if (config) {
                        config.setValue(task, oldValue);
                    } else {
                        task[field] = oldValue;
                    }
                }
                if (!options.skipRender) render();
                return { success: false, error: result.error };
            }
            return { success: true };
        } catch (error) {
            // Revert all
            for (const [field, oldValue] of Object.entries(oldValues)) {
                const config = fieldConfig[field];
                if (config) {
                    config.setValue(task, oldValue);
                } else {
                    task[field] = oldValue;
                }
            }
            if (!options.skipRender) render();
            return { success: false, error: error.message };
        }
    }

    // ============ Convenience Methods ============

    return {
        // Core
        update,
        updateAsync,
        updateBatch,

        // Convenience shortcuts
        setPriority: (taskId, priority) => updateAsync(taskId, 'priority', priority),
        setStatus: (taskId, statusId) => updateAsync(taskId, 'status', statusId),
        setAssignees: (taskId, assigneeIds) => updateAsync(taskId, 'assignees', assigneeIds),
        setDueDate: (taskId, date) => updateAsync(taskId, 'dueDate', date),
        setStage: (taskId, stage) => updateAsync(taskId, 'stageTag', stage),
        setName: (taskId, name) => updateAsync(taskId, 'name', name),

        // Utilities
        getTask,
        getTasks,
        getProjectId,
        render,

        // Register custom field config
        registerField(fieldName, config) {
            fieldConfig[fieldName] = config;
        }
    };
})();

// Export to global scope
window.TaskUpdater = TaskUpdater;
