import { mountApp, unmountApp } from './app';
import { getPlatform } from './platform';

export const version = '0.1.0';

export interface CutlinePagesApi {
  /** Render the Pages app into `element` (the route is read from the URL). Calling it again is harmless. */
  mount(element: Element, route?: string): void;
  unmount(element: Element): void;
  version: string;
}

const api: CutlinePagesApi = { mount: mountApp, unmount: unmountApp, version };

declare global {
  interface Window {
    CutlinePages?: CutlinePagesApi;
  }
}

window.CutlinePages = api;
// The bundle is deferred, so the legacy page may have been waiting for it (static/js/features/routes.js)
window.dispatchEvent(new CustomEvent('cutline:pages-ready'));

/**
 * /dev/ui is a full-screen page for admins: the legacy page does not know the
 * route, so once the login is restored we cover it with the component demo.
 */
function mountDevUiWhenReady(): void {
  if (window.location.pathname !== '/dev/ui') return;
  const started = Date.now();
  const timer = setInterval(() => {
    const user = getPlatform().user();
    if (user) {
      clearInterval(timer);
      if (user.role !== 'admin') return;
      const host = document.createElement('div');
      host.className = 'cl-fullscreen';
      host.id = 'cl-dev-ui';
      document.body.appendChild(host);
      mountApp(host);
    } else if (Date.now() - started > 30000) {
      clearInterval(timer); // never logged in: leave the legacy login alone
    }
  }, 150);
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mountDevUiWhenReady);
else mountDevUiWhenReady();
