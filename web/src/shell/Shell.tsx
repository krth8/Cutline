import { useEffect, useState, type ComponentType, type MouseEvent, type ReactNode } from 'react';
import { getPlatform } from '../platform';
import { buildRoute, navigate, routeProjectId, useRoute, type Route } from '../router';
import { Avatar, Button, cx } from '../ui';
import { useRouteView, useSidebarSections, type Space } from './registry';
import './shell.css';

const COLLAPSED_KEY = 'cl-sidebar-collapsed';

function readCollapsed(): boolean {
  try {
    return localStorage.getItem(COLLAPSED_KEY) === '1';
  } catch {
    return false;
  }
}

function writeCollapsed(value: boolean): void {
  try {
    localStorage.setItem(COLLAPSED_KEY, value ? '1' : '0');
  } catch {
    /* storage unavailable: the state just is not remembered */
  }
}

/** A real link (middle click and "open in new tab" work); a plain click navigates without reloading. */
function NavLink({
  to,
  active,
  className,
  children,
  indent,
}: {
  to: Route;
  active: boolean;
  className?: string;
  children: ReactNode;
  indent?: boolean;
}) {
  const href = buildRoute(to);
  const onClick = (e: MouseEvent<HTMLAnchorElement>) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    navigate(to);
  };
  return (
    <a
      href={href}
      onClick={onClick}
      className={cx('cl-nav__item', indent && 'cl-nav__item--indent', active && 'is-active', className)}
      aria-current={active ? 'page' : undefined}
    >
      {children}
    </a>
  );
}

function SectionSlots({ space, route }: { space: Space; route: Route }) {
  const sections = useSidebarSections();
  return (
    <>
      {sections.map(([id, Component]) => (
        <div key={id} className="cl-nav__slot" data-section={id}>
          <Component space={space} route={route} />
        </div>
      ))}
    </>
  );
}

function ProjectItem({ project, route }: { project: { id: string; name: string }; route: Route }) {
  const current = routeProjectId(route) === project.id;
  const [open, setOpen] = useState(current);
  // Following the route into a project (a link, back/forward) opens it
  useEffect(() => {
    if (current) setOpen(true);
  }, [current]);

  const panelId = `cl-project-${project.id}`;
  const onReview = route.kind === 'review' && route.projectId === project.id;
  const onPages = (route.kind === 'projectPages' || route.kind === 'projectPage') && route.projectId === project.id;
  return (
    <li className="cl-nav__project">
      <button
        type="button"
        className={cx('cl-nav__item', 'cl-nav__toggle', current && 'is-current')}
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((o) => !o)}
      >
        <span className={cx('cl-nav__chevron', open && 'is-open')} aria-hidden="true">
          &#9656;
        </span>
        <span className="cl-nav__label">{project.name}</span>
      </button>
      {open ? (
        <div id={panelId} className="cl-nav__children">
          <NavLink to={{ kind: 'review', projectId: project.id }} active={onReview} indent>
            Review
          </NavLink>
          <NavLink to={{ kind: 'projectPages', projectId: project.id }} active={onPages && route.kind === 'projectPages'} indent>
            Pages
          </NavLink>
          <SectionSlots space={{ kind: 'project', projectId: project.id }} route={route} />
        </div>
      ) : null}
    </li>
  );
}

export function Sidebar({ route, collapsed, onToggle }: { route: Route; collapsed: boolean; onToggle: () => void }) {
  const platform = getPlatform();
  const projects = platform.projects();
  const user = platform.user();
  return (
    <aside className={cx('cl-sidebar', collapsed && 'is-collapsed')} data-testid="cl-sidebar">
      <div className="cl-sidebar__bar">
        <Button
          variant="ghost"
          size="sm"
          onClick={onToggle}
          aria-expanded={!collapsed}
          aria-controls="cl-sidebar-nav"
          aria-label={collapsed ? 'Show sidebar' : 'Hide sidebar'}
          title={collapsed ? 'Show sidebar' : 'Hide sidebar'}
        >
          <span aria-hidden="true">{collapsed ? '»' : '«'}</span>
        </Button>
      </div>
      <nav id="cl-sidebar-nav" className="cl-sidebar__nav" aria-label="Pages" hidden={collapsed}>
        <NavLink to={{ kind: 'home' }} active={route.kind === 'home'}>
          Home
        </NavLink>
        <NavLink to={{ kind: 'me' }} active={route.kind === 'me' || route.kind === 'mePage'}>
          Personal space
        </NavLink>
        <SectionSlots space={{ kind: 'personal' }} route={route} />
        <div className="cl-nav__heading">Projects</div>
        {projects.length === 0 ? (
          <div className="cl-nav__empty">No projects</div>
        ) : (
          <ul className="cl-nav__projects">
            {projects.map((p) => (
              <ProjectItem key={p.id} project={p} route={route} />
            ))}
          </ul>
        )}
      </nav>
      {user && !collapsed ? (
        <div className="cl-sidebar__user">
          <Avatar name={user.username} src={user.profileImage} size={24} />
          <span className="cl-nav__label">{user.username}</span>
        </div>
      ) : null}
    </aside>
  );
}

function projectName(projectId: string): string {
  return getPlatform().projects().find((p) => p.id === projectId)?.name ?? 'Unknown project';
}

function Placeholder({ title, detail }: { title: string; detail?: string }) {
  return (
    <div className="cl-main__placeholder" data-testid="cl-placeholder">
      <h1 className="cl-main__title">{title}</h1>
      {detail ? <p className="cl-main__detail">{detail}</p> : null}
    </div>
  );
}

function placeholderFor(route: Route): { title: string; detail?: string } {
  switch (route.kind) {
    case 'home':
      return { title: 'Home', detail: 'Your pinned page or project list will show here.' };
    case 'me':
      return { title: 'Personal space', detail: 'Your private pages will show here.' };
    case 'mePage':
      return { title: 'Personal page', detail: route.pageId };
    case 'projectPages':
      return { title: `${projectName(route.projectId)}: Pages`, detail: 'The page tree of this project will show here.' };
    case 'projectPage':
      return { title: `${projectName(route.projectId)}: Page`, detail: route.pageId };
    case 'review':
      return { title: `${projectName(route.projectId)}: Review`, detail: 'Opening the review...' };
    case 'notFound':
      return { title: 'Not found', detail: route.path };
  }
}

function MainView({ route }: { route: Route }) {
  const View = useRouteView(route.kind) as ComponentType<{ route: Route }> | undefined;
  if (View) return <View route={route} />;
  const { title, detail } = placeholderFor(route);
  return <Placeholder title={title} {...(detail ? { detail } : {})} />;
}

/** The Pages shell: left sidebar + main area, driven by the URL. */
export function Shell() {
  const route = useRoute();
  const user = getPlatform().user();
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const toggle = () => {
    setCollapsed((c) => {
      writeCollapsed(!c);
      return !c;
    });
  };

  if (!user) {
    return (
      <div className="cl-shell" data-testid="cl-shell">
        <main className="cl-main">
          <Placeholder title="Not signed in" detail="Sign in to use Pages." />
        </main>
      </div>
    );
  }
  return (
    <div className="cl-shell" data-testid="cl-shell">
      <Sidebar route={route} collapsed={collapsed} onToggle={toggle} />
      <main className="cl-main" id="cl-main" tabIndex={-1}>
        <MainView route={route} />
      </main>
    </div>
  );
}
