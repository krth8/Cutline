import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NAVIGATE_EVENT, setPlatform } from '../platform';
import { createFakePlatform, type FakePlatform } from '../testing/fakePlatform';
import { clearRegistry, registerRouteView } from './registry';
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
  it('shows a placeholder for a route without a registered view', () => {
    render(<Shell />);
    expect(screen.getByRole('heading', { name: 'Personal space' })).toBeTruthy();
    go('/lounge');
    expect(screen.getByRole('heading', { name: 'Lounge' })).toBeTruthy();
  });

  it('follows route changes', () => {
    window.history.replaceState({}, '', '/p/p2/pages');
    render(<Shell />);
    expect(screen.getByRole('heading', { name: 'Project Two: Pages' })).toBeTruthy();
    go('/me');
    expect(screen.getByRole('heading', { name: 'Personal space' })).toBeTruthy();
  });

  it('has no sidebar of its own (the sidebar is mounted separately)', () => {
    render(<Shell />);
    expect(screen.queryByTestId('cl-sidebar')).toBeNull();
  });

  it('says so when nobody is signed in', () => {
    fake.data.user = null;
    render(<Shell />);
    expect(screen.getByText('Not signed in')).toBeTruthy();
    expect(screen.queryByRole('navigation')).toBeNull();
  });

  describe('registry', () => {
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
