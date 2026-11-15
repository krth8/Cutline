import { mountApp, mountNav, unmountApp, unmountNav } from './app';
import { getPlatform } from './platform';
import './pages/tree/register'; // sidebar tree and page views for the shell
import './pages/home/register'; // the Home route (S4)
import './pages/pageBody'; // the editor inside a page view
import { installViewSource } from './tables';
import './tables/routeViews'; // full-page routes of views and the Tasks tab
import { mountSearch } from './search'; // the command palette (Ctrl+K), mounted in a root of its own

export const version = '0.1.0';

export interface CutlinePagesApi {
  /** Render the Pages app into `element` (the route is read from the URL). Calling it again is harmless. */
  mount(element: Element, route?: string): void;
  unmount(element: Element): void;
  /** Render the sidebar into `element` (the legacy page does this once for every logged-in user). */
  mountNav(element: Element): void;
  unmountNav(element: Element): void;
  version: string;
}

const api: CutlinePagesApi = { mount: mountApp, unmount: unmountApp, mountNav, unmountNav, version };

declare global {
  interface Window {
    CutlinePages?: CutlinePagesApi;
  }
}

installViewSource();
window.CutlinePages = api;
// The bundle is deferred, so the legacy page may have been waiting for it (static/js/features/routes.js)
window.dispatchEvent(new CustomEvent('cutline:pages-ready'));

/**
 * /dev/ui (admins) and /dev/view/<viewId> (any user) are full-screen pages: the legacy page does not know the
 * route, so once the login is restored we cover it with the component demo.
 */
function mountDevUiWhenReady(): void {
  const path = window.location.pathname;
  const devFull = path.startsWith('/dev/view/') || path.startsWith('/dev/page/');
  if (path !== '/dev/ui' && path !== '/dev/theme' && !devFull) return;
  const started = Date.now();
  const timer = setInterval(() => {
    const user = getPlatform().user();
    if (user) {
      clearInterval(timer);
      if (!devFull && user.role !== 'admin') return; // /dev/ui and /dev/theme are for admins; /dev/view and /dev/page for any user
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

// The palette must work on every legacy tab too, so it gets its own root on <body> (it opens only for a logged-in user)
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mountSearch);
else mountSearch();
