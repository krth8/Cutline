/**
 * Global Toast Notification Component
 * A lightweight notification system for user feedback
 *
 * Usage:
 *   Toast.success('Changes saved!');
 *   Toast.error('Something went wrong');
 *   Toast.warning('Are you sure?');
 *   Toast.info('New update available');
 *
 *   // With options
 *   Toast.show({
 *     message: 'Custom toast',
 *     type: 'success',
 *     duration: 5000,
 *     action: { label: 'Undo', onClick: () => {} }
 *   });
 */

class Toast {
    static container = null;
    static toasts = [];
    static defaultDuration = 4000;

    /**
     * Initialize toast container
     */
    static init() {
        if (Toast.container) return;

        Toast.container = document.createElement('div');
        Toast.container.className = 'toast-container';
        document.body.appendChild(Toast.container);
    }

    /**
     * Show a toast notification
     */
    static show(options) {
        Toast.init();

        const config = typeof options === 'string'
            ? { message: options }
            : options;

        const {
            message,
            type = 'info',
            duration = Toast.defaultDuration,
            action = null,
            dismissible = true
        } = config;

        const toast = document.createElement('div');
        toast.className = `toast toast-${type}`;

        // Icon based on type
        const icons = {
            success: 'icon-check-circle',
            error: 'icon-x-circle',
            warning: 'icon-warning',
            info: 'icon-info'
        };

        let html = `
            <div class="toast-icon">
                <svg class="icon"><use href="/static/icons.svg#${icons[type] || icons.info}"/></svg>
            </div>
            <div class="toast-content">
                <span class="toast-message">${Toast.escapeHtml(message)}</span>
            </div>
        `;

        // Action button
        if (action) {
            html += `
                <button class="toast-action" data-action="custom">
                    ${Toast.escapeHtml(action.label)}
                </button>
            `;
        }

        // Dismiss button
        if (dismissible) {
            html += `
                <button class="toast-dismiss" data-action="dismiss">
                    <svg class="icon icon-sm"><use href="/static/icons.svg#icon-x"/></svg>
                </button>
            `;
        }

        toast.innerHTML = html;

        // Event handlers
        toast.querySelector('[data-action="dismiss"]')?.addEventListener('click', () => {
            Toast.dismiss(toast);
        });

        toast.querySelector('[data-action="custom"]')?.addEventListener('click', () => {
            if (action?.onClick) action.onClick();
            Toast.dismiss(toast);
        });

        // Add to container
        Toast.container.appendChild(toast);
        Toast.toasts.push(toast);

        // Animate in
        requestAnimationFrame(() => {
            toast.classList.add('toast-visible');
        });

        // Auto dismiss
        if (duration > 0) {
            setTimeout(() => {
                Toast.dismiss(toast);
            }, duration);
        }

        return toast;
    }

    /**
     * Dismiss a toast
     */
    static dismiss(toast) {
        if (!toast || !toast.parentNode) return;

        toast.classList.remove('toast-visible');
        toast.classList.add('toast-hiding');

        setTimeout(() => {
            if (toast.parentNode) {
                toast.remove();
            }
            const index = Toast.toasts.indexOf(toast);
            if (index > -1) {
                Toast.toasts.splice(index, 1);
            }
        }, 300);
    }

    /**
     * Dismiss all toasts
     */
    static dismissAll() {
        Toast.toasts.forEach(toast => Toast.dismiss(toast));
    }

    /**
     * Convenience methods
     */
    static success(message, options = {}) {
        return Toast.show({ ...options, message, type: 'success' });
    }

    static error(message, options = {}) {
        return Toast.show({ ...options, message, type: 'error', duration: 6000 });
    }

    static warning(message, options = {}) {
        return Toast.show({ ...options, message, type: 'warning' });
    }

    static info(message, options = {}) {
        return Toast.show({ ...options, message, type: 'info' });
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
window.Toast = Toast;
