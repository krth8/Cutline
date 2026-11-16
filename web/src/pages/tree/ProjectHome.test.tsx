import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setPlatform } from '../../platform';
import { createFakePlatform, type FakePlatform } from '../../testing/fakePlatform';
import { resetPageStores } from './pageStore';
import { ProjectHome } from './ProjectHome';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const page = (id: string, system: string | null = null) => ({ id, parentId: null, title: id, icon: null, sortOrder: 0, kind: 'page', system });

let fake: FakePlatform;
let asked: string[];

beforeEach(() => {
  fake = createFakePlatform();
  setPlatform(fake);
  asked = [];
  fake.routes['GET /api/spaces/p:p1/pages?archived=1'] = () => json([]);
});
afterEach(() => {
  cleanup();
  setPlatform(null);
  resetPageStores();
});

describe('ProjectHome', () => {
  it('opens the dashboard page of the project', async () => {
    fake.routes['GET /api/spaces/p:p1/pages'] = () => json([page('D', 'dashboard'), page('Brief')]);
    fake.routes['GET /api/pages/D'] = () => {
      asked.push('D');
      return json({ detail: 'Page not found' }, 404);
    };
    render(<ProjectHome route={{ kind: 'projectPages', projectId: 'p1' }} />);
    // the page view takes over (here the server says the page is gone, which only a page view reports)
    expect(await screen.findByText('This page is not available')).toBeTruthy();
    expect(asked).toEqual(['D']);
    expect(screen.queryByTestId('space-overview')).toBeNull();
  });

  it('falls back to the cards of the pages when the project has no dashboard', async () => {
    fake.routes['GET /api/spaces/p:p1/pages'] = () => json([page('Brief')]);
    render(<ProjectHome route={{ kind: 'projectPages', projectId: 'p1' }} />);
    expect(await screen.findByTestId('space-overview')).toBeTruthy();
    expect(screen.getByRole('link', { name: /Brief/ })).toBeTruthy();
  });
});
