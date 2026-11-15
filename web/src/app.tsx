import { createRoot, type Root } from 'react-dom/client';
import { DevUi } from './devUi';
import { CollabEditor } from './pages/sync';
import { getPlatform } from './platform';
import { useRoute } from './router';
import { NavApp } from './shell/NavApp';
import { Shell } from './shell/Shell';
import { RowPanelHost, TaskPanelHost } from './task';
import { DevView } from './tables/DevView';
import './app.css';

/** What the bundle renders: the component demo at /dev/ui (admins), the Pages shell elsewhere. */
export function App() {
  return (
    <>
      <AppView />
      <TaskPanelHost />
      <RowPanelHost />
    </>
  );
}

function AppView() {
  const route = useRoute();
  const user = getPlatform().user();
  if (route.kind === 'notFound' && route.path.split('?')[0] === '/dev/ui' && user?.role === 'admin') return <DevUi />;
  // Dev-only: /dev/page/<pageId> shows just the collaborative editor, for any logged-in user (browser tests)
  const devPage = route.kind === 'notFound' ? /^\/dev\/page\/([^/?#]+)$/.exec(route.path.split('?')[0] ?? '') : null;
  if (devPage && user) return <CollabEditor key={devPage[1]} pageId={decodeURIComponent(devPage[1]!)} autoFocus />;
  if (route.kind === 'notFound' && user) {
    const match = /^\/dev\/view\/([^/?]+)/.exec(route.path);
    if (match) return <DevView viewId={decodeURIComponent(match[1]!)} />;
  }
  return <Shell />;
}

const roots = new WeakMap<Element, Root>();

/**
 * Render the app into `element`. The route comes from the URL (`useRoute`);
 * `route` only says what the URL is at the time of the call and is kept so
 * callers (the legacy page) can pass it explicitly.
 */
export function mountApp(element: Element, _route?: string): void {
  let root = roots.get(element);
  if (!root) {
    root = createRoot(element);
    roots.set(element, root);
  }
  root.render(<App />);
}

export function unmountApp(element: Element): void {
  roots.get(element)?.unmount();
  roots.delete(element);
}

const navRoots = new WeakMap<Element, Root>();

/** Render the sidebar (the app's whole navigation) into `element`; it stays mounted on every screen. */
export function mountNav(element: Element): void {
  let root = navRoots.get(element);
  if (!root) {
    root = createRoot(element);
    navRoots.set(element, root);
  }
  root.render(<NavApp />);
}

export function unmountNav(element: Element): void {
  navRoots.get(element)?.unmount();
  navRoots.delete(element);
}
