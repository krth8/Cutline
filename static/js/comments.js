// ============ Comments Module (with integrated drawing) ============

// Initialize timecode preference from localStorage
if (typeof AppState !== 'undefined') {
    AppState.showTimecode = localStorage.getItem('showTimecode') === 'true';
}

// Selection state for multi-select comments
let selectedCommentIds = new Set();
let commentSelectMode = false;

// Format frame number as timecode (HH:MM:SS:FF)
function frameToTimecode(frame) {
    const fps = AppState.fps || 24;
    const totalSeconds = Math.floor(frame / fps);
    const frames = frame % fps;
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;

    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}:${String(frames).padStart(2, '0')}`;
}

// Get display string for frame (respects timecode toggle)
function getFrameDisplay(frame) {
    if (AppState.showTimecode) {
        return frameToTimecode(frame);
    }
    return `F${frame}`;
}

// Toggle between frame and timecode display
function toggleTimecodeDisplay() {
    AppState.showTimecode = !AppState.showTimecode;
    localStorage.setItem('showTimecode', AppState.showTimecode);
    renderComments();
    updateTimecodeDisplay();

    // Sync to other users in session
    if (typeof sendSyncTimecodeMode === 'function') {
        sendSyncTimecodeMode(AppState.showTimecode);
    }
}

function initComments() {
    setupCommentSubmit();
    setupDrawing();
    initSyncControl();
}

// ============ Comment Submission ============
function setupCommentSubmit() {
    document.getElementById('submitCommentBtn')?.addEventListener('click', submitComment);

    // Enter to submit (with shift for newline)
    document.getElementById('commentInput')?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            submitComment();
        }
    });
}

// Track reply state
let replyingToCommentId = null;

async function submitComment() {
    const textInput = document.getElementById('commentInput');
    const text = textInput.value.trim();
    const hasDrawing = AppState.pendingDrawing && AppState.pendingDrawing.strokes.length > 0;

    // Must have either text or drawing
    if (!text && !hasDrawing) return;

    // Must have a project loaded
    if (!AppState.projectId) {
        console.error('No project loaded');
        return;
    }

    const isHtml = AppState.currentMediaType === 'html';
    const currentFrame = isHtml ? 0 : getCurrentFrame();
    // Element anchor (HTML clips): only on top-level comments, replies follow their parent
    const anchor = isHtml && !replyingToCommentId ? (AppState.pendingAnchor || null) : null;
    const comment = {
        frame: currentFrame,
        anchor: anchor,
        user: AppState.userId,
        userName: AppState.userName || AppState.userId,
        userProfileImage: AppState.adminUser?.profileImage || null,
        text: text,
        drawing: hasDrawing ? { ...AppState.pendingDrawing, frame: currentFrame } : null,  // Override frame with current
        clipBaseName: AppState.currentClip?.baseName || null,
        clipVersion: AppState.currentClip?.version || null,
        parentId: replyingToCommentId || null  // Include parent if replying
    };

    // Use session endpoint if in session, otherwise use project endpoint
    const endpoint = AppState.sessionId
        ? `/api/session/${AppState.sessionId}/comment`
        : `/api/projects/${AppState.projectId}/comment`;

    const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(comment)
    });

    // Add comment locally if not in session (no WebSocket to receive it)
    if (!AppState.sessionId && response.ok) {
        const savedComment = await response.json();
        AppState.comments.push(savedComment);
        renderComments();
    }

    if (response.ok && anchor && typeof HtmlReview !== 'undefined') {
        HtmlReview.clearPendingAnchor();
    }

    // Notify others to clear the remote drawing preview
    if (hasDrawing && AppState.sessionId && typeof sendDrawComplete === 'function') {
        sendDrawComplete(comment.frame, comment.drawing?.strokes || []);
    }

    // Clear inputs and pending drawing state
    textInput.value = '';
    clearPendingDrawing();
    cancelReply();  // Clear reply state

    // Re-show drawings for current frame (so the just-posted drawing stays visible)
    if (hasDrawing) {
        // Small delay to ensure comment is added to AppState.comments (for session mode)
        setTimeout(() => {
            if (typeof showFrameDrawings === 'function') {
                showFrameDrawings(currentFrame);
            }
        }, 100);
    }
}

// ============ Reply Functions ============
function startReply(commentId, frame) {
    // Cancel any existing reply first
    cancelReply();

    replyingToCommentId = commentId;

    // Go to the frame of the comment we're replying to
    goToFrame(frame);

    // Find the comment element and inject inline reply form after it
    const commentEl = document.querySelector(`.comment-item[data-comment-id="${commentId}"]`);
    if (!commentEl) return;

    const parentComment = AppState.comments.find(c => c.id === commentId);
    const parentName = parentComment?.userName || 'comment';

    // Create inline reply form
    const replyForm = document.createElement('div');
    replyForm.className = 'inline-reply-form';
    replyForm.innerHTML = `
        <div class="inline-reply-header">
            <span>Replying to ${escapeHtml(parentName)}</span>
            <button class="btn-icon btn-xs" onclick="cancelReply()">
                <svg class="icon icon-sm"><use href="/static/icons.svg?v=3#icon-x"/></svg>
            </button>
        </div>
        <div class="inline-reply-input-row">
            <input type="text" class="inline-reply-input" placeholder="Write a reply..." id="inlineReplyInput">
            <button class="btn btn-primary btn-sm" onclick="submitInlineReply()">
                <svg class="icon icon-sm"><use href="/static/icons.svg?v=3#icon-send"/></svg>
            </button>
        </div>
    `;

    // Insert after the comment
    commentEl.insertAdjacentElement('afterend', replyForm);

    // Focus the input
    const input = replyForm.querySelector('.inline-reply-input');
    if (input) {
        input.focus();
        // Handle Enter key
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                submitInlineReply();
            }
            if (e.key === 'Escape') {
                cancelReply();
            }
        });
    }
}

async function submitInlineReply() {
    const input = document.getElementById('inlineReplyInput');
    if (!input) return;

    const text = input.value.trim();
    if (!text) return;

    if (!AppState.projectId) {
        console.error('No project loaded');
        return;
    }

    const currentFrame = getCurrentFrame();
    const comment = {
        frame: currentFrame,
        user: AppState.userId,
        userName: AppState.userName || AppState.userId,
        userProfileImage: AppState.adminUser?.profileImage || null,
        text: text,
        drawing: null,
        clipBaseName: AppState.currentClip?.baseName || null,
        clipVersion: AppState.currentClip?.version || null,
        parentId: replyingToCommentId
    };

    // Use session endpoint if in session, otherwise use project endpoint
    const endpoint = AppState.sessionId
        ? `/api/session/${AppState.sessionId}/comment`
        : `/api/projects/${AppState.projectId}/comment`;

    const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(comment)
    });

    // Add comment locally if not in session (no WebSocket to receive it)
    if (!AppState.sessionId && response.ok) {
        const savedComment = await response.json();
        AppState.comments.push(savedComment);
        renderComments();
    }

    // Clear reply state
    cancelReply();
}

function cancelReply() {
    replyingToCommentId = null;

    // Remove any inline reply forms
    const inlineForm = document.querySelector('.inline-reply-form');
    if (inlineForm) {
        inlineForm.remove();
    }

    // Also hide old-style reply indicator (backwards compat)
    const replyIndicator = document.getElementById('replyIndicator');
    if (replyIndicator) {
        replyIndicator.classList.remove('visible');
        replyIndicator.innerHTML = '';
    }
}

// ============ Resolved Toggle ============
async function toggleCommentResolved(commentId) {
    const comment = AppState.comments.find(c => c.id === commentId);
    if (!comment) return;

    const newResolved = !comment.resolved;

    // Update locally immediately for responsiveness
    comment.resolved = newResolved;
    renderComments();

    // Send to server
    const endpoint = AppState.sessionId
        ? `/api/session/${AppState.sessionId}/comment/${commentId}/resolved`
        : `/api/projects/${AppState.projectId}/comment/${commentId}/resolved`;

    try {
        const headers = { 'Content-Type': 'application/json' };
        if (typeof getAuthHeaders === 'function') {
            Object.assign(headers, getAuthHeaders());
        }
        await fetch(endpoint, {
            method: 'PATCH',
            headers,
            body: JSON.stringify({ resolved: newResolved })
        });
    } catch (err) {
        console.error('Failed to update comment resolved status:', err);
        // Revert on error
        comment.resolved = !newResolved;
        renderComments();
    }
}

// ============ Comments Rendering ============
function renderComments() {
    const container = document.getElementById('commentsList');
    if (!container) return;

    // Keep the pins inside an HTML page in step with the comment list
    const htmlMode = typeof HtmlReview !== 'undefined' && HtmlReview.isActive();
    if (htmlMode) HtmlReview.sendPins();

    // Check if a clip is selected
    if (!AppState.currentClip) {
        container.innerHTML = '<div class="comments-empty">Select a clip to view comments</div>';
        renderTimelineMarkers();
        updateCommentBulkActionBar([]);
        return;
    }

    // Filter comments for current clip only
    const currentBaseName = AppState.currentClip?.baseName;
    const filteredComments = AppState.comments.filter(c => {
        // Show comments that match current clip, or legacy comments without clipBaseName
        return c.clipBaseName === currentBaseName || !c.clipBaseName;
    });

    if (filteredComments.length === 0) {
        container.innerHTML = '<div class="comments-empty">No comments for this clip</div>';
        renderTimelineMarkers();
        updateCommentBulkActionBar([]);
        return;
    }

    // Clean up selectedCommentIds - remove any that are no longer in filtered list
    const filteredIds = new Set(filteredComments.map(c => c.id));
    selectedCommentIds = new Set([...selectedCommentIds].filter(id => filteredIds.has(id)));

    // Organize comments: root comments first, then insert replies after their parent
    const rootComments = filteredComments.filter(c => !c.parentId);
    const replies = filteredComments.filter(c => c.parentId);
    const replyMap = new Map(); // parentId -> [replies]

    replies.forEach(r => {
        if (!replyMap.has(r.parentId)) {
            replyMap.set(r.parentId, []);
        }
        replyMap.get(r.parentId).push(r);
    });

    // Build ordered list: each root comment followed by its replies
    const orderedComments = [];
    rootComments.forEach(root => {
        orderedComments.push(root);
        const rootReplies = replyMap.get(root.id) || [];
        orderedComments.push(...rootReplies);
    });

    // Also add orphaned replies (parent was deleted)
    replies.forEach(r => {
        if (!rootComments.find(root => root.id === r.parentId)) {
            if (!orderedComments.includes(r)) {
                orderedComments.push(r);
            }
        }
    });

    const pinNumbers = htmlMode ? HtmlReview.pinNumbers(filteredComments) : new Map();

    container.innerHTML = orderedComments.map((c) => {
        const hasDrawing = c.drawing && c.drawing.strokes && c.drawing.strokes.length > 0;
        // HTML clips: numbered pin badge (current version) or the version the anchor was made on
        let pinBadge = '';
        if (htmlMode && c.anchor && !c.parentId) {
            pinBadge = pinNumbers.has(c.id)
                ? `<span class="comment-pin-badge" title="${escapeHtml(c.anchor.label || c.anchor.tag || '')}">${pinNumbers.get(c.id)}</span>`
                : `<span class="comment-pin-badge other-version" title="Pinned on another version">v${escapeHtml(String(c.clipVersion ?? '?'))}</span>`;
        }
        const userColor = AppState.users[c.user]?.color || '#6366f1';
        const displayName = c.userName || c.user;
        const initials = displayName.split(' ').map(n => n[0]).join('').toUpperCase().substr(0, 2) || c.user.substr(-2).toUpperCase();
        const profileImage = c.userProfileImage;
        const isSelected = selectedCommentIds.has(c.id);

        // Avatar: show profile image if available, otherwise initials
        const avatarContent = profileImage
            ? `<img src="${profileImage}" alt="${escapeHtml(displayName)}" class="comment-avatar-img">`
            : initials;
        const avatarStyle = profileImage ? 'background:transparent' : `background:${userColor}`;

        // Use pencil icon instead of emoji
        const drawingIndicator = hasDrawing ? '<span class="comment-drawing-indicator" title="Has drawing"><svg class="icon icon-sm"><use href="/static/icons.svg?v=3#icon-pencil"/></svg></span>' : '';

        // Show delete button only for own comments or if admin
        const canDelete = c.user === AppState.userId || AppState.isAdmin;
        const deleteBtn = canDelete ? `<button class="comment-action-btn" onclick="event.stopPropagation(); deleteComment('${c.id}')" title="Delete"><svg class="icon icon-sm"><use href="/static/icons.svg?v=3#icon-trash"/></svg></button>` : '';

        // Reply button
        const replyBtn = `<button class="comment-action-btn" onclick="event.stopPropagation(); startReply('${c.id}', ${c.frame})" title="Reply"><svg class="icon icon-sm"><use href="/static/icons.svg?v=3#icon-reply"/></svg></button>`;

        // Resolved/checkmark button
        const isResolved = c.resolved || false;
        const resolvedBtn = `<button class="comment-action-btn ${isResolved ? 'resolved' : ''}" onclick="event.stopPropagation(); toggleCommentResolved('${c.id}')" title="${isResolved ? 'Mark as unresolved' : 'Mark as resolved'}"><svg class="icon icon-sm"><use href="/static/icons.svg?v=3#icon-check"/></svg></button>`;

        // Checkbox for multi-select (only show if select mode is active AND user can delete)
        const checkbox = (commentSelectMode && canDelete) ? `
            <input type="checkbox" class="cb-dark task-select-checkbox"
                   ${isSelected ? 'checked' : ''}
                   onclick="event.stopPropagation(); toggleCommentSelection('${c.id}', this.checked)"
                   title="Select for bulk delete">
        ` : '';

        // Check if this is a reply (has parentId)
        const isReply = c.parentId ? true : false;
        const replyIndent = isReply ? 'comment-reply' : '';

        return `
            <div class="comment-item ${isSelected ? 'selected' : ''} ${replyIndent} ${isResolved ? 'is-resolved' : ''}"
                 onclick="handleCommentClick(${c.frame}, '${c.id}')"
                 data-comment-id="${c.id}"
                 data-parent-id="${c.parentId || ''}">
                <div class="comment-header">
                    <div class="comment-author">
                        ${checkbox}
                        <div class="comment-author-avatar" style="${avatarStyle}">${avatarContent}</div>
                        <span class="comment-author-name">${escapeHtml(displayName)}</span>
                        <span class="comment-frame-badge">${getFrameDisplay(c.frame)}</span>
                        ${pinBadge}
                    </div>
                    <div class="comment-header-right">
                        ${drawingIndicator}
                        ${resolvedBtn}
                        ${replyBtn}
                        ${deleteBtn}
                    </div>
                </div>
                ${c.text ? `<div class="comment-text">${escapeHtml(c.text)}</div>` : ''}
                <div class="comment-time">${c.timestamp ? new Date(c.timestamp).toLocaleTimeString() : ''}</div>
            </div>
        `;
    }).join('');

    renderTimelineMarkers();
    updateCommentBulkActionBar(filteredComments);
}

function handleCommentClick(frame, commentId) {
    if (typeof HtmlReview !== 'undefined' && HtmlReview.isActive()) {
        // HTML page: jump to the element instead of a frame (replies use their parent's anchor)
        let comment = AppState.comments.find(c => c.id === commentId);
        if (comment && !comment.anchor && comment.parentId) {
            comment = AppState.comments.find(c => c.id === comment.parentId) || comment;
        }
        if (comment?.anchor) HtmlReview.focusComment(comment);
        const commentEl = document.querySelector(`[data-comment-id="${commentId}"]`);
        if (commentEl) {
            commentEl.classList.add('highlighted');
            setTimeout(() => commentEl.classList.remove('highlighted'), 3000);
        }
        return;
    }

    goToFrame(frame);

    // Highlight the corresponding marker on the timeline
    if (typeof highlightMarkerFromComment === 'function') {
        highlightMarkerFromComment(commentId, frame);
    }

    // Highlight this comment briefly
    const commentEl = document.querySelector(`[data-comment-id="${commentId}"]`);
    if (commentEl) {
        commentEl.classList.add('highlighted');
        setTimeout(() => commentEl.classList.remove('highlighted'), 3000);
    }

    // Show ALL drawings for this frame (not just the clicked one)
    // Use setTimeout to ensure video.currentTime has been applied
    setTimeout(() => showFrameDrawings(Number(frame)), 0);
}

// ============ Comment Selection Functions ============

function toggleCommentSelection(commentId, selected) {
    if (selected) {
        selectedCommentIds.add(commentId);
    } else {
        selectedCommentIds.delete(commentId);
    }

    // Update item styling
    const item = document.querySelector(`.comment-item[data-comment-id="${commentId}"]`);
    if (item) {
        item.classList.toggle('selected', selected);
    }

    // Get current filtered comments for bulk action bar
    const currentBaseName = AppState.currentClip?.baseName;
    const filteredComments = AppState.comments.filter(c =>
        c.clipBaseName === currentBaseName || !c.clipBaseName
    );
    updateCommentBulkActionBar(filteredComments);
}

function selectAllComments() {
    const currentBaseName = AppState.currentClip?.baseName;
    const filteredComments = AppState.comments.filter(c =>
        c.clipBaseName === currentBaseName || !c.clipBaseName
    );

    // Only select comments user can delete
    filteredComments.forEach(c => {
        const canDelete = c.user === AppState.userId || AppState.isAdmin;
        if (canDelete) {
            selectedCommentIds.add(c.id);
        }
    });

    renderComments();
}

function clearCommentSelection() {
    selectedCommentIds.clear();
    renderComments();
}

function updateCommentBulkActionBar(filteredComments) {
    let bar = document.getElementById('commentBulkActionBar');

    // Create bar if it doesn't exist
    if (!bar) {
        bar = document.createElement('div');
        bar.id = 'commentBulkActionBar';
        bar.className = 'comment-bulk-action-bar';

        // Insert before comments list
        const commentsList = document.getElementById('commentsList');
        if (commentsList && commentsList.parentNode) {
            commentsList.parentNode.insertBefore(bar, commentsList);
        }
    }

    const count = selectedCommentIds.size;
    const totalDeletable = filteredComments.filter(c =>
        c.user === AppState.userId || AppState.isAdmin
    ).length;

    // Only show bar if there are deletable comments (more than 1)
    if (totalDeletable > 1) {
        bar.classList.add('visible');
        bar.innerHTML = `
            <div class="bulk-action-left">
                <input type="checkbox" class="cb-dark task-select-checkbox"
                       ${commentSelectMode ? 'checked' : ''}
                       onchange="toggleCommentSelectMode()"
                       title="Show selection checkboxes">
                ${count > 0 ? `<span class="bulk-count">${count} selected</span>` : ''}
            </div>
            ${count > 0 ? `
                <div class="bulk-actions">
                    <button class="btn btn-ghost btn-xs" onclick="selectAllComments()" title="Select all">All</button>
                    <button class="btn btn-ghost btn-xs" onclick="clearCommentSelection()">Clear</button>
                    <button class="btn btn-danger btn-xs" onclick="bulkDeleteComments()">
                        <svg class="icon icon-xs"><use href="/static/icons.svg#icon-trash"/></svg>
                        Delete
                    </button>
                </div>
            ` : ''}
        `;
    } else {
        bar.classList.remove('visible');
    }
}

function toggleCommentSelectMode() {
    commentSelectMode = !commentSelectMode;

    // Clear selection when exiting select mode
    if (!commentSelectMode) {
        selectedCommentIds.clear();
    }

    renderComments();
}

async function bulkDeleteComments() {
    const count = selectedCommentIds.size;
    if (count === 0) return;

    // Confirm deletion
    if (!confirm(`Delete ${count} comment${count > 1 ? 's' : ''}? This cannot be undone.`)) {
        return;
    }

    const commentIds = Array.from(selectedCommentIds);
    let successCount = 0;
    let errorCount = 0;

    // Delete each comment
    for (const commentId of commentIds) {
        const endpoint = AppState.sessionId
            ? `/api/session/${AppState.sessionId}/comment/${commentId}`
            : `/api/projects/${AppState.projectId}/comment/${commentId}`;

        try {
            const response = await fetch(endpoint, { method: 'DELETE' });
            if (response.ok) {
                successCount++;
                // Remove locally if not in session
                if (!AppState.sessionId) {
                    AppState.comments = AppState.comments.filter(c => c.id !== commentId);
                }
            } else {
                errorCount++;
            }
        } catch (e) {
            console.error('Failed to delete comment:', commentId, e);
            errorCount++;
        }
    }

    // Clear selection
    selectedCommentIds.clear();

    // Re-render
    renderComments();

    // Show feedback
    if (typeof showToast === 'function') {
        if (errorCount === 0) {
            showToast(`Deleted ${successCount} comment${successCount > 1 ? 's' : ''}`, 'success');
        } else {
            showToast(`Deleted ${successCount}, failed to delete ${errorCount}`, 'warning');
        }
    }
}

function showCommentDrawing(drawing, append = false) {
    // Clear existing highlight drawings unless appending
    if (!append) {
        elements.svgOverlay.querySelectorAll('.highlight-stroke').forEach(el => el.remove());
    }

    // Draw the comment's drawing as SVG
    if (!drawing.strokes || drawing.strokes.length === 0) return;

    // Check if strokeArrays has per-stroke brush settings (new format)
    if (drawing.strokeArrays && drawing.strokeArrays.length > 0) {
        for (const stroke of drawing.strokeArrays) {
            // Handle both new format (object) and old format (array)
            let points, color, brushSize, brushType;

            if (Array.isArray(stroke)) {
                // Old format: stroke is array of points, use drawing-level settings
                points = stroke;
                color = drawing.color || '#6366f1';
                brushSize = drawing.brushSize || 4;
                brushType = drawing.brushType || 'pen';
            } else {
                // New format: stroke has its own settings
                points = stroke.points;
                color = stroke.color || drawing.color || '#6366f1';
                brushSize = stroke.brushSize || drawing.brushSize || 4;
                brushType = stroke.brushType || drawing.brushType || 'pen';
            }

            if (!points || points.length < 2) continue;

            // Build path data for this stroke
            let d = `M ${points[0].x} ${points[0].y}`;
            for (let i = 1; i < points.length; i++) {
                d += ` L ${points[i].x} ${points[i].y}`;
            }

            // Create path with this stroke's brush settings
            const brushSettings = getBrushSettingsFor(brushSize, brushType);
            const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
            path.setAttribute('stroke', color);
            path.setAttribute('stroke-width', brushSettings.strokeWidth);
            path.setAttribute('stroke-linecap', brushSettings.linecap);
            path.setAttribute('stroke-linejoin', 'round');
            path.setAttribute('fill', 'none');
            if (brushSettings.opacity < 1) {
                path.setAttribute('opacity', brushSettings.opacity);
            }
            if (brushSettings.dasharray) {
                path.setAttribute('stroke-dasharray', brushSettings.dasharray);
            }
            path.setAttribute('d', d);
            path.classList.add('highlight-stroke');
            elements.svgOverlay.appendChild(path);
        }
    } else {
        // Fallback: single stroke from flat array (legacy format)
        let d = `M ${drawing.strokes[0].x} ${drawing.strokes[0].y}`;
        for (let i = 1; i < drawing.strokes.length; i++) {
            d += ` L ${drawing.strokes[i].x} ${drawing.strokes[i].y}`;
        }

        const brushSize = drawing.brushSize || 4;
        const brushType = drawing.brushType || 'pen';
        const brushSettings = getBrushSettingsFor(brushSize, brushType);

        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('stroke', drawing.color || '#6366f1');
        path.setAttribute('stroke-width', brushSettings.strokeWidth);
        path.setAttribute('stroke-linecap', brushSettings.linecap);
        path.setAttribute('stroke-linejoin', 'round');
        path.setAttribute('fill', 'none');
        if (brushSettings.opacity < 1) {
            path.setAttribute('opacity', brushSettings.opacity);
        }
        if (brushSettings.dasharray) {
            path.setAttribute('stroke-dasharray', brushSettings.dasharray);
        }
        path.setAttribute('d', d);
        path.classList.add('highlight-stroke');
        elements.svgOverlay.appendChild(path);
    }
}

// Show ALL comment drawings for a specific frame
function showFrameDrawings(frame) {
    // Clear existing highlight drawings
    if (!elements.svgOverlay) return;
    elements.svgOverlay.querySelectorAll('.highlight-stroke').forEach(el => el.remove());

    // Get current clip info
    const currentClip = AppState.currentClip;
    if (!currentClip) return;

    // Find all comments with drawings on this frame AND for this clip
    const numFrame = Number(frame);
    const frameComments = (AppState.comments || []).filter(c => {
        // Must match frame
        if (Number(c.frame) !== numFrame) return false;
        // Must have a drawing with strokes
        if (!c.drawing || !c.drawing.strokes || c.drawing.strokes.length === 0) return false;
        // Must match current clip (baseName and version)
        if (c.clipBaseName !== currentClip.baseName) return false;
        if (c.clipVersion !== currentClip.version) return false;
        return true;
    });

    // Render all drawings for this frame
    for (const comment of frameComments) {
        showCommentDrawing(comment.drawing, true);  // append = true
    }
}

// Get brush settings for specific size/type (for rendering saved drawings)
function getBrushSettingsFor(size, type) {
    switch (type) {
        case 'dashed':
            return {
                strokeWidth: size,
                opacity: 1,
                linecap: 'round',
                dasharray: `${size * 3} ${size * 3}`
            };
        case 'highlighter':
            return {
                strokeWidth: size * 3,
                opacity: 0.35,
                linecap: 'square',
                dasharray: null
            };
        case 'pen':
        default:
            return {
                strokeWidth: size,
                opacity: 1,
                linecap: 'round',
                dasharray: null
            };
    }
}

function renderDrawingPreviews() {
    document.querySelectorAll('.comment-drawing-preview').forEach(preview => {
        const canvas = preview.querySelector('canvas');
        if (!canvas) return;

        const drawing = JSON.parse(preview.dataset.drawing || '{}');
        if (!drawing.strokes || drawing.strokes.length === 0) return;

        // Set canvas size
        canvas.width = preview.clientWidth * 2;
        canvas.height = preview.clientHeight * 2;
        canvas.style.width = '100%';
        canvas.style.height = '100%';

        const ctx = canvas.getContext('2d');
        ctx.scale(2, 2); // For retina

        // Calculate bounds of drawing
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        drawing.strokes.forEach(p => {
            minX = Math.min(minX, p.x);
            minY = Math.min(minY, p.y);
            maxX = Math.max(maxX, p.x);
            maxY = Math.max(maxY, p.y);
        });

        // Scale to fit preview
        const padding = 10;
        const drawWidth = maxX - minX || 1;
        const drawHeight = maxY - minY || 1;
        const scaleX = (preview.clientWidth - padding * 2) / drawWidth;
        const scaleY = (preview.clientHeight - padding * 2) / drawHeight;
        const scale = Math.min(scaleX, scaleY, 1);

        const offsetX = (preview.clientWidth - drawWidth * scale) / 2 - minX * scale;
        const offsetY = (preview.clientHeight - drawHeight * scale) / 2 - minY * scale;

        // Draw
        ctx.strokeStyle = drawing.color || '#6366f1';
        ctx.lineWidth = 2;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(drawing.strokes[0].x * scale + offsetX, drawing.strokes[0].y * scale + offsetY);
        drawing.strokes.forEach(p => {
            ctx.lineTo(p.x * scale + offsetX, p.y * scale + offsetY);
        });
        ctx.stroke();
    });
}

// ============ Drawing Integration (SVG-based) ============
let currentSvgPath = null;

function setupDrawing() {
    // Draw button in comment area
    document.getElementById('drawToggleBtn')?.addEventListener('click', toggleDrawMode);
    document.getElementById('clearDrawingBtn')?.addEventListener('click', clearPendingDrawing);

    // Color palette swatches
    document.querySelectorAll('#colorPalette .color-swatch').forEach(swatch => {
        swatch.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            selectDrawColor(swatch);
        });
    });

    // Brush size presets
    document.querySelectorAll('#brushSizePresets .brush-size-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            selectBrushSize(btn);
        });
    });

    // Brush type presets
    document.querySelectorAll('#brushTypePresets .brush-type-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            selectBrushType(btn);
        });
    });

    // Set default draw settings
    AppState.drawColor = '#ff4444';
    AppState.brushSize = 6;
    AppState.brushType = 'pen';

    // SVG drawing events - mouse
    elements.svgOverlay.addEventListener('mousedown', handleDrawStart);
    elements.svgOverlay.addEventListener('mousemove', handleDrawMove);
    elements.svgOverlay.addEventListener('mouseup', handleDrawEnd);
    elements.svgOverlay.addEventListener('mouseleave', handleDrawEnd);

    // SVG drawing events - touch (for mobile)
    elements.svgOverlay.addEventListener('touchstart', handleTouchDrawStart, { passive: false });
    elements.svgOverlay.addEventListener('touchmove', handleTouchDrawMove, { passive: false });
    elements.svgOverlay.addEventListener('touchend', handleDrawEnd);
    elements.svgOverlay.addEventListener('touchcancel', handleDrawEnd);
}

function selectDrawColor(swatch) {
    // Update active state
    document.querySelectorAll('#colorPalette .color-swatch').forEach(s => s.classList.remove('active'));
    swatch.classList.add('active');

    // Set draw color
    AppState.drawColor = swatch.dataset.color;
}

function selectBrushSize(btn) {
    // Update active state
    document.querySelectorAll('#brushSizePresets .brush-size-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');

    // Set brush size
    AppState.brushSize = parseInt(btn.dataset.size, 10);
}

function selectBrushType(btn) {
    // Update active state
    document.querySelectorAll('#brushTypePresets .brush-type-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');

    // Set brush type
    AppState.brushType = btn.dataset.type;
}

// Get brush settings for SVG path based on brush type
function getBrushSettings() {
    const size = AppState.brushSize || 4;
    const type = AppState.brushType || 'pen';

    switch (type) {
        case 'dashed':
            return {
                strokeWidth: size,
                opacity: 1,
                linecap: 'round',
                dasharray: `${size * 3} ${size * 3}`
            };
        case 'highlighter':
            return {
                strokeWidth: size * 3,
                opacity: 0.35,
                linecap: 'square',
                dasharray: null
            };
        case 'pen':
        default:
            return {
                strokeWidth: size,
                opacity: 1,
                linecap: 'round',
                dasharray: null
            };
    }
}

function toggleDrawMode() {
    AppState.drawMode = !AppState.drawMode;
    elements.svgOverlay.classList.toggle('drawing', AppState.drawMode);

    const drawBtn = document.getElementById('drawToggleBtn');
    if (drawBtn) {
        drawBtn.classList.toggle('active', AppState.drawMode);
    }

    // Show/hide color palette
    const paletteArea = document.getElementById('drawPaletteArea');
    if (paletteArea) {
        paletteArea.classList.toggle('visible', AppState.drawMode);
    }

    // Show drawing preview area
    const drawingArea = document.getElementById('commentDrawingArea');
    if (drawingArea) {
        drawingArea.classList.toggle('visible', AppState.drawMode || (AppState.pendingDrawing && AppState.pendingDrawing.strokes.length > 0));
    }

    if (AppState.drawMode) {
        // Turning ON draw mode
        // Pause video when drawing
        if (!elements.video.paused) {
            elements.video.pause();
        }
        // Turn off compare mode when entering draw mode
        if (typeof resetCompareMode === 'function') {
            resetCompareMode();
        }
    } else {
        // Turning OFF draw mode - clear any pending drawing that wasn't submitted
        clearPendingDrawing();
    }
}

function handleDrawStart(e) {
    if (!AppState.drawMode) return;
    // Only left-click (button 0) starts drawing - middle-click (button 1) is for panning
    if (e.button !== 0) return;

    AppState.isDrawing = true;
    const pos = getSvgPos(e);

    // Get brush settings
    const brush = getBrushSettings();

    // Initialize pending drawing if not exists
    if (!AppState.pendingDrawing) {
        AppState.pendingDrawing = {
            frame: getCurrentFrame(),
            strokes: [],
            color: AppState.drawColor || '#ff4444',
            brushSize: AppState.brushSize || 4,
            brushType: AppState.brushType || 'pen'
        };
    }

    // Always use current draw settings for new strokes
    AppState.pendingDrawing.color = AppState.drawColor || '#ff4444';
    AppState.pendingDrawing.brushSize = AppState.brushSize || 4;
    AppState.pendingDrawing.brushType = AppState.brushType || 'pen';

    AppState.currentStroke = [pos];

    // Create SVG path element with brush settings
    currentSvgPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    currentSvgPath.setAttribute('stroke', AppState.pendingDrawing.color);
    currentSvgPath.setAttribute('stroke-width', brush.strokeWidth);
    currentSvgPath.setAttribute('stroke-linecap', brush.linecap);
    currentSvgPath.setAttribute('stroke-linejoin', 'round');
    currentSvgPath.setAttribute('fill', 'none');
    if (brush.opacity < 1) {
        currentSvgPath.setAttribute('opacity', brush.opacity);
    }
    if (brush.dasharray) {
        currentSvgPath.setAttribute('stroke-dasharray', brush.dasharray);
    }
    currentSvgPath.setAttribute('d', `M ${pos.x} ${pos.y}`);
    currentSvgPath.classList.add('pending-stroke');
    elements.svgOverlay.appendChild(currentSvgPath);
}

function handleDrawMove(e) {
    const pos = getSvgPos(e);

    // Send cursor position (use percentage of untransformed dimensions for sync)
    const rect = elements.svgOverlay.getBoundingClientRect();
    const scale = window.zoomState?.scale || 1;
    const originalWidth = rect.width / scale;
    const originalHeight = rect.height / scale;
    sendCursor(pos.x / originalWidth * 100, pos.y / originalHeight * 100);

    if (!AppState.isDrawing || !currentSvgPath) return;

    AppState.currentStroke.push(pos);

    // Update SVG path
    const d = currentSvgPath.getAttribute('d') + ` L ${pos.x} ${pos.y}`;
    currentSvgPath.setAttribute('d', d);

    // Send point to draw buffer (buffer handles throttling and accumulation)
    sendDraw(getCurrentFrame(), pos);
}

function handleDrawEnd() {
    if (!AppState.isDrawing) return;
    AppState.isDrawing = false;

    // Flush any remaining points in the draw buffer
    if (typeof clearDrawBuffer === 'function') {
        clearDrawBuffer();
    }

    // Add stroke to pending drawing
    if (AppState.currentStroke.length > 1 && AppState.pendingDrawing) {
        // Store stroke WITH brush settings for multi-stroke support
        if (!AppState.pendingDrawing.strokeArrays) {
            AppState.pendingDrawing.strokeArrays = [];
        }
        AppState.pendingDrawing.strokeArrays.push({
            points: [...AppState.currentStroke],
            color: AppState.drawColor || '#ff4444',
            brushSize: AppState.brushSize || 4,
            brushType: AppState.brushType || 'pen'
        });

        // Also keep flat strokes for backwards compatibility
        if (AppState.pendingDrawing.strokes.length === 0) {
            AppState.pendingDrawing.strokes = [...AppState.currentStroke];  // Copy, not reference!
        } else {
            AppState.pendingDrawing.strokes.push(...AppState.currentStroke);
        }
    }

    AppState.currentStroke = [];
    currentSvgPath = null;

    // Show drawing area if we have a drawing
    const drawingArea = document.getElementById('commentDrawingArea');
    if (drawingArea && AppState.pendingDrawing && AppState.pendingDrawing.strokes.length > 0) {
        drawingArea.classList.add('visible');
    }
}

// Touch event handlers for mobile drawing
function handleTouchDrawStart(e) {
    if (!AppState.drawMode) return;
    if (e.touches.length !== 1) return; // Only single touch

    e.preventDefault(); // Prevent scrolling while drawing

    // Create a mouse-like event object from touch
    const touch = e.touches[0];
    const mouseEvent = {
        clientX: touch.clientX,
        clientY: touch.clientY,
        button: 0 // Simulate left-click
    };

    handleDrawStart(mouseEvent);
}

function handleTouchDrawMove(e) {
    if (!AppState.drawMode) return;
    if (!AppState.isDrawing) return;
    if (e.touches.length !== 1) return;

    e.preventDefault(); // Prevent scrolling while drawing

    // Create a mouse-like event object from touch
    const touch = e.touches[0];
    const mouseEvent = {
        clientX: touch.clientX,
        clientY: touch.clientY
    };

    handleDrawMove(mouseEvent);
}

function getSvgPos(e) {
    const svg = elements.svgOverlay;

    // Use SVG's built-in coordinate transformation which accounts for CSS transforms
    const point = svg.createSVGPoint();
    point.x = e.clientX;
    point.y = e.clientY;

    // Get the Current Transformation Matrix and invert it
    const ctm = svg.getScreenCTM();
    if (ctm) {
        const svgPoint = point.matrixTransform(ctm.inverse());
        return { x: svgPoint.x, y: svgPoint.y };
    }

    // Fallback: manual calculation if getScreenCTM not available
    const rect = svg.getBoundingClientRect();

    // Get zoom state from video-player
    const scale = window.zoomState?.scale || 1;
    const panX = window.zoomState?.panX || 0;
    const panY = window.zoomState?.panY || 0;

    // Calculate center of the transformed element
    const centerX = rect.width / 2;
    const centerY = rect.height / 2;

    // Get position relative to transformed element
    const screenX = e.clientX - rect.left;
    const screenY = e.clientY - rect.top;

    // Convert to center-relative
    const relX = screenX - centerX;
    const relY = screenY - centerY;

    // Reverse the transform: scale(s) translate(panX/s, panY/s) with transform-origin: center
    // Screen = s*(svg - center) + pan/s*s + center = s*(svg - center) + pan + center
    // So: svg = (screen - center - pan)/s + center
    const svgX = (relX - panX) / scale + centerX / scale;
    const svgY = (relY - panY) / scale + centerY / scale;

    return { x: svgX, y: svgY };
}

function clearPendingDrawing() {
    AppState.pendingDrawing = null;
    AppState.currentStroke = [];
    currentSvgPath = null;

    // Clear ALL pending SVG elements (more aggressive cleanup)
    if (elements.svgOverlay) {
        elements.svgOverlay.querySelectorAll('.pending-stroke').forEach(el => el.remove());
        elements.svgOverlay.querySelectorAll('.drawing-path').forEach(el => el.remove());
        elements.svgOverlay.querySelectorAll('.current-stroke').forEach(el => el.remove());
    }

    // Hide drawing area
    const drawingArea = document.getElementById('commentDrawingArea');
    if (drawingArea) {
        drawingArea.classList.remove('visible');
    }

    // Redraw saved annotations to restore proper state
    redrawCanvas();
}

// Track remote drawings per user
const remoteDrawings = {};

function drawRemoteStroke(userId, stroke, color, brushSize, brushType) {
    if (!stroke || stroke.length < 2) return;

    // Get brush settings from parameters
    const size = brushSize || 6;
    const type = brushType || 'pen';
    const brushSettings = getBrushSettingsFor(size, type);

    // Get or create remote drawing state for this user
    if (!remoteDrawings[userId]) {
        remoteDrawings[userId] = {
            path: null,
            points: [],
            color: color,
            brushSize: size,
            brushType: type,
            timeout: null
        };
    }

    const remote = remoteDrawings[userId];

    // Check if brush settings changed - create new path if so
    const settingsChanged = remote.brushSize !== size || remote.brushType !== type || remote.color !== color;

    // Clear existing cleanup timeout
    if (remote.timeout) {
        clearTimeout(remote.timeout);
    }

    // Create path if needed or if settings changed
    if (!remote.path || settingsChanged) {
        // If settings changed, keep old path but start fresh
        if (settingsChanged && remote.path) {
            remote.path = null;
            remote.points = [];
        }
        remote.color = color;
        remote.brushSize = size;
        remote.brushType = type;

        remote.path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        remote.path.setAttribute('stroke', color);
        remote.path.setAttribute('stroke-width', brushSettings.strokeWidth);
        remote.path.setAttribute('fill', 'none');
        remote.path.setAttribute('stroke-linecap', brushSettings.linecap);
        remote.path.setAttribute('stroke-linejoin', 'round');
        if (brushSettings.opacity < 1) {
            remote.path.setAttribute('opacity', brushSettings.opacity);
        }
        if (brushSettings.dasharray) {
            remote.path.setAttribute('stroke-dasharray', brushSettings.dasharray);
        }
        remote.path.classList.add('remote-stroke');
        elements.svgOverlay.appendChild(remote.path);
        remote.points = [];
    }

    // Add points to accumulated path (stroke can contain multiple points now)
    if (remote.points.length === 0) {
        // First segment - start with M and add all points
        let d = `M ${stroke[0].x} ${stroke[0].y}`;
        remote.points.push(stroke[0]);
        for (let i = 1; i < stroke.length; i++) {
            d += ` L ${stroke[i].x} ${stroke[i].y}`;
            remote.points.push(stroke[i]);
        }
        remote.path.setAttribute('d', d);
    } else {
        // Check if this is a continuation or a new stroke
        const lastPoint = remote.points[remote.points.length - 1];
        const isNewStroke = Math.abs(lastPoint.x - stroke[0].x) > 1 || Math.abs(lastPoint.y - stroke[0].y) > 1;

        let d = remote.path.getAttribute('d');
        if (isNewStroke) {
            // New stroke - add M to move to new position
            d += ` M ${stroke[0].x} ${stroke[0].y}`;
            remote.points.push(stroke[0]);
        }
        // Add all points (skip first if it's same as last)
        const startIdx = isNewStroke ? 1 : 0;
        for (let i = startIdx; i < stroke.length; i++) {
            d += ` L ${stroke[i].x} ${stroke[i].y}`;
            remote.points.push(stroke[i]);
        }
        remote.path.setAttribute('d', d);
    }

    // No timeout - drawing stays visible until explicitly cleared
    // Cleanup happens when:
    // 1. Drawing is posted (via WebSocket 'drawEnd' or 'comment' message)
    // 2. User cancels drawing (via WebSocket 'drawCancel' message)
    // 3. User leaves session
}

// Clear remote drawing for a specific user (called when they finish)
function clearRemoteDrawing(userId) {
    if (remoteDrawings[userId]) {
        if (remoteDrawings[userId].timeout) {
            clearTimeout(remoteDrawings[userId].timeout);
        }
        if (remoteDrawings[userId].path) {
            remoteDrawings[userId].path.remove();
        }
        delete remoteDrawings[userId];
    }
}

// ============ Comment Delete ============
async function deleteComment(commentId) {
    if (!confirm('Delete this comment?')) return;

    const endpoint = AppState.sessionId
        ? `/api/session/${AppState.sessionId}/comment/${commentId}`
        : `/api/projects/${AppState.projectId}/comment/${commentId}`;

    try {
        const response = await fetch(endpoint, { method: 'DELETE' });
        if (response.ok) {
            // Remove locally if not in session (no WebSocket to receive it)
            if (!AppState.sessionId) {
                AppState.comments = AppState.comments.filter(c => c.id !== commentId);
                renderComments();
            }
        }
    } catch (err) {
        console.error('Failed to delete comment:', err);
    }
}

// Handle WebSocket comment_deleted event
function handleCommentDeleted(commentId) {
    AppState.comments = AppState.comments.filter(c => c.id !== commentId);
    renderComments();
}

// Make functions globally accessible
window.initComments = initComments;
window.renderComments = renderComments;
window.submitComment = submitComment;
window.toggleDrawMode = toggleDrawMode;
window.selectDrawColor = selectDrawColor;
window.selectBrushSize = selectBrushSize;
window.selectBrushType = selectBrushType;
window.clearPendingDrawing = clearPendingDrawing;
window.drawRemoteStroke = drawRemoteStroke;
window.clearRemoteDrawing = clearRemoteDrawing;
window.handleCommentClick = handleCommentClick;
window.showCommentDrawing = showCommentDrawing;
window.showFrameDrawings = showFrameDrawings;
window.deleteComment = deleteComment;
window.startReply = startReply;
window.submitInlineReply = submitInlineReply;
window.cancelReply = cancelReply;
window.toggleCommentResolved = toggleCommentResolved;
window.handleCommentDeleted = handleCommentDeleted;
window.toggleCommentSelectMode = toggleCommentSelectMode;
window.toggleCommentSelection = toggleCommentSelection;
window.selectAllComments = selectAllComments;
window.clearCommentSelection = clearCommentSelection;
window.bulkDeleteComments = bulkDeleteComments;
window.frameToTimecode = frameToTimecode;
window.getFrameDisplay = getFrameDisplay;
window.toggleTimecodeDisplay = toggleTimecodeDisplay;
