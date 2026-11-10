/**
 * Avatar Component
 * Consistent user avatar rendering across the app
 *
 * Usage:
 *   // Basic - returns HTML string
 *   Avatar.render({ name: 'John Doe' });
 *   Avatar.render({ name: 'Jane', image: '/path/to/image.jpg' });
 *
 *   // With options
 *   Avatar.render({
 *       name: 'User',
 *       image: '/avatar.jpg',
 *       size: 'lg',
 *       showStatus: true,
 *       status: 'online'
 *   });
 *
 *   // Multiple avatars (stacked)
 *   Avatar.stack([user1, user2, user3], { max: 3, size: 'sm' });
 */

class Avatar {
    // Size presets (in pixels)
    static sizes = {
        xs: 20,
        sm: 24,
        md: 32,
        lg: 40,
        xl: 48,
        xxl: 64
    };

    // Color palette for initials backgrounds
    static colors = [
        '#ef4444', '#f97316', '#f59e0b', '#84cc16', '#22c55e',
        '#14b8a6', '#06b6d4', '#3b82f6', '#6366f1', '#8b5cf6',
        '#a855f7', '#ec4899', '#f43f5e'
    ];

    /**
     * Render a single avatar
     * @param {Object} options
     * @returns {string} HTML string
     */
    static render(options = {}) {
        const {
            name = '',
            image = null,
            size = 'md',
            showStatus = false,
            status = 'offline', // online, offline, away, busy
            className = '',
            title = null,
            onClick = null
        } = options;

        const sizeValue = Avatar.sizes[size] || Avatar.sizes.md;
        const initials = Avatar.getInitials(name);
        const bgColor = Avatar.getColor(name);
        const textColor = '#ffffff';

        const clickAttr = onClick ? `onclick="${onClick}"` : '';
        const cursorClass = onClick ? 'avatar-clickable' : '';
        const titleAttr = title || name ? `title="${Avatar.escapeHtml(title || name)}"` : '';

        let innerHtml;
        if (image) {
            innerHtml = `
                <img class="avatar-img"
                     src="${Avatar.escapeHtml(image)}"
                     alt="${Avatar.escapeHtml(name)}"
                     onerror="this.style.display='none'; this.nextElementSibling.style.display='flex';">
                <span class="avatar-initials" style="display: none; background: ${bgColor}; color: ${textColor}">
                    ${Avatar.escapeHtml(initials)}
                </span>
            `;
        } else {
            innerHtml = `
                <span class="avatar-initials" style="background: ${bgColor}; color: ${textColor}">
                    ${Avatar.escapeHtml(initials)}
                </span>
            `;
        }

        // Status dot
        const statusHtml = showStatus ? `
            <span class="avatar-status avatar-status-${status}"></span>
        ` : '';

        return `
            <div class="avatar avatar-${size} ${cursorClass} ${className}"
                 style="width: ${sizeValue}px; height: ${sizeValue}px;"
                 ${titleAttr}
                 ${clickAttr}>
                ${innerHtml}
                ${statusHtml}
            </div>
        `;
    }

    /**
     * Render stacked avatars (for multiple assignees, etc.)
     * @param {Array} users - Array of user objects with name/image
     * @param {Object} options
     * @returns {string} HTML string
     */
    static stack(users = [], options = {}) {
        const {
            max = 3,
            size = 'sm',
            showOverflow = true,
            className = ''
        } = options;

        if (!users || users.length === 0) {
            return '';
        }

        const displayed = users.slice(0, max);
        const overflow = users.length - max;

        let html = `<div class="avatar-stack ${className}">`;

        displayed.forEach((user, index) => {
            html += Avatar.render({
                name: user.name || user.username || '',
                image: user.image || user.profileImage || user.avatar,
                size,
                className: 'avatar-stacked'
            });
        });

        if (showOverflow && overflow > 0) {
            const sizeValue = Avatar.sizes[size] || Avatar.sizes.md;
            html += `
                <div class="avatar avatar-${size} avatar-overflow"
                     style="width: ${sizeValue}px; height: ${sizeValue}px;"
                     title="${overflow} more">
                    <span class="avatar-initials" style="background: var(--bg-tertiary); color: var(--text-muted)">
                        +${overflow}
                    </span>
                </div>
            `;
        }

        html += '</div>';
        return html;
    }

    /**
     * Get initials from name
     */
    static getInitials(name) {
        if (!name) return '?';
        const parts = name.trim().split(/\s+/);
        if (parts.length >= 2) {
            return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
        }
        return name.substring(0, 2).toUpperCase();
    }

    /**
     * Get consistent color based on name
     */
    static getColor(name) {
        if (!name) return Avatar.colors[0];
        let hash = 0;
        for (let i = 0; i < name.length; i++) {
            hash = name.charCodeAt(i) + ((hash << 5) - hash);
        }
        return Avatar.colors[Math.abs(hash) % Avatar.colors.length];
    }

    /**
     * Escape HTML
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
window.Avatar = Avatar;
