/**
 * Routes - the URL decides which top tab is shown (PLAN.md 5.3).
 *
 *   /                          legacy behaviour: the last tab (Projects, Docs, Lounge, ...)
 *   /p/<id>/review[?session=]  Review tab with that project loaded
 *   /me, /me/page/<id>,
 *   /p/<id>/pages, /p/<id>/page/<id>   Pages tab (the React bundle mounts in #viewPages)
 *   /?project=<id>[&session=]  old link, rewritten to /p/<id>/review
 *
 * switchTab() (navigation.js) calls Routes.sync() so choosing a tab updates the
 * URL; back/forward and `cutline:navigate` (fired by the bundle's navigate())
 * call Routes.apply() so the URL updates the tab. Share-link guests (/s/<id>)
 * never get here: they keep their single-project view.
 */
const Routes = (function () {
    const PENDING_KEY = 'pendingRoute';
    const ROOT_TABS = ['projects', 'review', 'docs', 'lounge'];

    // ============ Parsing ============

    function decode(segment) {
        try {
            return decodeURIComponent(segment);
        } catch (e) {
            return null;
        }
    }

    /** What a URL means: {tab, projectId?} for an app route, {tab: null} for "/", null for anything else. */
    function parse(pathname, search) {
        const segments = pathname.split('/').filter(s => s !== '').map(decode);
        if (segments.some(s => s === null)) return null;
        if (segments.length === 0) return { tab: null };
        if (segments[0] === 'me') {
            if (segments.length === 1 || (segments.length === 3 && segments[1] === 'page')) return { tab: 'pages' };
        } else if (segments[0] === 'p' && segments.length >= 3) {
            const projectId = segments[1];
            if (segments.length === 3 && segments[2] === 'review') return { tab: 'review', projectId };
            if (segments.length === 3 && segments[2] === 'pages') return { tab: 'pages', projectId };
            if (segments.length === 4 && segments[2] === 'page') return { tab: 'pages', projectId };
        }
        return null;
    }

    function current() {
        return parse(location.pathname, location.search);
    }

    function currentUrl() {
        return location.pathname + location.search;
    }

    function reviewUrl(projectId, sessionId) {
        const base = `/p/${encodeURIComponent(projectId)}/review`;
        return sessionId ? `${base}?session=${encodeURIComponent(sessionId)}` : base;
    }

    /** A path that is not "/" and not a legacy ?project= link: a deep link the user may have opened. */
    function isDeepLink() {
        const route = current();
        if (route && route.tab) return true;
        return location.pathname === '/' && new URLSearchParams(location.search).has('project');
    }

    function projectInContext() {
        return AppState.projectId || window.currentTasksProjectId || null;
    }

    // ============ URL <- tab ============

    /** The URL a tab should have, or null when the current URL already fits. */
    function desiredUrl(tab) {
        const route = current();
        const pid = projectInContext();
        if (tab === 'review') {
            if (!pid) return route && !route.tab ? null : '/';
            if (route && route.tab === 'review' && route.projectId === pid) return null;
            return reviewUrl(pid, AppState.sessionId);
        }
        if (tab === 'pages') {
            if (route && route.tab === 'pages') return null;
            return pid ? `/p/${encodeURIComponent(pid)}/pages` : '/me';
        }
        // Projects, Docs and Lounge have no URL of their own: they live at "/"
        return location.pathname === '/' ? null : '/';
    }

    /**
     * Put the URL in line with the tab that was just selected.
     * mode: 'push' (default) | 'replace' | 'none'. previousTab is the tab we came from.
     */
    function sync(tab, mode, previousTab) {
        if (mode === 'none' || AppState.isShareLinkGuest) return; // guests keep their /s/<id> URL
        const url = desiredUrl(tab);
        if (url === null) {
            // Staying on "/": remember which tab this history entry showed (for back/forward)
            if (location.pathname === '/' && ROOT_TABS.includes(tab)) history.replaceState({ tab }, '', currentUrl());
            return;
        }
        if (mode === 'replace') {
            history.replaceState({ tab }, '', url);
            return;
        }
        // Leaving "/": the entry we leave must know its tab, so Back returns to it
        if (location.pathname === '/' && ROOT_TABS.includes(previousTab)) {
            history.replaceState({ tab: previousTab }, '', currentUrl());
        }
        history.pushState({ tab }, '', url);
    }

    // ============ Pages view (React bundle) ============

    let mounted = false;
    let waitingForBundle = false;

    function mountPages() {
        const el = document.getElementById('viewPages');
        if (!el) return;
        if (window.CutlinePages) {
            window.CutlinePages.mount(el, currentUrl());
            mounted = true;
        } else if (!waitingForBundle) {
            // The bundle is `defer`red and may load after us
            waitingForBundle = true;
            window.addEventListener('cutline:pages-ready', () => {
                waitingForBundle = false;
                if (AppState.activeTab === 'pages') mountPages();
            }, { once: true });
        }
    }

    function unmountPages() {
        if (!mounted) return;
        const el = document.getElementById('viewPages');
        if (el && window.CutlinePages) window.CutlinePages.unmount(el);
        mounted = false;
    }

    /** navigation.js: a tab was shown. Mounts the bundle for Pages, unmounts it for everything else. */
    function afterSwitch(tab) {
        if (tab === 'pages') mountPages();
        else unmountPages();
    }

    /** The Pages tab is for logged-in users; share-link guests never see it. */
    function refreshPagesTab() {
        const tab = document.getElementById('mainTabPages');
        if (!tab) return;
        const show = !!AppState.adminUser && !AppState.isShareLinkGuest;
        if (tab.classList.contains('hidden') === show) {
            tab.classList.toggle('hidden', !show);
            if (typeof updateTabIndicator === 'function') updateTabIndicator();
        }
    }

    // ============ Tab <- URL ============

    /** Old /?project=<id>[&session=<id>] links become /p/<id>/review[?session=<id>]. */
    function rewriteLegacyLink() {
        if (location.pathname !== '/') return;
        const params = new URLSearchParams(location.search);
        const projectId = params.get('project');
        if (!projectId) return;
        params.delete('project');
        const rest = params.toString();
        const base = `/p/${encodeURIComponent(projectId)}/review`;
        history.replaceState(history.state, '', rest ? `${base}?${rest}` : base);
    }

    async function openReview(projectId) {
        const sessionId = new URLSearchParams(location.search).get('session');
        if (sessionId) {
            if (AppState.sessionId !== sessionId || AppState.projectId !== projectId) {
                await joinSessionFromUrl(sessionId, projectId);
                return;
            }
        } else if (AppState.projectId !== projectId || !AppState.currentProject) {
            AppState.projectId = projectId;
            await loadProject(projectId);
            return;
        }
        switchTab('review', { history: 'none' });
    }

    /**
     * Show what the URL says. Called on page load and after login (initial),
     * on back/forward and when the bundle navigates.
     */
    async function apply(options) {
        const initial = !!(options && options.initial);
        if (AppState.isShareLinkGuest || !AppState.authToken) return;
        refreshPagesTab();
        rewriteLegacyLink();

        const route = current();
        if (route && route.tab === 'review') {
            await openReview(route.projectId);
        } else if (route && route.tab === 'pages') {
            switchTab('pages', { history: 'none' });
        } else if (route) {
            // "/": keep today's behaviour. Back/forward restore the tab of that history entry.
            let tab = history.state && history.state.tab;
            if (!tab && !initial) tab = localStorage.getItem('activeTab');
            if (tab && ROOT_TABS.includes(tab)) switchTab(tab, { history: 'none' });
            else if (!initial) switchTab('projects', { history: 'none' });
        }
    }

    // ============ Keeping the URL across a login ============

    /** Auth.end() calls this before it reloads to "/": after the next login the user lands here again. */
    function remember() {
        try {
            if (isDeepLink()) sessionStorage.setItem(PENDING_KEY, currentUrl());
        } catch (e) {}
    }

    /** On page load: bring back the URL remembered by remember(), if we are at the bare "/". */
    function restore() {
        try {
            const url = sessionStorage.getItem(PENDING_KEY);
            sessionStorage.removeItem(PENDING_KEY);
            if (!url || location.pathname !== '/' || location.search) return;
            if (!url.startsWith('/') || url.startsWith('//')) return;
            const target = new URL(url, location.origin);
            if (target.origin !== location.origin) return;
            if (!parse(target.pathname, target.search) && !target.searchParams.has('project')) return;
            history.replaceState(null, '', target.pathname + target.search);
        } catch (e) {}
    }

    // ============ Wiring ============

    function onNavigate() {
        apply();
    }
    window.addEventListener('popstate', onNavigate);
    window.addEventListener('cutline:navigate', onNavigate);

    return { parse, apply, sync, afterSwitch, refreshPagesTab, reviewUrl, isDeepLink, remember, restore };
})();

window.Routes = Routes;
