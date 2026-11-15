/**
 * The sidebar: the whole navigation of the app. Search, Home, the personal pages, every project
 * (Review, Tasks, pages) and the Lounge. It stays on screen for every route, including the legacy
 * Review and Lounge views, so the current item is chosen from the route alone.
 */
import { useRef, useState, type MouseEvent, type ReactNode } from 'react';
import { getPlatform } from '../platform';
import { buildRoute, navigate, routeProjectId, type Route } from '../router';
import { openSearch, shortcutLabel } from '../search';
import { Button, cx, Menu, type MenuItem } from '../ui';
import { useOpenProjects } from './navState';
import { usePageStore } from '../pages/tree/space';
import { useSidebarSections, type Space } from './registry';
import './sidebar.css';

type IconName = 'search' | 'home' | 'review' | 'tasks' | 'lounge' | 'plus';

/** Small line icons, drawn in the text colour. */
function Icon({ name }: { name: IconName }) {
  const common = { width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true, focusable: false, className: 'cl-nav__icon' } as const;
  switch (name) {
    case 'search':
      return (
        <svg {...common}>
          <circle cx="7" cy="7" r="4.5" />
          <path d="M10.5 10.5 14 14" />
        </svg>
      );
    case 'home':
      return (
        <svg {...common}>
          <path d="M2 7.5 8 2.5l6 5M3.5 6.5V13.5h9V6.5" />
        </svg>
      );
    case 'review':
      return (
        <svg {...common}>
          <rect x="2" y="3" width="12" height="10" rx="2" />
          <path d="M6.8 6v4l3.2-2z" />
        </svg>
      );
    case 'tasks':
      return (
        <svg {...common}>
          <rect x="2" y="2" width="12" height="12" rx="2.5" />
          <path d="M5 8.2l2.1 2.1L11 6" />
        </svg>
      );
    case 'lounge':
      return (
        <svg {...common}>
          <path d="M2.5 3.5h11v7h-6L4.5 13v-2.5h-2z" />
        </svg>
      );
    case 'plus':
      return (
        <svg {...common}>
          <path d="M8 3v10M3 8h10" />
        </svg>
      );
  }
}

/** A real link (middle click and "open in new tab" work); a plain click navigates without reloading. */
function NavLink({
  to,
  active,
  className,
  children,
  indent,
  testId,
}: {
  to: Route;
  active: boolean;
  className?: string;
  children: ReactNode;
  indent?: boolean;
  testId?: string;
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
      {...(testId ? { 'data-testid': testId } : {})}
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

/** The project's Tasks entry. It is also current while the project's system Tasks page is open. */
function TasksLink({ projectId, route }: { projectId: string; route: Route }) {
  const { snap } = usePageStore(`p:${projectId}`);
  const onTasksPage =
    route.kind === 'projectPage' && route.projectId === projectId && snap.model.byId.get(route.pageId)?.page.system === 'tasks';
  const active = (route.kind === 'projectTasks' && route.projectId === projectId) || onTasksPage;
  return (
    <NavLink to={{ kind: 'projectTasks', projectId }} active={active} indent testId="nav-tasks">
      <Icon name="tasks" />
      <span className="cl-nav__label">Tasks</span>
    </NavLink>
  );
}

type SidebarProject = ReturnType<ReturnType<typeof getPlatform>['projects']>[number];

function ProjectItem({
  project,
  route,
  open,
  onOpenChange,
}: {
  project: SidebarProject;
  route: Route;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const platform = getPlatform();
  const tools = platform.projectTools;
  const isAdmin = platform.user()?.role === 'admin';
  const current = routeProjectId(route) === project.id;
  const onOverview = route.kind === 'projectPages' && route.projectId === project.id;
  const onReview = route.kind === 'review' && route.projectId === project.id;
  const panelId = `cl-project-${project.id}`;
  const moreRef = useRef<HTMLButtonElement | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);

  const items: MenuItem[] = [];
  if (tools?.canShare()) items.push({ id: 'share', label: 'Share link...', onSelect: () => tools.share(project.id) });
  if (tools) items.push({ id: 'cover', label: 'Set cover image...', onSelect: () => tools.setCover(project.id) });
  if (tools && isAdmin) items.push({ id: 'access', label: 'Access and members...', onSelect: () => tools.openAccess() });
  if (tools?.canDelete()) {
    items.push({ type: 'separator' }, { id: 'delete', label: 'Delete project...', danger: true, onSelect: () => tools.remove(project.id, project.name) });
  }

  return (
    <li className="cl-nav__project" data-project-id={project.id}>
      <div className={cx('cl-nav__projectrow', current && 'is-current', onOverview && 'is-active', menuOpen && 'is-menu-open')}>
        <button
          type="button"
          className={cx('cl-nav__chevron', open && 'is-open')}
          aria-expanded={open}
          aria-controls={panelId}
          aria-label={`${open ? 'Collapse' : 'Expand'} ${project.name}`}
          onClick={() => onOpenChange(!open)}
        >
          &#9656;
        </button>
        <a
          href={buildRoute({ kind: 'projectPages', projectId: project.id })}
          className="cl-nav__projectname"
          aria-current={onOverview ? 'page' : undefined}
          onClick={(e) => {
            if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
            e.preventDefault();
            onOpenChange(true);
            navigate({ kind: 'projectPages', projectId: project.id });
          }}
        >
          {project.name}
        </a>
        {items.length ? (
          <button
            ref={moreRef}
            type="button"
            className="cl-nav__more"
            aria-haspopup="menu"
            aria-label={`Actions for ${project.name}`}
            title="Project actions"
            onClick={() => setMenuOpen(true)}
          >
            &hellip;
          </button>
        ) : null}
      </div>
      {items.length ? (
        <Menu open={menuOpen} onOpenChange={setMenuOpen} anchorRef={moreRef} items={items} placement="bottom-start" aria-label={`${project.name} actions`} />
      ) : null}
      {open ? (
        <div id={panelId} className="cl-nav__children">
          <NavLink to={{ kind: 'review', projectId: project.id }} active={onReview} indent testId="nav-review">
            <Icon name="review" />
            <span className="cl-nav__label">Review</span>
            {typeof project.clipCount === 'number' && project.clipCount > 0 ? (
              <span className="cl-nav__count" aria-hidden="true" title={`${project.clipCount} clips`}>
                {project.clipCount}
              </span>
            ) : null}
          </NavLink>
          {project.canTasks ? <TasksLink projectId={project.id} route={route} /> : null}
          <SectionSlots space={{ kind: 'project', projectId: project.id }} route={route} />
        </div>
      ) : null}
    </li>
  );
}

/** What the sidebar offers when it is folded to a narrow strip: the three entries that need no list. */
function Rail({ route, onToggle }: { route: Route; onToggle: () => void }) {
  return (
    <>
      <div className="cl-sidebar__bar">
        <Button variant="ghost" size="sm" onClick={onToggle} aria-expanded={false} aria-controls="cl-sidebar-nav" aria-label="Show sidebar" title="Show sidebar">
          <span aria-hidden="true">&raquo;</span>
        </Button>
      </div>
      <div className="cl-sidebar__rail">
        <button type="button" className="cl-nav__railbtn" aria-label="Search" title="Search and commands" onClick={openSearch}>
          <Icon name="search" />
        </button>
        <a
          href="/home"
          className={cx('cl-nav__railbtn', route.kind === 'home' && 'is-active')}
          aria-label="Home"
          title="Home"
          aria-current={route.kind === 'home' ? 'page' : undefined}
          onClick={(e) => {
            e.preventDefault();
            navigate({ kind: 'home' });
          }}
        >
          <Icon name="home" />
        </a>
        <a
          href="/lounge"
          className={cx('cl-nav__railbtn', route.kind === 'lounge' && 'is-active')}
          aria-label="Lounge"
          title="Lounge"
          aria-current={route.kind === 'lounge' ? 'page' : undefined}
          onClick={(e) => {
            e.preventDefault();
            navigate({ kind: 'lounge' });
          }}
        >
          <Icon name="lounge" />
        </a>
      </div>
    </>
  );
}

export function Sidebar({
  route,
  collapsed,
  onToggle,
  drawer,
}: {
  route: Route;
  collapsed: boolean;
  onToggle: () => void;
  /** True in the phone-width drawer: no collapse button, always the full list. */
  drawer?: boolean;
}) {
  const platform = getPlatform();
  const projects = platform.projects();
  const user = platform.user();
  const tools = platform.projectTools;
  const open = useOpenProjects(user?.id ?? 'anonymous', routeProjectId(route));

  return (
    <aside className={cx('cl-sidebar', collapsed && 'is-collapsed', drawer && 'is-drawer')} data-testid="cl-sidebar">
      {collapsed ? (
        <Rail route={route} onToggle={onToggle} />
      ) : (
        <>
          <div className="cl-sidebar__bar">
            <a
              href="/home"
              className="cl-sidebar__logo"
              aria-label="Cutline, go to Home"
              onClick={(e) => {
                e.preventDefault();
                navigate({ kind: 'home' });
              }}
            >
              <img src="/static/logo.png" alt="" />
            </a>
            {drawer ? null : (
              <Button
                variant="ghost"
                size="sm"
                onClick={onToggle}
                aria-expanded
                aria-controls="cl-sidebar-nav"
                aria-label="Hide sidebar"
                title="Hide sidebar"
              >
                <span aria-hidden="true">&laquo;</span>
              </Button>
            )}
          </div>
          <nav id="cl-sidebar-nav" className="cl-sidebar__nav" aria-label="Main">
            <button type="button" className="cl-nav__item cl-nav__search" data-testid="sidebar-search" onClick={openSearch} title="Search and commands">
              <Icon name="search" />
              <span className="cl-nav__label">Search</span>
              <kbd>{shortcutLabel()}</kbd>
            </button>
            <NavLink to={{ kind: 'home' }} active={route.kind === 'home'} testId="nav-home">
              <Icon name="home" />
              <span className="cl-nav__label">Home</span>
            </NavLink>

            <NavLink to={{ kind: 'me' }} active={route.kind === 'me' || route.kind === 'mePage'} className="cl-nav__heading" testId="nav-personal">
              Personal
            </NavLink>
            <SectionSlots space={{ kind: 'personal' }} route={route} />

            <div className="cl-nav__heading">Projects</div>
            {projects.length === 0 ? (
              <div className="cl-nav__empty">No projects</div>
            ) : (
              <ul className="cl-nav__projects">
                {projects.map((p) => (
                  <ProjectItem key={p.id} project={p} route={route} open={open.isOpen(p.id)} onOpenChange={(o) => open.set(p.id, o)} />
                ))}
              </ul>
            )}
            {tools?.canCreate() ? (
              <button type="button" className="cl-nav__item cl-nav__newproject" data-testid="new-project" onClick={() => tools.create()}>
                <Icon name="plus" />
                <span className="cl-nav__label">New project</span>
              </button>
            ) : null}
          </nav>
          <div className="cl-sidebar__foot">
            <NavLink to={{ kind: 'lounge' }} active={route.kind === 'lounge'} testId="nav-lounge">
              <Icon name="lounge" />
              <span className="cl-nav__label">Lounge</span>
            </NavLink>
          </div>
        </>
      )}
    </aside>
  );
}
