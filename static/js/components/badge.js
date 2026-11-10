/**
 * Badge/Pill Component
 * Consistent badges and pills across the app
 *
 * Usage:
 *   // Basic badge
 *   Badge.render('New');
 *   Badge.render('3', { type: 'notification' });
 *
 *   // Status badge with color
 *   Badge.status('Approved', '#22c55e');
 *   Badge.status('In Progress', '#f59e0b');
 *
 *   // Version pill
 *   Badge.version('v1.2');
 *
 *   // Count badge (for notifications)
 *   Badge.count(5);
 *   Badge.count(99, { max: 99 }); // Shows "99+"
 */

class Badge {
    // Preset types
    static types = {
        default: { bg: 'var(--bg-tertiary)', color: 'var(--text)' },
        primary: { bg: 'var(--accent)', color: '#ffffff' },
        success: { bg: '#22c55e', color: '#ffffff' },
        warning: { bg: '#f59e0b', color: '#ffffff' },
        danger: { bg: '#ef4444', color: '#ffffff' },
        info: { bg: '#3b82f6', color: '#ffffff' },
        muted: { bg: 'var(--bg-hover)', color: 'var(--text-muted)' },
        notification: { bg: '#ef4444', color: '#ffffff' }
    };

    /**
     * Render a basic badge
     * @param {string} text - Badge text
     * @param {Object} options
     * @returns {string} HTML string
     */
    static render(text, options = {}) {
        const {
            type = 'default',
            size = 'md', // sm, md, lg
            rounded = false, // full pill shape
            icon = null,
            className = '',
            title = null
        } = options;

        const preset = Badge.types[type] || Badge.types.default;
        const bg = options.bg || preset.bg;
        const color = options.color || preset.color;

        const sizeClass = `badge-${size}`;
        const roundedClass = rounded ? 'badge-rounded' : '';
        const titleAttr = title ? `title="${Badge.escapeHtml(title)}"` : '';

        const iconHtml = icon ? `
            <svg class="badge-icon"><use href="/static/icons.svg#${icon}"/></svg>
        ` : '';

        return `
            <span class="badge ${sizeClass} ${roundedClass} ${className}"
                  style="background: ${bg}; color: ${color}"
                  ${titleAttr}>
                ${iconHtml}
                <span class="badge-text">${Badge.escapeHtml(text)}</span>
            </span>
        `;
    }

    /**
     * Render a status badge with custom color
     * @param {string} text - Status text
     * @param {string} color - Background color
     * @param {Object} options
     * @returns {string} HTML string
     */
    static status(text, color, options = {}) {
        const textColor = Badge.getContrastColor(color);
        return Badge.render(text, {
            ...options,
            bg: color,
            color: textColor,
            rounded: true
        });
    }

    /**
     * Render a version pill
     * @param {string|number} version - Version string or number
     * @param {Object} options
     * @returns {string} HTML string
     */
    static version(version, options = {}) {
        const text = String(version).startsWith('v') ? version : `v${version}`;
        return Badge.render(text, {
            type: 'muted',
            size: 'sm',
            rounded: true,
            ...options
        });
    }

    /**
     * Render a notification count badge
     * @param {number} count - Count to display
     * @param {Object} options
     * @returns {string} HTML string
     */
    static count(count, options = {}) {
        const {
            max = 99,
            showZero = false,
            type = 'notification'
        } = options;

        if (count === 0 && !showZero) {
            return '';
        }

        const displayText = count > max ? `${max}+` : String(count);

        return Badge.render(displayText, {
            type,
            size: 'sm',
            rounded: true,
            className: 'badge-count',
            ...options
        });
    }

    /**
     * Render a dot badge (no text, just a colored dot)
     * @param {string} color - Dot color
     * @param {Object} options
     * @returns {string} HTML string
     */
    static dot(color, options = {}) {
        const {
            size = 'md', // sm: 6px, md: 8px, lg: 10px
            pulse = false,
            className = ''
        } = options;

        const pulseClass = pulse ? 'badge-dot-pulse' : '';

        return `
            <span class="badge-dot badge-dot-${size} ${pulseClass} ${className}"
                  style="background: ${color}">
            </span>
        `;
    }

    /**
     * Render an icon-only badge
     * @param {string} icon - Icon ID
     * @param {Object} options
     * @returns {string} HTML string
     */
    static icon(icon, options = {}) {
        const {
            type = 'default',
            size = 'md',
            title = null,
            className = ''
        } = options;

        const preset = Badge.types[type] || Badge.types.default;
        const bg = options.bg || preset.bg;
        const color = options.color || preset.color;
        const titleAttr = title ? `title="${Badge.escapeHtml(title)}"` : '';

        return `
            <span class="badge badge-icon-only badge-${size} ${className}"
                  style="background: ${bg}; color: ${color}"
                  ${titleAttr}>
                <svg class="badge-icon"><use href="/static/icons.svg#${icon}"/></svg>
            </span>
        `;
    }

    /**
     * Get contrasting text color for background
     */
    static getContrastColor(bgColor) {
        // Handle CSS variables
        if (bgColor.startsWith('var(')) {
            return 'var(--text)';
        }

        // Parse hex color
        let color = bgColor.replace('#', '');
        if (color.length === 3) {
            color = color.split('').map(c => c + c).join('');
        }

        const r = parseInt(color.substr(0, 2), 16);
        const g = parseInt(color.substr(2, 2), 16);
        const b = parseInt(color.substr(4, 2), 16);

        // Calculate luminance
        const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;

        return luminance > 0.5 ? '#000000' : '#ffffff';
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
window.Badge = Badge;
