import { act, cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NAVIGATE_EVENT, PROJECTS_CHANGED_EVENT, URL_CHANGED_EVENT, setPlatform } from '../platform';
import { createFakePlatform, type FakePlatform } from '../testing/fakePlatform';
import { clearRegistry, registerSidebarSection } from './registry';
import { NavApp } from './NavApp';

let fake: FakePlatform;
const calls: string[] = [];

function go(url: string) {
  act(() => {
    window.history.pushState({}, '', url);
    window.dispatchEvent(new CustomEvent(NAVIGATE_EVENT));
  });
}

beforeEach(() => {
  calls.length = 0;
  fake = createFakePlatform({
    projects: [
      { id: 'p1', name: 'Project One', canTasks: true, isOwner: true },
      { id: 'p2', name: 'Project Two', canTasks: false, isOwner: false },
    ],
  });
  fake.navigate = (route) => {
    fake.navigations.push(route);
    go(route);
  };
  fake.projectTools = {
    canCreate: () => true,
    canShare: () => true,
    canDelete: () => true,
    create: () => calls.push('create'),
    share: (id) => calls.push(`share:${id}`),
    setCover: (id) => calls.push(`cover:${id}`),
    remove: (id, name) => calls.push(`delete:${id}:${name}`),
    openAccess: () => calls.push('access'),
  };
  fake.onProjectsChanged = (listener) => {
    window.addEventListener(PROJECTS_CHANGED_EVENT, listener);
    return () => window.removeEventListener(PROJECTS_CHANGED_EVENT, listener);
  };
  setPlatform(fake);
  localStorage.clear();
  window.history.replaceState({}, '', '/home');
  // The legacy header's host for the project tabs
  const host = document.createElement('div');
  host.id = 'clTabsHost';
  document.body.appendChild(host);
});

afterEach(() => {
  cleanup(); // release the page stores while the fake platform is still set
  setPlatform(null);
  clearRegistry();
  document.getElementById('clTabsHost')?.remove();
});

const nav = () => screen.getByRole('navigation', { name: 'Main' });
const tabs = () => screen.getByRole('navigation', { name: 'Sections' });

describe('Sidebar', () => {
  it('lists Search, Home, Personal, every project and New project, on every screen', () => {
    render(<NavApp />);
    for (const url of ['/home', '/p/p1/review', '/p/p2/pages', '/lounge']) {
      go(url);
      expect(within(nav()).getByRole('button', { name: /Search/ })).toBeTruthy();
      expect(within(nav()).getByRole('link', { name: 'Home' })).toBeTruthy();
      expect(within(nav()).getByRole('link', { name: 'Personal' })).toBeTruthy();
      expect(within(nav()).getByRole('link', { name: 'Project One' })).toBeTruthy();
      expect(within(nav()).getByRole('link', { name: 'Project Two' })).toBeTruthy();
      expect(within(nav()).getByRole('button', { name: /New project/ })).toBeTruthy();
    }
  });

  it('always shows the tabs Main, Review and Lounge, and highlights the one of the route', () => {
    render(<NavApp />);
    const currentTab = () => within(tabs()).getAllByRole('link').find((a) => a.getAttribute('aria-current') === 'page')?.textContent;
    expect(within(tabs()).getAllByRole('link').map((a) => a.textContent)).toEqual(['Main', 'Review', 'Lounge']);
    expect(currentTab()).toBe('Main'); // Home
    for (const [url, tab] of [
      ['/me', 'Main'],
      ['/projects', 'Review'],
      ['/lounge', 'Lounge'],
      ['/p/p1/review', 'Review'],
      ['/p/p1/tasks', 'Main'],
      ['/p/p1/pages', 'Main'],
      ['/p/p1/page/abc', 'Main'],
      ['/p/p1/lounge', 'Lounge'],
    ] as const) {
      go(url);
      expect(currentTab()).toBe(tab);
    }
  });

  it('the tabs lead into the open project, or to the general screens when none is open', () => {
    render(<NavApp />);
    const hrefs = () => within(tabs()).getAllByRole('link').map((a) => a.getAttribute('href'));
    expect(hrefs()).toEqual(['/home', '/projects', '/lounge']);
    go('/p/p1/review');
    expect(hrefs()).toEqual(['/p/p1/pages', '/p/p1/review', '/p/p1/lounge']);
  });

  it('follows URL changes made by the legacy page', () => {
    render(<NavApp />);
    go('/p/p1/review');
    act(() => {
      window.history.pushState({}, '', '/p/p1/tasks');
      window.dispatchEvent(new CustomEvent(URL_CHANGED_EVENT));
    });
    expect(within(nav()).getByRole('link', { name: 'Tasks' }).getAttribute('aria-current')).toBe('page');
  });

  it('a project name opens that project in the tab that is showing, and expands it', async () => {
    const user = userEvent.setup();
    render(<NavApp />);
    await user.click(within(nav()).getByRole('link', { name: 'Project One' }));
    expect(fake.navigations).toEqual(['/p/p1/pages']); // from Home: the Main tab
    expect(within(nav()).getByRole('link', { name: 'Tasks' })).toBeTruthy();
    go('/p/p1/review');
    await user.click(within(nav()).getByRole('link', { name: 'Project Two' }));
    expect(fake.navigations[fake.navigations.length - 1]).toBe('/p/p2/review');
    go('/lounge');
    await user.click(within(nav()).getByRole('link', { name: 'Project One' }));
    expect(fake.navigations[fake.navigations.length - 1]).toBe('/p/p1/lounge');
  });

  it('lists Tasks under a project only with task access', async () => {
    const user = userEvent.setup();
    render(<NavApp />);
    await user.click(screen.getByRole('button', { name: 'Expand Project One' }));
    await user.click(screen.getByRole('button', { name: 'Expand Project Two' }));
    expect(screen.getAllByRole('link', { name: 'Tasks' })).toHaveLength(1); // Project Two has no task access
    await user.click(screen.getByRole('link', { name: 'Tasks' }));
    expect(fake.navigations).toEqual(['/p/p1/tasks']);
  });

  it('opens the project of the current route and remembers open projects per user', async () => {
    const user = userEvent.setup();
    window.history.replaceState({}, '', '/p/p1/review');
    const first = render(<NavApp />);
    expect(screen.getAllByRole('link', { name: 'Tasks' })).toHaveLength(1);
    await user.click(screen.getByRole('button', { name: 'Expand Project Two' }));
    first.unmount();
    window.history.replaceState({}, '', '/home');
    render(<NavApp />);
    const stored = JSON.parse(localStorage.getItem('cl-nav-projects:' + fake.data.user!.id)!) as string[];
    expect(stored.sort()).toEqual(['p1', 'p2']);
    expect(screen.getByRole('button', { name: 'Collapse Project One' })).toBeTruthy();
  });

  it('renders registered sidebar sections per space', async () => {
    const user = userEvent.setup();
    registerSidebarSection('tree', ({ space }) => <div>{space.kind === 'personal' ? 'tree:personal' : `tree:${space.projectId}`}</div>);
    render(<NavApp />);
    expect(screen.getByText('tree:personal')).toBeTruthy();
    expect(screen.queryByText('tree:p1')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Expand Project One' }));
    expect(screen.getByText('tree:p1')).toBeTruthy();
    expect(screen.getByText('tree:personal')).toBeTruthy();
  });

  it('lets modified clicks through to the browser', async () => {
    const user = userEvent.setup();
    render(<NavApp />);
    const stopFollowing = (e: Event) => e.preventDefault(); // jsdom cannot open links
    document.addEventListener('click', stopFollowing);
    await user.keyboard('{Control>}');
    await user.click(screen.getByRole('link', { name: 'Personal' }));
    await user.keyboard('{/Control}');
    document.removeEventListener('click', stopFollowing);
    expect(fake.navigations).toEqual([]);
  });

  it('offers the project actions of the legacy UI and calls them', async () => {
    const user = userEvent.setup();
    render(<NavApp />);
    for (const label of ['Share link...', 'Set cover image...', 'Delete project...']) {
      await user.click(screen.getByRole('button', { name: 'Actions for Project One' }));
      await user.click(screen.getByRole('menuitem', { name: label }));
    }
    await user.click(screen.getByRole('button', { name: /New project/ }));
    expect(calls).toEqual(['share:p1', 'cover:p1', 'delete:p1:Project One', 'create']);
  });

  it('shows Access only to admins', async () => {
    const user = userEvent.setup();
    fake.data.user = { ...fake.data.user!, role: 'admin' };
    render(<NavApp />);
    await user.click(screen.getByRole('button', { name: 'Actions for Project One' }));
    await user.click(screen.getByRole('menuitem', { name: 'Access and members...' }));
    expect(calls).toEqual(['access']);
  });

  it('hides New project without the permission and re-renders when the list changes', () => {
    fake.projectTools!.canCreate = () => false;
    render(<NavApp />);
    expect(screen.queryByRole('button', { name: /New project/ })).toBeNull();
    fake.data.projects.push({ id: 'p3', name: 'Project Three', canTasks: true, isOwner: true });
    act(() => {
      window.dispatchEvent(new CustomEvent(PROJECTS_CHANGED_EVENT));
    });
    expect(screen.getByRole('link', { name: 'Project Three' })).toBeTruthy();
  });

  it('collapses to a strip and remembers it', async () => {
    const user = userEvent.setup();
    const first = render(<NavApp />);
    await user.click(screen.getByRole('button', { name: 'Hide sidebar' }));
    expect(screen.queryByRole('navigation', { name: 'Main' })).toBeNull();
    expect(localStorage.getItem('cl-sidebar-collapsed')).toBe('1');
    first.unmount();
    render(<NavApp />);
    expect(screen.queryByRole('navigation', { name: 'Main' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Show sidebar' }));
    expect(screen.getByRole('link', { name: 'Home' })).toBeTruthy();
    expect(localStorage.getItem('cl-sidebar-collapsed')).toBe('0');
  });

  it('renders nothing when nobody is signed in', () => {
    fake.data.user = null;
    const { container } = render(<NavApp />);
    expect(container.querySelector('aside')).toBeNull();
  });
});
