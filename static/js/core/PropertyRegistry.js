/**
 * PropertyRegistry - Central definition of all task properties
 * Single source of truth for types, validation, and API mapping
 *
 * NOTE: Cell rendering is handled by TaskListView/taskTable.js
 * This file only contains property DEFINITIONS, not view-specific rendering.
 */
const PropertyRegistry = (function() {

    // ============ Property Type Definitions ============

    const PropertyTypes = {
        TEXT: 'text',
        STATUS: 'status',
        PERSON: 'person',
        DATE: 'date',
        SELECT: 'select',
        PRIORITY: 'priority',
        NUMBER: 'number',
        CHECKBOX: 'checkbox',
        TEXTAREA: 'textarea',
        RELATION: 'relation'  // For task relationships (parent/child)
    };

    // ============ Priority Configuration ============

    const DefaultPriorityOptions = {
        low: { label: 'Low', color: '#6b7280', icon: 'icon-minus' },
        medium: { label: 'Medium', color: '#f59e0b', icon: 'icon-equals' },
        high: { label: 'High', color: '#ef4444', icon: 'icon-arrow-up' }
    };

    function getPriorityOptions() {
        if (typeof PresetManager !== 'undefined' && PresetManager.isReady()) {
            const options = PresetManager.getActivePriorityOptions();
            if (options && options.length > 0) {
                const optionsObj = {};
                options.forEach(opt => {
                    optionsObj[opt.value] = {
                        label: opt.label,
                        color: opt.color,
                        icon: opt.icon || 'icon-equals'
                    };
                });
                return optionsObj;
            }
        }
        return DefaultPriorityOptions;
    }

    const PriorityOptions = new Proxy({}, {
        get(target, prop) {
            return getPriorityOptions()[prop];
        },
        ownKeys() {
            return Object.keys(getPriorityOptions());
        },
        getOwnPropertyDescriptor(target, prop) {
            const options = getPriorityOptions();
            if (prop in options) {
                return { enumerable: true, configurable: true, value: options[prop] };
            }
        }
    });

    // ============ Stage Options ============

    const DefaultStageOptions = {
        'Previz': { label: 'Previz', color: '#8b5cf6' },
        'Layout': { label: 'Layout', color: '#3b82f6' },
        'Animation': { label: 'Animation', color: '#10b981' },
        'Lighting': { label: 'Lighting', color: '#f59e0b' },
        'FX': { label: 'FX', color: '#ef4444' },
        'Comp': { label: 'Comp', color: '#ec4899' },
        'Review': { label: 'Review', color: '#6366f1' }
    };

    function getStageOptions() {
        if (typeof PresetManager !== 'undefined' && PresetManager.isReady()) {
            const options = PresetManager.getActiveStageOptions?.();
            if (options && Object.keys(options).length > 0) {
                return options;
            }
        }
        return DefaultStageOptions;
    }

    const StageOptions = Object.keys(DefaultStageOptions);

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

    function getAssigneeName(assignee) {
        return assignee?.name || assignee?.username || 'Unknown';
    }

    // ============ Property Definitions ============
    // NOTE: renderCell removed - rendering is now in taskTable.js

    const properties = {
        name: {
            id: 'name',
            type: PropertyTypes.TEXT,
            label: 'Name',
            required: true,
            fixed: true,
            default: '',
            width: 300,
            minWidth: 150,
            apiField: 'name',
            getValue: (task) => task.name,
            validate: (value) => value && value.trim().length > 0,
            renderDetail: (task) => {
                return `<input type="text" id="taskDetailName" class="task-detail-input" value="${escapeHtml(task.name || '')}">`;
            }
        },

        description: {
            id: 'description',
            type: PropertyTypes.TEXTAREA,
            label: 'Description',
            required: false,
            default: '',
            apiField: 'description',
            getValue: (task) => task.description,
            showInTable: false,
            renderDetail: (task) => {
                return `<textarea id="taskDetailDescription" class="task-detail-textarea" placeholder="Add description...">${escapeHtml(task.description || '')}</textarea>`;
            }
        },

        status: {
            id: 'status',
            type: PropertyTypes.STATUS,
            label: 'Status',
            required: false,
            default: null,
            width: 120,
            minWidth: 80,
            apiField: 'statusId',
            getValue: (task) => task.status,
            transform: (value) => value?.id || null,
            getOptions: () => window.AppState?.statuses || [],
            renderDetail: (task) => {
                const status = task.status;
                if (status) {
                    const textColor = getContrastTextColor(status.color);
                    return `<span class="status-badge" style="background: ${status.color}; color: ${textColor}">${escapeHtml(status.name)}</span>`;
                }
                return `<span class="status-badge empty">-</span>`;
            }
        },

        priority: {
            id: 'priority',
            type: PropertyTypes.PRIORITY,
            label: 'Priority',
            required: false,
            default: null,
            width: 100,
            minWidth: 80,
            apiField: 'priority',
            getValue: (task) => task.priority,
            getOptions: getPriorityOptions,
            renderDetail: (task) => {
                const priority = task.priority;
                if (!priority) {
                    return `<span style="color: var(--text-muted)">-</span>`;
                }
                const options = getPriorityOptions();
                const config = options[priority] || { label: priority, color: '#6b7280' };
                return `<span class="priority-pill" style="background-color: ${config.color}20; color: ${config.color}; border: 1px solid ${config.color}40">${config.label}</span>`;
            }
        },

        assignee: {
            id: 'assignee',
            type: PropertyTypes.PERSON,
            label: 'Assignee',
            required: false,
            default: null,
            width: 150,
            minWidth: 100,
            apiField: 'assigneeIds',
            getValue: (task) => task.assignee,
            transform: (assignees) => assignees?.map(a => a.id) || [],
            getOptions: () => window.TaskState?.members || [],
            renderDetail: (task) => {
                const assignees = task.assignees || [];
                if (assignees.length > 0) {
                    const avatars = assignees.slice(0, 3).map(a => {
                        const name = getAssigneeName(a);
                        if (a.profileImage) {
                            return `<img src="${a.profileImage}" class="assignee-avatar" alt="${escapeHtml(name)}" title="${escapeHtml(name)}">`;
                        } else {
                            return `<span class="assignee-avatar assignee-initials" title="${escapeHtml(name)}">${getInitials(name)}</span>`;
                        }
                    }).join('');
                    const overflow = assignees.length > 3 ? `<span class="assignee-overflow">+${assignees.length - 3}</span>` : '';
                    return avatars + overflow;
                }
                return `<span class="assignee-placeholder"><svg class="icon icon-sm"><use href="/static/icons.svg#icon-user"/></svg></span>`;
            }
        },

        dueDate: {
            id: 'dueDate',
            type: PropertyTypes.DATE,
            label: 'Due Date',
            required: false,
            default: null,
            width: 120,
            minWidth: 80,
            apiField: 'dueDate',
            getValue: (task) => task.dueDate,
            formatDisplay: (value) => {
                if (!value) return '-';
                if (typeof DatePicker !== 'undefined' && DatePicker.formatDisplay) {
                    return DatePicker.formatDisplay(value);
                }
                return new Date(value).toLocaleDateString();
            },
            isOverdue: (value) => {
                if (!value) return false;
                return new Date(value) < new Date().setHours(0, 0, 0, 0);
            },
            renderDetail: (task) => {
                if (task.dueDate) {
                    const isOverdue = new Date(task.dueDate) < new Date().setHours(0, 0, 0, 0);
                    const displayText = typeof DatePicker !== 'undefined' ? DatePicker.formatDisplay(task.dueDate) : task.dueDate;
                    return `<span class="${isOverdue ? 'overdue' : ''}">${escapeHtml(displayText)}</span>`;
                }
                return `<span>-</span>`;
            }
        },

        stage: {
            id: 'stage',
            type: PropertyTypes.SELECT,
            label: 'Stage',
            required: false,
            default: null,
            width: 110,
            minWidth: 90,
            apiField: 'stageTag',
            getValue: (task) => task.stageTag,
            getOptions: getStageOptions,
            renderDetail: (task) => {
                const value = task.stageTag;
                if (!value) {
                    return `<span style="color: var(--text-muted)">-</span>`;
                }
                const stageOptions = getStageOptions();
                const config = stageOptions[value] || { label: value, color: '#6b7280' };
                return `<span class="stage-badge" style="background: ${config.color}; color: ${getContrastTextColor(config.color)}">${escapeHtml(config.label)}</span>`;
            }
        },

        // ============ Hierarchy Properties ============

        parentId: {
            id: 'parentId',
            type: PropertyTypes.RELATION,
            label: 'Parent Task',
            required: false,
            default: null,
            apiField: 'parentId',
            getValue: (task) => task.parentId,
            showInTable: false,  // Not a visible column, used for hierarchy
            validate: (value, task) => {
                // Cannot be its own parent
                if (value && task && value === task.id) return false;
                return true;
            },
            // Check if task is a subtask
            isSubtask: (task) => !!task.parentId,
            // Get parent task from current tasks
            getParent: (task) => {
                if (!task.parentId) return null;
                return window.currentTasks?.find(t => t.id === task.parentId) || null;
            }
        },

        childCount: {
            id: 'childCount',
            type: PropertyTypes.NUMBER,
            label: 'Subtasks',
            required: false,
            default: 0,
            apiField: 'childCount',
            getValue: (task) => task.childCount || 0,
            showInTable: false,  // Shown via expand caret, not as column
            // Check if task has children
            hasChildren: (task) => (task.childCount || 0) > 0
        }
    };

    // ============ Default Column Configuration ============

    const defaultColumns = [
        { id: 'name', label: 'Name', type: PropertyTypes.TEXT, width: 300, minWidth: 150, fixed: true },
        { id: 'status', label: 'Status', type: PropertyTypes.STATUS, width: 120, minWidth: 80 },
        { id: 'priority', label: 'Priority', type: PropertyTypes.PRIORITY, width: 100, minWidth: 80 },
        { id: 'assignee', label: 'Assignee', type: PropertyTypes.PERSON, width: 150, minWidth: 100 },
        { id: 'dueDate', label: 'Due Date', type: PropertyTypes.DATE, width: 120, minWidth: 80 },
        { id: 'stage', label: 'Stage', type: PropertyTypes.SELECT, width: 100, minWidth: 80, options: StageOptions }
    ];

    // ============ Public API ============

    return {
        // Constants
        Types: PropertyTypes,
        PriorityOptions,
        StageOptions,

        // Dynamic getters
        getPriorityOptions,
        getStageOptions,

        // Get single property definition
        get(propertyId) {
            return properties[propertyId] || null;
        },

        // Get all properties
        getAll() {
            return { ...properties };
        },

        // Get property IDs
        getPropertyIds() {
            return Object.keys(properties);
        },

        // Get required properties
        getRequired() {
            return Object.values(properties).filter(p => p.required);
        },

        // Get properties visible in table
        getTableProperties() {
            return Object.values(properties).filter(p => p.showInTable !== false);
        },

        // Get default columns configuration
        getDefaultColumns() {
            return [...defaultColumns];
        },

        // Get value from task using property definition
        getValue(propertyId, task) {
            const prop = properties[propertyId];
            if (!prop) return undefined;
            return prop.getValue ? prop.getValue(task) : task[propertyId];
        },

        // Transform value for API
        transformForApi(propertyId, value) {
            const prop = properties[propertyId];
            if (!prop) return value;
            return prop.transform ? prop.transform(value) : value;
        },

        // Render property for detail modal
        renderDetail(propertyId, task) {
            const prop = properties[propertyId];
            if (!prop || !prop.renderDetail) {
                return '-';
            }
            return prop.renderDetail(task);
        },

        // Validate property value
        validate(propertyId, value) {
            const prop = properties[propertyId];
            if (!prop || !prop.validate) return true;
            return prop.validate(value);
        },

        // Get column configuration for a property
        getColumnConfig(propertyId) {
            const prop = properties[propertyId];
            if (!prop) return null;

            return {
                id: prop.id,
                label: prop.label,
                type: prop.type,
                width: prop.width || 120,
                minWidth: prop.minWidth || 80,
                fixed: prop.fixed || false,
                options: prop.options
            };
        },

        // Register a new property (for custom properties)
        register(propertyId, definition) {
            if (properties[propertyId]) {
                console.warn(`Property ${propertyId} already exists, overwriting`);
            }
            properties[propertyId] = {
                id: propertyId,
                ...definition
            };
        },

        // Utility functions exposed for use elsewhere
        utils: {
            escapeHtml,
            getContrastTextColor,
            getInitials,
            getAssigneeName
        },

        // ============ Hierarchy Helpers ============

        // Check if task is a subtask (has a parent)
        isSubtask(task) {
            return !!task?.parentId;
        },

        // Check if task has children
        hasChildren(task) {
            return (task?.childCount || 0) > 0;
        },

        // Get parent task
        getParent(task) {
            if (!task?.parentId) return null;
            return window.currentTasks?.find(t => t.id === task.parentId) || null;
        },

        // Get task depth in hierarchy
        getDepth(task) {
            let depth = 0;
            let current = task;
            while (current?.parentId) {
                depth++;
                current = window.currentTasks?.find(t => t.id === current.parentId);
                if (!current) break;
            }
            return depth;
        }
    };
})();

// Export to global scope
window.PropertyRegistry = PropertyRegistry;
