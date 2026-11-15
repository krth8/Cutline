/**
 * The persistent sidebar, mounted once into the legacy page's #clNavHost for every logged-in user.
 * It follows the URL (also when the legacy page changes it), collapses to a narrow strip on wide
 * screens and is a drawer on phone widths. The legacy menu button toggles `nav-open` on #clLayout.
 */
import { useEffect, useState, type MouseEvent } from 'react';
import { getPlatform } from '../platform';
import { useRoute } from '../router';
import { readCollapsed, writeCollapsed } from './navState';
import { Sidebar } from './Sidebar';

const NARROW_QUERY = '(max-width: 800px)';

function useNarrow(): boolean {
  const [narrow, setNarrow] = useState(() => (typeof window.matchMedia === 'function' ? window.matchMedia(NARROW_QUERY).matches : false));
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const query = window.matchMedia(NARROW_QUERY);
    const onChange = () => setNarrow(query.matches);
    onChange();
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);
  return narrow;
}

function layout(): HTMLElement | null {
  return document.getElementById('clLayout');
}

export function NavApp() {
  const route = useRoute();
  const narrow = useNarrow();
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const user = getPlatform().user();
  const [, setProjectsVersion] = useState(0);

  // The project list is re-rendered by the legacy page after create / delete / access changes
  useEffect(() => getPlatform().onProjectsChanged?.(() => setProjectsVersion((v) => v + 1)), []);

  const effectiveCollapsed = collapsed && !narrow;
  // The header shows the logo itself while the sidebar is folded or a drawer
  useEffect(() => {
    layout()?.classList.toggle('nav-collapsed', effectiveCollapsed);
  }, [effectiveCollapsed]);

  // A drawer closes when the route changes or Escape is pressed
  useEffect(() => {
    layout()?.classList.remove('nav-open');
  }, [route]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') layout()?.classList.remove('nav-open');
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  if (!user) return null;
  const toggle = () => {
    setCollapsed((c) => {
      writeCollapsed(!c);
      return !c;
    });
  };
  // Choosing the item that is already open does not change the route, so close the drawer here too
  const onClick = (e: MouseEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).closest('a, [role=treeitem]')) layout()?.classList.remove('nav-open');
  };
  return (
    <div className="cl-navapp" onClick={onClick}>
      <Sidebar route={route} collapsed={effectiveCollapsed} onToggle={toggle} drawer={narrow} />
    </div>
  );
}
