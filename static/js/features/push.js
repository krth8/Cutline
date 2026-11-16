/**
 * Push notifications and the installable web app.
 *
 * The service worker (/sw.js) is registered for every visitor; it only shows notifications. A logged-in
 * user turns push on per browser with the button in the notifications panel. The server then sends every
 * notification of that user to this browser as well (api/push.py).
 *
 *   Push.sync()      after login: tell the server this browser's subscription belongs to the current user
 *   Push.forget()    before logout: this browser stops getting the user's notifications
 *   Push.toggle()    the button in the notifications panel
 *   Push.refresh()   update that button
 */
const Push = (function () {
    const supported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
    let registration = null;
    let syncedFor = null;

    function headers() {
        return { 'Content-Type': 'application/json', Authorization: `Bearer ${AppState.authToken}` };
    }

    function toBytes(base64url) {
        const padded = (base64url + '='.repeat((4 - (base64url.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/');
        return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
    }

    async function register() {
        if (!supported) return null;
        if (!registration) {
            try {
                registration = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
            } catch (e) {
                console.warn('Service worker not registered:', e);
                return null;
            }
        }
        return registration;
    }

    async function current() {
        const reg = await register();
        return reg ? reg.pushManager.getSubscription() : null;
    }

    async function send(subscription) {
        const res = await fetch('/api/push/subscribe', { method: 'POST', headers: headers(), body: JSON.stringify(subscription.toJSON()) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
    }

    /** After login: a browser that already has push turned on now notifies this user. */
    async function sync() {
        if (!supported || !AppState.authToken || AppState.isShareLinkGuest) return;
        const userId = AppState.adminUser && AppState.adminUser.id;
        if (!userId || syncedFor === userId) return;
        syncedFor = userId;
        try {
            const subscription = await current();
            if (subscription && Notification.permission === 'granted') await send(subscription);
        } catch (e) {
            syncedFor = null;
        }
        refresh();
    }

    /** Before logout: the server forgets this browser. The browser keeps its subscription for the next login. */
    async function forget() {
        syncedFor = null;
        if (!supported || !AppState.authToken) return;
        try {
            const subscription = await current();
            if (!subscription) return;
            await Promise.race([
                fetch('/api/push/unsubscribe', { method: 'POST', headers: headers(), body: JSON.stringify({ endpoint: subscription.endpoint }) }),
                new Promise((resolve) => setTimeout(resolve, 1500)),
            ]);
        } catch (e) {}
    }

    function iosNeedsInstall() {
        const ios = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
        const standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
        return ios && !standalone;
    }

    async function enable() {
        if (!supported) {
            showToast(iosNeedsInstall()
                ? 'On iPhone and iPad: add Cutline to the Home Screen (Share, Add to Home Screen), open it from there and turn notifications on.'
                : 'This browser does not support push notifications.', 'error');
            return;
        }
        const permission = await Notification.requestPermission();
        if (permission !== 'granted') {
            showToast('Notifications are blocked for this site. Allow them in the browser settings.', 'error');
            return;
        }
        const reg = await register();
        if (!reg) return;
        const res = await fetch('/api/push/key', { headers: headers() });
        const { publicKey } = await res.json();
        let subscription = await reg.pushManager.getSubscription();
        if (!subscription) {
            subscription = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: toBytes(publicKey) });
        }
        await send(subscription);
        await fetch('/api/push/test', { method: 'POST', headers: headers() }).catch(() => {});
        showToast('Notifications are on for this device', 'success');
    }

    async function disable() {
        const subscription = await current();
        if (!subscription) return;
        await fetch('/api/push/unsubscribe', { method: 'POST', headers: headers(), body: JSON.stringify({ endpoint: subscription.endpoint }) }).catch(() => {});
        await subscription.unsubscribe().catch(() => {});
        showToast('Notifications are off for this device', 'success');
    }

    async function isOn() {
        if (!supported || Notification.permission !== 'granted') return false;
        try {
            return !!(await current());
        } catch (e) {
            return false;
        }
    }

    async function toggle() {
        try {
            if (await isOn()) await disable();
            else await enable();
        } catch (e) {
            console.error('Push toggle failed:', e);
            showToast('Could not change notifications on this device', 'error');
        }
        refresh();
    }

    async function refresh() {
        const button = document.getElementById('pushToggleBtn');
        if (!button) return;
        const on = await isOn();
        button.textContent = on ? 'Turn off on this device' : 'Notify me on this device';
        button.setAttribute('aria-pressed', on ? 'true' : 'false');
    }

    // A click on a notification in an open window: go to its link without reloading
    if (supported) {
        navigator.serviceWorker.addEventListener('message', (event) => {
            const data = event.data || {};
            if (data.type !== 'cutline:open' || typeof data.link !== 'string') return;
            if (!data.link.startsWith('/') || data.link.startsWith('//')) return;
            history.pushState({}, '', data.link);
            window.dispatchEvent(new CustomEvent('cutline:navigate', { detail: { route: data.link } }));
        });
        window.addEventListener('load', () => { register(); });
    }

    return { supported, sync, forget, toggle, refresh, isOn };
})();

window.Push = Push;
