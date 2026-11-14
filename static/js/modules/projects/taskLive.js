/**
 * TaskLive - applies other users' task changes to the open task list in real time.
 *
 * The events arrive over the shared live connection (core/live.js);
 * TaskManager.init() says which project's tasks to follow and
 * TaskManager.clear() stops. Changes made in this tab are not echoed back.
 */
const TaskLive = (function () {
    let projectId = null;
    let pendingRender = false;

    function connect(pid) {
        projectId = pid || null;
        Live.watch('tasks', projectId);
    }

    function disconnect() {
        projectId = null;
        Live.watch('tasks', null);
    }

    // ============ Applying changes ============

    function tasks() {
        return (window.TaskManager && TaskManager.getTasks()) || [];
    }

    function isEditing() {
        const el = document.activeElement;
        return !!(el && el.closest && el.closest('#projectsTableBody') &&
            (el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName)));
    }

    function render() {
        if (!window.TaskListView || !window.TaskManager) return;
        // Don't yank the table away while someone is typing in it
        if (isEditing()) {
            if (!pendingRender) {
                pendingRender = true;
                document.addEventListener('focusout', function onBlur() {
                    document.removeEventListener('focusout', onBlur);
                    setTimeout(() => {
                        pendingRender = false;
                        render();
                    }, 0);
                });
            }
            return;
        }
        TaskListView.render(TaskManager.getTasks(), TaskManager.getProjectId(), false);
    }

    function needsFullRender() {
        return window.TaskFilters && TaskFilters.isActive();
    }

    function updateOne(taskId) {
        const row = document.querySelector(`#projectsTableBody tr.task-row[data-task-id="${taskId}"]`);
        if (needsFullRender() || !row) {
            render();
            return;
        }
        if (row.contains(document.activeElement)) return; // user is editing this row
        TaskListView.updateRow(taskId);
    }

    async function reload() {
        if (!window.TaskManager || !TaskManager.getProjectId()) return;
        await TaskManager.loadTasks();
        render();
    }

    function handle(msg) {
        if (!projectId || msg.project !== projectId) return;
        if (!window.TaskManager || TaskManager.getProjectId() !== projectId) return;
        const list = tasks();

        switch (msg.type) {
            case 'task_created': {
                const task = msg.task;
                if (!task || list.some(t => t.id === task.id)) return;
                const parent = task.parentId ? list.find(t => t.id === task.parentId) : null;
                if (task.parentId) {
                    if (parent) parent.childCount = (parent.childCount || 0) + 1;
                    // Only keep the subtask locally if its parent is expanded
                    if ((TaskState.expandedTasks || []).includes(task.parentId)) list.push(task);
                    render();
                } else {
                    list.push(task);
                    render();
                }
                break;
            }
            case 'task_updated': {
                const task = msg.task;
                if (!task) return;
                const existing = list.find(t => t.id === task.id);
                if (existing) {
                    Object.keys(existing).forEach(k => { if (!(k in task)) delete existing[k]; });
                    Object.assign(existing, task);
                    updateOne(task.id);
                } else if (!task.parentId) {
                    list.push(task);
                    render();
                }
                break;
            }
            case 'task_deleted': {
                const remove = new Set([msg.taskId]);
                let grew = true;
                while (grew) {
                    grew = false;
                    list.forEach(t => {
                        if (t.parentId && remove.has(t.parentId) && !remove.has(t.id)) {
                            remove.add(t.id);
                            grew = true;
                        }
                    });
                }
                for (let i = list.length - 1; i >= 0; i--) {
                    if (remove.has(list[i].id)) list.splice(i, 1);
                }
                const parent = msg.parentId ? list.find(t => t.id === msg.parentId) : null;
                if (parent) parent.childCount = Math.max(0, (parent.childCount || 1) - 1);
                render();
                break;
            }
            case 'tasks_reordered':
                reload();
                break;
        }
    }

    return { connect, disconnect, handle, reload };
})();

window.TaskLive = TaskLive;
