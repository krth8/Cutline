/**
 * TaskQuery - Filtering, Grouping, and Sorting for Tasks
 * Central module for querying and organizing task data
 */
const TaskQuery = (function() {

    // ============ Filter Definitions ============

    const FilterOperators = {
        EQUALS: 'equals',
        NOT_EQUALS: 'notEquals',
        CONTAINS: 'contains',
        STARTS_WITH: 'startsWith',
        IS_EMPTY: 'isEmpty',
        IS_NOT_EMPTY: 'isNotEmpty',
        GREATER_THAN: 'greaterThan',
        LESS_THAN: 'lessThan',
        IN: 'in',
        NOT_IN: 'notIn'
    };

    // ============ Sort Definitions ============

    const SortDirection = {
        ASC: 'asc',
        DESC: 'desc'
    };

    // ============ Current Query State ============

    let currentFilters = [];
    let currentGroupBy = null;
    let currentSort = { field: 'createdAt', direction: SortDirection.DESC };

    // ============ Filter Functions ============

    function applyFilter(task, filter) {
        const value = PropertyRegistry.getValue(filter.field, task);
        const filterValue = filter.value;

        switch (filter.operator) {
            case FilterOperators.EQUALS:
                return value === filterValue;

            case FilterOperators.NOT_EQUALS:
                return value !== filterValue;

            case FilterOperators.CONTAINS:
                return String(value || '').toLowerCase().includes(String(filterValue).toLowerCase());

            case FilterOperators.STARTS_WITH:
                return String(value || '').toLowerCase().startsWith(String(filterValue).toLowerCase());

            case FilterOperators.IS_EMPTY:
                return value === null || value === undefined || value === '' ||
                       (Array.isArray(value) && value.length === 0);

            case FilterOperators.IS_NOT_EMPTY:
                return value !== null && value !== undefined && value !== '' &&
                       !(Array.isArray(value) && value.length === 0);

            case FilterOperators.GREATER_THAN:
                return value > filterValue;

            case FilterOperators.LESS_THAN:
                return value < filterValue;

            case FilterOperators.IN:
                return Array.isArray(filterValue) && filterValue.includes(value);

            case FilterOperators.NOT_IN:
                return Array.isArray(filterValue) && !filterValue.includes(value);

            default:
                return true;
        }
    }

    function filterTasks(tasks, filters = currentFilters) {
        if (!filters || filters.length === 0) return tasks;

        return tasks.filter(task => {
            return filters.every(filter => applyFilter(task, filter));
        });
    }

    // ============ Sort Functions ============

    function getComparableValue(task, field) {
        const prop = PropertyRegistry.get(field);
        const value = PropertyRegistry.getValue(field, task);

        // Special handling for different types
        if (prop?.type === 'date' && value) {
            return new Date(value).getTime();
        }
        if (prop?.type === 'priority') {
            const priorityOrder = { high: 3, medium: 2, low: 1 };
            return priorityOrder[value] || 0;
        }
        if (prop?.type === 'status' && value) {
            return value.name?.toLowerCase() || '';
        }
        if (prop?.type === 'person' && value) {
            // For assignees, sort by first assignee name
            if (Array.isArray(value)) {
                return value[0]?.name?.toLowerCase() || '';
            }
            return value.name?.toLowerCase() || '';
        }

        // Default string/number comparison
        if (typeof value === 'string') {
            return value.toLowerCase();
        }
        return value ?? '';
    }

    function sortTasks(tasks, sort = currentSort) {
        if (!sort || !sort.field) return tasks;

        return [...tasks].sort((a, b) => {
            const aVal = getComparableValue(a, sort.field);
            const bVal = getComparableValue(b, sort.field);

            let comparison = 0;
            if (aVal < bVal) comparison = -1;
            if (aVal > bVal) comparison = 1;

            return sort.direction === SortDirection.DESC ? -comparison : comparison;
        });
    }

    // ============ Group Functions ============

    function getGroupKey(task, groupField) {
        const prop = PropertyRegistry.get(groupField);
        const value = PropertyRegistry.getValue(groupField, task);

        if (value === null || value === undefined) {
            return { key: '__none__', label: 'No ' + (prop?.label || groupField) };
        }

        // Special handling for different types
        if (prop?.type === 'status') {
            return {
                key: value.id,
                label: value.name,
                color: value.color
            };
        }
        if (prop?.type === 'priority') {
            const config = PropertyRegistry.PriorityOptions[value];
            return {
                key: value,
                label: config?.label || value,
                color: config?.color
            };
        }
        // Handle stage grouping with colors from PresetManager
        if (groupField === 'stage') {
            const stageOptions = PropertyRegistry.getStageOptions?.() || {};
            const config = stageOptions[value];
            return {
                key: value,
                label: config?.label || value,
                color: config?.color
            };
        }
        if (prop?.type === 'person') {
            // Group by first assignee
            if (Array.isArray(value) && value.length > 0) {
                return { key: value[0].id, label: value[0].name };
            }
            return { key: '__none__', label: 'Unassigned' };
        }
        if (prop?.type === 'date') {
            // Group by date (day)
            const date = new Date(value);
            const today = new Date();
            today.setHours(0, 0, 0, 0);
            const tomorrow = new Date(today);
            tomorrow.setDate(tomorrow.getDate() + 1);
            const dateValue = new Date(value);
            dateValue.setHours(0, 0, 0, 0);

            if (dateValue.getTime() === today.getTime()) {
                return { key: 'today', label: 'Today' };
            }
            if (dateValue.getTime() === tomorrow.getTime()) {
                return { key: 'tomorrow', label: 'Tomorrow' };
            }
            if (dateValue < today) {
                return { key: 'overdue', label: 'Overdue', color: '#ef4444' };
            }
            return { key: value, label: DatePicker?.formatDisplay?.(value) || value };
        }

        // Default: use value as key and label
        return { key: String(value), label: String(value) };
    }

    function groupTasks(tasks, groupField = currentGroupBy) {
        if (!groupField) {
            return [{ key: '__all__', label: 'All Tasks', tasks: tasks }];
        }

        const groups = new Map();

        tasks.forEach(task => {
            const groupInfo = getGroupKey(task, groupField);

            if (!groups.has(groupInfo.key)) {
                groups.set(groupInfo.key, {
                    key: groupInfo.key,
                    label: groupInfo.label,
                    color: groupInfo.color,
                    tasks: []
                });
            }
            groups.get(groupInfo.key).tasks.push(task);
        });

        // Sort groups by label
        return Array.from(groups.values()).sort((a, b) => {
            // Put "No X" group at the end
            if (a.key === '__none__') return 1;
            if (b.key === '__none__') return -1;
            // Put "Overdue" at the beginning for dates
            if (a.key === 'overdue') return -1;
            if (b.key === 'overdue') return 1;
            return a.label.localeCompare(b.label);
        });
    }

    // ============ Combined Query ============

    function query(tasks, options = {}) {
        const filters = options.filters ?? currentFilters;
        const groupBy = options.groupBy ?? currentGroupBy;
        const sort = options.sort ?? currentSort;

        // Apply filters
        let result = filterTasks(tasks, filters);

        // Apply sort
        result = sortTasks(result, sort);

        // Apply grouping
        const groups = groupTasks(result, groupBy);

        return {
            tasks: result,
            groups: groups,
            totalCount: tasks.length,
            filteredCount: result.length
        };
    }

    // ============ State Management ============

    function setFilters(filters) {
        currentFilters = filters;
        notifyChange();
    }

    function addFilter(filter) {
        currentFilters.push(filter);
        notifyChange();
    }

    function removeFilter(index) {
        currentFilters.splice(index, 1);
        notifyChange();
    }

    function clearFilters() {
        currentFilters = [];
        notifyChange();
    }

    function setGroupBy(field) {
        currentGroupBy = field;
        notifyChange();
    }

    function setSort(field, direction = SortDirection.ASC) {
        currentSort = { field, direction };
        notifyChange();
    }

    function toggleSortDirection() {
        currentSort.direction = currentSort.direction === SortDirection.ASC
            ? SortDirection.DESC
            : SortDirection.ASC;
        notifyChange();
    }

    // ============ Event Subscription ============

    const subscribers = [];

    function subscribe(callback) {
        subscribers.push(callback);
        return () => {
            const index = subscribers.indexOf(callback);
            if (index > -1) subscribers.splice(index, 1);
        };
    }

    function notifyChange() {
        subscribers.forEach(cb => cb({
            filters: currentFilters,
            groupBy: currentGroupBy,
            sort: currentSort
        }));
    }

    // ============ Quick Filters (Presets) ============

    const QuickFilters = {
        myTasks: (userId) => ({
            field: 'assignee',
            operator: FilterOperators.IN,
            value: [userId]
        }),
        overdue: () => ({
            field: 'dueDate',
            operator: FilterOperators.LESS_THAN,
            value: new Date().toISOString().split('T')[0]
        }),
        dueToday: () => {
            const today = new Date().toISOString().split('T')[0];
            return {
                field: 'dueDate',
                operator: FilterOperators.EQUALS,
                value: today
            };
        },
        highPriority: () => ({
            field: 'priority',
            operator: FilterOperators.EQUALS,
            value: 'high'
        }),
        unassigned: () => ({
            field: 'assignee',
            operator: FilterOperators.IS_EMPTY,
            value: null
        }),
        byStatus: (statusId) => ({
            field: 'status',
            operator: FilterOperators.EQUALS,
            value: statusId
        })
    };

    // ============ Public API ============

    return {
        // Constants
        Operators: FilterOperators,
        SortDirection,
        QuickFilters,

        // Query
        query,
        filter: filterTasks,
        sort: sortTasks,
        group: groupTasks,

        // State management
        setFilters,
        addFilter,
        removeFilter,
        clearFilters,
        setGroupBy,
        setSort,
        toggleSortDirection,

        // Getters
        getFilters: () => [...currentFilters],
        getGroupBy: () => currentGroupBy,
        getSort: () => ({ ...currentSort }),

        // Events
        subscribe,

        // Reset
        reset() {
            currentFilters = [];
            currentGroupBy = null;
            currentSort = { field: 'createdAt', direction: SortDirection.DESC };
            notifyChange();
        }
    };
})();

// Export to global scope
window.TaskQuery = TaskQuery;
