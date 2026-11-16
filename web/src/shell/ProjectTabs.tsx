/**
 * The tabs of the header: Main (pages and tasks), Review and Lounge.
 *
 * A person's access to a project is one switch per tab. With a project open the tabs are the ones they have
 * in that project; with none open, the ones they have in any project. Someone with a single tab sees no tab
 * bar at all. Which project the tabs show is chosen in the sidebar; with none, Main is Home, Review is the
 * grid of projects and Lounge is the general Lounge.
 */
import type { MouseEvent, ReactNode } from 'react';
import { getPlatform } from '../platform';
import { buildRoute, navigate, routeProjectId, type Route } from '../router';
import { cx } from '../ui';
import './projectTabs.css';

export type TabId = 'main' | 'review' | 'lounge';
export const TAB_ORDER: TabId[] = ['main', 'review', 'lounge'];
const LABELS: Record<TabId, string> = { main: 'Main', review: 'Review', lounge: 'Lounge' };

type AccessProject = { id: string; canTasks: boolean; canReview?: boolean; canLounge?: boolean };

/** The tabs a project gives its member (a switch that is not stated counts as on). */
export function projectTabs(project: AccessProject): TabId[] {
  const has: Record<TabId, boolean> = { main: project.canTasks, review: project.canReview !== false, lounge: project.canLounge !== false };
  return TAB_ORDER.filter((t) => has[t]);
}

/**
 * The tabs the user may use: those of the open project, or with none open those of any project. Someone
 * without projects has Main only (their personal space).
 */
export function allowedTabs(projects: AccessProject[], projectId: string | null): TabId[] {
  const open = projectId ? projects.find((p) => p.id === projectId) : undefined;
  if (open) return projectTabs(open);
  if (projects.length === 0) return ['main'];
  const any = new Set(projects.flatMap(projectTabs));
  return TAB_ORDER.filter((t) => any.has(t));
}

/** Which tab a route belongs to: Review and Lounge have their own screens, everything else is Main. Null for pages outside the app's tabs. */
export function tabOf(route: Route): TabId | null {
  if (route.kind === 'notFound') return null;
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

/**
 * Where to send someone whose route is in a tab they do not have (a link from someone else, an old
 * bookmark, access that was taken away): the first tab they do have. Null when the route is fine.
 */
export function redirectFor(route: Route, projects: AccessProject[]): Route | null {
  const tab = tabOf(route);
  if (!tab) return null;
  const projectId = routeProjectId(route);
  const known = projectId && projects.some((p) => p.id === projectId) ? projectId : null;
  if (projectId && !known) return null; // not their project: the screen itself says so
  const allowed = allowedTabs(projects, known);
  if (allowed.includes(tab) || allowed.length === 0) return null;
  return tabRoute(allowed[0]!, known);
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
  const projects = getPlatform().projects();
  const projectId = routeProjectId(route);
  const current = tabOf(route);
  const allowed = allowedTabs(projects, projectId && projects.some((p) => p.id === projectId) ? projectId : null);
  // One tab is no choice: no bar
  if (allowed.length < 2) return null;
  return (
    <nav className="cl-ptabs" aria-label="Sections" data-testid="project-tabs" {...(projectId ? { 'data-project-id': projectId } : {})}>
      <div className="cl-ptabs__tabs">
        {allowed.map((tab) => (
          <Tab key={tab} id={tab} to={tabRoute(tab, projectId)} active={current === tab}>
            {LABELS[tab]}
          </Tab>
        ))}
      </div>
    </nav>
  );
}
