import { createRoot, type Root } from 'react-dom/client';
import { DevUi } from './devUi';
import { getPlatform } from './platform';
import { useRoute } from './router';
import { Shell } from './shell/Shell';
import './app.css';

/** What the bundle renders: the component demo at /dev/ui (admins), the Pages shell elsewhere. */
export function App() {
  const route = useRoute();
  const user = getPlatform().user();
  if (route.kind === 'notFound' && route.path.split('?')[0] === '/dev/ui' && user?.role === 'admin') return <DevUi />;
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
