import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NAVIGATE_EVENT, setPlatform } from '../platform';
import { createFakePlatform, type FakePlatform } from '../testing/fakePlatform';
import { clearRegistry, registerRouteView, registerSidebarSection } from './registry';
import { Shell } from './Shell';

let fake: FakePlatform;

function go(url: string) {
  act(() => {
    window.history.pushState({}, '', url);
    window.dispatchEvent(new CustomEvent(NAVIGATE_EVENT));
  });
}

beforeEach(() => {
  fake = createFakePlatform({
    projects: [
      { id: 'p1', name: 'Project One', canTasks: true, isOwner: true },
      { id: 'p2', name: 'Project Two', canTasks: true, isOwner: false },
    ],
  });
  // The shell navigates through the platform; mimic the legacy one (history + event)
  fake.navigate = (route) => {
    fake.navigations.push(route);
    go(route);
  };
  setPlatform(fake);
  localStorage.clear();
  window.history.replaceState({}, '', '/me');
});

afterEach(() => {
  setPlatform(null);
  clearRegistry();
});

describe('Shell', () => {
  it('lists Home, Personal space and the projects', () => {
    render(<Shell />);
    const nav = screen.getByRole('navigation', { name: 'Pages' });
    expect(within(nav).getByRole('link', { name: 'Home' })).toBeTruthy();
    expect(within(nav).getByRole('link', { name: 'Personal space' })).toBeTruthy();
    expect(within(nav).getByRole('button', { name: 'Project One' })).toBeTruthy();
    expect(within(nav).getByRole('button', { name: 'Project Two' })).toBeTruthy();
  });

  it('highlights the active item and shows a placeholder for the route', () => {
    render(<Shell />);
    expect(screen.getByRole('link', { name: 'Personal space' }).getAttribute('aria-current')).toBe('page');
    expect(screen.getByRole('link', { name: 'Home' }).getAttribute('aria-current')).toBeNull();
    expect(screen.getByRole('heading', { name: 'Personal space' })).toBeTruthy();
  });

  it('expands a project to Review and Pages and navigates', async () => {
    const user = userEvent.setup();
    render(<Shell />);
    expect(screen.queryByRole('link', { name: 'Review' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Project One' }));
    await user.click(screen.getByRole('link', { name: 'Review' }));
    expect(fake.navigations).toEqual(['/p/p1/review']);
    await user.click(screen.getByRole('link', { name: 'Pages' }));
    expect(fake.navigations[fake.navigations.length - 1]).toBe('/p/p1/pages');
    expect(screen.getByRole('link', { name: 'Pages' }).getAttribute('aria-current')).toBe('page');
  });

  it('opens the project of the current route and follows route changes', () => {
    window.history.replaceState({}, '', '/p/p2/pages');
    render(<Shell />);
    expect(screen.getByRole('link', { name: 'Pages' }).getAttribute('aria-current')).toBe('page');
    expect(screen.getByRole('heading', { name: 'Project Two: Pages' })).toBeTruthy();
    go('/me');
    expect(screen.getByRole('heading', { name: 'Personal space' })).toBeTruthy();
  });

  it('is operable with the keyboard', async () => {
    const user = userEvent.setup();
    render(<Shell />);
    const toggle = screen.getByRole('button', { name: 'Project One' });
    toggle.focus();
    await user.keyboard('{Enter}');
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    await user.keyboard('{Tab}');
    expect((document.activeElement as HTMLElement).textContent).toBe('Review');
    await user.keyboard('{Enter}');
    expect(fake.navigations).toEqual(['/p/p1/review']);
  });

  it('lets modified clicks through to the browser', async () => {
    const user = userEvent.setup();
    render(<Shell />);
    const stopFollowing = (e: Event) => e.preventDefault(); // jsdom cannot open links
    document.addEventListener('click', stopFollowing);
    await user.keyboard('{Control>}');
    await user.click(screen.getByRole('link', { name: 'Home' }));
    await user.keyboard('{/Control}');
    document.removeEventListener('click', stopFollowing);
    expect(fake.navigations).toEqual([]);
  });

  it('collapses the sidebar and remembers it', async () => {
    const user = userEvent.setup();
    const first = render(<Shell />);
    await user.click(screen.getByRole('button', { name: 'Hide sidebar' }));
    expect(screen.queryByRole('link', { name: 'Home' })).toBeNull();
    expect(localStorage.getItem('cl-sidebar-collapsed')).toBe('1');
    first.unmount();
    render(<Shell />);
    expect(screen.queryByRole('link', { name: 'Home' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Show sidebar' }));
    expect(screen.getByRole('link', { name: 'Home' })).toBeTruthy();
    expect(localStorage.getItem('cl-sidebar-collapsed')).toBe('0');
  });

  it('says so when nobody is signed in', () => {
    fake.data.user = null;
    render(<Shell />);
    expect(screen.getByText('Not signed in')).toBeTruthy();
    expect(screen.queryByRole('navigation')).toBeNull();
  });

  describe('registry', () => {
    it('renders registered sidebar sections per space', async () => {
      const user = userEvent.setup();
      registerSidebarSection('tree', ({ space }) => (
        <div>{space.kind === 'personal' ? 'tree:personal' : `tree:${space.projectId}`}</div>
      ));
      render(<Shell />);
      expect(screen.getByText('tree:personal')).toBeTruthy();
      expect(screen.queryByText('tree:p1')).toBeNull();
      await user.click(screen.getByRole('button', { name: 'Project One' }));
      expect(screen.getByText('tree:p1')).toBeTruthy();
    });

    it('renders a registered route view and picks up late registrations', () => {
      window.history.replaceState({}, '', '/p/p1/page/abc');
      render(<Shell />);
      expect(screen.getByTestId('cl-placeholder')).toBeTruthy();
      let unregister = () => {};
      act(() => {
        unregister = registerRouteView('projectPage', ({ route }) => <div>page {route.pageId} of {route.projectId}</div>);
      });
      expect(screen.getByText('page abc of p1')).toBeTruthy();
      act(() => unregister());
      expect(screen.getByTestId('cl-placeholder')).toBeTruthy();
    });
  });
});
