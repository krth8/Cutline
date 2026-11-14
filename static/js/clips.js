// ============ Clips Module (with versioning) ============

function initClips() {
    // Enable horizontal scroll with mouse wheel in clip bin
    initClipBinWheelScroll();
}

// Enable mouse wheel horizontal scrolling in clip bin
function initClipBinWheelScroll() {
    const clipBinContent = document.getElementById('clipBinContent');
    if (!clipBinContent) return;

    clipBinContent.addEventListener('wheel', (e) => {
        // Only intercept if there's horizontal overflow
        if (clipBinContent.scrollWidth > clipBinContent.clientWidth) {
            e.preventDefault();
            // Convert vertical scroll to horizontal
            clipBinContent.scrollLeft += e.deltaY;
        }
    }, { passive: false });
}

// ============ Clip Version Management ============
function addClipVersion(baseName, version, filename) {
    if (!AppState.clips[baseName]) {
        AppState.clips[baseName] = {
            versions: [],
            activeVersion: version
        };
    }

    // Check if version already exists
    const existingVersion = AppState.clips[baseName].versions.find(v => v.version === version);
    if (!existingVersion) {
        AppState.clips[baseName].versions.push({
            version,
            filename,
            uploadedAt: new Date().toISOString()
        });

        // Sort versions descending
        AppState.clips[baseName].versions.sort((a, b) => b.version - a.version);

        // Set as active if it's the newest
        if (version >= AppState.clips[baseName].activeVersion) {
            AppState.clips[baseName].activeVersion = version;
        }
    }

    // Set current clip
    if (!AppState.currentClip) {
        AppState.currentClip = { baseName, version };
    }

    renderClipsSidebar();
    renderClipBin();
}

function selectClipVersion(baseName, version) {
    // Check if we're changing to a different clip (not just a different version)
    const isChangingClip = !AppState.currentClip || AppState.currentClip.baseName !== baseName;

    AppState.clips[baseName].activeVersion = version;
    AppState.currentClip = { baseName, version };

    // Reset play button state when switching clips
    if (typeof resetPlayButton === 'function') {
        resetPlayButton();
    }

    // Only reset compare mode when changing to a DIFFERENT clip, not when changing versions
    if (isChangingClip && typeof resetCompareMode === 'function') {
        resetCompareMode();
    }

    // Always reset drawing mode and UI when switching clips
    AppState.drawMode = false;
    AppState.pendingDrawing = null;
    AppState.currentStroke = [];
    elements.svgOverlay?.classList.remove('drawing');
    elements.svgOverlay?.querySelectorAll('path').forEach(el => el.remove());

    const drawBtn = document.getElementById('drawToggleBtn');
    if (drawBtn) drawBtn.classList.remove('active');

    const paletteArea = document.getElementById('drawPaletteArea');
    if (paletteArea) paletteArea.classList.remove('visible');

    const drawingArea = document.getElementById('commentDrawingArea');
    if (drawingArea) drawingArea.classList.remove('visible');

    const clip = AppState.clips[baseName].versions.find(v => v.version === version);
    if (clip) {
        // Check media type
        const mediaType = clip.mediaType || 'video';
        AppState.currentMediaType = mediaType;

        if (mediaType === 'html') {
            // Sandboxed iframe with element-anchored comments
            HtmlReview.load(clip, baseName);
        } else if (mediaType === 'image') {
            // Load image
            loadImage(`/video/${clip.filename}`);
        } else {
            // Use proxy file based on current quality if available
            let videoFile = clip.filename;
            if (clip.proxies) {
                // Check if current quality is available, otherwise use default
                if (clip.proxies[AppState.currentQuality]) {
                    videoFile = clip.proxies[AppState.currentQuality];
                } else if (clip.defaultQuality && clip.proxies[clip.defaultQuality]) {
                    videoFile = clip.proxies[clip.defaultQuality];
                    AppState.currentQuality = clip.defaultQuality;
                } else {
                    // Use first available proxy
                    const availableQualities = Object.keys(clip.proxies);
                    if (availableQualities.length > 0) {
                        videoFile = clip.proxies[availableQualities[0]];
                        AppState.currentQuality = availableQualities[0];
                    }
                }
            }
            loadVideo(`/video/${videoFile}`);

            // Update quality dropdown
            if (typeof updateQualityDropdown === 'function') {
                updateQualityDropdown();
            }
        }

        // Update UI for media type
        updateMediaTypeUI(mediaType);
    }

    // Sync clip selection to other users
    sendSyncClip(baseName, version);

    renderClipsSidebar();
    renderClipBin();

    // Update project sidebar to show active clip
    if (typeof renderProjectsSidebar === 'function') {
        renderProjectsSidebar();
    }

    // Update version dropdown in player bar
    if (typeof updateVersionDropdown === 'function') {
        updateVersionDropdown();
    }

    // Update status dropdown in player bar
    if (typeof updateStatusDropdownUI === 'function') {
        updateStatusDropdownUI();
    }

    // Re-render comments for this clip
    if (typeof renderComments === 'function') {
        renderComments();
    }

    // Update compare control (show/hide based on version count)
    if (typeof initCompareControl === 'function') {
        initCompareControl();
    }

    // Notify clip tasks panel of selection change
    if (typeof onClipSelectionChanged === 'function') {
        onClipSelectionChanged();
    }
}

// Load video (replacing cacheVideo)
function loadVideo(src) {
    const video = elements.video;
    const stillImage = document.getElementById('stillImage');

    // Show video, hide image and HTML page
    if (typeof HtmlReview !== 'undefined') HtmlReview.unload();
    if (video) video.style.display = 'block';
    if (stillImage) stillImage.style.display = 'none';

    // Resize canvas when video metadata loads
    video.addEventListener('loadedmetadata', () => {
        if (typeof resizeCanvasToDisplay === 'function') resizeCanvasToDisplay();
    }, { once: true });

    // Cache and load video
    cacheVideo(src);
}

// Load still image
function loadImage(src) {
    const video = elements.video;
    const stillImage = document.getElementById('stillImage');

    // Hide video and HTML page, show image
    if (typeof HtmlReview !== 'undefined') HtmlReview.unload();
    if (video) {
        video.pause();
        video.style.display = 'none';
    }

    if (stillImage) {
        stillImage.src = src;
        stillImage.style.display = 'block';

        // Update overlay dimensions when image loads
        stillImage.onload = () => {
            if (typeof updateOverlayDimensions === 'function') {
                updateOverlayDimensions();
            }
        };
    }

    // Reset timeline to frame 0 for images
    AppState.currentFrame = 0;
}

// Update UI based on media type (show/hide video controls)
function updateMediaTypeUI(mediaType) {
    const app = document.querySelector('.app');
    if (!app) return;

    app.classList.toggle('image-mode', mediaType === 'image');
    app.classList.toggle('html-mode', mediaType === 'html');
    app.classList.toggle('video-mode', mediaType !== 'image' && mediaType !== 'html');

    const input = document.getElementById('commentInput');
    if (input) {
        input.placeholder = mediaType === 'html'
            ? 'Add a comment… (E: pin to an element, D: draw)'
            : 'Add a comment at current frame...';
    }
}

function getActiveClip(baseName) {
    const clipData = AppState.clips[baseName];
    if (!clipData) return null;
    return clipData.versions.find(v => v.version === clipData.activeVersion);
}

// ============ Sidebar Rendering ============
function renderClipsSidebar() {
    const container = document.getElementById('clipsList');
    if (!container) return;

    const clipNames = Object.keys(AppState.clips);

    if (clipNames.length === 0) {
        container.innerHTML = `
            <div class="empty-state">
                <p>No clips yet</p>
            </div>
        `;
        return;
    }

    container.innerHTML = clipNames.map(baseName => {
        const clipData = AppState.clips[baseName];
        const versionCount = clipData.versions.length;
        const isActive = AppState.currentClip?.baseName === baseName;
        const isExpanded = versionCount > 1;

        const versionsHtml = clipData.versions.map(v => {
            const isCurrent = v.version === clipData.activeVersion;
            return `
                <div class="clip-version-item ${isCurrent ? 'current' : ''}"
                     onclick="event.stopPropagation(); selectClipVersion('${baseName}', ${v.version})">
                    v${formatVersion(v.version)}${isCurrent ? ' - current' : ''}
                </div>
            `;
        }).join('');

        // Icon changes to trash on hover for admins
        const normalIcon = versionCount > 1
            ? '<svg class="icon icon-sm"><use href="/static/icons.svg#icon-caret-right"/></svg>'
            : '<svg class="icon icon-sm"><use href="/static/icons.svg#icon-dot"/></svg>';
        const trashIcon = '<svg class="icon icon-sm"><use href="/static/icons.svg#icon-trash"/></svg>';

        return `
            <div class="clip-group ${isExpanded ? 'expanded' : ''}" data-clip="${baseName}">
                <div class="clip-group-header ${isActive ? 'active' : ''} ${AppState.isAdmin ? 'admin-hover' : ''}"
                     onclick="toggleClipGroup('${baseName}')">
                    <span class="clip-group-icon">
                        <span class="icon-normal">${normalIcon}</span>
                        ${AppState.isAdmin ? `<span class="icon-delete" onclick="event.stopPropagation(); confirmDeleteClip('${escapeHtml(baseName).replace(/'/g, "\\'")}')">${trashIcon}</span>` : ''}
                    </span>
                    <span class="clip-group-name">${escapeHtml(baseName)}</span>
                    <span class="clip-group-count">${versionCount}</span>
                </div>
                ${versionCount > 1 ? `<div class="clip-versions">${versionsHtml}</div>` : ''}
            </div>
        `;
    }).join('');
}

function toggleClipGroup(baseName) {
    const group = document.querySelector(`.clip-group[data-clip="${baseName}"]`);
    if (group) {
        group.classList.toggle('expanded');
    }

    // If single version, select it
    const clipData = AppState.clips[baseName];
    if (clipData && clipData.versions.length === 1) {
        selectClipVersion(baseName, clipData.versions[0].version);
    }
}

// ============ Clip Bin Rendering ============
function renderClipBin() {
    const container = document.getElementById('clipBinContent');
    if (!container) return;

    const clipElements = ClipCard.renderAll(AppState.clips, {
        getCardOptions: (baseName, clipData) => ({
            isActive: AppState.currentClip?.baseName === baseName,
            showDelete: AppState.isAdmin,
            onDelete: `confirmDeleteClip('${ClipCard.escapeHtml(baseName).replace(/'/g, "\\'")}')`,
            onClick: `selectClipVersion('${baseName}', ${clipData.activeVersion})`
        })
    });

    container.innerHTML = clipElements + `
        <div class="clip-add" onclick="triggerMultiUpload()">
            <div class="clip-add-icon"><svg class="icon icon-lg"><use href="/static/icons.svg#icon-plus"/></svg></div>
            <div class="clip-add-text">Add clips</div>
        </div>
    `;
}

// ============ Clip Status Dropdown ============
let activeClipStatusDropdown = null;

function openClipStatusDropdown(event, baseName) {
    event.stopPropagation();

    // Close any open dropdowns
    Dropdown.closeAll();
    DatePicker.closeAll();

    const trigger = event.currentTarget;
    const currentId = trigger.dataset.currentId || '';
    const statuses = AppState.statuses || [];

    const items = statuses.map(s => ({
        id: s.id,
        label: s.name,
        color: s.color
    }));

    activeClipStatusDropdown = new Dropdown({
        id: 'clipStatusDropdown',
        items: items,
        value: currentId,
        clearable: true,
        clearLabel: 'No status',
        minWidth: 120,
        maxWidth: 180,
        renderItem: (item, index) => {
            const isSelected = currentId === item.id;
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
            updateClipStatus(baseName, item ? item.id : '');
        }
    });

    activeClipStatusDropdown.open(trigger);
}

// ============ Clip Delete ============
async function confirmDeleteClip(baseName) {
    const clipData = AppState.clips[baseName];
    const versionCount = clipData?.versions?.length || 0;
    const versionText = versionCount === 1 ? '1 versjon' : `${versionCount} versjoner`;

    const confirmed = await Confirm.danger(
        `Er du sikker på at du vil slette "${baseName}"?\n\nDette vil slette:\n• ${versionText}\n• Alle tilhørende filer og thumbnails\n\nDenne handlingen kan ikke angres!`,
        'Slett klipp'
    );

    if (confirmed) {
        deleteClip(baseName);
    }
}

async function deleteClip(baseName) {
    if (!AppState.projectId) {
        alert('Ingen prosjekt valgt');
        return;
    }

    try {
        const response = await fetch(`/api/projects/${AppState.projectId}/clips/${encodeURIComponent(baseName)}`, {
            method: 'DELETE',
            headers: {
                'Authorization': `Bearer ${AppState.authToken}`
            }
        });

        if (!response.ok) {
            const data = await response.json();
            throw new Error(data.detail || 'Kunne ikke slette klipp');
        }

        removeClipLocally(baseName);

    } catch (error) {
        console.error('Delete clip error:', error);
        alert('Feil ved sletting av klipp: ' + error.message);
    }
}

/** A clip is gone (deleted here or, via the live connection, by someone else). */
function removeClipLocally(baseName) {
    if (!AppState.clips[baseName]) return;
    delete AppState.clips[baseName];

    // If this was the current clip, move to another one
    if (AppState.currentClip?.baseName === baseName) {
        AppState.currentClip = null;
        if (typeof HtmlReview !== 'undefined') HtmlReview.unload();
        const remainingClips = Object.keys(AppState.clips);
        if (remainingClips.length > 0) {
            const firstClip = AppState.clips[remainingClips[0]];
            selectClipVersion(remainingClips[0], firstClip.activeVersion);
        } else if (typeof showEmptyPlayerState === 'function') {
            showEmptyPlayerState();
        }
    }

    renderClipsSidebar();
    renderClipBin();
    if (typeof renderProjectsSidebar === 'function') renderProjectsSidebar();
}

/**
 * Take in a clip as the server has it now (new version, status change, ...)
 * without disturbing what this tab is playing.
 */
function applyClipUpdate(baseName, clip, announce) {
    const existing = AppState.clips[baseName];
    const isCurrent = AppState.currentClip?.baseName === baseName;
    const knownVersions = new Set((existing?.versions || []).map(v => v.version));
    const newVersions = (clip.versions || []).filter(v => !knownVersions.has(v.version));

    const next = { ...clip };
    // Keep this tab on the version it is showing
    if (isCurrent && next.versions.some(v => v.version === AppState.currentClip.version)) {
        next.activeVersion = AppState.currentClip.version;
    }
    AppState.clips[baseName] = next;

    if (!AppState.currentClip) {
        // Nothing was open (empty project): show the clip that just arrived
        document.getElementById('emptyPlayerOverlay')?.classList.remove('visible');
        selectClipVersion(baseName, clip.activeVersion);
    } else {
        renderClipsSidebar();
        renderClipBin();
        if (typeof renderProjectsSidebar === 'function') renderProjectsSidebar();
        if (isCurrent) {
            if (typeof updateVersionDropdown === 'function') updateVersionDropdown();
            if (typeof updateStatusDropdownUI === 'function') updateStatusDropdownUI();
            if (typeof initCompareControl === 'function') initCompareControl();
        }
    }

    if (announce && newVersions.length && typeof Toast !== 'undefined') {
        const newest = newVersions[0];
        Toast.info(existing ? `New version of ${baseName}: ${newest.versionStr || 'v' + newest.version}` : `New clip: ${baseName}`);
    }
}

// Make functions globally accessible
window.removeClipLocally = removeClipLocally;
window.applyClipUpdate = applyClipUpdate;
window.initClips = initClips;
window.addClipVersion = addClipVersion;
window.selectClipVersion = selectClipVersion;
window.getActiveClip = getActiveClip;
window.renderClipsSidebar = renderClipsSidebar;
window.renderClipBin = renderClipBin;
window.toggleClipGroup = toggleClipGroup;
window.loadVideo = loadVideo;
window.loadImage = loadImage;
window.updateMediaTypeUI = updateMediaTypeUI;
window.confirmDeleteClip = confirmDeleteClip;
window.deleteClip = deleteClip;
window.openClipStatusDropdown = openClipStatusDropdown;
