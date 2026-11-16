/**
 * The open project and its tabs, shown in the header on every screen of a project: Review, Tasks, Pages
 * and Lounge. Choosing a project (the Projects grid) decides what all four show.
 */
import { useRef, useState, type MouseEvent, type ReactNode } from 'react';
import { usePageStore } from '../pages/tree/space';
import { getPlatform } from '../platform';
import { buildRoute, navigate, routeProjectId, type Route } from '../router';
import { cx, Menu } from '../ui';
import { projectMenuItems } from './projectMenu';
import './projectTabs.css';

type TabId = 'review' | 'tasks' | 'pages' | 'lounge';

/** Which tab a route of this project belongs to. `onTasksPage`: the open page is the project's Tasks page. */
export function tabOf(route: Route, onTasksPage: boolean): TabId | null {
  switch (route.kind) {
    case 'review':
      return 'review';
    case 'projectTasks':
    case 'projectView':
      return 'tasks';
    case 'projectPage':
      return onTasksPage ? 'tasks' : 'pages';
    case 'projectPages':
      return 'pages';
    case 'lounge':
      return 'lounge';
    default:
      return null;
  }
}

function plainClick(e: MouseEvent<HTMLAnchorElement>): boolean {
  return !(e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey);
}

function Tab({ id, to, active, children }: { id: TabId; to: Route; active: boolean; children: ReactNode }) {
  return (
    <a
      href={buildRoute(to)}
      className={cx('cl-ptabs__tab', active && 'is-active')}
      aria-current={active ? 'page' : undefined}
      data-testid={`tab-${id}`}
      onClick={(e) => {
        if (!plainClick(e)) return;
        e.preventDefault();
        navigate(to);
      }}
    >
      {children}
    </a>
  );
}

function Tabs({ projectId, route }: { projectId: string; route: Route }) {
  const platform = getPlatform();
  const project = platform.projects().find((p) => p.id === projectId);
  const { snap } = usePageStore(`p:${projectId}`);
  const moreRef = useRef<HTMLButtonElement | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const onTasksPage = route.kind === 'projectPage' && snap.model.byId.get(route.pageId)?.page.system === 'tasks';
  const current = tabOf(route, onTasksPage);
  const name = project?.name ?? 'Project';
  const items = project ? projectMenuItems(project) : [];

  return (
    <nav className="cl-ptabs" aria-label="Project" data-testid="project-tabs" data-project-id={projectId}>
      <a
        href="/projects"
        className="cl-ptabs__back"
        data-testid="tabs-projects"
        title="All projects"
        onClick={(e) => {
          if (!plainClick(e)) return;
          e.preventDefault();
          navigate({ kind: 'projects' });
        }}
      >
        Projects
      </a>
      <span className="cl-ptabs__sep" aria-hidden="true">
        /
      </span>
      <span className="cl-ptabs__name" data-testid="tabs-project-name" title={name}>
        {name}
      </span>
      {items.length ? (
        <>
          <button
            ref={moreRef}
            type="button"
            className="cl-ptabs__more"
            aria-haspopup="menu"
            aria-label={`Actions for ${name}`}
            title="Project actions"
            onClick={() => setMenuOpen(true)}
          >
            &hellip;
          </button>
          <Menu open={menuOpen} onOpenChange={setMenuOpen} anchorRef={moreRef} items={items} placement="bottom-start" aria-label={`${name} actions`} />
        </>
      ) : null}
      <div className="cl-ptabs__tabs">
        <Tab id="review" to={{ kind: 'review', projectId }} active={current === 'review'}>
          Review
        </Tab>
        {project?.canTasks ? (
          <Tab id="tasks" to={{ kind: 'projectTasks', projectId }} active={current === 'tasks'}>
            Tasks
          </Tab>
        ) : null}
        <Tab id="pages" to={{ kind: 'projectPages', projectId }} active={current === 'pages'}>
          Pages
        </Tab>
        <Tab id="lounge" to={{ kind: 'lounge', projectId }} active={current === 'lounge'}>
          Lounge
        </Tab>
      </div>
    </nav>
  );
}

/** Nothing outside a project (Home, the personal space, the Projects grid, the general Lounge). */
export function ProjectTabs({ route }: { route: Route }) {
  const projectId = routeProjectId(route);
  if (!projectId) return null;
  return <Tabs key={projectId} projectId={projectId} route={route} />;
}
