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
const tabs = () => screen.getByRole('navigation', { name: 'Project' });

describe('Sidebar', () => {
  it('lists Search, Home, Personal, the projects, New project and Lounge outside a project', () => {
    render(<NavApp />);
    expect(within(nav()).getByRole('button', { name: /Search/ })).toBeTruthy();
    expect(within(nav()).getByRole('link', { name: 'Home' })).toBeTruthy();
    expect(within(nav()).getByRole('link', { name: 'Personal' })).toBeTruthy();
    expect(within(nav()).getByRole('link', { name: 'Project One' })).toBeTruthy();
    expect(within(nav()).getByRole('link', { name: 'Project Two' })).toBeTruthy();
    expect(within(nav()).getByRole('button', { name: /New project/ })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Lounge' })).toBeTruthy();
  });

  it('highlights the item of the route: Home, the tabs of a project, Lounge', () => {
    render(<NavApp />);
    expect(screen.getByRole('link', { name: 'Home' }).getAttribute('aria-current')).toBe('page');
    expect(screen.queryByRole('navigation', { name: 'Project' })).toBeNull(); // no tabs outside a project
    go('/p/p1/review');
    expect(within(tabs()).getByRole('link', { name: 'Review' }).getAttribute('aria-current')).toBe('page');
    expect(screen.getByRole('link', { name: 'Home' }).getAttribute('aria-current')).toBeNull();
    go('/p/p1/tasks');
    expect(within(tabs()).getByRole('link', { name: 'Tasks' }).getAttribute('aria-current')).toBe('page');
    expect(within(tabs()).getByRole('link', { name: 'Review' }).getAttribute('aria-current')).toBeNull();
    go('/p/p1/pages');
    expect(within(tabs()).getByRole('link', { name: 'Pages' }).getAttribute('aria-current')).toBe('page');
    go('/p/p1/page/abc');
    expect(within(tabs()).getByRole('link', { name: 'Pages' }).getAttribute('aria-current')).toBe('page');
    go('/p/p1/lounge');
    expect(within(tabs()).getByRole('link', { name: 'Lounge' }).getAttribute('aria-current')).toBe('page');
    go('/lounge');
    expect(screen.queryByRole('navigation', { name: 'Project' })).toBeNull();
    expect(screen.getByRole('link', { name: 'Lounge' }).getAttribute('aria-current')).toBe('page');
  });

  it('follows URL changes made by the legacy page', () => {
    render(<NavApp />);
    go('/p/p1/review');
    act(() => {
      window.history.pushState({}, '', '/p/p1/tasks');
      window.dispatchEvent(new CustomEvent(URL_CHANGED_EVENT));
    });
    expect(within(tabs()).getByRole('link', { name: 'Tasks' }).getAttribute('aria-current')).toBe('page');
  });

  it('opens a project on its Review from the list, and the tabs navigate inside it', async () => {
    const user = userEvent.setup();
    render(<NavApp />);
    await user.click(within(nav()).getByRole('link', { name: 'Project One' }));
    expect(fake.navigations).toEqual(['/p/p1/review']);
    expect(within(tabs()).getByText('Project One')).toBeTruthy();
    await user.click(within(tabs()).getByRole('link', { name: 'Tasks' }));
    await user.click(within(tabs()).getByRole('link', { name: 'Pages' }));
    await user.click(within(tabs()).getByRole('link', { name: 'Lounge' }));
    expect(fake.navigations.slice(1)).toEqual(['/p/p1/tasks', '/p/p1/pages', '/p/p1/lounge']);
    await user.click(within(tabs()).getByRole('link', { name: 'Projects' }));
    expect(fake.navigations[fake.navigations.length - 1]).toBe('/projects');
  });

  it('has no Tasks tab without task access', () => {
    window.history.replaceState({}, '', '/p/p2/review');
    render(<NavApp />);
    expect(within(tabs()).getAllByRole('link').map((a) => a.textContent)).toEqual(['Projects', 'Review', 'Pages', 'Lounge']);
  });

  it('inside a project the sidebar shows that project only', () => {
    registerSidebarSection('tree', ({ space }) => <div>{space.kind === 'personal' ? 'tree:personal' : `tree:${space.projectId}`}</div>);
    render(<NavApp />);
    expect(screen.getByText('tree:personal')).toBeTruthy();
    expect(screen.queryByText('tree:p1')).toBeNull();
    go('/p/p1/review');
    expect(screen.getByText('tree:p1')).toBeTruthy();
    expect(screen.queryByText('tree:personal')).toBeNull();
    expect(within(nav()).queryByRole('link', { name: 'Project Two' })).toBeNull();
    expect(within(nav()).getByRole('link', { name: 'All projects' })).toBeTruthy();
    expect(within(nav()).getByRole('link', { name: 'Project One' }).getAttribute('href')).toBe('/p/p1/pages');
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

  it('offers the project actions of the legacy UI in the header and calls them', async () => {
    const user = userEvent.setup();
    window.history.replaceState({}, '', '/p/p1/review');
    render(<NavApp />);
    for (const label of ['Share link...', 'Set cover image...', 'Delete project...']) {
      await user.click(screen.getByRole('button', { name: 'Actions for Project One' }));
      await user.click(screen.getByRole('menuitem', { name: label }));
    }
    go('/home');
    await user.click(screen.getByRole('button', { name: /New project/ }));
    expect(calls).toEqual(['share:p1', 'cover:p1', 'delete:p1:Project One', 'create']);
  });

  it('shows Access only to admins', async () => {
    const user = userEvent.setup();
    fake.data.user = { ...fake.data.user!, role: 'admin' };
    window.history.replaceState({}, '', '/p/p1/review');
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
