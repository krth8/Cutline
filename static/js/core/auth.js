/**
 * Auth - the one place that knows whether someone is logged in.
 *
 *   Auth.start(data)   after a successful login / setup / registration
 *   Auth.restore()     on page load: pick the login up from localStorage
 *   Auth.logout()      the user asked to log out
 *   Auth.end(reason)   the login is over (timed out, ended on the server, ...)
 *
 * Idle logout: the server ends a login after `idleTimeout` seconds without
 * user input. Every API request tells the server how long ago the user last
 * did something (X-Idle-Seconds, added in api.js), so background polling does
 * not keep a login alive. Tabs share the time of the last input through
 * localStorage, so being active in one tab keeps all of them logged in and
 * they all time out together.
 */
const Auth = (function () {
    const AUTH_KEY = 'authData';
    const ACTIVITY_KEY = 'lastActivity';
    const REASON_KEY = 'logoutReason';

    const REASONS = {
        idle: 'You were logged out because you were inactive.',
        expired: 'Your session has ended. Please sign in again.',
    };

    let idleTimeout = 3600;   // seconds, from the server
    let idleWarning = 120;
    let lastActivity = Date.now();
    let lastShared = 0;       // when lastActivity was last written to localStorage
    let reportedActivity = 0; // the newest lastActivity the server has heard about
    let lastReportAt = 0;
    let ending = false;
    let ticker = null;
    let warningEl = null;

    function store(key, value) {
        try {
            if (value === null) localStorage.removeItem(key);
            else localStorage.setItem(key, value);
        } catch (e) {}
    }

    function read(key) {
        try {
            return localStorage.getItem(key);
        } catch (e) {
            return null;
        }
    }

    /** A user account is logged in (share-link guests are not). */
    function isLoggedIn() {
        return !!AppState.authToken;
    }

    // ============ Login state ============

    function apply(user, token, permissions) {
        AppState.adminUser = user;
        AppState.isAdmin = !!(user && (user.isAdmin || user.role === 'admin'));
        AppState.authToken = token;
        AppState.permissions = permissions || [];
        AppState.userName = (user && user.username) || 'Anonymous';
        if (user && user.id) AppState.userId = user.id;
    }

    function save() {
        if (AppState.authToken && AppState.adminUser) {
            store(AUTH_KEY, JSON.stringify({
                token: AppState.authToken,
                user: AppState.adminUser,
                permissions: AppState.permissions,
            }));
        } else {
            store(AUTH_KEY, null);
        }
    }

    function setIdleConfig(data) {
        if (data && data.idleTimeout > 0) idleTimeout = data.idleTimeout;
        if (data && data.idleWarning > 0) idleWarning = Math.min(data.idleWarning, idleTimeout / 2);
    }

    /** Log in with the response of /api/auth/login (or setup / registration). */
    function start(data) {
        setIdleConfig(data);
        apply(data.user, data.token, data.permissions);
        store(REASON_KEY, null);
        markActive(true);
        noteReported(0);
        save();
        watch();
    }

    /** Pick up the login stored by an earlier page load. Returns true if there is one. */
    function restore() {
        store('adminUser', null); // old storage format
        let stored = null;
        try {
            stored = JSON.parse(read(AUTH_KEY));
        } catch (e) {}
        if (!stored || !stored.token || !stored.user) {
            store(AUTH_KEY, null);
            return false;
        }
        apply(stored.user, stored.token, stored.permissions);
        // Opening the page is activity, but other tabs may know of something newer
        const shared = Number(read(ACTIVITY_KEY)) || 0;
        lastActivity = Math.max(shared, Date.now());
        watch();
        refresh();
        return true;
    }

    /** Check the stored login with the server and pick up permissions, profile and idle settings. */
    async function refresh() {
        const token = AppState.authToken;
        if (!token) return;
        try {
            const res = await fetch('/api/auth/me');
            if (!res.ok || token !== AppState.authToken) return; // a 401 already ended the login (api.js)
            const data = await res.json();
            setIdleConfig(data);
            AppState.permissions = data.permissions || [];
            if (data.user && AppState.adminUser) {
                AppState.adminUser.profileImage = data.user.profileImage;
            }
            save();
            if (typeof updateUserDisplay === 'function') updateUserDisplay();
        } catch (e) {
            console.error('Could not check the login:', e);
        }
    }

    // ============ Logging out ============

    /** The user asked to log out. */
    async function logout() {
        if (isLoggedIn()) {
            try {
                await fetch('/api/auth/logout', { method: 'POST' });
            } catch (e) {}
        }
        end();
    }

    /**
     * The login is over in this browser. Clears it and reloads to the login
     * screen, which also drops every open connection, timer and piece of data.
     */
    function end(reason) {
        if (ending) return;
        ending = true;
        clearInterval(ticker);
        // The server may notice the timeout a moment before this tab does
        if (reason === 'expired' && idleSeconds() >= idleTimeout - 60) reason = 'idle';
        if (reason && REASONS[reason]) store(REASON_KEY, reason);
        store(AUTH_KEY, null);
        AppState.authToken = null;
        AppState.adminUser = null;
        AppState.isAdmin = false;
        AppState.permissions = [];
        window.location.replace('/');
    }

    /** Message for the login screen after an involuntary logout (shown until the next login). */
    function logoutMessage() {
        return REASONS[read(REASON_KEY)] || null;
    }

    // ============ Idle tracking ============

    function idleSeconds() {
        return Math.max(0, Math.floor((Date.now() - lastActivity) / 1000));
    }

    /** The user did something. */
    function markActive(shareNow) {
        lastActivity = Date.now();
        if (shareNow === true || lastActivity - lastShared > 5000) {
            lastShared = lastActivity;
            store(ACTIVITY_KEY, String(lastActivity));
        }
        if (warningEl) hideWarning();
    }

    /** api.js calls this for every request that told the server about our activity. */
    function noteReported(idle) {
        reportedActivity = Math.max(reportedActivity, Date.now() - idle * 1000);
        lastReportAt = Date.now();
    }

    function isMediaPlaying() {
        if (document.hidden) return false;
        return Array.from(document.querySelectorAll('video')).some(v => !v.paused && !v.ended);
    }

    let timingOut = false;
    function tick() {
        if (!isLoggedIn() || ending || timingOut) return;
        if (isMediaPlaying() && !warningEl) markActive();

        const idle = idleSeconds();
        if (idle >= idleTimeout) {
            // End it on the server too, then show the login screen
            timingOut = true;
            const done = () => end('idle');
            fetch('/api/auth/logout', { method: 'POST' }).catch(() => {}).finally(done);
            setTimeout(done, 3000);
            return;
        }
        if (idle >= idleTimeout - idleWarning) {
            showWarning(idleTimeout - idle);
            return;
        }
        if (warningEl) hideWarning();

        // Active without making requests (watching a clip, typing): tell the server
        if (lastActivity > reportedActivity + 1000 && Date.now() - lastReportAt >= 30000) {
            fetch('/api/auth/ping', { method: 'POST' }).catch(() => {});
        }
    }

    let watching = false;
    function watch() {
        clearInterval(ticker);
        ticker = setInterval(tick, 5000);
        if (watching) return;
        watching = true;

        let lastMove = 0;
        // While the "Still there?" box is up, only its button counts
        const onInput = () => { if (!warningEl) markActive(); };
        ['pointerdown', 'keydown', 'wheel', 'touchstart'].forEach(type => {
            window.addEventListener(type, onInput, { capture: true, passive: true });
        });
        window.addEventListener('mousemove', () => {
            const now = Date.now();
            if (now - lastMove > 2000) {
                lastMove = now;
                onInput();
            }
        }, { capture: true, passive: true });
        // Timers are throttled in background tabs and stop while a laptop sleeps
        document.addEventListener('visibilitychange', () => { if (!document.hidden) tick(); });
        window.addEventListener('focus', tick);
    }

    // Other tabs: shared activity, and logging in / out
    window.addEventListener('storage', (e) => {
        if (e.key === ACTIVITY_KEY && e.newValue) {
            const shared = Number(e.newValue) || 0;
            if (shared > lastActivity) {
                lastActivity = shared;
                if (warningEl) hideWarning();
            }
        } else if (e.key === AUTH_KEY && !ending) {
            let token = null;
            try {
                token = e.newValue ? JSON.parse(e.newValue).token : null;
            } catch (err) {}
            if (token === AppState.authToken) return;
            if (AppState.isShareLinkGuest && !AppState.authToken) return; // guests don't follow logins
            ending = true;
            if (token) window.location.reload();   // logged in (or switched user) in another tab
            else window.location.replace('/');     // logged out in another tab
        }
    });

    // ============ "Still there?" warning ============

    function formatRemaining(seconds) {
        const s = Math.max(0, Math.ceil(seconds));
        return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
    }

    let countdown = null;
    function showWarning(remaining) {
        if (!warningEl) {
            warningEl = document.createElement('div');
            warningEl.className = 'modal-overlay idle-warning';
            warningEl.innerHTML = `
                <div class="modal idle-warning-modal" role="alertdialog" aria-labelledby="idleWarningTitle">
                    <div class="modal-header"><h3 id="idleWarningTitle">Still there?</h3></div>
                    <div class="modal-body">
                        <p>You will be logged out in <strong class="idle-warning-time"></strong> because of inactivity.</p>
                    </div>
                    <div class="modal-footer">
                        <button class="btn btn-ghost" data-action="logout">Log out</button>
                        <button class="btn btn-primary" data-action="stay">Stay logged in</button>
                    </div>
                </div>`;
            warningEl.querySelector('[data-action="stay"]').addEventListener('click', () => {
                markActive(true);
                fetch('/api/auth/ping', { method: 'POST' }).catch(() => {});
            });
            warningEl.querySelector('[data-action="logout"]').addEventListener('click', (e) => {
                e.stopPropagation();
                logout();
            });
            document.body.appendChild(warningEl);
            countdown = setInterval(() => {
                const left = idleTimeout - (Date.now() - lastActivity) / 1000;
                const el = warningEl && warningEl.querySelector('.idle-warning-time');
                if (el) el.textContent = formatRemaining(left);
                if (left <= 0) tick();
            }, 1000);
        }
        warningEl.querySelector('.idle-warning-time').textContent = formatRemaining(remaining);
    }

    function hideWarning() {
        clearInterval(countdown);
        if (warningEl) warningEl.remove();
        warningEl = null;
    }

    return {
        start, restore, refresh, save, logout, end, logoutMessage,
        isLoggedIn, idleSeconds, noteReported, markActive,
    };
})();

window.Auth = Auth;
