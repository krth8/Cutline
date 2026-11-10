/**
 * Global ContextMenu Component
 * A right-click context menu system
 *
 * Usage:
 *   // Bind to element
 *   ContextMenu.bind(element, [
 *     { label: 'Edit', icon: 'icon-pencil', action: () => {} },
 *     { type: 'separator' },
 *     { label: 'Delete', icon: 'icon-trash', action: () => {}, danger: true }
 *   ]);
 *
 *   // Or show programmatically
 *   ContextMenu.show(x, y, items);
 */

class ContextMenu {
    static activeMenu = null;
    static boundElements = new WeakMap();

    /**
     * Show context menu at position
     */
    static show(x, y, items, options = {}) {
        ContextMenu.close();

        const menu = document.createElement('div');
        menu.className = 'context-menu';

        let html = '';
        items.forEach((item, index) => {
            if (item.type === 'separator') {
                html += '<div class="context-menu-separator"></div>';
            } else if (item.type === 'header') {
                html += `<div class="context-menu-header">${ContextMenu.escapeHtml(item.label)}</div>`;
            } else {
                const classes = ['context-menu-item'];
                if (item.danger) classes.push('context-menu-danger');
                if (item.disabled) classes.push('context-menu-disabled');

                html += `
                    <div class="${classes.join(' ')}" data-index="${index}">
                        ${item.icon ? `
                            <span class="context-menu-icon">
                                <svg class="icon icon-sm"><use href="/static/icons.svg#${item.icon}"/></svg>
                            </span>
                        ` : ''}
                        <span class="context-menu-label">${ContextMenu.escapeHtml(item.label)}</span>
                        ${item.shortcut ? `
                            <span class="context-menu-shortcut">${ContextMenu.escapeHtml(item.shortcut)}</span>
                        ` : ''}
                    </div>
                `;
            }
        });

        menu.innerHTML = html;

        // Add to DOM
        document.body.appendChild(menu);

        // Position menu
        ContextMenu.position(menu, x, y);

        // Animate in
        requestAnimationFrame(() => {
            menu.classList.add('context-menu-visible');
        });

        // Bind events
        menu.addEventListener('click', (e) => {
            const item = e.target.closest('.context-menu-item');
            if (!item || item.classList.contains('context-menu-disabled')) return;

            const index = parseInt(item.dataset.index);
            const menuItem = items[index];
            if (menuItem && menuItem.action) {
                menuItem.action(options.context);
            }
            ContextMenu.close();
        });

        // Close handlers
        setTimeout(() => {
            document.addEventListener('click', ContextMenu.handleOutsideClick);
            document.addEventListener('contextmenu', ContextMenu.handleOutsideClick);
            document.addEventListener('keydown', ContextMenu.handleKeydown);
            document.addEventListener('scroll', ContextMenu.close, true);
        }, 10);

        ContextMenu.activeMenu = { menu, items };
    }

    /**
     * Position menu within viewport
     */
    static position(menu, x, y) {
        const viewportWidth = window.innerWidth;
        const viewportHeight = window.innerHeight;

        menu.style.position = 'fixed';
        menu.style.left = x + 'px';
        menu.style.top = y + 'px';

        // Adjust after render to get actual dimensions
        requestAnimationFrame(() => {
            const rect = menu.getBoundingClientRect();

            // Horizontal adjustment
            if (rect.right > viewportWidth - 8) {
                menu.style.left = (viewportWidth - rect.width - 8) + 'px';
            }
            if (rect.left < 8) {
                menu.style.left = '8px';
            }

            // Vertical adjustment
            if (rect.bottom > viewportHeight - 8) {
                menu.style.top = (viewportHeight - rect.height - 8) + 'px';
            }
            if (rect.top < 8) {
                menu.style.top = '8px';
            }
        });
    }

    /**
     * Close active context menu
     */
    static close() {
        if (!ContextMenu.activeMenu) return;

        const { menu } = ContextMenu.activeMenu;

        menu.classList.remove('context-menu-visible');
        menu.classList.add('context-menu-hiding');

        setTimeout(() => {
            if (menu.parentNode) {
                menu.remove();
            }
        }, 150);

        document.removeEventListener('click', ContextMenu.handleOutsideClick);
        document.removeEventListener('contextmenu', ContextMenu.handleOutsideClick);
        document.removeEventListener('keydown', ContextMenu.handleKeydown);
        document.removeEventListener('scroll', ContextMenu.close, true);

        ContextMenu.activeMenu = null;
    }

    /**
     * Handle clicks outside menu
     */
    static handleOutsideClick = (e) => {
        if (ContextMenu.activeMenu && !ContextMenu.activeMenu.menu.contains(e.target)) {
            ContextMenu.close();
        }
    };

    /**
     * Handle keyboard events
     */
    static handleKeydown = (e) => {
        if (e.key === 'Escape') {
            ContextMenu.close();
        }
    };

    /**
     * Bind context menu to element
     */
    static bind(element, items, options = {}) {
        const handler = (e) => {
            e.preventDefault();
            e.stopPropagation();

            // Resolve items if it's a function
            const resolvedItems = typeof items === 'function'
                ? items(e, element)
                : items;

            ContextMenu.show(e.clientX, e.clientY, resolvedItems, {
                ...options,
                context: element
            });
        };

        element.addEventListener('contextmenu', handler);
        ContextMenu.boundElements.set(element, handler);
    }

    /**
     * Unbind context menu from element
     */
    static unbind(element) {
        const handler = ContextMenu.boundElements.get(element);
        if (handler) {
            element.removeEventListener('contextmenu', handler);
            ContextMenu.boundElements.delete(element);
        }
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
window.ContextMenu = ContextMenu;
