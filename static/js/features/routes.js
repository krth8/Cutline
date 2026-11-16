/**
 * Routes - the URL decides which view is shown (PLAN.md 5.3). There are no top tabs any more: the
 * sidebar (React bundle, mounted in #clNavHost) is the navigation, and switchTab() only swaps the view
 * in the content area.
 *
 *   /                          opens the route the user was last on (localStorage.lastRoute) or Home
 *   /lounge                    Lounge (team chat)
 *   /home                      Home: the user's home page (Pages tab; the React bundle mounts in #viewPages)
 *   /p/<id>/review[?session=][&clip=<name>[&v=<n>][&frame=<n>]]
 *                              Review tab with that project loaded, on that clip version and frame
 *   /me, /me/page/<id>,
 *   /p/<id>/pages, /p/<id>/page/<id>   Pages tab (the React bundle mounts in #viewPages)
 *   /p/<id>/tasks, /p/<id>/view/<id>, /me/view/<id>
 *                              the bundle too (the project's Tasks view and views full page)
 *   /?project=<id>[&session=]  old link, rewritten to /p/<id>/review
 *
 * `localStorage.legacyTasks = '1'` brings the old Tasks list back: /p/<id>/tasks then opens the Projects
 * tab on that project and nothing below sends people to the new list (see legacyTasks()).
 *
 * switchTab() (navigation.js) calls Routes.sync() so choosing a tab updates the
 * URL; back/forward and `cutline:navigate` (fired by the bundle's navigate())
 * call Routes.apply() so the URL updates the tab. Share-link guests (/s/<id>)
 * never get here: they keep their single-project view.
 */
// The sidebar follows the URL, also when this legacy code changes it: tell the bundle after every history write
(function () {
    ['pushState', 'replaceState'].forEach(function (name) {
        const original = history[name];
        history[name] = function () {
            const result = original.apply(this, arguments);
            window.dispatchEvent(new CustomEvent('cutline:url-changed'));
            return result;
        };
    });
})();

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

    const LEGACY_TASKS_KEY = 'legacyTasks';

    /** True when this browser asked for the old Tasks list (localStorage.legacyTasks = '1'). */
    function legacyTasks() {
        try {
            return localStorage.getItem(LEGACY_TASKS_KEY) === '1';
        } catch (e) {
            return false;
        }
    }

    /** What a URL means: {tab, projectId?} for an app route, {tab: null} for "/", null for anything else. */
    function parse(pathname, search) {
        const segments = pathname.split('/').filter(s => s !== '').map(decode);
        if (segments.some(s => s === null)) return null;
        if (segments.length === 0) return { tab: null };
        if (segments.length === 1 && segments[0] === 'home') return { tab: 'pages', home: true };
        if (segments.length === 1 && segments[0] === 'lounge') return { tab: 'lounge' };
        if (segments[0] === 'me') {
            if (segments.length === 1 || (segments.length === 3 && segments[1] === 'page')) return { tab: 'pages' };
            if (segments.length === 3 && segments[1] === 'view') return { tab: 'pages' };
        } else if (segments[0] === 'p' && segments.length >= 3) {
            const projectId = segments[1];
            if (segments.length === 3 && segments[2] === 'review') return { tab: 'review', projectId };
            if (segments.length === 3 && segments[2] === 'pages') return { tab: 'pages', projectId };
            if (segments.length === 4 && segments[2] === 'page') return { tab: 'pages', projectId };
            if (segments.length === 4 && segments[2] === 'view') return { tab: 'pages', projectId };
            if (segments.length === 3 && segments[2] === 'tasks') return legacyTasks() ? { tab: 'projects', projectId } : { tab: 'pages', projectId };
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
        if (location.pathname.startsWith('/dev/')) return true; // the bundle's own full-screen pages keep their URL
        return location.pathname === '/' && new URLSearchParams(location.search).has('project');
    }

    const PAGES_HOME_KEY = 'pagesAtHome';

    /** True when the Pages tab was last showing Home (so choosing the tab again comes back to /home). */
    function pagesAtHome() {
        try {
            return localStorage.getItem(PAGES_HOME_KEY) === '1';
        } catch (e) {
            return false;
        }
    }

    function rememberPagesAtHome(atHome) {
        try {
            localStorage.setItem(PAGES_HOME_KEY, atHome ? '1' : '0');
        } catch (e) {}
    }

    /** Show Home (the "Home" button of the top bar): /home is pushed and the URL decides the rest. */
    function goHome() {
        if (AppState.isShareLinkGuest) return;
        if (location.pathname === '/' && ROOT_TABS.includes(AppState.activeTab)) {
            history.replaceState({ tab: AppState.activeTab }, '', currentUrl());
        }
        if (location.pathname !== '/home') history.pushState({ tab: 'pages' }, '', '/home');
        apply();
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
            if (pagesAtHome()) return '/home'; // the Pages tab was last showing Home
            return pid ? `/p/${encodeURIComponent(pid)}/pages` : '/home';
        }
        if (tab === 'lounge') return location.pathname === '/lounge' ? null : '/lounge';
        // The old task list (Projects tab) and Docs have no URL of their own: they live at "/"
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

    // ============ Sidebar (React bundle) ============

    let navMounted = false;
    let waitingForNav = false;

    /** Mount the sidebar into #clNavHost, once. */
    function mountNav() {
        const host = document.getElementById('clNavHost');
        if (!host || navMounted) return;
        if (window.CutlinePages && window.CutlinePages.mountNav) {
            window.CutlinePages.mountNav(host);
            navMounted = true;
        } else if (!waitingForNav) {
            waitingForNav = true;
            window.addEventListener('cutline:pages-ready', () => {
                waitingForNav = false;
                mountNav();
            }, { once: true });
        }
    }

    /** The sidebar and the header search are for logged-in users; share-link guests never get them. */
    function refreshChrome() {
        const show = !!AppState.adminUser && !AppState.isShareLinkGuest;
        const layout = document.getElementById('clLayout');
        if (layout) layout.classList.toggle('has-nav', show);
        // The search button of the header (the palette is in the bundle)
        const search = document.getElementById('searchBtn');
        if (search) {
            search.classList.toggle('hidden', !show);
            const key = document.getElementById('searchBtnKey');
            if (key && /Mac|iPhone|iPad/.test(navigator.platform)) key.textContent = '⌘K';
        }
        if (show) mountNav();
    }

    // ============ Tasks tab on the new table (T13) ============

    /** Show the project's Tasks view in the bundle (and the task panel over it when taskId is given). Returns
     *  false, doing nothing, when the old list is switched on, so callers fall back to the old behaviour. */
    function openTasks(projectId, taskId) {
        if (legacyTasks() || AppState.isShareLinkGuest || !AppState.adminUser) return false;
        let url = `/p/${encodeURIComponent(projectId)}/tasks`;
        if (taskId) url += `?task=${encodeURIComponent(taskId)}`;
        if (currentUrl() !== url) history.pushState({ tab: 'pages' }, '', url);
        apply();
        return true;
    }

    /** The "Use the old / new task list" links: flip the switch and reload at the matching address. */
    function toggleLegacyTasks() {
        const next = !legacyTasks();
        try {
            localStorage.setItem(LEGACY_TASKS_KEY, next ? '1' : '0');
        } catch (e) {}
        const pid = window.currentTasksProjectId;
        location.href = pid ? `/p/${encodeURIComponent(pid)}/tasks` : '/';
    }

    /** Label of the switch link in the Projects tab. */
    function refreshTasksToggle() {
        const link = document.getElementById('tasksListToggle');
        if (link) link.textContent = legacyTasks() ? 'Use the new task list' : 'Use the old task list';
    }

    // ============ Docs moved into Pages (migration 006) ============

    const DOCS_MOVED_KEY = 'docsMoved';

    /** True once the server has said the Docs now live in Pages (remembered so the next load starts without the tab). */
    function docsMoved() {
        try {
            return localStorage.getItem(DOCS_MOVED_KEY) === '1';
        } catch (e) {
            return false;
        }
    }

    /** Hide the Docs tab (a saved Docs tab opens Pages instead: see initNavigation and apply). */
    function setDocsMoved(moved) {
        try {
            localStorage.setItem(DOCS_MOVED_KEY, moved ? '1' : '0');
        } catch (e) {}
        hideDocsTab();
    }

    function hideDocsTab() {
        const tab = document.querySelector('.main-tab[data-tab="docs"]');
        if (!tab) return;
        tab.classList.toggle('hidden', docsMoved());
        if (typeof updateTabIndicator === 'function') updateTabIndicator();
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

    /** `?clip=<baseName>[&v=<version>][&frame=<n>]` of the current URL, or null. */
    function clipTarget() {
        const params = new URLSearchParams(location.search);
        const clip = params.get('clip');
        if (!clip) return null;
        const version = parseInt(params.get('v'), 10);
        const frame = parseInt(params.get('frame'), 10);
        return {
            clip,
            version: Number.isFinite(version) ? version : null,
            frame: Number.isFinite(frame) && frame >= 0 ? frame : null,
        };
    }

    /** Select the clip (and version, and frame) a review link names. Does nothing when the clip is not in the project. */
    function showClipTarget(target) {
        const clip = AppState.clips && AppState.clips[target.clip];
        if (!clip) return;
        const version = clip.versions.some(v => v.version === target.version) ? target.version : clip.activeVersion;
        selectClipVersion(target.clip, version);
        if (target.frame === null || AppState.currentMediaType !== 'video') return;
        // A freshly selected clip has no metadata yet: seek once it has
        const video = elements.video;
        const seek = () => goToFrame(target.frame);
        if (video.readyState >= 1) seek();
        else video.addEventListener('loadedmetadata', seek, { once: true });
    }

    async function openReview(projectId) {
        // Read before loading: loading the project rewrites the URL and drops the query
        const target = clipTarget();
        const sessionId = new URLSearchParams(location.search).get('session');
        if (sessionId) {
            if (AppState.sessionId !== sessionId || AppState.projectId !== projectId) {
                await joinSessionFromUrl(sessionId, projectId);
            } else {
                switchTab('review', { history: 'none' });
            }
        } else if (AppState.projectId !== projectId || !AppState.currentProject) {
            AppState.projectId = projectId;
            await loadProject(projectId);
        } else {
            switchTab('review', { history: 'none' });
        }
        if (target) showClipTarget(target);
    }

    /**
     * Show what the URL says. Called on page load and after login (initial),
     * on back/forward and when the bundle navigates.
     */
    async function apply(options) {
        const initial = !!(options && options.initial);
        if (AppState.isShareLinkGuest || !AppState.authToken) return;
        refreshChrome();
        refreshTasksToggle();
        hideDocsTab();
        rewriteLegacyLink();

        const route = current();
        if (route && route.tab) rememberLastRoute();
        if (route && route.tab === 'review') {
            await openReview(route.projectId);
        } else if (route && route.tab === 'pages') {
            rememberPagesAtHome(!!route.home);
            switchTab('pages', { history: 'none' });
        } else if (route && route.tab === 'lounge') {
            switchTab('lounge', { history: 'none' });
        } else if (route && route.tab === 'projects') {
            // /p/<id>/tasks with the old list switched on: the Projects tab on that project
            window.currentTasksProjectId = route.projectId;
            switchTab('projects', { history: 'none' });
        } else if (route) {
            // "/": the route the user was last on, or Home
            history.replaceState(null, '', lastRouteTarget() || '/home');
            await apply(options);
        }
    }

    // ============ The last route ============

    const LAST_ROUTE_KEY = 'lastRoute';

    function rememberLastRoute() {
        try {
            localStorage.setItem(LAST_ROUTE_KEY, location.pathname);
        } catch (e) {}
    }

    /** The path stored by rememberLastRoute() if it still makes sense (known route, project still listed), else null. */
    function lastRouteTarget() {
        try {
            const path = localStorage.getItem(LAST_ROUTE_KEY);
            if (!path || !path.startsWith('/') || path.startsWith('//')) return null;
            const route = parse(path, '');
            if (!route || !route.tab) return null;
            if (route.projectId && !(AppState.projects || []).some(p => p.id === route.projectId)) return null;
            return path;
        } catch (e) {
            return null;
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

    return { parse, apply, goHome, sync, afterSwitch, refreshChrome, legacyTasks, openTasks, toggleLegacyTasks, refreshTasksToggle, docsMoved, setDocsMoved, reviewUrl, isDeepLink, remember, restore };
})();

window.Routes = Routes;
