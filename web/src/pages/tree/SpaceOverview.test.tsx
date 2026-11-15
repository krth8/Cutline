import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setPlatform } from '../../platform';
import { createFakePlatform, type FakePlatform } from '../../testing/fakePlatform';
import { resetPageStores } from './pageStore';
import { SpaceOverview } from './SpaceOverview';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const page = (id: string, parentId: string | null, sortOrder: number) => ({
  id, parentId, title: id, icon: null, sortOrder, kind: 'page',
});

let fake: FakePlatform;

beforeEach(() => {
  fake = createFakePlatform();
  setPlatform(fake);
  fake.routes['GET /api/spaces/p:p1/pages?archived=1'] = () => json([]);
});
afterEach(() => {
  cleanup();
  setPlatform(null);
  resetPageStores();
});

describe('SpaceOverview', () => {
  it('lists the top-level pages as cards with their sub-page count (no redirect)', async () => {
    fake.routes['GET /api/spaces/p:p1/pages'] = () => json([page('A', null, 0), page('A1', 'A', 0), page('B', null, 1)]);
    render(<SpaceOverview route={{ kind: 'projectPages', projectId: 'p1' }} />);
    expect(await screen.findByRole('link', { name: /A.*1 sub-page/ })).toBeTruthy();
    expect(screen.getByRole('link', { name: /B.*No sub-pages/ })).toBeTruthy();
    expect(fake.navigations).toEqual([]);
  });

  it('empty state offers to create the first page', async () => {
    const user = userEvent.setup();
    fake.routes['GET /api/spaces/p:p1/pages'] = () => json([]);
    fake.routes['POST /api/spaces/p:p1/pages'] = () => json({ ...page('N', null, 0), space: 'p:p1', canEdit: true, needsImport: false, archived: false });
    render(<SpaceOverview route={{ kind: 'projectPages', projectId: 'p1' }} />);
    await user.click(await screen.findByRole('button', { name: 'Create the first page' }));
    await waitFor(() => expect(fake.navigations).toEqual(['/p/p1/page/N']));
  });

  it('a viewer gets no create button', async () => {
    fake.data.user = { id: 'u', username: 'v', role: 'viewer' };
    fake.routes['GET /api/spaces/p:p1/pages'] = () => json([]);
    render(<SpaceOverview route={{ kind: 'projectPages', projectId: 'p1' }} />);
    expect(await screen.findByText('No pages yet.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /page/i })).toBeNull();
  });
});
