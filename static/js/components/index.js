/**
 * UI Components Registry
 * Central registry of all available UI components
 *
 * This file should be loaded last in the components folder.
 * It provides a central reference for all components and logs availability.
 */

const UIComponents = {
    // Core components
    Dropdown: window.Dropdown,
    DatePicker: window.DatePicker,
    Toast: window.Toast,
    Confirm: window.Confirm,
    Modal: window.Modal,
    ColorPicker: window.ColorPicker,
    ContextMenu: window.ContextMenu,

    // Display components
    Avatar: window.Avatar,
    Badge: window.Badge,
    ClipCard: window.ClipCard,

    /**
     * Get list of available components
     */
    list() {
        return Object.keys(this).filter(k => typeof this[k] !== 'function');
    },

    /**
     * Check if a component is available
     */
    has(name) {
        return this[name] !== undefined && typeof this[name] !== 'function';
    },

    /**
     * Log component info to console (for developers)
     */
    info() {
        console.group('%c📦 UI Components', 'font-weight: bold; color: #6366f1');
        console.log('Available components:');

        const components = this.list();
        components.forEach(name => {
            const component = this[name];
            if (component) {
                console.log(`  • ${name}`);
            }
        });

        console.log('\nUsage: UIComponents.Dropdown, Toast.success(), etc.');
        console.log('Docs: /static/js/components/README.md');
        console.groupEnd();
    }
};

// Export to global scope
window.UIComponents = UIComponents;

// Log component availability in development (can be disabled in production)
if (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') {
    // Defer logging until DOM is ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => {
            setTimeout(() => UIComponents.info(), 100);
        });
    } else {
        setTimeout(() => UIComponents.info(), 100);
    }
}
