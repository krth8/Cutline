/**
 * Global Dropdown Component
 * Reusable dropdown with animations, search, and flexible rendering
 *
 * Usage:
 *   const dropdown = new Dropdown({
 *     trigger: element,
 *     items: [{ id: '1', label: 'Option 1', color: '#ff0000' }],
 *     onSelect: (item) => console.log('Selected:', item),
 *     searchable: true,
 *     multiSelect: false
 *   });
 *   dropdown.open();
 */

class Dropdown {
    static activeDropdown = null;
    static instances = new Map();

    constructor(options = {}) {
        this.id = options.id || `dropdown-${Date.now()}`;
        this.trigger = options.trigger;
        this.items = options.items || [];
        this.value = options.value || null;
        this.values = options.values || []; // For multi-select
        this.onSelect = options.onSelect || (() => {});
        this.onClose = options.onClose || (() => {});
        this.renderItem = options.renderItem || this.defaultRenderItem.bind(this);
        this.renderTrigger = options.renderTrigger || null;

        // Options
        this.searchable = options.searchable || false;
        this.searchPlaceholder = options.searchPlaceholder || 'Search...';
        this.multiSelect = options.multiSelect || false;
        this.clearable = options.clearable !== false;
        this.clearLabel = options.clearLabel || 'Clear';
        this.emptyLabel = options.emptyLabel || 'No options';
        this.width = options.width || 'auto';
        this.minWidth = options.minWidth || 140;
        this.maxWidth = options.maxWidth || 280;
        this.maxHeight = options.maxHeight || 280;
        this.position = options.position || 'bottom-start'; // bottom-start, bottom-end, top-start, top-end

        // State
        this.isOpen = false;
        this.element = null;
        this.searchQuery = '';

        // Store instance
        Dropdown.instances.set(this.id, this);

        // Bind trigger if provided
        if (this.trigger) {
            this.bindTrigger(this.trigger);
        }
    }

    /**
     * Bind click handler to trigger element
     */
    bindTrigger(element) {
        this.trigger = element;
        element.addEventListener('click', (e) => {
            e.stopPropagation();
            this.toggle();
        });
    }

    /**
     * Toggle dropdown open/closed
     */
    toggle() {
        if (this.isOpen) {
            this.close();
        } else {
            this.open();
        }
    }

    /**
     * Open the dropdown
     */
    open(anchorElement = null) {
        // Close any other open dropdown
        Dropdown.closeAll();

        const anchor = anchorElement || this.trigger;
        if (!anchor) return;

        this.isOpen = true;
        this.element = this.render();

        // Position the dropdown
        this.positionDropdown(anchor);

        // Add to DOM with animation
        document.body.appendChild(this.element);

        // Trigger animation
        requestAnimationFrame(() => {
            this.element.classList.add('dropdown-open');
        });

        // Focus search if searchable
        if (this.searchable) {
            const searchInput = this.element.querySelector('.dropdown-search-input');
            if (searchInput) {
                setTimeout(() => searchInput.focus(), 50);
            }
        }

        // Setup close handlers
        setTimeout(() => {
            document.addEventListener('click', this.handleOutsideClick);
            document.addEventListener('keydown', this.handleKeydown);
        }, 10);

        Dropdown.activeDropdown = this;
    }

    /**
     * Close the dropdown
     */
    close(skipCallback = false) {
        if (!this.isOpen || !this.element) return;

        this.isOpen = false;
        this.element.classList.remove('dropdown-open');
        this.element.classList.add('dropdown-closing');

        // Wait for animation then remove
        setTimeout(() => {
            if (this.element && this.element.parentNode) {
                this.element.remove();
            }
            this.element = null;
        }, 150);

        // Cleanup listeners
        document.removeEventListener('click', this.handleOutsideClick);
        document.removeEventListener('keydown', this.handleKeydown);

        if (Dropdown.activeDropdown === this) {
            Dropdown.activeDropdown = null;
        }

        if (!skipCallback) {
            this.onClose(this.multiSelect ? this.values : this.value);
        }
    }

    /**
     * Close all open dropdowns (including notifications panel)
     */
    static closeAll() {
        if (Dropdown.activeDropdown) {
            Dropdown.activeDropdown.close(true);
        }
        // Also close notifications panel if open
        if (typeof window.closeNotificationsPanel === 'function') {
            window.closeNotificationsPanel();
        }
    }

    /**
     * Handle click outside dropdown
     */
    handleOutsideClick = (e) => {
        if (this.element && !this.element.contains(e.target)) {
            this.close();
        }
    };

    /**
     * Handle keyboard events
     */
    handleKeydown = (e) => {
        if (e.key === 'Escape') {
            this.close();
        }
    };

    /**
     * Position dropdown relative to anchor element
     */
    positionDropdown(anchor) {
        const rect = anchor.getBoundingClientRect();
        const viewportHeight = window.innerHeight;
        const viewportWidth = window.innerWidth;

        this.element.style.position = 'fixed';

        // Vertical positioning
        const spaceBelow = viewportHeight - rect.bottom;
        const spaceAbove = rect.top;
        const dropdownHeight = Math.min(this.maxHeight + 100, 400); // Estimate max height

        if (this.position.startsWith('top') || (spaceBelow < dropdownHeight && spaceAbove > spaceBelow)) {
            // Position above
            this.element.style.bottom = (viewportHeight - rect.top + 4) + 'px';
            this.element.style.top = 'auto';
            this.element.classList.add('dropdown-above');
        } else {
            // Position below
            this.element.style.top = (rect.bottom + 4) + 'px';
            this.element.style.bottom = 'auto';
        }

        // Horizontal positioning
        if (this.position.endsWith('end')) {
            this.element.style.right = (viewportWidth - rect.right) + 'px';
            this.element.style.left = 'auto';
        } else {
            this.element.style.left = rect.left + 'px';
            this.element.style.right = 'auto';
        }

        // Ensure doesn't go off-screen
        requestAnimationFrame(() => {
            if (!this.element) return;
            const dropdownRect = this.element.getBoundingClientRect();
            if (dropdownRect.right > viewportWidth) {
                this.element.style.left = 'auto';
                this.element.style.right = '8px';
            }
            if (dropdownRect.left < 0) {
                this.element.style.left = '8px';
                this.element.style.right = 'auto';
            }
        });
    }

    /**
     * Render the dropdown element
     */
    render() {
        const dropdown = document.createElement('div');
        dropdown.className = 'dropdown';
        dropdown.id = this.id;
        dropdown.style.minWidth = this.minWidth + 'px';
        dropdown.style.maxWidth = this.maxWidth + 'px';
        if (this.width !== 'auto') {
            dropdown.style.width = this.width + 'px';
        }

        let html = '';

        // Search box
        if (this.searchable) {
            html += `
                <div class="dropdown-search">
                    <input type="text"
                           class="dropdown-search-input"
                           placeholder="${this.escapeHtml(this.searchPlaceholder)}"
                           autocomplete="off">
                </div>
            `;
        }

        // Items list
        html += `<div class="dropdown-list" style="max-height: ${this.maxHeight}px">`;

        // Clear option
        const hasValue = this.multiSelect ? this.values.length > 0 : this.value != null;
        if (this.clearable && hasValue) {
            html += `
                <div class="dropdown-item dropdown-item-clear" data-action="clear">
                    <span class="dropdown-item-icon">
                        <svg class="icon icon-sm"><use href="/static/icons.svg#icon-x"/></svg>
                    </span>
                    <span class="dropdown-item-label">${this.escapeHtml(this.clearLabel)}</span>
                </div>
            `;
        }

        // Render items
        if (this.items.length === 0) {
            html += `<div class="dropdown-empty">${this.escapeHtml(this.emptyLabel)}</div>`;
        } else {
            this.items.forEach((item, index) => {
                html += this.renderItem(item, index);
            });
        }

        html += '</div>';

        dropdown.innerHTML = html;

        // Bind events
        this.bindDropdownEvents(dropdown);

        return dropdown;
    }

    /**
     * Bind events to dropdown element
     */
    bindDropdownEvents(dropdown) {
        // Item click
        dropdown.addEventListener('click', (e) => {
            const item = e.target.closest('.dropdown-item');
            if (!item) return;

            e.stopPropagation();

            if (item.dataset.action === 'clear') {
                this.handleClear();
                return;
            }

            const index = parseInt(item.dataset.index);
            if (isNaN(index)) return;

            this.handleSelect(this.items[index], index);
        });

        // Search input
        if (this.searchable) {
            const searchInput = dropdown.querySelector('.dropdown-search-input');
            if (searchInput) {
                searchInput.addEventListener('input', (e) => {
                    this.handleSearch(e.target.value);
                });
                searchInput.addEventListener('click', (e) => e.stopPropagation());
            }
        }
    }

    /**
     * Handle item selection
     */
    handleSelect(item, index) {
        // Skip disabled items
        if (item.disabled) return;

        if (this.multiSelect) {
            const valueIndex = this.values.indexOf(item.id);
            if (valueIndex > -1) {
                this.values.splice(valueIndex, 1);
            } else {
                this.values.push(item.id);
            }
            // Update UI
            this.updateMultiSelectUI();
            // Callback
            this.onSelect(this.values, item);
        } else {
            this.value = item.id;
            this.onSelect(item);
            this.close();
        }
    }

    /**
     * Handle clear action
     */
    handleClear() {
        if (this.multiSelect) {
            this.values = [];
            this.onSelect([], null);
        } else {
            this.value = null;
            this.onSelect(null);
        }
        this.close();
    }

    /**
     * Handle search filtering
     */
    handleSearch(query) {
        this.searchQuery = query.toLowerCase();
        const items = this.element.querySelectorAll('.dropdown-item:not(.dropdown-item-clear)');

        items.forEach((itemEl, index) => {
            const item = this.items[index];
            if (!item) return;

            const label = (item.label || item.name || '').toLowerCase();
            const matches = label.includes(this.searchQuery);
            itemEl.style.display = matches ? '' : 'none';
        });

        // Show/hide empty message
        const visibleItems = Array.from(items).filter(el => el.style.display !== 'none');
        let emptyEl = this.element.querySelector('.dropdown-empty');

        if (visibleItems.length === 0 && this.items.length > 0) {
            if (!emptyEl) {
                emptyEl = document.createElement('div');
                emptyEl.className = 'dropdown-empty';
                emptyEl.textContent = 'No matches';
                this.element.querySelector('.dropdown-list').appendChild(emptyEl);
            }
            emptyEl.style.display = '';
        } else if (emptyEl) {
            emptyEl.style.display = 'none';
        }
    }

    /**
     * Update multi-select checkboxes
     */
    updateMultiSelectUI() {
        if (!this.element) return;

        const items = this.element.querySelectorAll('.dropdown-item:not(.dropdown-item-clear)');
        items.forEach((itemEl, index) => {
            const item = this.items[index];
            if (!item) return;

            const isSelected = this.values.includes(item.id);
            itemEl.classList.toggle('selected', isSelected);

            const checkbox = itemEl.querySelector('.dropdown-checkbox');
            if (checkbox) {
                checkbox.textContent = isSelected ? '☑' : '☐';
            }
        });
    }

    /**
     * Default item renderer
     */
    defaultRenderItem(item, index) {
        const isSelected = this.multiSelect
            ? this.values.includes(item.id)
            : this.value === item.id;
        const isDisabled = item.disabled === true;

        let iconHtml = '';
        if (item.color) {
            iconHtml = `<span class="dropdown-item-color" style="background-color: ${item.color}"></span>`;
        } else if (item.icon) {
            iconHtml = `<span class="dropdown-item-icon">${item.icon}</span>`;
        } else if (item.image) {
            iconHtml = `<img class="dropdown-item-avatar" src="${this.escapeHtml(item.image)}" alt="">`;
        } else if (item.initials) {
            iconHtml = `<span class="dropdown-item-avatar dropdown-item-initials">${this.escapeHtml(item.initials)}</span>`;
        }

        const checkboxHtml = this.multiSelect
            ? `<span class="dropdown-checkbox">${isSelected ? '☑' : '☐'}</span>`
            : '';

        const classes = ['dropdown-item'];
        if (isSelected) classes.push('selected');
        if (isDisabled) classes.push('dropdown-item-disabled');

        return `
            <div class="${classes.join(' ')}"
                 data-index="${index}"
                 data-id="${this.escapeHtml(item.id)}">
                ${checkboxHtml}
                ${iconHtml}
                <span class="dropdown-item-label">${this.escapeHtml(item.label || item.name || item.id)}</span>
            </div>
        `;
    }

    /**
     * Update items dynamically
     */
    setItems(items) {
        this.items = items;
        if (this.isOpen && this.element) {
            // Re-render the list
            const list = this.element.querySelector('.dropdown-list');
            if (list) {
                let html = '';
                const hasValue = this.multiSelect ? this.values.length > 0 : this.value != null;
                if (this.clearable && hasValue) {
                    html += `
                        <div class="dropdown-item dropdown-item-clear" data-action="clear">
                            <span class="dropdown-item-icon">
                                <svg class="icon icon-sm"><use href="/static/icons.svg#icon-x"/></svg>
                            </span>
                            <span class="dropdown-item-label">${this.escapeHtml(this.clearLabel)}</span>
                        </div>
                    `;
                }
                if (items.length === 0) {
                    html += `<div class="dropdown-empty">${this.escapeHtml(this.emptyLabel)}</div>`;
                } else {
                    items.forEach((item, index) => {
                        html += this.renderItem(item, index);
                    });
                }
                list.innerHTML = html;
            }
        }
    }

    /**
     * Set current value(s)
     */
    setValue(value) {
        if (this.multiSelect) {
            this.values = Array.isArray(value) ? value : [value];
        } else {
            this.value = value;
        }
    }

    /**
     * Escape HTML special characters
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
     * Destroy the dropdown instance
     */
    destroy() {
        this.close(true);
        Dropdown.instances.delete(this.id);
    }
}

// Export to global scope
window.Dropdown = Dropdown;
