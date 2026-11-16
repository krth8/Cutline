/**
 * The sidebar. It stays on screen for every route, including the legacy Review and Lounge views.
 * Outside a project it lists Home, the personal pages and the projects. Inside a project it shows that
 * project's pages only: Review, Tasks, Pages and Lounge are the tabs of the header (ProjectTabs).
 */
import { type MouseEvent, type ReactNode } from 'react';
import { getPlatform } from '../platform';
import { buildRoute, navigate, routeProjectId, type Route } from '../router';
import { openSearch, shortcutLabel } from '../search';
import { Button, cx } from '../ui';
import { useSidebarSections, type Space } from './registry';
import './sidebar.css';

type IconName = 'search' | 'home' | 'projects' | 'lounge' | 'plus';

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
        <RailLink to={{ kind: 'lounge' }} active={route.kind === 'lounge' && !route.projectId} label="Lounge" icon="lounge" />
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
  const tools = platform.projectTools;
  const projectId = routeProjectId(route);
  const project = projectId ? projects.find((p) => p.id === projectId) : undefined;

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
            {projectId ? (
              <NavLink to={{ kind: 'projects' }} active={false} testId="nav-projects">
                <Icon name="projects" />
                <span className="cl-nav__label">All projects</span>
              </NavLink>
            ) : null}

            {projectId ? (
              <div className="cl-nav__project" data-project-id={projectId} data-testid="nav-project-pages">
                <NavLink to={{ kind: 'projectPages', projectId }} active={route.kind === 'projectPages'} className="cl-nav__heading" testId="nav-project-heading">
                  {project?.name ?? 'Project'}
                </NavLink>
                <SectionSlots space={{ kind: 'project', projectId }} route={route} />
              </div>
            ) : (
              <>
                <NavLink to={{ kind: 'me' }} active={route.kind === 'me' || route.kind === 'mePage'} className="cl-nav__heading" testId="nav-personal">
                  Personal
                </NavLink>
                <SectionSlots space={{ kind: 'personal' }} route={route} />

                <NavLink to={{ kind: 'projects' }} active={route.kind === 'projects'} className="cl-nav__heading" testId="nav-projects-heading">
                  Projects
                </NavLink>
                {projects.length === 0 ? (
                  <div className="cl-nav__empty">No projects</div>
                ) : (
                  <ul className="cl-nav__projects">
                    {projects.map((p) => (
                      <li key={p.id} className="cl-nav__project" data-project-id={p.id}>
                        <NavLink to={{ kind: 'review', projectId: p.id }} active={false} testId="nav-project">
                          <span className="cl-nav__label">{p.name}</span>
                        </NavLink>
                      </li>
                    ))}
                  </ul>
                )}
                {tools?.canCreate() ? (
                  <button type="button" className="cl-nav__item cl-nav__newproject" data-testid="new-project" onClick={() => tools.create()}>
                    <Icon name="plus" />
                    <span className="cl-nav__label">New project</span>
                  </button>
                ) : null}
              </>
            )}
          </nav>
          {projectId ? null : (
            <div className="cl-sidebar__foot">
              <NavLink to={{ kind: 'lounge' }} active={route.kind === 'lounge'} testId="nav-lounge">
                <Icon name="lounge" />
                <span className="cl-nav__label">Lounge</span>
              </NavLink>
            </div>
          )}
        </>
      )}
    </aside>
  );
}
