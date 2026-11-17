/**
 * PresetManager - Manages priority and status presets
 *
 * Provides access to built-in and custom presets for:
 * - Priority options (low/medium/high, P1-P4, urgency, etc.)
 * - Status configurations (kanban, vfx pipeline, simple, etc.)
 *
 * Usage:
 *   await PresetManager.init();
 *   const priorities = PresetManager.getActivePriorityOptions();
 *   const presets = PresetManager.getPriorityPresets();
 */
const PresetManager = (function() {

    // ============ State ============

    let priorityPresets = [];
    let statusPresets = [];
    let activePriorityPresetId = 'default';
    let isInitialized = false;

    // ============ API ============

    async function fetchPriorityPresets() {
        const response = await fetch('/api/priority-presets', {
            headers: { 'Authorization': `Bearer ${getAuthToken()}` }
        });

        if (!response.ok) {
            console.error('Failed to fetch priority presets:', response.status);
            return [];
        }

        return await response.json();
    }

    async function fetchStatusPresets() {
        const response = await fetch('/api/status-presets', {
            headers: { 'Authorization': `Bearer ${getAuthToken()}` }
        });

        if (!response.ok) {
            console.error('Failed to fetch status presets:', response.status);
            return [];
        }

        return await response.json();
    }

    async function createPriorityPreset(name, options) {
        const response = await fetch('/api/priority-presets', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${getAuthToken()}`
            },
            body: JSON.stringify({ name, options })
        });

        if (!response.ok) {
            const error = await response.json();
            return { error: error.detail || 'Failed to create preset' };
        }

        const preset = await response.json();
        priorityPresets.push(preset);
        notify('priorityPresetCreated', preset);
        return { preset };
    }

    async function updatePriorityPreset(presetId, updates) {
        const response = await fetch(`/api/priority-presets/${presetId}`, {
            method: 'PATCH',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${getAuthToken()}`
            },
            body: JSON.stringify(updates)
        });

        if (!response.ok) {
            const error = await response.json();
            return { error: error.detail || 'Failed to update preset' };
        }

        const preset = await response.json();
        const idx = priorityPresets.findIndex(p => p.id === presetId);
        if (idx > -1) priorityPresets[idx] = preset;
        notify('priorityPresetUpdated', preset);
        return { preset };
    }

    async function deletePriorityPreset(presetId) {
        const response = await fetch(`/api/priority-presets/${presetId}`, {
            method: 'DELETE',
            headers: { 'Authorization': `Bearer ${getAuthToken()}` }
        });

        if (!response.ok) {
            const error = await response.json();
            return { error: error.detail || 'Failed to delete preset' };
        }

        priorityPresets = priorityPresets.filter(p => p.id !== presetId);
        notify('priorityPresetDeleted', { id: presetId });
        return { success: true };
    }

    async function createStatusPreset(name, statuses) {
        const response = await fetch('/api/status-presets', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${getAuthToken()}`
            },
            body: JSON.stringify({ name, statuses })
        });

        if (!response.ok) {
            const error = await response.json();
            return { error: error.detail || 'Failed to create preset' };
        }

        const preset = await response.json();
        statusPresets.push(preset);
        notify('statusPresetCreated', preset);
        return { preset };
    }

    async function applyStatusPreset(presetId, projectId = null) {
        const response = await fetch(`/api/status-presets/${presetId}/apply`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${getAuthToken()}`
            },
            body: JSON.stringify({ projectId })
        });

        if (!response.ok) {
            const error = await response.json();
            return { error: error.detail || 'Failed to apply preset' };
        }

        const result = await response.json();
        notify('statusPresetApplied', { presetId, statuses: result.statuses });
        return result;
    }

    // ============ Core Functions ============

    async function init() {
        // Load presets from API
        const [priorities, statuses] = await Promise.all([
            fetchPriorityPresets(),
            fetchStatusPresets()
        ]);

        priorityPresets = priorities;
        statusPresets = statuses;

        // Get active presets from settings
        if (typeof SettingsManager !== 'undefined' && SettingsManager.isReady()) {
            activePriorityPresetId = SettingsManager.get('priorityPreset') || 'default';
        }

        isInitialized = true;
        notify('initialized', { priorityPresets, statusPresets });
    }

    function setActivePriorityPreset(presetId) {
        const preset = priorityPresets.find(p => p.id === presetId);
        if (!preset) {
            console.warn('Priority preset not found:', presetId);
            return false;
        }

        activePriorityPresetId = presetId;

        // Save to settings
        if (typeof SettingsManager !== 'undefined') {
            SettingsManager.set('priorityPreset', presetId);
        }

        // Update PropertyRegistry if available
        if (typeof PropertyRegistry !== 'undefined') {
            updatePropertyRegistryPriorities(preset.options);
        }

        notify('activePriorityPresetChanged', { presetId, preset });
        return true;
    }

    function updatePropertyRegistryPriorities(options) {
        // Convert options array to PriorityOptions format
        const priorityOptions = {};
        options.forEach(opt => {
            priorityOptions[opt.id] = {
                label: opt.label,
                color: opt.color,
                icon: opt.icon || 'icon-minus'
            };
        });

        // Update PropertyRegistry (if it supports dynamic updates)
        if (PropertyRegistry.PriorityOptions) {
            // Clear and repopulate
            Object.keys(PropertyRegistry.PriorityOptions).forEach(key => {
                delete PropertyRegistry.PriorityOptions[key];
            });
            Object.assign(PropertyRegistry.PriorityOptions, priorityOptions);
        }
    }

    // ============ Getters ============

    function getPriorityPresets() {
        return [...priorityPresets];
    }

    function getStatusPresets() {
        return [...statusPresets];
    }

    function getPriorityPreset(presetId) {
        return priorityPresets.find(p => p.id === presetId) || null;
    }

    function getStatusPreset(presetId) {
        return statusPresets.find(p => p.id === presetId) || null;
    }

    function getActivePriorityPreset() {
        return getPriorityPreset(activePriorityPresetId);
    }

    function getActivePriorityOptions() {
        const preset = getActivePriorityPreset();
        if (preset) {
            return preset.options;
        }

        // Fallback to hardcoded defaults
        return [
            { id: 'low', label: 'Low', color: '#6b7280', sortOrder: 1 },
            { id: 'medium', label: 'Medium', color: '#f59e0b', sortOrder: 2 },
            { id: 'high', label: 'High', color: '#ef4444', sortOrder: 3 }
        ];
    }

    function getActivePriorityOptionsMap() {
        const options = getActivePriorityOptions();
        const map = {};
        options.forEach(opt => {
            map[opt.id] = {
                label: opt.label,
                color: opt.color,
                icon: opt.icon || 'icon-minus'
            };
        });
        return map;
    }

    function isReady() {
        return isInitialized;
    }

    // ============ Event System ============

    const subscribers = [];

    function subscribe(callback) {
        subscribers.push(callback);
        return () => {
            const idx = subscribers.indexOf(callback);
            if (idx > -1) subscribers.splice(idx, 1);
        };
    }

    function notify(event, data) {
        subscribers.forEach(cb => cb(event, data));
    }

    // ============ Public API ============

    return {
        init,

        // Priority presets
        getPriorityPresets,
        getPriorityPreset,
        getActivePriorityPreset,
        getActivePriorityOptions,
        getActivePriorityOptionsMap,
        setActivePriorityPreset,
        createPriorityPreset,
        updatePriorityPreset,
        deletePriorityPreset,

        // Status presets
        getStatusPresets,
        getStatusPreset,
        createStatusPreset,
        applyStatusPreset,

        // Utilities
        isReady,
        subscribe
    };
})();

// Export to global scope
window.PresetManager = PresetManager;
