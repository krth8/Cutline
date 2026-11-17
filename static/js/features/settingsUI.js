/**
 * SettingsUI - UI functions for the Settings tab
 *
 * Handles:
 * - Scope toggle (global/project)
 * - Priority preset selection and preview
 * - Status preset selection and preview
 * - Custom preset creation
 */

// ============ State ============

let currentSettingsScope = 'global';

// ============ Initialization ============

/**
 * Initialize settings UI when the settings tab is opened
 */
async function initSettingsUI() {
    // Wait for managers to be ready
    if (!SettingsManager.isReady()) {
        await SettingsManager.init();
    }
    if (!PresetManager.isReady()) {
        await PresetManager.init();
    }

    // Update scope button state
    updateScopeButtons();

    // Load preset dropdowns
    await loadPriorityPresetDropdown();
    await loadStatusPresetDropdown();
}

// ============ Scope Toggle ============

function setSettingsScope(scope) {
    currentSettingsScope = scope;
    updateScopeButtons();

    // Reload dropdowns with new scope
    loadPriorityPresetDropdown();
    loadStatusPresetDropdown();
}

function updateScopeButtons() {
    const globalBtn = document.getElementById('scopeGlobalBtn');
    const projectBtn = document.getElementById('scopeProjectBtn');
    const hint = document.getElementById('settingsScopeHint');

    // Check if a project is selected
    const currentProject = SettingsManager.getCurrentProjectId() || AppState.currentProject;

    if (globalBtn) {
        globalBtn.classList.toggle('active', currentSettingsScope === 'global');
    }

    if (projectBtn) {
        projectBtn.classList.toggle('active', currentSettingsScope === 'project');
        projectBtn.disabled = !currentProject;
    }

    if (hint) {
        if (currentSettingsScope === 'global') {
            hint.textContent = 'Global settings apply to all projects';
        } else if (currentProject) {
            hint.textContent = 'Settings for this project only';
        } else {
            hint.textContent = 'Select a project to use project settings';
        }
    }
}

// ============ Priority Presets ============

async function loadPriorityPresetDropdown() {
    const select = document.getElementById('priorityPresetSelect');
    if (!select) return;

    const presets = PresetManager.getPriorityPresets();
    const activePresetId = SettingsManager.get('priorityPreset', currentSettingsScope === 'project') || 'default';

    select.innerHTML = presets.map(preset => `
        <option value="${preset.id}" ${preset.id === activePresetId ? 'selected' : ''}>
            ${preset.name}${preset.isBuiltin ? '' : ' (Custom)'}
        </option>
    `).join('');

    // Update preview
    updatePriorityPresetPreview(activePresetId);
}

function updatePriorityPresetPreview(presetId) {
    const preview = document.getElementById('priorityPresetPreview');
    if (!preview) return;

    const preset = PresetManager.getPriorityPresets().find(p => p.id === presetId);
    if (!preset) {
        preview.innerHTML = '<span class="preset-preview-empty">No preset selected</span>';
        return;
    }

    preview.innerHTML = preset.options.map(opt => `
        <span class="preset-preview-item" style="--pill: ${opt.color}">
            <span class="preset-preview-dot" style="background: ${opt.color}"></span>
            ${opt.label}
        </span>
    `).join('');
}

async function changePriorityPreset(presetId) {
    const scope = currentSettingsScope === 'project' ? 'project' : 'global';
    await SettingsManager.set('priorityPreset', presetId, scope);
    await PresetManager.setActivePriorityPreset(presetId);
    updatePriorityPresetPreview(presetId);
}

// ============ Status Presets ============

async function loadStatusPresetDropdown() {
    const select = document.getElementById('statusPresetSelect');
    if (!select) return;

    const presets = PresetManager.getStatusPresets();
    const activePresetId = SettingsManager.get('statusPreset', currentSettingsScope === 'project') || 'kanban';

    select.innerHTML = presets.map(preset => `
        <option value="${preset.id}" ${preset.id === activePresetId ? 'selected' : ''}>
            ${preset.name}${preset.isBuiltin ? '' : ' (Custom)'}
        </option>
    `).join('');

    // Update preview
    updateStatusPresetPreview(activePresetId);
}

function updateStatusPresetPreview(presetId) {
    const preview = document.getElementById('statusPresetPreview');
    if (!preview) return;

    const preset = PresetManager.getStatusPresets().find(p => p.id === presetId);
    if (!preset) {
        preview.innerHTML = '<span class="preset-preview-empty">No preset selected</span>';
        return;
    }

    preview.innerHTML = preset.statuses.map(status => `
        <span class="preset-preview-item" style="--pill: ${status.color}">
            <span class="preset-preview-dot" style="background: ${status.color}"></span>
            ${status.name}
        </span>
    `).join('');
}

async function changeStatusPreset(presetId) {
    const scope = currentSettingsScope === 'project' ? 'project' : 'global';
    await SettingsManager.set('statusPreset', presetId, scope);
    updateStatusPresetPreview(presetId);

    // Ask if user wants to apply status preset to current project
    const currentProject = AppState.currentProject;
    if (currentProject && scope === 'project') {
        const confirmed = await showConfirm({
            title: 'Apply Status Preset?',
            message: 'Do you want to replace the current project statuses with this preset?',
            confirmText: 'Apply',
            cancelText: 'Keep Current'
        });

        if (confirmed) {
            await PresetManager.applyStatusPreset(presetId, currentProject);
            // Reload statuses
            if (typeof loadStatuses === 'function') {
                await loadStatuses();
            }
        }
    }
}

// ============ Custom Preset Creation ============

function showCreatePriorityPreset() {
    const modal = UIModal.create({
        title: 'Create Priority Preset',
        size: 'medium',
        body: `
            <div class="form-field">
                <label>Preset Name</label>
                <input type="text" id="newPresetName" class="input-large" placeholder="e.g. My Custom Priorities">
            </div>
            <div class="form-field">
                <label>Priority Options</label>
                <div id="priorityOptionsEditor" class="preset-options-editor">
                    <div class="preset-option-row">
                        <input type="text" class="input-small priority-value" placeholder="Value (e.g. low)">
                        <input type="text" class="input-small priority-label" placeholder="Label (e.g. Low)">
                        <input type="color" class="input-color priority-color" value="#6b7280">
                        <button class="btn btn-ghost btn-small" onclick="removePriorityOption(this)">
                            <svg class="icon icon-sm"><use href="/static/icons.svg#icon-x"/></svg>
                        </button>
                    </div>
                </div>
                <button class="btn btn-ghost btn-small" onclick="addPriorityOption()">
                    <svg class="icon icon-sm"><use href="/static/icons.svg#icon-plus"/></svg>
                    Add Option
                </button>
            </div>
        `,
        footer: `
            <button class="btn btn-ghost" onclick="UIModal.close()">Cancel</button>
            <button class="btn btn-primary" onclick="saveCustomPriorityPreset()">Create Preset</button>
        `
    });

    UIModal.open(modal);
}

function addPriorityOption() {
    const editor = document.getElementById('priorityOptionsEditor');
    if (!editor) return;

    const row = document.createElement('div');
    row.className = 'preset-option-row';
    row.innerHTML = `
        <input type="text" class="input-small priority-value" placeholder="Value">
        <input type="text" class="input-small priority-label" placeholder="Label">
        <input type="color" class="input-color priority-color" value="#6b7280">
        <button class="btn btn-ghost btn-small" onclick="removePriorityOption(this)">
            <svg class="icon icon-sm"><use href="/static/icons.svg#icon-x"/></svg>
        </button>
    `;
    editor.appendChild(row);
}

function removePriorityOption(btn) {
    const row = btn.closest('.preset-option-row');
    if (row) row.remove();
}

async function saveCustomPriorityPreset() {
    const name = document.getElementById('newPresetName')?.value?.trim();
    if (!name) {
        showToast('Please enter a preset name', 'error');
        return;
    }

    const rows = document.querySelectorAll('#priorityOptionsEditor .preset-option-row');
    const options = [];

    for (const row of rows) {
        const value = row.querySelector('.priority-value')?.value?.trim();
        const label = row.querySelector('.priority-label')?.value?.trim();
        const color = row.querySelector('.priority-color')?.value;

        if (value && label) {
            options.push({ value, label, color });
        }
    }

    if (options.length < 2) {
        showToast('Please add at least 2 priority options', 'error');
        return;
    }

    const result = await PresetManager.createPriorityPreset(name, options);
    if (result.error) {
        showToast(result.error, 'error');
        return;
    }

    UIModal.close();
    showToast('Priority preset created', 'success');
    await loadPriorityPresetDropdown();
}

function showCreateStatusPreset() {
    const modal = UIModal.create({
        title: 'Create Status Preset',
        size: 'medium',
        body: `
            <div class="form-field">
                <label>Preset Name</label>
                <input type="text" id="newStatusPresetName" class="input-large" placeholder="e.g. My Workflow">
            </div>
            <div class="form-field">
                <label>Statuses</label>
                <div id="statusOptionsEditor" class="preset-options-editor">
                    <div class="preset-option-row">
                        <input type="text" class="input-small status-name" placeholder="Status name">
                        <input type="color" class="input-color status-color" value="#6b7280">
                        <button class="btn btn-ghost btn-small" onclick="removeStatusOption(this)">
                            <svg class="icon icon-sm"><use href="/static/icons.svg#icon-x"/></svg>
                        </button>
                    </div>
                </div>
                <button class="btn btn-ghost btn-small" onclick="addStatusOption()">
                    <svg class="icon icon-sm"><use href="/static/icons.svg#icon-plus"/></svg>
                    Add Status
                </button>
            </div>
        `,
        footer: `
            <button class="btn btn-ghost" onclick="UIModal.close()">Cancel</button>
            <button class="btn btn-primary" onclick="saveCustomStatusPreset()">Create Preset</button>
        `
    });

    UIModal.open(modal);
}

function addStatusOption() {
    const editor = document.getElementById('statusOptionsEditor');
    if (!editor) return;

    const row = document.createElement('div');
    row.className = 'preset-option-row';
    row.innerHTML = `
        <input type="text" class="input-small status-name" placeholder="Status name">
        <input type="color" class="input-color status-color" value="#6b7280">
        <button class="btn btn-ghost btn-small" onclick="removeStatusOption(this)">
            <svg class="icon icon-sm"><use href="/static/icons.svg#icon-x"/></svg>
        </button>
    `;
    editor.appendChild(row);
}

function removeStatusOption(btn) {
    const row = btn.closest('.preset-option-row');
    if (row) row.remove();
}

async function saveCustomStatusPreset() {
    const name = document.getElementById('newStatusPresetName')?.value?.trim();
    if (!name) {
        showToast('Please enter a preset name', 'error');
        return;
    }

    const rows = document.querySelectorAll('#statusOptionsEditor .preset-option-row');
    const statuses = [];

    for (const row of rows) {
        const statusName = row.querySelector('.status-name')?.value?.trim();
        const color = row.querySelector('.status-color')?.value;

        if (statusName) {
            statuses.push({ name: statusName, color });
        }
    }

    if (statuses.length < 1) {
        showToast('Please add at least 1 status', 'error');
        return;
    }

    const result = await PresetManager.createStatusPreset(name, statuses);
    if (result.error) {
        showToast(result.error, 'error');
        return;
    }

    UIModal.close();
    showToast('Status preset created', 'success');
    await loadStatusPresetDropdown();
}

// ============ Integration ============

// Initialize when settings tab is shown
document.addEventListener('DOMContentLoaded', () => {
    // Listen for settings tab activation
    const settingsTab = document.querySelector('[data-settings-tab="settings"]');
    if (settingsTab) {
        settingsTab.addEventListener('click', () => {
            // Small delay to ensure tab is visible
            setTimeout(initSettingsUI, 50);
        });
    }
});

// Export functions to global scope
window.setSettingsScope = setSettingsScope;
window.changePriorityPreset = changePriorityPreset;
window.changeStatusPreset = changeStatusPreset;
window.showCreatePriorityPreset = showCreatePriorityPreset;
window.showCreateStatusPreset = showCreateStatusPreset;
window.addPriorityOption = addPriorityOption;
window.removePriorityOption = removePriorityOption;
window.saveCustomPriorityPreset = saveCustomPriorityPreset;
window.addStatusOption = addStatusOption;
window.removeStatusOption = removeStatusOption;
window.saveCustomStatusPreset = saveCustomStatusPreset;
window.initSettingsUI = initSettingsUI;
