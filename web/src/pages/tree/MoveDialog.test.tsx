import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PageNode } from '../../api/pageTree';
import { setPlatform } from '../../platform';
import { createFakePlatform, type FakePlatform } from '../../testing/fakePlatform';
import { MoveDialog, moveDestinations } from './MoveDialog';
import { getPageStore, resetPageStores } from './pageStore';

const node = (id: string, parentId: string | null, sortOrder: number): PageNode => ({
  id,
  parentId,
  title: id,
  icon: null,
  sortOrder,
  kind: 'page',
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const PREVIEW_PATH = '/api/pages/a/move-preview?space=p%3Aspot';

let fake: FakePlatform;

beforeEach(() => {
  fake = createFakePlatform({
    projects: [
      { id: 'spot', name: 'Spot', canTasks: true, isOwner: false },
      { id: 'ro', name: 'Read only', canTasks: false, isOwner: false },
    ],
  });
  setPlatform(fake);
  fake.routes['GET /api/spaces/me/pages'] = () => json([node('a', null, 0), node('a1', 'a', 0)]);
  fake.routes[`GET ${PREVIEW_PATH}`] = () =>
    json({
      from: 'me',
      to: 'p:spot',
      subPages: 1,
      gain: { count: 2, names: ['ana', 'ben'] },
      lose: { count: 0, names: [] },
      limitedViews: [],
    });
});

afterEach(() => {
  cleanup();
  setPlatform(null);
  resetPageStores();
});

describe('moveDestinations', () => {
  it('offers the personal space and projects with task access, never the current space', () => {
    expect(moveDestinations('me').map((d) => d.key)).toEqual(['p:spot']);
    expect(moveDestinations('p:spot').map((d) => d.key)).toEqual(['me']);
  });

  it('offers no project to a viewer', () => {
    fake.data.user = { id: 'u1', username: 'V', role: 'viewer' };
    expect(moveDestinations('p:spot').map((d) => d.key)).toEqual(['me']);
    expect(moveDestinations('me')).toEqual([]);
  });
});

describe('MoveDialog', () => {
  it('shows who gains access and moves only after the user confirms', async () => {
    const onMoved = vi.fn();
    fake.routes['POST /api/pages/a/move'] = () =>
      json({ ...node('a', null, 0), space: 'p:spot', canEdit: true, needsImport: false, archived: false });
    getPageStore('me').acquire(); // the sidebar tree holds the store in the app
    render(<MoveDialog open onClose={() => {}} from="me" pageId="a" title="Plan" onMoved={onMoved} />);
    const user = userEvent.setup();
    // Spot is the only destination: it is selected and the warning loads
    const warning = await screen.findByTestId('move-warning');
    expect(warning.textContent).toContain('Everyone in Spot will be able to see this page and its 1 sub-page.');
    expect(warning.textContent).toContain('2 people who cannot see it now will gain access: ana, ben.');
    expect(fake.fetchCalls.some((c) => c.path === '/api/pages/a/move')).toBe(false);

    await user.click(screen.getByRole('button', { name: 'Move page' }));
    await waitFor(() => expect(onMoved).toHaveBeenCalled());
    expect(onMoved.mock.calls[0]![1]).toBe('p:spot');
    expect(onMoved.mock.calls[0]![2]).toEqual(['a', 'a1']);
  });

  it('cancel does not move anything', async () => {
    const onClose = vi.fn();
    render(<MoveDialog open onClose={onClose} from="me" pageId="a" title="Plan" />);
    await screen.findByTestId('move-warning');
    await userEvent.setup().click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onClose).toHaveBeenCalled();
    expect(fake.fetchCalls.some((c) => c.path === '/api/pages/a/move')).toBe(false);
  });

  it('cannot move when the preview fails', async () => {
    fake.routes[`GET ${PREVIEW_PATH}`] = () => json({ detail: 'Access denied' }, 403);
    render(<MoveDialog open onClose={() => {}} from="me" pageId="a" title="Plan" />);
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Move page' }) as HTMLButtonElement).disabled).toBe(true);
  });
});
