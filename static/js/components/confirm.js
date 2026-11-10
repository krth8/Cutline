/**
 * Global Confirm Dialog Component
 * A styled replacement for native confirm() dialogs
 *
 * Usage:
 *   // Simple usage
 *   const confirmed = await Confirm.show('Delete this item?');
 *
 *   // With options
 *   const confirmed = await Confirm.show({
 *     title: 'Delete Project',
 *     message: 'Are you sure you want to delete this project? This cannot be undone.',
 *     confirmText: 'Delete',
 *     cancelText: 'Cancel',
 *     type: 'danger'
 *   });
 *
 *   // Shorthand for danger confirmations
 *   const confirmed = await Confirm.danger('Delete this file?', 'Delete');
 */

class Confirm {
    static activeDialog = null;

    /**
     * Show a confirmation dialog
     * @returns {Promise<boolean>} Resolves to true if confirmed, false if cancelled
     */
    static show(options) {
        return new Promise((resolve) => {
            // Close any existing dialog
            if (Confirm.activeDialog) {
                Confirm.activeDialog.resolve(false);
                Confirm.close();
            }

            const config = typeof options === 'string'
                ? { message: options }
                : options;

            const {
                title = 'Confirm',
                message,
                confirmText = 'Confirm',
                cancelText = 'Cancel',
                type = 'default', // default, danger, warning
                showCancel = true
            } = config;

            // Create overlay
            const overlay = document.createElement('div');
            overlay.className = 'confirm-overlay';

            // Create dialog
            const dialog = document.createElement('div');
            dialog.className = `confirm-dialog confirm-${type}`;

            // Icon based on type
            const icons = {
                default: 'icon-question',
                danger: 'icon-warning',
                warning: 'icon-warning'
            };

            dialog.innerHTML = `
                <div class="confirm-header">
                    <div class="confirm-icon confirm-icon-${type}">
                        <svg class="icon"><use href="/static/icons.svg#${icons[type] || icons.default}"/></svg>
                    </div>
                    <h3 class="confirm-title">${Confirm.escapeHtml(title)}</h3>
                </div>
                <div class="confirm-body">
                    <p class="confirm-message">${Confirm.escapeHtml(message)}</p>
                </div>
                <div class="confirm-footer">
                    ${showCancel ? `
                        <button class="btn btn-secondary confirm-cancel">
                            ${Confirm.escapeHtml(cancelText)}
                        </button>
                    ` : ''}
                    <button class="btn ${type === 'danger' ? 'btn-danger' : 'btn-primary'} confirm-submit">
                        ${Confirm.escapeHtml(confirmText)}
                    </button>
                </div>
            `;

            overlay.appendChild(dialog);
            document.body.appendChild(overlay);

            // Store reference and resolve function
            Confirm.activeDialog = { overlay, dialog, resolve };

            // Animate in
            requestAnimationFrame(() => {
                overlay.classList.add('confirm-visible');
            });

            // Event handlers
            const handleConfirm = () => {
                resolve(true);
                Confirm.close();
            };

            const handleCancel = () => {
                resolve(false);
                Confirm.close();
            };

            dialog.querySelector('.confirm-submit').addEventListener('click', handleConfirm);
            dialog.querySelector('.confirm-cancel')?.addEventListener('click', handleCancel);
            overlay.addEventListener('click', (e) => {
                if (e.target === overlay) handleCancel();
            });

            // Keyboard handler
            const handleKeydown = (e) => {
                if (e.key === 'Escape') {
                    handleCancel();
                } else if (e.key === 'Enter') {
                    handleConfirm();
                }
            };
            document.addEventListener('keydown', handleKeydown);
            Confirm.activeDialog.keydownHandler = handleKeydown;

            // Focus confirm button
            setTimeout(() => {
                dialog.querySelector('.confirm-submit').focus();
            }, 100);
        });
    }

    /**
     * Close the active dialog
     */
    static close() {
        if (!Confirm.activeDialog) return;

        const { overlay, keydownHandler } = Confirm.activeDialog;

        // Remove keyboard handler
        if (keydownHandler) {
            document.removeEventListener('keydown', keydownHandler);
        }

        // Animate out
        overlay.classList.remove('confirm-visible');
        overlay.classList.add('confirm-hiding');

        setTimeout(() => {
            if (overlay.parentNode) {
                overlay.remove();
            }
        }, 200);

        Confirm.activeDialog = null;
    }

    /**
     * Shorthand for danger confirmation
     */
    static danger(message, confirmText = 'Delete') {
        return Confirm.show({
            title: 'Confirm Delete',
            message,
            confirmText,
            type: 'danger'
        });
    }

    /**
     * Shorthand for warning confirmation
     */
    static warning(message, confirmText = 'Continue') {
        return Confirm.show({
            title: 'Warning',
            message,
            confirmText,
            type: 'warning'
        });
    }

    /**
     * Alert dialog (no cancel button)
     */
    static alert(message, buttonText = 'OK') {
        return Confirm.show({
            title: 'Alert',
            message,
            confirmText: buttonText,
            showCancel: false
        });
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
window.Confirm = Confirm;
