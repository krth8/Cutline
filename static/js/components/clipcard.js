/**
 * ClipCard Component
 * Reusable clip thumbnail card for consistent rendering across the app
 *
 * Usage:
 *   const html = ClipCard.render({
 *       baseName: 'shot_010',
 *       clipData: AppState.clips['shot_010'],
 *       isActive: true,
 *       showDelete: AppState.isAdmin,
 *       onDelete: "confirmDeleteClip('shot_010')"
 *   });
 */

class ClipCard {
    /**
     * Render a clip card
     * @param {Object} options
     * @param {string} options.baseName - The clip's base name
     * @param {Object} options.clipData - The clip data object with versions, status, etc.
     * @param {boolean} [options.isActive=false] - Whether this clip is currently selected
     * @param {boolean} [options.showDelete=false] - Whether to show delete button
     * @param {string} [options.onDelete] - onclick handler for delete button
     * @param {string} [options.onClick] - onclick handler for the card
     * @param {string} [options.projectId] - Project ID (for grid context)
     * @returns {string} HTML string
     */
    static render(options = {}) {
        const {
            baseName,
            clipData,
            isActive = false,
            showDelete = false,
            onDelete = '',
            onClick = '',
            projectId = null
        } = options;

        if (!clipData || !baseName) return '';

        const activeClip = clipData.versions.find(v => v.version === clipData.activeVersion) || clipData.versions[0];
        const versionCount = clipData.versions.length;

        // Determine media type
        const mediaType = activeClip?.mediaType || 'video';
        const isImage = mediaType === 'image';
        const isHtml = mediaType === 'html';

        // Thumbnail
        const placeholderIcon = isHtml ? 'icon-code' : isImage ? 'icon-image' : 'icon-film-strip';
        let thumbnailHtml = `<div class="clip-thumb-placeholder"><svg class="icon icon-xl"><use href="/static/icons.svg#${placeholderIcon}"/></svg></div>`;
        if (activeClip?.thumbnail) {
            thumbnailHtml = `<img src="/thumbnail/${activeClip.thumbnail}" alt="${ClipCard.escapeHtml(baseName)}" onerror="this.parentElement.innerHTML='<svg class=\\'icon icon-xl\\'><use href=\\'/static/icons.svg#${placeholderIcon}\\'/></svg>'">`;
        }

        // Media type pill
        const typePillClass = isHtml ? 'html' : isImage ? 'image' : 'video';
        const typePillIcon = isHtml ? 'icon-code' : isImage ? 'icon-image' : 'icon-video';
        const typePillHtml = `<div class="clip-type-pill ${typePillClass}"><svg class="icon icon-sm"><use href="/static/icons.svg#${typePillIcon}"/></svg></div>`;

        // Version pill
        const versionPillHtml = `<div class="clip-version-pill">v${ClipCard.formatVersion(clipData.activeVersion)}</div>`;

        // Status bar
        const currentStatusColor = clipData.status?.color || '';
        const statusBarHtml = currentStatusColor
            ? `<div class="clip-status-bar" style="background: ${currentStatusColor}"></div>`
            : '';

        // Status dropdown
        const statuses = (typeof AppState !== 'undefined' && AppState.statuses) || [];
        const currentStatusId = clipData.status?.id || '';
        let statusDropdown = '';
        if (statuses.length > 0) {
            const currentStatusName = clipData.status?.name || 'No status';
            const escapedBaseName = ClipCard.escapeHtml(baseName).replace(/'/g, "\\'");
            statusDropdown = `
                <div class="clip-status-wrapper" onclick="event.stopPropagation()">
                    <div class="clip-status-trigger"
                         data-clip-name="${ClipCard.escapeHtml(baseName)}"
                         data-current-id="${currentStatusId}"
                         onclick="openClipStatusDropdown(event, '${escapedBaseName}')">
                        ${ClipCard.escapeHtml(currentStatusName)}
                    </div>
                </div>
            `;
        }

        // Version count text
        const versionText = versionCount === 1 ? '1 version' : `${versionCount} versions`;

        // Delete button
        const deleteBtn = showDelete && onDelete
            ? `<button class="clip-delete-btn" onclick="event.stopPropagation(); ${onDelete}"><svg class="icon"><use href="/static/icons.svg#icon-trash"/></svg></button>`
            : '';

        // Build onclick handler
        const clickHandler = onClick ? `onclick="${onClick}"` : '';

        return `
            <div class="clip-thumbnail ${isActive ? 'active' : ''}" ${clickHandler}>
                <div class="clip-thumb-image">
                    ${thumbnailHtml}
                    ${typePillHtml}
                    ${versionPillHtml}
                    ${deleteBtn}
                </div>
                <div class="clip-thumb-info">
                    <div class="clip-thumb-name">${ClipCard.escapeHtml(baseName)}</div>
                    <div class="clip-thumb-meta">${versionText}</div>
                    ${statusDropdown}
                </div>
                ${statusBarHtml}
            </div>
        `;
    }

    /**
     * Render multiple clip cards
     * @param {Object} clips - Object with baseName keys and clipData values
     * @param {Object} options - Options passed to each card
     * @param {Function} [options.getCardOptions] - Function to get options for each card
     * @returns {string} HTML string
     */
    static renderAll(clips, options = {}) {
        const { getCardOptions = () => ({}) } = options;

        return Object.entries(clips).map(([baseName, clipData]) => {
            const cardOptions = getCardOptions(baseName, clipData);
            return ClipCard.render({
                baseName,
                clipData,
                ...cardOptions
            });
        }).join('');
    }

    /**
     * Format version number
     */
    static formatVersion(version) {
        if (typeof formatVersion === 'function') {
            return formatVersion(version);
        }
        return String(version).padStart(2, '0');
    }

    /**
     * Escape HTML special characters
     */
    static escapeHtml(str) {
        if (str == null) return '';
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }
}

// Export to global scope
window.ClipCard = ClipCard;
