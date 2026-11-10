/**
 * Global Modal Component
 * A reusable modal dialog system
 *
 * Usage:
 *   // Create modal
 *   const modal = new Modal({
 *     title: 'Edit User',
 *     content: '<form>...</form>',
 *     size: 'medium',
 *     onClose: () => console.log('Closed')
 *   });
 *   modal.open();
 *
 *   // Or use static method
 *   Modal.open({
 *     title: 'Settings',
 *     content: settingsHtml,
 *     footer: '<button class="btn btn-primary">Save</button>'
 *   });
 */

class Modal {
    static activeModals = [];
    static idCounter = 0;

    constructor(options = {}) {
        this.id = options.id || `modal-${++Modal.idCounter}`;
        this.title = options.title || '';
        this.content = options.content || '';
        this.footer = options.footer || null;
        this.size = options.size || 'medium'; // small, medium, large, full
        this.closable = options.closable !== false;
        this.closeOnOverlay = options.closeOnOverlay !== false;
        this.closeOnEscape = options.closeOnEscape !== false;
        this.onOpen = options.onOpen || (() => {});
        this.onClose = options.onClose || (() => {});
        this.className = options.className || '';

        this.overlay = null;
        this.element = null;
        this.isOpen = false;
    }

    /**
     * Open the modal
     */
    open() {
        if (this.isOpen) return;

        this.isOpen = true;
        this.render();

        document.body.appendChild(this.overlay);
        document.body.classList.add('ui-modal-open');

        // Animate in
        requestAnimationFrame(() => {
            this.overlay.classList.add('ui-modal-visible');
        });

        // Setup event handlers
        if (this.closeOnEscape) {
            document.addEventListener('keydown', this.handleKeydown);
        }

        Modal.activeModals.push(this);
        this.onOpen(this);

        return this;
    }

    /**
     * Close the modal
     */
    close() {
        if (!this.isOpen) return;

        this.isOpen = false;

        // Animate out
        this.overlay.classList.remove('ui-modal-visible');
        this.overlay.classList.add('ui-modal-hiding');

        setTimeout(() => {
            if (this.overlay && this.overlay.parentNode) {
                this.overlay.remove();
            }
            this.overlay = null;
            this.element = null;
        }, 200);

        // Remove from active modals
        const index = Modal.activeModals.indexOf(this);
        if (index > -1) {
            Modal.activeModals.splice(index, 1);
        }

        // Remove body class if no more modals
        if (Modal.activeModals.length === 0) {
            document.body.classList.remove('ui-modal-open');
        }

        // Cleanup handlers
        document.removeEventListener('keydown', this.handleKeydown);

        this.onClose(this);

        return this;
    }

    /**
     * Update modal content
     */
    setContent(content) {
        this.content = content;
        if (this.element) {
            const body = this.element.querySelector('.modal-body');
            if (body) {
                body.innerHTML = content;
            }
        }
        return this;
    }

    /**
     * Update modal title
     */
    setTitle(title) {
        this.title = title;
        if (this.element) {
            const titleEl = this.element.querySelector('.modal-title');
            if (titleEl) {
                titleEl.textContent = title;
            }
        }
        return this;
    }

    /**
     * Update modal footer
     */
    setFooter(footer) {
        this.footer = footer;
        if (this.element) {
            let footerEl = this.element.querySelector('.modal-footer');
            if (footer) {
                if (!footerEl) {
                    footerEl = document.createElement('div');
                    footerEl.className = 'modal-footer';
                    this.element.querySelector('.modal-content').appendChild(footerEl);
                }
                footerEl.innerHTML = footer;
            } else if (footerEl) {
                footerEl.remove();
            }
        }
        return this;
    }

    /**
     * Render the modal
     */
    render() {
        // Create overlay
        this.overlay = document.createElement('div');
        this.overlay.className = 'ui-modal-overlay';
        this.overlay.id = this.id;

        // Create modal element
        this.element = document.createElement('div');
        this.element.className = `ui-modal ui-modal-${this.size} ${this.className}`.trim();

        let html = '<div class="modal-content">';

        // Header
        if (this.title || this.closable) {
            html += `
                <div class="modal-header">
                    ${this.title ? `<h2 class="modal-title">${this.escapeHtml(this.title)}</h2>` : ''}
                    ${this.closable ? `
                        <button class="modal-close" data-action="close">
                            <svg class="icon"><use href="/static/icons.svg#icon-x"/></svg>
                        </button>
                    ` : ''}
                </div>
            `;
        }

        // Body
        html += `<div class="modal-body">${this.content}</div>`;

        // Footer
        if (this.footer) {
            html += `<div class="modal-footer">${this.footer}</div>`;
        }

        html += '</div>';

        this.element.innerHTML = html;
        this.overlay.appendChild(this.element);

        // Bind events
        this.bindEvents();

        return this.overlay;
    }

    /**
     * Bind modal events
     */
    bindEvents() {
        // Close button
        this.element.querySelector('[data-action="close"]')?.addEventListener('click', () => {
            this.close();
        });

        // Overlay click
        if (this.closeOnOverlay) {
            this.overlay.addEventListener('click', (e) => {
                if (e.target === this.overlay) {
                    this.close();
                }
            });
        }
    }

    /**
     * Handle keyboard events
     */
    handleKeydown = (e) => {
        if (e.key === 'Escape' && this.isOpen) {
            // Only close topmost modal
            const topModal = Modal.activeModals[Modal.activeModals.length - 1];
            if (topModal === this) {
                this.close();
            }
        }
    };

    /**
     * Get modal element (for custom queries)
     */
    getElement() {
        return this.element;
    }

    /**
     * Escape HTML
     */
    escapeHtml(str) {
        if (str == null) return '';
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }

    /**
     * Static method to quickly open a modal
     */
    static open(options) {
        const modal = new Modal(options);
        return modal.open();
    }

    /**
     * Close all open modals
     */
    static closeAll() {
        [...Modal.activeModals].forEach(modal => modal.close());
    }

    /**
     * Get the topmost active modal
     */
    static getActive() {
        return Modal.activeModals[Modal.activeModals.length - 1] || null;
    }
}

// Export to global scope
window.Modal = Modal;
