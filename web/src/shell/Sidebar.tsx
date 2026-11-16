/**
 * The sidebar. It stays on screen for every route, including the legacy Review and Lounge views, and
 * always lists Home, the personal pages and every project the user has access to, each with Tasks and its
 * pages. Choosing a project here decides what the tabs of the header (Main, Review, Lounge) show.
 */
import { useRef, useState, type MouseEvent, type ReactNode } from 'react';
import { getPlatform } from '../platform';
import { buildRoute, navigate, routeProjectId, type Route } from '../router';
import { openSearch, shortcutLabel } from '../search';
import { Button, cx, Menu } from '../ui';
import { usePageStore } from '../pages/tree/space';
import { useOpenProjects } from './navState';
import { projectMenuItems } from './projectMenu';
import { tabOf, tabRoute } from './ProjectTabs';
import { useSidebarSections, type Space } from './registry';
import './sidebar.css';

type IconName = 'search' | 'home' | 'projects' | 'tasks' | 'plus';

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
    case 'projects':
      return (
        <svg {...common}>
          <rect x="2" y="2.5" width="5" height="4.5" rx="1" />
          <rect x="9" y="2.5" width="5" height="4.5" rx="1" />
          <rect x="2" y="9" width="5" height="4.5" rx="1" />
          <rect x="9" y="9" width="5" height="4.5" rx="1" />
        </svg>
      );
    case 'tasks':
      return (
        <svg {...common}>
          <rect x="2" y="2" width="12" height="12" rx="2.5" />
          <path d="M5 8.2l2.1 2.1L11 6" />
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

/** The project's Tasks entry, first among its pages. It is also current while the project's Tasks page or a task view is open. */
function TasksLink({ projectId, route }: { projectId: string; route: Route }) {
  const { snap } = usePageStore(`p:${projectId}`);
  const inProject = routeProjectId(route) === projectId;
  const onTasksPage = route.kind === 'projectPage' && inProject && snap.model.byId.get(route.pageId)?.page.system === 'tasks';
  const active = inProject && (route.kind === 'projectTasks' || route.kind === 'projectView' || onTasksPage);
  return (
    <NavLink to={{ kind: 'projectTasks', projectId }} active={active} indent testId="nav-tasks">
      <Icon name="tasks" />
      <span className="cl-nav__label">Tasks</span>
    </NavLink>
  );
}

type SidebarProject = ReturnType<ReturnType<typeof getPlatform>['projects']>[number];

/**
 * One project: its name opens it in the tab that is showing (Main, Review or Lounge); under it are Tasks
 * and its pages.
 */
function ProjectItem({ project, route, open, onOpenChange }: { project: SidebarProject; route: Route; open: boolean; onOpenChange: (open: boolean) => void }) {
  const current = routeProjectId(route) === project.id;
  const onOverview = route.kind === 'projectPages' && current;
  const panelId = `cl-project-${project.id}`;
  const moreRef = useRef<HTMLButtonElement | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const items = projectMenuItems(project);
  const target = tabRoute(tabOf(route), project.id);

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
          href={buildRoute(target)}
          className="cl-nav__projectname"
          data-testid="nav-project"
          aria-current={onOverview ? 'page' : undefined}
          onClick={(e) => {
            if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
            e.preventDefault();
            onOpenChange(true);
            navigate(target);
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
          {project.canTasks ? <TasksLink projectId={project.id} route={route} /> : null}
          <SectionSlots space={{ kind: 'project', projectId: project.id }} route={route} />
        </div>
      ) : null}
    </li>
  );
}

function RailLink({ to, active, label, icon }: { to: Route; active: boolean; label: string; icon: IconName }) {
  return (
    <a
      href={buildRoute(to)}
      className={cx('cl-nav__railbtn', active && 'is-active')}
      aria-label={label}
      title={label}
      aria-current={active ? 'page' : undefined}
      onClick={(e) => {
        e.preventDefault();
        navigate(to);
      }}
    >
      <Icon name={icon} />
    </a>
  );
}

/** What the sidebar offers when it is folded to a narrow strip: the entries that need no list. */
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
        <RailLink to={{ kind: 'home' }} active={route.kind === 'home'} label="Home" icon="home" />
        <RailLink to={{ kind: 'projects' }} active={route.kind === 'projects'} label="Projects" icon="projects" />
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
              href="/projects"
              className="cl-sidebar__logo"
              aria-label="Cutline, go to Projects"
              onClick={(e) => {
                e.preventDefault();
                navigate({ kind: 'projects' });
              }}
            >
              <img src="/static/logo-mark.svg" alt="" />
              <span className="cl-sidebar__word">Cutline</span>
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

            <NavLink to={{ kind: 'projects' }} active={route.kind === 'projects'} className="cl-nav__heading" testId="nav-projects">
              Projects
            </NavLink>
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
        </>
      )}
    </aside>
  );
}
