/*
 * Cutline service worker. It does one thing: show push notifications and open the app when one is
 * clicked. It caches nothing, so the app is always the version the server has.
 */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
    let data = {};
    try {
        data = event.data ? event.data.json() : {};
    } catch (e) {
        data = { body: event.data ? event.data.text() : '' };
    }
    const title = data.title || 'Cutline';
    event.waitUntil(
        self.registration.showNotification(title, {
            body: data.body || '',
            icon: '/static/icon-192.png',
            badge: '/static/badge-72.png',
            tag: data.id || undefined,
            data: { link: typeof data.link === 'string' && data.link.startsWith('/') && !data.link.startsWith('//') ? data.link : '/' },
        })
    );
});

self.addEventListener('notificationclick', (event) => {
    event.notification.close();
    const link = (event.notification.data && event.notification.data.link) || '/';
    event.waitUntil(
        self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windows) => {
            // An open Cutline window goes to the link without reloading; otherwise a new one opens there
            for (const client of windows) {
                if (new URL(client.url).origin === self.location.origin) {
                    client.postMessage({ type: 'cutline:open', link });
                    return client.focus();
                }
            }
            return self.clients.openWindow(link);
        })
    );
});
