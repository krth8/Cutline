/**
 * TaskFilters - search, filter, sort and group for the task list.
 *
 * State is kept per project in localStorage. TaskListView.render() calls
 * TaskFilters.apply() and renders whatever comes back (flat list or groups).
 */
const TaskFilters = (function () {
    const STORAGE_PREFIX = 'taskFilters:';

    const SORTS = {
        manual: 'Manual',
        name: 'Name',
        priority: 'Priority',
        dueDate: 'Due date',
        status: 'Status',
        createdAt: 'Created'
    };

    const GROUPS = {
        none: 'None',
        status: 'Status',
        priority: 'Priority',
        assignee: 'Assignee',
        dueDate: 'Due date',
        stage: 'Stage'
    };

    const DUE_OPTIONS = {
        overdue: 'Overdue',
        today: 'Today',
        week: 'Next 7 days',
        none: 'No due date'
    };

    let projectId = null;
    let state = defaultState();
    let searchTimer = null;
    let menuEl = null;

    function defaultState() {
        return {
            search: '',
            status: [],
            priority: [],
            assignee: [],
            due: [],
            sort: 'manual',
            dir: 'asc',
            group: 'none',
            collapsed: []
        };
    }

    // ============ Persistence ============

    function load(pid) {
        projectId = pid;
        state = defaultState();
        try {
            const saved = JSON.parse(localStorage.getItem(STORAGE_PREFIX + pid) || 'null');
            if (saved) state = { ...state, ...saved };
        } catch (e) {}
    }

    function save() {
        if (!projectId) return;
        try {
            localStorage.setItem(STORAGE_PREFIX + projectId, JSON.stringify(state));
        } catch (e) {}
    }

    // ============ Option sources ============

    function statusList() {
        return (typeof AppState !== 'undefined' && AppState.statuses) || [];
    }

    function priorityOptions() {
        const opts = (typeof PropertyRegistry !== 'undefined' && PropertyRegistry.getPriorityOptions)
            ? PropertyRegistry.getPriorityOptions()
            : {};
        return Object.entries(opts).map(([value, o]) => ({ value, label: o.label || value, color: o.color }));
    }

    function priorityRank(value) {
        // Options are listed low -> high; unknown/none sorts lowest
        const order = priorityOptions().map(o => o.value);
        if (value === 'urgent' && !order.includes('urgent')) return order.length + 1;
        const i = order.indexOf(value);
        return i === -1 ? -1 : i;
    }

    function members() {
        return (window.TaskState && TaskState.members) || [];
    }

    function currentUserId() {
        return (typeof AppState !== 'undefined' && AppState.adminUser && AppState.adminUser.id) || null;
    }

    // ============ Task values ============

    function statusOf(task) {
        const id = task.status?.id || task.statusId || null;
        if (!id) return null;
        return task.status?.name ? task.status : (statusList().find(s => s.id === id) || { id, name: 'Unknown' });
    }

    function assigneeIds(task) {
        const list = task.assignees || (task.assignee ? [task.assignee] : []);
        return list.map(a => a.id);
    }

    function dayStart(d) {
        const x = new Date(d);
        x.setHours(0, 0, 0, 0);
        return x;
    }

    function dueBucket(task) {
        if (!task.dueDate) return 'none';
        const due = dayStart(task.dueDate + (task.dueDate.length === 10 ? 'T00:00:00' : ''));
        const today = dayStart(new Date());
        const days = Math.round((due - today) / 86400000);
        if (days < 0) return 'overdue';
        if (days === 0) return 'today';
        if (days <= 7) return 'week';
        return 'later';
    }

    // ============ Filtering ============

    function matches(task) {
        if (state.search) {
            const q = state.search.toLowerCase();
            const text = `${task.name || ''} ${task.description || ''}`.toLowerCase();
            if (!text.includes(q)) return false;
        }
        if (state.status.length) {
            const id = statusOf(task)?.id || '__none__';
            if (!state.status.includes(id)) return false;
        }
        if (state.priority.length) {
            if (!state.priority.includes(task.priority || '__none__')) return false;
        }
        if (state.assignee.length) {
            const ids = assigneeIds(task);
            const me = currentUserId();
            const ok = state.assignee.some(a =>
                (a === '__none__' && ids.length === 0) ||
                (a === '__me__' && me && ids.includes(me)) ||
                ids.includes(a)
            );
            if (!ok) return false;
        }
        if (state.due.length) {
            const bucket = dueBucket(task);
            // "Next 7 days" includes today
            const ok = state.due.some(d => d === bucket || (d === 'week' && bucket === 'today'));
            if (!ok) return false;
        }
        return true;
    }

    // ============ Sorting ============

    function sortValue(task) {
        switch (state.sort) {
            case 'name': return (task.name || '').toLowerCase();
            case 'priority': return priorityRank(task.priority);
            case 'dueDate': return task.dueDate || null;
            case 'status': {
                const s = statusOf(task);
                if (!s) return null;
                const i = statusList().findIndex(x => x.id === s.id);
                return i === -1 ? statusList().length : i;
            }
            case 'createdAt': return task.createdAt || '';
            default: return task.sortOrder ?? 0;
        }
    }

    function sortTasks(list) {
        const dir = state.dir === 'desc' ? -1 : 1;
        return list
            .map((task, index) => ({ task, index, value: sortValue(task) }))
            .sort((a, b) => {
                // Empty values always last, whatever the direction
                const aEmpty = a.value === null || a.value === -1;
                const bEmpty = b.value === null || b.value === -1;
                if (aEmpty !== bEmpty) return aEmpty ? 1 : -1;
                if (a.value < b.value) return -dir;
                if (a.value > b.value) return dir;
                return a.index - b.index;
            })
            .map(x => x.task);
    }

    // ============ Grouping ============

    function groupInfo(task) {
        switch (state.group) {
            case 'status': {
                const s = statusOf(task);
                return s ? { key: s.id, label: s.name, color: s.color } : { key: '__none__', label: 'No status' };
            }
            case 'priority': {
                const o = priorityOptions().find(p => p.value === task.priority);
                if (!task.priority) return { key: '__none__', label: 'No priority' };
                return { key: task.priority, label: o?.label || task.priority, color: o?.color };
            }
            case 'assignee': {
                const a = (task.assignees || [])[0] || task.assignee;
                return a ? { key: a.id, label: a.name || a.username || 'Unknown' } : { key: '__none__', label: 'Unassigned' };
            }
            case 'dueDate': {
                const b = dueBucket(task);
                const labels = { overdue: 'Overdue', today: 'Today', week: 'Next 7 days', later: 'Later', none: 'No due date' };
                return { key: b, label: labels[b], color: b === 'overdue' ? '#ef4444' : undefined };
            }
            case 'stage': {
                const stages = (PropertyRegistry.getStageOptions && PropertyRegistry.getStageOptions()) || {};
                if (!task.stageTag) return { key: '__none__', label: 'No stage' };
                const cfg = stages[task.stageTag];
                return { key: task.stageTag, label: cfg?.label || task.stageTag, color: cfg?.color };
            }
            default:
                return { key: '__all__', label: '' };
        }
    }

    function groupOrder(key) {
        if (key === '__none__') return Number.MAX_SAFE_INTEGER;
        switch (state.group) {
            case 'status': {
                const i = statusList().findIndex(s => s.id === key);
                return i === -1 ? 9999 : i;
            }
            case 'priority':
                return -priorityRank(key);
            case 'dueDate':
                return ['overdue', 'today', 'week', 'later', 'none'].indexOf(key);
            default:
                return null;
        }
    }

    function groupTasks(list) {
        const groups = new Map();
        list.forEach(task => {
            const info = groupInfo(task);
            if (!groups.has(info.key)) groups.set(info.key, { ...info, tasks: [] });
            groups.get(info.key).tasks.push(task);
        });
        return Array.from(groups.values()).sort((a, b) => {
            const oa = groupOrder(a.key), ob = groupOrder(b.key);
            if (oa !== null && ob !== null && oa !== ob) return oa - ob;
            if (a.key === '__none__') return 1;
            if (b.key === '__none__') return -1;
            return String(a.label).localeCompare(String(b.label));
        });
    }

    // ============ Public: apply ============

    function activeFilterCount() {
        return state.status.length + state.priority.length + state.assignee.length + state.due.length;
    }

    function isActive() {
        return !!state.search || activeFilterCount() > 0 || state.sort !== 'manual' || state.group !== 'none';
    }

    /**
     * @returns {{tasks: Array, groups: Array|null, total: number, shown: number}}
     */
    function apply(tasks, pid) {
        if (pid && pid !== projectId) load(pid);
        const all = tasks || [];
        const filtered = sortTasks(all.filter(matches));
        const groups = state.group !== 'none' ? groupTasks(filtered) : null;
        return { tasks: filtered, groups, total: all.length, shown: filtered.length };
    }

    function isCollapsed(key) {
        return state.collapsed.includes(`${state.group}:${key}`);
    }

    // ============ Toolbar ============

    function escapeHtml(str) {
        const div = document.createElement('div');
        div.textContent = str == null ? '' : String(str);
        return div.innerHTML;
    }

    function options(map, selected) {
        return Object.entries(map)
            .map(([v, label]) => `<option value="${v}" ${v === selected ? 'selected' : ''}>${label}</option>`)
            .join('');
    }

    function renderToolbar(container, result) {
        if (!container) return;
        let bar = document.getElementById('taskToolbar');
        if (!bar) {
            bar = document.createElement('div');
            bar.id = 'taskToolbar';
            bar.className = 'task-toolbar';
            container.insertBefore(bar, container.firstChild);
            bar.innerHTML = `
                <div class="task-toolbar-search">
                    <svg class="icon icon-sm"><use href="/static/icons.svg#icon-search"/></svg>
                    <input type="search" id="taskSearchInput" placeholder="Search tasks" autocomplete="off"
                           oninput="TaskFilters.setSearch(this.value)">
                </div>
                <button class="task-toolbar-btn" id="taskFilterBtn" onclick="TaskFilters.toggleFilterMenu(event)">
                    <svg class="icon icon-sm"><use href="/static/icons.svg#icon-funnel"/></svg>
                    <span>Filter</span><span class="task-toolbar-badge hidden" id="taskFilterBadge"></span>
                </button>
                <label class="task-toolbar-select" title="Sort">
                    <svg class="icon icon-sm"><use href="/static/icons.svg#icon-arrows-down-up"/></svg>
                    <select id="taskSortSelect" onchange="TaskFilters.setSort(this.value)" aria-label="Sort by"></select>
                </label>
                <button class="task-toolbar-btn task-toolbar-dir" id="taskSortDir" onclick="TaskFilters.toggleDir()" title="Reverse order" aria-label="Reverse order"></button>
                <label class="task-toolbar-select" title="Group">
                    <svg class="icon icon-sm"><use href="/static/icons.svg#icon-stack"/></svg>
                    <select id="taskGroupSelect" onchange="TaskFilters.setGroup(this.value)" aria-label="Group by"></select>
                </label>
                <button class="task-toolbar-btn task-toolbar-clear hidden" id="taskFilterClear" onclick="TaskFilters.clear()">Clear</button>
                <span class="task-toolbar-count" id="taskFilterCount"></span>
            `;
        }

        const search = document.getElementById('taskSearchInput');
        if (search && document.activeElement !== search) search.value = state.search;

        document.getElementById('taskSortSelect').innerHTML = options(
            Object.fromEntries(Object.entries(SORTS).map(([k, v]) => [k, `Sort: ${v}`])), state.sort);
        document.getElementById('taskGroupSelect').innerHTML = options(
            Object.fromEntries(Object.entries(GROUPS).map(([k, v]) => [k, k === 'none' ? 'Group: None' : `Group: ${v}`])), state.group);

        const dirBtn = document.getElementById('taskSortDir');
        dirBtn.textContent = state.dir === 'desc' ? '↓' : '↑';
        dirBtn.classList.toggle('hidden', state.sort === 'manual');

        const n = activeFilterCount();
        const badge = document.getElementById('taskFilterBadge');
        badge.textContent = n;
        badge.classList.toggle('hidden', n === 0);
        document.getElementById('taskFilterBtn').classList.toggle('active', n > 0);
        document.getElementById('taskFilterClear').classList.toggle('hidden', !isActive());

        const count = document.getElementById('taskFilterCount');
        count.textContent = result && (state.search || n > 0) ? `${result.shown} of ${result.total}` : '';
    }

    // ============ Filter menu ============

    function checkboxGroup(title, field, items) {
        if (!items.length) return '';
        const rows = items.map(it => `
            <label class="task-filter-option">
                <input type="checkbox" ${state[field].includes(it.value) ? 'checked' : ''}
                       onchange="TaskFilters.toggleValue('${field}', '${escapeHtml(it.value)}', this.checked)">
                ${it.color ? `<span class="task-filter-dot" style="background:${escapeHtml(it.color)}"></span>` : ''}
                <span>${escapeHtml(it.label)}</span>
            </label>`).join('');
        return `<div class="task-filter-group"><div class="task-filter-title">${title}</div>${rows}</div>`;
    }

    function renderMenu() {
        const statusItems = statusList().map(s => ({ value: s.id, label: s.name, color: s.color }))
            .concat([{ value: '__none__', label: 'No status' }]);
        const priorityItems = priorityOptions().slice().reverse()
            .concat([{ value: '__none__', label: 'No priority' }]);
        const me = currentUserId();
        const assigneeItems = (me ? [{ value: '__me__', label: 'Me' }] : [])
            .concat([{ value: '__none__', label: 'Unassigned' }])
            .concat(members().filter(m => m.id !== me).map(m => ({ value: m.id, label: m.name || m.username })));
        const dueItems = Object.entries(DUE_OPTIONS).map(([value, label]) => ({ value, label }));

        return `
            <div class="task-filter-columns">
                ${checkboxGroup('Status', 'status', statusItems)}
                ${checkboxGroup('Priority', 'priority', priorityItems)}
                ${checkboxGroup('Assignee', 'assignee', assigneeItems)}
                ${checkboxGroup('Due', 'due', dueItems)}
            </div>`;
    }

    function closeMenu() {
        if (menuEl) {
            menuEl.remove();
            menuEl = null;
            document.removeEventListener('mousedown', onOutside, true);
            document.removeEventListener('keydown', onMenuKey, true);
        }
    }

    function onOutside(e) {
        if (menuEl && !menuEl.contains(e.target) && !e.target.closest('#taskFilterBtn')) closeMenu();
    }

    function onMenuKey(e) {
        if (e.key === 'Escape') closeMenu();
    }

    function toggleFilterMenu(event) {
        event?.stopPropagation();
        if (menuEl) { closeMenu(); return; }
        const btn = document.getElementById('taskFilterBtn');
        menuEl = document.createElement('div');
        menuEl.className = 'task-filter-menu';
        menuEl.innerHTML = renderMenu();
        document.body.appendChild(menuEl);
        const r = btn.getBoundingClientRect();
        const width = menuEl.offsetWidth;
        menuEl.style.top = `${r.bottom + 6}px`;
        menuEl.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - width - 8))}px`;
        document.addEventListener('mousedown', onOutside, true);
        document.addEventListener('keydown', onMenuKey, true);
    }

    // ============ State changes ============

    function rerender() {
        save();
        if (window.TaskManager && window.TaskListView) {
            TaskListView.render(TaskManager.getTasks(), TaskManager.getProjectId() || projectId, false);
        }
    }

    function setSearch(value) {
        state.search = value.trim();
        clearTimeout(searchTimer);
        searchTimer = setTimeout(rerender, 120);
    }

    function setSort(value) {
        state.sort = SORTS[value] ? value : 'manual';
        // Sensible default direction per field
        state.dir = ['priority', 'createdAt'].includes(state.sort) ? 'desc' : 'asc';
        rerender();
    }

    function toggleDir() {
        state.dir = state.dir === 'desc' ? 'asc' : 'desc';
        rerender();
    }

    /** Column header click: asc -> desc -> back to manual order. */
    function sortBy(field) {
        if (state.sort !== field) {
            state.sort = field;
            state.dir = 'asc';
        } else if (state.dir === 'asc') {
            state.dir = 'desc';
        } else {
            state.sort = 'manual';
            state.dir = 'asc';
        }
        rerender();
    }

    function setGroup(value) {
        state.group = GROUPS[value] ? value : 'none';
        rerender();
    }

    function toggleValue(field, value, on) {
        const list = state[field];
        const i = list.indexOf(value);
        if (on && i === -1) list.push(value);
        if (!on && i !== -1) list.splice(i, 1);
        rerender();
    }

    function toggleGroup(key) {
        const id = `${state.group}:${key}`;
        const i = state.collapsed.indexOf(id);
        if (i === -1) state.collapsed.push(id); else state.collapsed.splice(i, 1);
        rerender();
    }

    function clear() {
        const collapsed = state.collapsed;
        state = { ...defaultState(), collapsed };
        closeMenu();
        rerender();
    }

    return {
        apply,
        isActive,
        isCollapsed,
        renderToolbar,
        toggleFilterMenu,
        closeMenu,
        setSearch,
        setSort,
        toggleDir,
        sortBy,
        setGroup,
        toggleValue,
        toggleGroup,
        clear,
        getState: () => JSON.parse(JSON.stringify(state))
    };
})();

window.TaskFilters = TaskFilters;
