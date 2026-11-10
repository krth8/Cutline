/**
 * SettingsManager - Handles global and project-specific settings
 *
 * Settings hierarchy:
 * 1. Project-specific settings (highest priority)
 * 2. Global settings (fallback)
 * 3. Defaults (hardcoded fallback)
 *
 * Usage:
 *   await SettingsManager.init();
 *   const value = SettingsManager.get('priorityPreset');
 *   await SettingsManager.set('priorityPreset', 'urgency');
 */
const SettingsManager = (function() {

    // ============ State ============

    let globalSettings = {};
    let projectSettings = {};
    let currentProjectId = null;
    let isInitialized = false;

    // Default values for known settings
    const defaults = {
        priorityPreset: 'default',
        statusPreset: null,
        defaultColumns: ['name', 'status', 'priority', 'assignee', 'dueDate', 'stage'],
        theme: 'dark',
        sidebarCollapsed: false
    };

    // ============ API ============

    async function fetchSettings(scope = 'global', scopeId = null) {
        let url = `/api/settings?scope=${scope}`;
        if (scopeId) url += `&scope_id=${scopeId}`;

        const response = await fetch(url, {
            headers: { 'Authorization': `Bearer ${getAuthToken()}` }
        });

        if (!response.ok) {
            console.error('Failed to fetch settings:', response.status);
            return {};
        }

        return await response.json();
    }

    async function saveSetting(key, value, scope = 'global', scopeId = null) {
        const response = await fetch(`/api/settings/${key}`, {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${getAuthToken()}`
            },
            body: JSON.stringify({ value, scope, scopeId })
        });

        if (!response.ok) {
            console.error('Failed to save setting:', response.status);
            return { error: 'Failed to save setting' };
        }

        return await response.json();
    }

    async function deleteSetting(key, scope = 'global', scopeId = null) {
        let url = `/api/settings/${key}?scope=${scope}`;
        if (scopeId) url += `&scope_id=${scopeId}`;

        const response = await fetch(url, {
            method: 'DELETE',
            headers: { 'Authorization': `Bearer ${getAuthToken()}` }
        });

        return response.ok;
    }

    // ============ Core Functions ============

    async function init(projectId = null) {
        // Load global settings
        globalSettings = await fetchSettings('global');

        // Load project settings if project ID provided
        if (projectId) {
            currentProjectId = projectId;
            projectSettings = await fetchSettings('project', projectId);
        }

        isInitialized = true;
        notify('initialized', { globalSettings, projectSettings });
    }

    async function setProject(projectId) {
        if (projectId === currentProjectId) return;

        currentProjectId = projectId;
        if (projectId) {
            projectSettings = await fetchSettings('project', projectId);
        } else {
            projectSettings = {};
        }

        notify('projectChanged', { projectId, projectSettings });
    }

    function get(key, useProjectScope = true) {
        // Try project-specific first
        if (useProjectScope && currentProjectId && projectSettings[key] !== undefined) {
            return projectSettings[key];
        }

        // Fall back to global
        if (globalSettings[key] !== undefined) {
            return globalSettings[key];
        }

        // Fall back to defaults
        return defaults[key];
    }

    async function set(key, value, scope = 'auto') {
        // Determine scope
        let actualScope = scope;
        let scopeId = null;

        if (scope === 'auto') {
            // If project is selected, save to project; otherwise global
            if (currentProjectId) {
                actualScope = 'project';
                scopeId = currentProjectId;
            } else {
                actualScope = 'global';
            }
        } else if (scope === 'project') {
            if (!currentProjectId) {
                console.warn('Cannot save project setting without a project');
                return { error: 'No project selected' };
            }
            scopeId = currentProjectId;
        }

        // Save to API
        const result = await saveSetting(key, value, actualScope, scopeId);

        if (!result.error) {
            // Update local cache
            if (actualScope === 'project') {
                projectSettings[key] = value;
            } else {
                globalSettings[key] = value;
            }
            notify('settingChanged', { key, value, scope: actualScope, scopeId });
        }

        return result;
    }

    async function remove(key, scope = 'auto') {
        let actualScope = scope;
        let scopeId = null;

        if (scope === 'auto' && currentProjectId) {
            actualScope = 'project';
            scopeId = currentProjectId;
        } else if (scope === 'project') {
            scopeId = currentProjectId;
        }

        const success = await deleteSetting(key, actualScope, scopeId);

        if (success) {
            if (actualScope === 'project') {
                delete projectSettings[key];
            } else {
                delete globalSettings[key];
            }
            notify('settingRemoved', { key, scope: actualScope, scopeId });
        }

        return success;
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

    // ============ Utility Functions ============

    function getAll(scope = 'effective') {
        if (scope === 'global') {
            return { ...globalSettings };
        }
        if (scope === 'project') {
            return { ...projectSettings };
        }
        // Effective: merge with project overriding global
        return { ...defaults, ...globalSettings, ...projectSettings };
    }

    function isProjectSetting(key) {
        return currentProjectId && projectSettings[key] !== undefined;
    }

    function getCurrentProjectId() {
        return currentProjectId;
    }

    function isReady() {
        return isInitialized;
    }

    // ============ Public API ============

    return {
        init,
        setProject,
        get,
        set,
        remove,
        getAll,
        isProjectSetting,
        getCurrentProjectId,
        isReady,
        subscribe,

        // Expose defaults for reference
        defaults: { ...defaults }
    };
})();

// Export to global scope
window.SettingsManager = SettingsManager;
