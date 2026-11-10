/**
 * TaskManager - Centralized task state management
 * Single source of truth for all task operations
 */
const TaskManager = (function() {
    // Private state
    let tasks = [];
    let projectId = null;
    let listeners = [];

    return {
        // ============ Getters ============
        getTasks() {
            return tasks;
        },

        getTask(id) {
            return tasks.find(t => t.id === id);
        },

        getProjectId() {
            return projectId;
        },

        // ============ Initialize ============
        async init(newProjectId) {
            projectId = newProjectId;
            if (window.TaskLive) TaskLive.connect(newProjectId);
            await this.loadTasks();
        },

        // ============ Load Tasks ============
        async loadTasks() {
            if (!projectId) {
                console.error('TaskManager: No project ID set');
                return { tasks: [], error: 'No project ID' };
            }

            const { data, error } = await API.getTasks(projectId);

            if (error) {
                console.error('TaskManager: Failed to load tasks:', error);
                return { tasks: [], error };
            }

            tasks = data?.tasks || [];
            this.notify('tasksLoaded', tasks);

            // Sync with window.currentTasks for backwards compatibility
            window.currentTasks = tasks;

            return { tasks, error: null };
        },

        // ============ Create Task ============
        async createTask(taskData) {
            if (!projectId) {
                return { error: 'No project ID set' };
            }

            // Create optimistic task
            const tempId = `temp-${Date.now()}`;
            const tempTask = {
                id: tempId,
                projectId: projectId,
                name: taskData.name,
                statusId: taskData.statusId || null,
                status: taskData.statusId ? AppState.statuses?.find(s => s.id === taskData.statusId) : null,
                priority: taskData.priority || null,
                assignees: [],
                dueDate: taskData.dueDate || null,
                stageTag: taskData.stageTag || null,
                _isOptimistic: true
            };

            // Add to local state
            tasks.push(tempTask);
            window.currentTasks = tasks;
            this.notify('taskCreated', tempTask);

            // API call
            const { data, error } = await API.createTask(projectId, taskData);

            if (error) {
                // Rollback on error
                tasks = tasks.filter(t => t.id !== tempId);
                window.currentTasks = tasks;
                this.notify('taskCreateFailed', { tempId, error });
                showToast?.('Failed to create task', 'error');
                return { error };
            }

            // Replace temp with real task
            const idx = tasks.findIndex(t => t.id === tempId);
            if (idx !== -1 && data?.task) {
                tasks[idx] = data.task;
                window.currentTasks = tasks;
                this.notify('taskCreated', data.task);
            }

            return { task: data?.task };
        },

        // ============ Update Field ============
        async updateField(taskId, field, value) {
            const task = this.getTask(taskId);
            if (!task) {
                return { error: 'Task not found' };
            }

            // Store old value for rollback
            const oldValue = task[field];

            // Optimistic update
            task[field] = value;
            this.notify('taskUpdated', { taskId, field, value });

            // Map to API field names
            const apiFieldMap = {
                'statusId': 'statusId',
                'status': 'statusId',
                'priority': 'priority',
                'assignees': 'assigneeIds',
                'assigneeIds': 'assigneeIds',
                'dueDate': 'dueDate',
                'name': 'name',
                'description': 'description',
                'stageTag': 'stageTag'
            };

            const apiField = apiFieldMap[field] || field;
            const { error } = await API.updateTask(taskId, { [apiField]: value });

            if (error) {
                // Rollback on error
                task[field] = oldValue;
                this.notify('taskUpdateFailed', { taskId, field, error });
                showToast?.('Failed to update task', 'error');
                return { error };
            }

            return { success: true };
        },

        // ============ Convenience Methods ============
        async setStatus(taskId, statusId) {
            const task = this.getTask(taskId);
            if (task) {
                // Update both statusId and status object
                task.statusId = statusId;
                task.status = statusId ? (AppState.statuses?.find(s => s.id === statusId) || null) : null;
            }
            return this.updateField(taskId, 'statusId', statusId);
        },

        async setPriority(taskId, priority) {
            return this.updateField(taskId, 'priority', priority);
        },

        async setAssignees(taskId, assigneeIds) {
            const task = this.getTask(taskId);
            if (task) {
                // Update assignees array from TaskState.members
                const members = window.TaskState?.members || [];
                task.assignees = assigneeIds
                    .map(id => members.find(m => m.id === id))
                    .filter(Boolean);
            }
            return this.updateField(taskId, 'assigneeIds', assigneeIds);
        },

        async setDueDate(taskId, dueDate) {
            return this.updateField(taskId, 'dueDate', dueDate);
        },

        async setName(taskId, name) {
            return this.updateField(taskId, 'name', name);
        },

        // ============ Delete Task ============
        async deleteTask(taskId) {
            const task = this.getTask(taskId);
            if (!task) {
                return { error: 'Task not found' };
            }

            // Optimistic removal
            const oldTasks = [...tasks];
            tasks = tasks.filter(t => t.id !== taskId);
            window.currentTasks = tasks;
            this.notify('taskDeleted', taskId);

            // API call
            const { error } = await API.deleteTask(taskId);

            if (error) {
                // Rollback on error
                tasks = oldTasks;
                window.currentTasks = tasks;
                this.notify('taskDeleteFailed', { taskId, error });
                showToast?.('Failed to delete task', 'error');
                return { error };
            }

            return { success: true };
        },

        // ============ Subtask Operations ============
        async createSubtask(parentId, subtaskData) {
            const parent = this.getTask(parentId);
            if (!parent) {
                return { error: 'Parent task not found' };
            }

            // Create optimistic subtask
            const tempId = `temp-${Date.now()}`;
            const tempSubtask = {
                id: tempId,
                projectId: projectId,
                parentId: parentId,
                name: subtaskData.name,
                statusId: subtaskData.statusId || null,
                priority: subtaskData.priority || null,
                _isOptimistic: true
            };

            // Add to tasks and update parent childCount
            tasks.push(tempSubtask);
            parent.childCount = (parent.childCount || 0) + 1;
            window.currentTasks = tasks;
            this.notify('subtaskCreated', { parentId, subtask: tempSubtask });

            // API call
            const { data, error } = await API.createTask(projectId, {
                ...subtaskData,
                parentId: parentId
            });

            if (error) {
                // Rollback
                tasks = tasks.filter(t => t.id !== tempId);
                parent.childCount = Math.max(0, (parent.childCount || 1) - 1);
                window.currentTasks = tasks;
                this.notify('subtaskCreateFailed', { parentId, tempId, error });
                showToast?.('Failed to create subtask', 'error');
                return { error };
            }

            // Replace temp with real
            const idx = tasks.findIndex(t => t.id === tempId);
            if (idx !== -1 && data?.task) {
                tasks[idx] = data.task;
                window.currentTasks = tasks;
                this.notify('subtaskCreated', { parentId, subtask: data.task });
            }

            return { task: data?.task };
        },

        async deleteSubtask(subtaskId) {
            const subtask = this.getTask(subtaskId);
            if (!subtask) {
                return { error: 'Subtask not found' };
            }

            const parentId = subtask.parentId;
            const parent = parentId ? this.getTask(parentId) : null;

            // Optimistic removal
            const oldTasks = [...tasks];
            const oldChildCount = parent?.childCount;

            tasks = tasks.filter(t => t.id !== subtaskId);
            if (parent) {
                parent.childCount = Math.max(0, (parent.childCount || 1) - 1);
            }
            window.currentTasks = tasks;
            this.notify('subtaskDeleted', { parentId, subtaskId });

            // API call
            const { error } = await API.deleteTask(subtaskId);

            if (error) {
                // Rollback
                tasks = oldTasks;
                if (parent) parent.childCount = oldChildCount;
                window.currentTasks = tasks;
                this.notify('subtaskDeleteFailed', { parentId, subtaskId, error });
                showToast?.('Failed to delete subtask', 'error');
                return { error };
            }

            return { success: true };
        },

        // Get subtasks for a parent
        getSubtasks(parentId) {
            return tasks.filter(t => t.parentId === parentId);
        },

        // ============ Event System ============
        subscribe(callback) {
            listeners.push(callback);
            // Return unsubscribe function
            return () => {
                listeners = listeners.filter(l => l !== callback);
            };
        },

        notify(event, data) {
            listeners.forEach(cb => {
                try {
                    cb(event, data);
                } catch (e) {
                    console.error('TaskManager: Listener error:', e);
                }
            });
        },

        // ============ Utility Methods ============
        clear() {
            if (window.TaskLive) TaskLive.disconnect();
            tasks = [];
            projectId = null;
            window.currentTasks = [];
            this.notify('cleared', null);
        },

        // Force re-render by notifying listeners
        refresh() {
            this.notify('refresh', tasks);
        }
    };
})();

// Export to global scope
window.TaskManager = TaskManager;
