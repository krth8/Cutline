import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PageInfo, PageNode } from '../../api/pageTree';
import { setPlatform } from '../../platform';
import type { Space } from '../../shell/registry';
import { createFakePlatform, type FakePlatform } from '../../testing/fakePlatform';
import { PageView } from '../PageView';
import { resetPageStores } from '../tree/pageStore';
import { PageTree } from '../tree/PageTree';
import { HomeView } from './HomeView';
import { resetHome } from './homeStore';

const node = (id: string, sortOrder: number, title = id): PageNode => ({
  id,
  parentId: null,
  title,
  icon: null,
  sortOrder,
  kind: 'page',
});
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const info = (n: PageNode, extra: Partial<PageInfo> = {}): PageInfo => ({
  ...n,
  space: 'me',
  canEdit: true,
  needsImport: false,
  archived: false,
  ...extra,
});

let fake: FakePlatform;
/** What the fake server holds as the user's Home page. */
let home: string | null;

function puts(): unknown[] {
  return fake.fetchCalls.filter((c) => c.init?.method === 'PUT' && c.path === '/api/home').map((c) => JSON.parse(c.init!.body as string));
}

beforeEach(() => {
  localStorage.clear();
  fake = createFakePlatform();
  setPlatform(fake);
  home = null;
  const pages = [node('A', 0), node('B', 1)];
  fake.routes['GET /api/spaces/me/pages'] = () => json(pages);
  fake.routes['GET /api/spaces/me/pages?archived=1'] = () => json([]);
  fake.routes['GET /api/spaces/p:p1/pages'] = () => json([]);
  fake.routes['GET /api/spaces/p:p1/pages?archived=1'] = () => json([]);
  fake.routes['GET /api/pages/A'] = () => json(info(pages[0]!));
  fake.routes['GET /api/pages/B'] = () => json(info(pages[1]!));
  fake.routes['GET /api/pages/D'] = () => json(info(node('D', 2, 'My dashboard')));
  fake.routes['GET /api/pages/X'] = () => json(info(node('X', 0, 'Shared'), { space: 'p:p1' }));
  fake.routes['GET /api/home'] = () => json({ pageId: home });
  fake.routes['PUT /api/home'] = (_p: string, init?: RequestInit) => {
    home = (JSON.parse(init!.body as string) as { pageId: string }).pageId;
    return json({ pageId: home });
  };
  fake.routes['POST /api/home/open'] = () => {
    home = home ?? 'D';
    return json({ pageId: home, created: false });
  };
});

afterEach(() => {
  cleanup();
  setPlatform(null);
  resetPageStores();
  resetHome();
});

describe('Set as home in the page menu', () => {
  it('a personal page offers it, and choosing it sends the page id and hides the entry', async () => {
    const user = userEvent.setup();
    render(<PageView route={{ kind: 'mePage', pageId: 'B' }} />);
    await user.click(await screen.findByRole('button', { name: 'Page menu' }));
    await user.click(screen.getByRole('menuitem', { name: 'Set as home' }));
    await waitFor(() => expect(puts()).toEqual([{ pageId: 'B' }]));
    expect(fake.toasts.some((t) => t.kind === 'success')).toBe(true);
    await user.click(screen.getByRole('button', { name: 'Page menu' }));
    expect(screen.queryByRole('menuitem', { name: 'Set as home' })).toBeNull();
  });

  it('the current home page does not offer it', async () => {
    home = 'B';
    const user = userEvent.setup();
    render(<PageView route={{ kind: 'mePage', pageId: 'B' }} />);
    await screen.findByTestId('page-view');
    await waitFor(() => expect(fake.fetchCalls.some((c) => c.path === '/api/home')).toBe(true));
    await user.click(screen.getByRole('button', { name: 'Page menu' }));
    await waitFor(() => expect(screen.queryByRole('menuitem', { name: 'Set as home' })).toBeNull());
  });

  it('a project page never offers it', async () => {
    const user = userEvent.setup();
    render(<PageView route={{ kind: 'projectPage', projectId: 'p1', pageId: 'X' }} />);
    await user.click(await screen.findByRole('button', { name: 'Page menu' }));
    expect(screen.queryByRole('menuitem', { name: 'Set as home' })).toBeNull();
  });

  it('shows an error toast when the server refuses', async () => {
    fake.routes['PUT /api/home'] = () => json({ detail: 'no' }, 400);
    const user = userEvent.setup();
    render(<PageView route={{ kind: 'mePage', pageId: 'B' }} />);
    await user.click(await screen.findByRole('button', { name: 'Page menu' }));
    await user.click(screen.getByRole('menuitem', { name: 'Set as home' }));
    await waitFor(() => expect(fake.toasts.some((t) => t.kind === 'error')).toBe(true));
  });
});

describe('the page tree', () => {
  const personal: Space = { kind: 'personal' };
  const row = (name: string) => screen.getByRole('treeitem', { name: new RegExp(name) });

  it('marks the home page with a house and moves the mark after "Set as home"', async () => {
    home = 'A';
    render(<PageTree space={personal} route={{ kind: 'me' }} />);
    await screen.findByRole('treeitem', { name: /A/ });
    await waitFor(() => expect(within(row('A')).getByRole('img', { name: 'Home page' })).toBeTruthy());
    expect(within(row('B')).queryByRole('img', { name: 'Home page' })).toBeNull();

    fireEvent.contextMenu(row('B'));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Set as home' }));
    await waitFor(() => expect(puts()).toEqual([{ pageId: 'B' }]));
    await waitFor(() => expect(within(row('B')).getByRole('img', { name: 'Home page' })).toBeTruthy());
    expect(within(row('A')).queryByRole('img', { name: 'Home page' })).toBeNull();
  });

  it('the home page itself has no "Set as home" entry', async () => {
    home = 'A';
    render(<PageTree space={personal} route={{ kind: 'me' }} />);
    await waitFor(() => expect(within(row('A')).getByRole('img', { name: 'Home page' })).toBeTruthy());
    fireEvent.contextMenu(row('A'));
    await screen.findByRole('menuitem', { name: 'Rename' });
    expect(screen.queryByRole('menuitem', { name: 'Set as home' })).toBeNull();
  });
});

describe('HomeView', () => {
  it('asks the server for Home and shows that page', async () => {
    render(<HomeView />);
    const view = await screen.findByTestId('page-view');
    expect(view.getAttribute('data-page-id')).toBe('D');
    expect(fake.fetchCalls.some((c) => c.path === '/api/home/open' && c.init?.method === 'POST')).toBe(true);
  });

  it('follows a changed home page', async () => {
    render(<HomeView />);
    await screen.findByTestId('page-view');
    fake.emit('page_changed', { pageId: 'D', change: 'archived' });
    home = 'B';
    fake.emit('page_changed', { pageId: 'D', change: 'archived' });
    await waitFor(() => expect(screen.getByTestId('page-view').getAttribute('data-page-id')).toBe('B'));
  });

  it('offers a retry when Home cannot be opened', async () => {
    fake.routes['POST /api/home/open'] = () => json({ detail: 'x' }, 500);
    render(<HomeView />);
    expect(await screen.findByRole('button', { name: 'Try again' })).toBeTruthy();
  });
});
