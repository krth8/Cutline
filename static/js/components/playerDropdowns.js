/**
 * Player Bar Dropdown Components
 * Custom dropdowns for version, status, quality, speed, and zoom controls
 */

// ============ Player Dropdown State ============
const PlayerDropdowns = {
    version: null,
    compareVersion: null,
    status: null,
    quality: null,
    speed: null,
    zoom: null
};

// ============ Version Dropdown ============

function initVersionDropdown() {
    const trigger = document.getElementById('versionDropdownTrigger');
    if (!trigger) return;

    trigger.addEventListener('click', (e) => {
        e.stopPropagation();
        openVersionDropdown();
    });
}

function openVersionDropdown() {
    Dropdown.closeAll();
    DatePicker.closeAll();

    const trigger = document.getElementById('versionDropdownTrigger');
    if (!trigger) return;

    // Get versions from current clip
    if (!AppState.currentClip) return;

    const clipData = AppState.clips[AppState.currentClip.baseName];
    if (!clipData) return;

    const items = clipData.versions.map(v => ({
        id: v.version,
        label: `v${formatVersion(v.version)}`
    }));

    PlayerDropdowns.version = new Dropdown({
        id: 'playerVersionDropdown',
        items: items,
        value: clipData.activeVersion,
        clearable: false,
        minWidth: 80,
        maxWidth: 120,
        onSelect: (item) => {
            selectClipVersion(AppState.currentClip.baseName, item.id);
        }
    });

    PlayerDropdowns.version.open(trigger);
}

function updateVersionDropdownUI() {
    const trigger = document.getElementById('versionDropdownTrigger');
    if (!trigger) return;

    const valueEl = trigger.querySelector('.player-dropdown-value');
    if (!valueEl) return;

    if (!AppState.currentClip) {
        valueEl.textContent = '--';
        return;
    }

    const clipData = AppState.clips[AppState.currentClip.baseName];
    if (!clipData) {
        valueEl.textContent = '--';
        return;
    }

    valueEl.textContent = `v${formatVersion(clipData.activeVersion)}`;
}

// ============ Compare Version Dropdown ============

function initCompareVersionDropdown() {
    const trigger = document.getElementById('compareVersionTrigger');
    if (!trigger) return;

    trigger.addEventListener('click', (e) => {
        e.stopPropagation();
        openCompareVersionDropdown();
    });
}

function openCompareVersionDropdown() {
    Dropdown.closeAll();
    DatePicker.closeAll();

    const trigger = document.getElementById('compareVersionTrigger');
    if (!trigger) return;

    // Get versions from current clip
    if (!AppState.currentClip) return;

    const clipData = AppState.clips[AppState.currentClip.baseName];
    if (!clipData) return;

    const items = clipData.versions.map(v => ({
        id: v.version,
        label: `v${formatVersion(v.version)}`
    }));

    PlayerDropdowns.compareVersion = new Dropdown({
        id: 'playerCompareVersionDropdown',
        items: items,
        value: AppState.compareVersion,
        clearable: false,
        minWidth: 80,
        maxWidth: 120,
        onSelect: (item) => {
            selectCompareVersion(item.id);
        }
    });

    PlayerDropdowns.compareVersion.open(trigger);
}

function updateCompareVersionDropdownUI() {
    const trigger = document.getElementById('compareVersionTrigger');
    if (!trigger) return;

    const valueEl = trigger.querySelector('.player-dropdown-value');
    if (!valueEl) return;

    if (!AppState.compareVersion) {
        valueEl.textContent = '--';
        return;
    }

    valueEl.textContent = `v${formatVersion(AppState.compareVersion)}`;
}

// ============ Status Dropdown ============

function initStatusDropdown() {
    const trigger = document.getElementById('statusDropdownTrigger');
    if (!trigger) return;

    trigger.addEventListener('click', (e) => {
        e.stopPropagation();
        openPlayerStatusDropdown();
    });
}

function openPlayerStatusDropdown() {
    Dropdown.closeAll();
    DatePicker.closeAll();

    const trigger = document.getElementById('statusDropdownTrigger');
    if (!trigger) return;

    const statuses = AppState.statuses || [];

    // Get current status
    let currentStatusId = null;
    if (AppState.currentClip) {
        const clipData = AppState.clips[AppState.currentClip.baseName];
        if (clipData && clipData.status) {
            currentStatusId = clipData.status.id;
        }
    }

    const items = statuses.map(s => ({
        id: s.id,
        label: s.name,
        color: s.color
    }));

    PlayerDropdowns.status = new Dropdown({
        id: 'playerStatusDropdown',
        items: items,
        value: currentStatusId,
        clearable: true,
        clearLabel: 'No status',
        minWidth: 120,
        maxWidth: 180,
        renderItem: (item, index) => {
            const isSelected = PlayerDropdowns.status?.value === item.id;
            return `
                <div class="dropdown-item ${isSelected ? 'selected' : ''}"
                     data-index="${index}"
                     data-id="${item.id}">
                    <span class="status-dropdown-color" style="background-color: ${item.color}"></span>
                    <span class="dropdown-item-label">${Dropdown.prototype.escapeHtml(item.label)}</span>
                </div>
            `;
        },
        onSelect: (item) => {
            if (AppState.currentClip) {
                updateClipStatus(AppState.currentClip.baseName, item ? item.id : '');
                updateStatusDropdownUI();
            }
        }
    });

    PlayerDropdowns.status.open(trigger);
}

function updateStatusDropdownUI() {
    const trigger = document.getElementById('statusDropdownTrigger');
    if (!trigger) return;

    const valueEl = trigger.querySelector('.player-dropdown-value');
    if (!valueEl) return;

    // Reset styling
    trigger.style.backgroundColor = '';
    trigger.style.color = '';
    trigger.classList.remove('has-status');

    if (!AppState.currentClip) {
        valueEl.textContent = 'No status';
        return;
    }

    const clipData = AppState.clips[AppState.currentClip.baseName];
    if (clipData && clipData.status) {
        valueEl.textContent = clipData.status.name;
        trigger.style.backgroundColor = clipData.status.color;
        trigger.style.color = getContrastTextColor(clipData.status.color);
        trigger.classList.add('has-status');
    } else {
        valueEl.textContent = 'No status';
    }
}

// ============ Quality Dropdown ============

function initQualityDropdown() {
    const trigger = document.getElementById('qualityDropdownTrigger');
    if (!trigger) return;

    trigger.addEventListener('click', (e) => {
        e.stopPropagation();
        openQualityDropdown();
    });
}

function openQualityDropdown() {
    Dropdown.closeAll();
    DatePicker.closeAll();

    const trigger = document.getElementById('qualityDropdownTrigger');
    if (!trigger) return;

    // Get available qualities from current clip
    let availableQualities = [];
    if (AppState.currentClip) {
        const clipData = AppState.clips[AppState.currentClip.baseName];
        if (clipData) {
            const activeVersion = clipData.versions.find(v => v.version === clipData.activeVersion);
            if (activeVersion && activeVersion.proxies) {
                availableQualities = Object.keys(activeVersion.proxies);
            }
        }
    }

    const allQualities = [
        { id: '720p', label: '720p' },
        { id: '1080p', label: '1080p' },
        { id: '4k', label: '4K' }
    ];

    const items = allQualities.map(q => ({
        ...q,
        disabled: availableQualities.length > 0 && !availableQualities.includes(q.id)
    }));

    PlayerDropdowns.quality = new Dropdown({
        id: 'playerQualityDropdown',
        items: items,
        value: AppState.currentQuality,
        clearable: false,
        minWidth: 80,
        maxWidth: 120,
        renderItem: (item, index) => {
            const isSelected = AppState.currentQuality === item.id;
            const disabledClass = item.disabled ? 'dropdown-item-disabled' : '';
            return `
                <div class="dropdown-item ${isSelected ? 'selected' : ''} ${disabledClass}"
                     data-index="${index}"
                     data-id="${item.id}">
                    <span class="dropdown-item-label">${item.label}</span>
                </div>
            `;
        },
        onSelect: (item) => {
            if (!item.disabled) {
                changeQuality(item.id, true);
                updateQualityDropdownUI();
            }
        }
    });

    PlayerDropdowns.quality.open(trigger);
}

function updateQualityDropdownUI() {
    const trigger = document.getElementById('qualityDropdownTrigger');
    if (!trigger) return;

    const valueEl = trigger.querySelector('.player-dropdown-value');
    if (!valueEl) return;

    const label = AppState.currentQuality === '4k' ? '4K' : AppState.currentQuality;
    valueEl.textContent = label;
}

// ============ Speed Dropdown ============

function initSpeedDropdown() {
    const trigger = document.getElementById('speedDropdownTrigger');
    if (!trigger) return;

    trigger.addEventListener('click', (e) => {
        e.stopPropagation();
        openSpeedDropdown();
    });
}

function openSpeedDropdown() {
    Dropdown.closeAll();
    DatePicker.closeAll();

    const trigger = document.getElementById('speedDropdownTrigger');
    if (!trigger) return;

    const speeds = [
        { id: '0.25', label: '0.25x' },
        { id: '0.5', label: '0.5x' },
        { id: '0.75', label: '0.75x' },
        { id: '1', label: '1x' },
        { id: '1.25', label: '1.25x' },
        { id: '1.5', label: '1.5x' },
        { id: '2', label: '2x' }
    ];

    const currentSpeed = elements.video?.playbackRate?.toString() || '1';

    PlayerDropdowns.speed = new Dropdown({
        id: 'playerSpeedDropdown',
        items: speeds,
        value: currentSpeed,
        clearable: false,
        minWidth: 80,
        maxWidth: 100,
        onSelect: (item) => {
            if (elements.video) {
                elements.video.playbackRate = parseFloat(item.id);
                updateSpeedDropdownUI();
            }
        }
    });

    PlayerDropdowns.speed.open(trigger);
}

function updateSpeedDropdownUI() {
    const trigger = document.getElementById('speedDropdownTrigger');
    if (!trigger) return;

    const valueEl = trigger.querySelector('.player-dropdown-value');
    if (!valueEl) return;

    const speed = elements.video?.playbackRate || 1;
    valueEl.textContent = speed + 'x';
}

// ============ Zoom Dropdown ============

function initZoomDropdown() {
    const trigger = document.getElementById('zoomDropdownTrigger');
    if (!trigger) return;

    trigger.addEventListener('click', (e) => {
        e.stopPropagation();
        openZoomDropdown();
    });
}

function openZoomDropdown() {
    Dropdown.closeAll();
    DatePicker.closeAll();

    const trigger = document.getElementById('zoomDropdownTrigger');
    if (!trigger) return;

    const zoomLevels = [
        { id: 'fit', label: 'Fit' },
        { id: '0.5', label: '50%' },
        { id: '0.75', label: '75%' },
        { id: '1', label: '100%' },
        { id: '1.5', label: '150%' },
        { id: '2', label: '200%' },
        { id: '3', label: '300%' },
        { id: '4', label: '400%' }
    ];

    // Determine current zoom value
    let currentZoom = 'fit';
    if (typeof zoomState !== 'undefined' && zoomState.scale !== 1) {
        // Check if it matches a preset
        const ratio = typeof getBaseDisplayRatio === 'function' ? getBaseDisplayRatio() : 1;
        const actualRatio = zoomState.scale * ratio;
        const matched = zoomLevels.find(z => z.id !== 'fit' && Math.abs(parseFloat(z.id) - actualRatio) < 0.05);
        currentZoom = matched ? matched.id : 'custom';
    }

    PlayerDropdowns.zoom = new Dropdown({
        id: 'playerZoomDropdown',
        items: zoomLevels,
        value: currentZoom,
        clearable: false,
        minWidth: 80,
        maxWidth: 100,
        onSelect: (item) => {
            if (item.id === 'fit') {
                if (typeof resetZoom === 'function') resetZoom();
            } else {
                const targetRatio = parseFloat(item.id);
                const baseRatio = typeof getBaseDisplayRatio === 'function' ? getBaseDisplayRatio() : 1;
                if (baseRatio && baseRatio > 0) {
                    const neededScale = targetRatio / baseRatio;
                    if (typeof setZoom === 'function') {
                        setZoom(Math.max(0.1, Math.min(10, neededScale)));
                    }
                }
            }
            updateZoomDropdownUI();
        }
    });

    PlayerDropdowns.zoom.open(trigger);
}

function updateZoomDropdownUI() {
    const trigger = document.getElementById('zoomDropdownTrigger');
    if (!trigger) return;

    const valueEl = trigger.querySelector('.player-dropdown-value');
    if (!valueEl) return;

    if (typeof zoomState === 'undefined') {
        valueEl.textContent = 'Fit';
        return;
    }

    // Calculate actual display ratio
    const ratio = typeof getBaseDisplayRatio === 'function' ? getBaseDisplayRatio() : 1;
    const actualRatio = zoomState.scale * ratio;

    // Check if fit (scale ~= 1 and no pan)
    if (Math.abs(zoomState.scale - 1) < 0.01 && Math.abs(zoomState.panX) < 1 && Math.abs(zoomState.panY) < 1) {
        valueEl.textContent = 'Fit';
    } else {
        valueEl.textContent = Math.round(actualRatio * 100) + '%';
    }
}

// ============ Initialize All Player Dropdowns ============

function initPlayerDropdowns() {
    initVersionDropdown();
    initCompareVersionDropdown();
    initStatusDropdown();
    initQualityDropdown();
    initSpeedDropdown();
    initZoomDropdown();
}

// ============ Exports ============

// Override the old functions from app.js
window.updateVersionDropdown = updateVersionDropdownUI;
window.updateStatusDropdownUI = updateStatusDropdownUI;
window.updateQualityDropdown = updateQualityDropdownUI;
window.updateZoomUI = updateZoomDropdownUI;

window.initPlayerDropdowns = initPlayerDropdowns;
window.openVersionDropdown = openVersionDropdown;
window.openCompareVersionDropdown = openCompareVersionDropdown;
window.updateCompareVersionDropdownUI = updateCompareVersionDropdownUI;
window.openPlayerStatusDropdown = openPlayerStatusDropdown;
window.openQualityDropdown = openQualityDropdown;
window.openSpeedDropdown = openSpeedDropdown;
window.openZoomDropdown = openZoomDropdown;
window.updateSpeedDropdownUI = updateSpeedDropdownUI;
window.updateZoomDropdownUI = updateZoomDropdownUI;
