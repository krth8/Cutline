/**
 * The three tabs of the header, on every screen: Main (pages and tasks), Review and Lounge.
 *
 * Which project they show is chosen in the sidebar. With a project open each tab shows that project;
 * with none, Main is Home, Review is the grid of projects and Lounge is the general Lounge.
 */
import type { MouseEvent, ReactNode } from 'react';
import { buildRoute, navigate, routeProjectId, type Route } from '../router';
import { cx } from '../ui';
import './projectTabs.css';

export type TabId = 'main' | 'review' | 'lounge';

/** Which tab a route belongs to: Review and Lounge have their own screens, everything else is Main. */
export function tabOf(route: Route): TabId {
  if (route.kind === 'review' || route.kind === 'projects') return 'review';
  if (route.kind === 'lounge') return 'lounge';
  return 'main';
}

/** Where a tab leads: into the open project, or to its general screen when no project is open. */
export function tabRoute(tab: TabId, projectId: string | null): Route {
  if (tab === 'review') return projectId ? { kind: 'review', projectId } : { kind: 'projects' };
  if (tab === 'lounge') return projectId ? { kind: 'lounge', projectId } : { kind: 'lounge' };
  return projectId ? { kind: 'projectPages', projectId } : { kind: 'home' };
}

function Tab({ id, to, active, children }: { id: TabId; to: Route; active: boolean; children: ReactNode }) {
  return (
    <a
      href={buildRoute(to)}
      className={cx('cl-ptabs__tab', active && 'is-active')}
      aria-current={active ? 'page' : undefined}
      data-testid={`tab-${id}`}
      onClick={(e: MouseEvent<HTMLAnchorElement>) => {
        if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        e.preventDefault();
        navigate(to);
      }}
    >
      {children}
    </a>
  );
}

export function ProjectTabs({ route }: { route: Route }) {
  const projectId = routeProjectId(route);
  const current = tabOf(route);
  return (
    <nav className="cl-ptabs" aria-label="Sections" data-testid="project-tabs" {...(projectId ? { 'data-project-id': projectId } : {})}>
      <div className="cl-ptabs__tabs">
        <Tab id="main" to={tabRoute('main', projectId)} active={current === 'main'}>
          Main
        </Tab>
        <Tab id="review" to={tabRoute('review', projectId)} active={current === 'review'}>
          Review
        </Tab>
        <Tab id="lounge" to={tabRoute('lounge', projectId)} active={current === 'lounge'}>
          Lounge
        </Tab>
      </div>
    </nav>
  );
}
