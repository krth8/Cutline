/**
 * The right panel: one container with the same width in every tab. Review shows the comments in it, Lounge
 * the people, Home the activity. One button in the header turns it on and off, remembered per tab.
 *
 * Review's panel is the legacy .sidebar-right (hidden with .comments-hidden on .app); the other two are
 * hidden with .panel-off-home / .panel-off-lounge on #clLayout.
 */
const RightPanel = (() => {
    const KEY = 'cl-panel';

    function read() {
        try {
            return JSON.parse(localStorage.getItem(KEY)) || {};
        } catch (e) {
            return {};
        }
    }

    /** The tab on screen, or null where there is no panel. */
    function tab() {
        const view = document.querySelector('.app')?.dataset.view;
        if (view === 'review') return 'review';
        if (view === 'lounge') return 'lounge';
        if (view === 'pages') return 'home';
        return null;
    }

    function isOn(name) {
        return read()[name] !== false;
    }

    function narrow() {
        return window.innerWidth <= 800;
    }

    function apply() {
        const layout = document.getElementById('clLayout');
        const app = document.querySelector('.app');
        if (!layout || !app) return;
        layout.classList.toggle('panel-off-home', !isOn('home'));
        layout.classList.toggle('panel-off-lounge', !isOn('lounge'));
        // On a phone the comments are a sheet that opens over the picture, so the saved choice does not apply
        if (!narrow()) app.classList.toggle('comments-hidden', !isOn('review'));
        const current = tab();
        const btn = document.getElementById('panelToggleBtn');
        if (btn) {
            const on = current ? isOn(current) : false;
            btn.classList.toggle('hidden', !current);
            btn.classList.toggle('active', on);
            btn.setAttribute('aria-pressed', String(on));
            const what = current === 'review' ? 'comments' : current === 'lounge' ? 'people' : 'activity';
            btn.title = `${on ? 'Hide' : 'Show'} ${what}`;
        }
    }

    function toggle() {
        const current = tab();
        if (!current) return;
        if (current === 'review' && narrow() && typeof toggleMobileSheet === 'function') {
            toggleMobileSheet('comments');
            return;
        }
        const state = read();
        state[current] = !isOn(current);
        try {
            localStorage.setItem(KEY, JSON.stringify(state));
        } catch (e) { /* private mode: the choice lasts until reload */ }
        apply();
    }

    document.addEventListener('DOMContentLoaded', apply);
    window.addEventListener('resize', apply);
    return { apply, toggle, isOn };
})();
