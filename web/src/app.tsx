import { useEffect, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { getPlatform, NAVIGATE_EVENT } from './platform';
import { Avatar } from './ui';
import { DevUi } from './devUi';
import './app.css';

/** The route the legacy page URL currently points at (path + query). */
function currentRoute(): string {
  return window.location.pathname + window.location.search;
}

function useRoute(initial: string): string {
  const [route, setRoute] = useState(initial);
  useEffect(() => {
    // The router (WP F5) will replace this; for now just follow history changes
    const update = () => setRoute(currentRoute());
    window.addEventListener('popstate', update);
    window.addEventListener(NAVIGATE_EVENT, update);
    return () => {
      window.removeEventListener('popstate', update);
      window.removeEventListener(NAVIGATE_EVENT, update);
    };
  }, []);
  return route;
}

/** Placeholder shell: proves the bundle runs inside the legacy page with the user's theme. */
export function PlaceholderShell({ route }: { route: string }) {
  const user = getPlatform().user();
  return (
    <div className="cl-shell" data-testid="cl-shell">
      <div className="cl-shell__card">
        {user ? <Avatar name={user.username} src={user.profileImage} size={36} /> : null}
        <div>
          <div className="cl-shell__title">Cutline Pages</div>
          <div className="cl-shell__sub">
            {user ? (
              <>
                Signed in as <strong>{user.username}</strong> ({user.role})
              </>
            ) : (
              'Not signed in'
            )}
            {' · '}
            <code>{route}</code>
          </div>
        </div>
      </div>
    </div>
  );
}

export function App({ route: initial }: { route: string }) {
  const route = useRoute(initial);
  const user = getPlatform().user();
  if (route.split('?')[0] === '/dev/ui' && user?.role === 'admin') return <DevUi />;
  return <PlaceholderShell route={route} />;
}

const roots = new WeakMap<Element, Root>();

export function mountApp(element: Element, route: string): void {
  let root = roots.get(element);
  if (!root) {
    root = createRoot(element);
    roots.set(element, root);
  }
  root.render(<App route={route} />);
}

export function unmountApp(element: Element): void {
  roots.get(element)?.unmount();
  roots.delete(element);
}
