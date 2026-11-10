/**
 * Global ColorPicker Component
 * A color swatch picker with preset colors
 *
 * Usage:
 *   const picker = new ColorPicker({
 *     trigger: element,
 *     value: '#ff0000',
 *     colors: ['#ff0000', '#00ff00', '#0000ff'],
 *     onSelect: (color) => console.log('Selected:', color)
 *   });
 */

class ColorPicker {
    static activePicker = null;

    // Default color palette
    static defaultColors = [
        '#ef4444', '#f97316', '#f59e0b', '#eab308', '#84cc16',
        '#22c55e', '#10b981', '#14b8a6', '#06b6d4', '#0ea5e9',
        '#3b82f6', '#6366f1', '#8b5cf6', '#a855f7', '#d946ef',
        '#ec4899', '#f43f5e', '#78716c', '#71717a', '#6b7280'
    ];

    constructor(options = {}) {
        this.id = options.id || `colorpicker-${Date.now()}`;
        this.trigger = options.trigger;
        this.value = options.value || null;
        this.colors = options.colors || ColorPicker.defaultColors;
        this.onSelect = options.onSelect || (() => {});
        this.onClose = options.onClose || (() => {});
        this.clearable = options.clearable !== false;
        this.clearLabel = options.clearLabel || 'No color';

        // State
        this.isOpen = false;
        this.element = null;

        // Bind trigger if provided
        if (this.trigger) {
            this.bindTrigger(this.trigger);
        }
    }

    bindTrigger(element) {
        this.trigger = element;
        element.addEventListener('click', (e) => {
            e.stopPropagation();
            this.toggle();
        });
    }

    toggle() {
        if (this.isOpen) {
            this.close();
        } else {
            this.open();
        }
    }

    open(anchorElement = null) {
        // Close any other picker
        ColorPicker.closeAll();
        if (typeof Dropdown !== 'undefined') {
            Dropdown.closeAll();
        }
        if (typeof DatePicker !== 'undefined') {
            DatePicker.closeAll();
        }

        const anchor = anchorElement || this.trigger;
        if (!anchor) return;

        this.isOpen = true;
        this.element = this.render();

        // Position
        this.positionPicker(anchor);

        document.body.appendChild(this.element);

        // Animate in
        requestAnimationFrame(() => {
            this.element.classList.add('dropdown-open');
        });

        // Setup close handlers
        setTimeout(() => {
            document.addEventListener('click', this.handleOutsideClick);
            document.addEventListener('keydown', this.handleKeydown);
        }, 10);

        ColorPicker.activePicker = this;
    }

    close() {
        if (!this.isOpen || !this.element) return;

        this.isOpen = false;
        this.element.classList.remove('dropdown-open');
        this.element.classList.add('dropdown-closing');

        setTimeout(() => {
            if (this.element && this.element.parentNode) {
                this.element.remove();
            }
            this.element = null;
        }, 150);

        document.removeEventListener('click', this.handleOutsideClick);
        document.removeEventListener('keydown', this.handleKeydown);

        if (ColorPicker.activePicker === this) {
            ColorPicker.activePicker = null;
        }

        this.onClose(this.value);
    }

    static closeAll() {
        if (ColorPicker.activePicker) {
            ColorPicker.activePicker.close();
        }
    }

    handleOutsideClick = (e) => {
        if (this.element && !this.element.contains(e.target)) {
            this.close();
        }
    };

    handleKeydown = (e) => {
        if (e.key === 'Escape') {
            this.close();
        }
    };

    positionPicker(anchor) {
        const rect = anchor.getBoundingClientRect();
        const viewportHeight = window.innerHeight;
        const viewportWidth = window.innerWidth;

        this.element.style.position = 'fixed';

        // Check space below
        const spaceBelow = viewportHeight - rect.bottom;
        if (spaceBelow < 200) {
            this.element.style.bottom = (viewportHeight - rect.top + 4) + 'px';
            this.element.style.top = 'auto';
            this.element.classList.add('dropdown-above');
        } else {
            this.element.style.top = (rect.bottom + 4) + 'px';
            this.element.style.bottom = 'auto';
        }

        this.element.style.left = rect.left + 'px';

        // Ensure doesn't go off-screen
        requestAnimationFrame(() => {
            if (!this.element) return;
            const pickerRect = this.element.getBoundingClientRect();
            if (pickerRect.right > viewportWidth) {
                this.element.style.left = 'auto';
                this.element.style.right = '8px';
            }
        });
    }

    render() {
        const picker = document.createElement('div');
        picker.className = 'dropdown colorpicker';
        picker.id = this.id;

        let html = '<div class="colorpicker-grid">';

        // Clear option
        if (this.clearable) {
            html += `
                <div class="colorpicker-swatch colorpicker-clear ${!this.value ? 'selected' : ''}"
                     data-color="" title="${this.escapeHtml(this.clearLabel)}">
                    <svg class="icon icon-sm"><use href="/static/icons.svg#icon-x"/></svg>
                </div>
            `;
        }

        // Color swatches
        this.colors.forEach(color => {
            const isSelected = this.value === color;
            html += `
                <div class="colorpicker-swatch ${isSelected ? 'selected' : ''}"
                     data-color="${color}"
                     style="background-color: ${color}"
                     title="${color}">
                    ${isSelected ? '<svg class="icon icon-sm"><use href="/static/icons.svg#icon-check"/></svg>' : ''}
                </div>
            `;
        });

        html += '</div>';

        picker.innerHTML = html;
        this.bindPickerEvents(picker);

        return picker;
    }

    bindPickerEvents(picker) {
        picker.addEventListener('click', (e) => {
            e.stopPropagation();

            const swatch = e.target.closest('.colorpicker-swatch');
            if (swatch) {
                const color = swatch.dataset.color || null;
                this.selectColor(color);
            }
        });
    }

    selectColor(color) {
        this.value = color;
        this.onSelect(color);
        this.close();
    }

    setValue(color) {
        this.value = color;
    }

    escapeHtml(str) {
        if (str == null) return '';
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }

    destroy() {
        this.close();
    }
}

// Export to global scope
window.ColorPicker = ColorPicker;
