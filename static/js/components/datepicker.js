/**
 * Global DatePicker Component
 * A custom date picker with quick presets and calendar view
 *
 * Usage:
 *   const picker = new DatePicker({
 *     trigger: element,
 *     value: '2024-01-15',
 *     onSelect: (date) => console.log('Selected:', date),
 *     clearable: true
 *   });
 */

class DatePicker {
    static activePicker = null;

    constructor(options = {}) {
        this.id = options.id || `datepicker-${Date.now()}`;
        this.trigger = options.trigger;
        this.value = options.value || null; // ISO date string: YYYY-MM-DD
        this.onSelect = options.onSelect || (() => {});
        this.onClose = options.onClose || (() => {});

        // Options
        this.clearable = options.clearable !== false;
        this.showPresets = options.showPresets !== false;
        this.minDate = options.minDate || null;
        this.maxDate = options.maxDate || null;

        // State
        this.isOpen = false;
        this.element = null;
        this.viewDate = this.value ? new Date(this.value) : new Date();

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
        // Close any other picker or dropdown
        DatePicker.closeAll();
        if (typeof Dropdown !== 'undefined') {
            Dropdown.closeAll();
        }

        const anchor = anchorElement || this.trigger;
        if (!anchor) return;

        this.isOpen = true;
        this.viewDate = this.value ? new Date(this.value) : new Date();
        this.element = this.render();

        // Position
        this.positionPicker(anchor);

        document.body.appendChild(this.element);

        // Trigger animation
        requestAnimationFrame(() => {
            this.element.classList.add('dropdown-open');
        });

        // Setup close handlers
        setTimeout(() => {
            document.addEventListener('click', this.handleOutsideClick);
            document.addEventListener('keydown', this.handleKeydown);
        }, 10);

        DatePicker.activePicker = this;
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

        if (DatePicker.activePicker === this) {
            DatePicker.activePicker = null;
        }

        this.onClose(this.value);
    }

    static closeAll() {
        if (DatePicker.activePicker) {
            DatePicker.activePicker.close();
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
        if (spaceBelow < 320) {
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
        picker.className = 'dropdown datepicker';
        picker.id = this.id;

        let html = '';

        // Quick presets
        if (this.showPresets) {
            html += this.renderPresets();
        }

        // Calendar
        html += this.renderCalendar();

        picker.innerHTML = html;
        this.bindPickerEvents(picker);

        return picker;
    }

    renderPresets() {
        const today = new Date();
        const tomorrow = new Date(today);
        tomorrow.setDate(tomorrow.getDate() + 1);
        const nextWeek = new Date(today);
        nextWeek.setDate(nextWeek.getDate() + 7);
        const nextMonth = new Date(today);
        nextMonth.setMonth(nextMonth.getMonth() + 1);

        const presets = [
            { label: 'Today', date: this.formatDate(today) },
            { label: 'Tomorrow', date: this.formatDate(tomorrow) },
            { label: 'Next week', date: this.formatDate(nextWeek) },
            { label: 'Next month', date: this.formatDate(nextMonth) }
        ];

        const presetItems = presets.map(p => `
            <div class="datepicker-preset" data-date="${p.date}">
                ${p.label}
            </div>
        `).join('');

        return `
            <div class="datepicker-presets">
                ${this.clearable && this.value ? `
                    <div class="datepicker-preset datepicker-clear" data-action="clear">
                        <svg class="icon icon-sm"><use href="/static/icons.svg#icon-x"/></svg>
                        Clear
                    </div>
                ` : ''}
                ${presetItems}
            </div>
        `;
    }

    renderCalendar() {
        const year = this.viewDate.getFullYear();
        const month = this.viewDate.getMonth();

        const monthNames = ['January', 'February', 'March', 'April', 'May', 'June',
                           'July', 'August', 'September', 'October', 'November', 'December'];

        // Get first day of month and total days
        const firstDay = new Date(year, month, 1).getDay();
        const daysInMonth = new Date(year, month + 1, 0).getDate();
        const daysInPrevMonth = new Date(year, month, 0).getDate();

        // Build day cells
        let dayCells = '';
        const today = this.formatDate(new Date());

        // Previous month days (faded)
        for (let i = firstDay - 1; i >= 0; i--) {
            const day = daysInPrevMonth - i;
            const prevMonth = month === 0 ? 11 : month - 1;
            const prevYear = month === 0 ? year - 1 : year;
            const dateStr = this.formatDate(new Date(prevYear, prevMonth, day));
            dayCells += `<div class="datepicker-day other-month" data-date="${dateStr}">${day}</div>`;
        }

        // Current month days
        for (let day = 1; day <= daysInMonth; day++) {
            const dateStr = this.formatDate(new Date(year, month, day));
            const isToday = dateStr === today;
            const isSelected = dateStr === this.value;
            const classes = ['datepicker-day'];
            if (isToday) classes.push('today');
            if (isSelected) classes.push('selected');

            dayCells += `<div class="${classes.join(' ')}" data-date="${dateStr}">${day}</div>`;
        }

        // Next month days (to fill grid)
        const totalCells = firstDay + daysInMonth;
        const remainingCells = totalCells % 7 === 0 ? 0 : 7 - (totalCells % 7);
        for (let day = 1; day <= remainingCells; day++) {
            const nextMonth = month === 11 ? 0 : month + 1;
            const nextYear = month === 11 ? year + 1 : year;
            const dateStr = this.formatDate(new Date(nextYear, nextMonth, day));
            dayCells += `<div class="datepicker-day other-month" data-date="${dateStr}">${day}</div>`;
        }

        return `
            <div class="datepicker-calendar">
                <div class="datepicker-header">
                    <button class="datepicker-nav" data-action="prev-month">
                        <svg class="icon icon-sm"><use href="/static/icons.svg#icon-caret-left"/></svg>
                    </button>
                    <span class="datepicker-title">${monthNames[month]} ${year}</span>
                    <button class="datepicker-nav" data-action="next-month">
                        <svg class="icon icon-sm"><use href="/static/icons.svg#icon-caret-right"/></svg>
                    </button>
                </div>
                <div class="datepicker-weekdays">
                    <div>Su</div><div>Mo</div><div>Tu</div><div>We</div><div>Th</div><div>Fr</div><div>Sa</div>
                </div>
                <div class="datepicker-days">
                    ${dayCells}
                </div>
            </div>
        `;
    }

    bindPickerEvents(picker) {
        picker.addEventListener('click', (e) => {
            e.stopPropagation();

            // Handle presets
            const preset = e.target.closest('.datepicker-preset');
            if (preset) {
                if (preset.dataset.action === 'clear') {
                    this.selectDate(null);
                } else if (preset.dataset.date) {
                    this.selectDate(preset.dataset.date);
                }
                return;
            }

            // Handle navigation
            const nav = e.target.closest('.datepicker-nav');
            if (nav) {
                if (nav.dataset.action === 'prev-month') {
                    this.viewDate.setMonth(this.viewDate.getMonth() - 1);
                    this.updateCalendar();
                } else if (nav.dataset.action === 'next-month') {
                    this.viewDate.setMonth(this.viewDate.getMonth() + 1);
                    this.updateCalendar();
                }
                return;
            }

            // Handle day click
            const day = e.target.closest('.datepicker-day');
            if (day && day.dataset.date) {
                this.selectDate(day.dataset.date);
            }
        });
    }

    updateCalendar() {
        if (!this.element) return;
        const calendarEl = this.element.querySelector('.datepicker-calendar');
        if (calendarEl) {
            calendarEl.outerHTML = this.renderCalendar();
            // Re-bind events for new calendar
            this.bindPickerEvents(this.element);
        }
    }

    selectDate(date) {
        this.value = date;
        this.onSelect(date);
        this.close();
    }

    formatDate(date) {
        const year = date.getFullYear();
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const day = String(date.getDate()).padStart(2, '0');
        return `${year}-${month}-${day}`;
    }

    // Format for display
    static formatDisplay(dateStr) {
        if (!dateStr) return '-';
        const date = new Date(dateStr);
        const today = new Date();
        const tomorrow = new Date(today);
        tomorrow.setDate(tomorrow.getDate() + 1);

        // Check if today or tomorrow
        if (DatePicker.prototype.formatDate.call(null, date) === DatePicker.prototype.formatDate.call({}, today)) {
            return 'Today';
        }
        if (DatePicker.prototype.formatDate.call(null, date) === DatePicker.prototype.formatDate.call({}, tomorrow)) {
            return 'Tomorrow';
        }

        // Format as "Jan 15" or "Jan 15, 2025" if different year
        const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
        const month = months[date.getMonth()];
        const day = date.getDate();
        const year = date.getFullYear();

        if (year !== today.getFullYear()) {
            return `${month} ${day}, ${year}`;
        }
        return `${month} ${day}`;
    }

    setValue(date) {
        this.value = date;
        this.viewDate = date ? new Date(date) : new Date();
    }

    destroy() {
        this.close();
    }
}

// Export to global scope
window.DatePicker = DatePicker;
