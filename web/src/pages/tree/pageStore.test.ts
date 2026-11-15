import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PageInfo, PageNode } from '../../api/pageTree';
import { setPlatform } from '../../platform';
import { createFakePlatform, type FakePlatform } from '../../testing/fakePlatform';
import { getPageStore, PageStore, resetPageStores } from './pageStore';

const node = (id: string, parentId: string | null, sortOrder: number, title = id): PageNode => ({
  id,
  parentId,
  title,
  icon: null,
  sortOrder,
  kind: 'page',
});

const info = (n: PageNode, extra: Partial<PageInfo> = {}): PageInfo => ({
  ...n,
  space: 'me',
  canEdit: true,
  needsImport: false,
  archived: false,
  ...extra,
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

let fake: FakePlatform;
let server: PageNode[];
let listCalls: () => number;

/** Serve `server` as the page list of the personal space. */
function serveList(key = 'me') {
  let calls = 0;
  fake.routes[`GET /api/spaces/${key}/pages`] = () => {
    calls += 1;
    return json(server);
  };
  listCalls = () => calls;
}

async function settle() {
  await vi.advanceTimersByTimeAsync(0);
}

beforeEach(() => {
  vi.useFakeTimers();
  fake = createFakePlatform();
  setPlatform(fake);
  server = [node('a', null, 0), node('b', null, 1), node('a1', 'a', 0)];
  serveList();
});

afterEach(() => {
  vi.useRealTimers();
  setPlatform(null);
  resetPageStores();
});

describe('loading', () => {
  it('loads the flat list and builds the tree', async () => {
    const store = new PageStore('me');
    store.acquire();
    expect(store.snapshot().status).toBe('loading');
    await settle();
    const snap = store.snapshot();
    expect(snap.status).toBe('ready');
    expect(snap.model.roots.map((n) => n.page.id)).toEqual(['a', 'b']);
    expect(snap.model.byId.get('a')!.children.map((n) => n.page.id)).toEqual(['a1']);
  });

  it('shares one instance per space', () => {
    expect(getPageStore('me')).toBe(getPageStore('me'));
    expect(getPageStore('p:p1')).not.toBe(getPageStore('me'));
  });

  it('loads once for several holders', async () => {
    const store = new PageStore('me');
    store.acquire();
    store.acquire();
    await settle();
    expect(listCalls()).toBe(1);
  });

  it('reports an error when nothing could be loaded', async () => {
    fake.routes['GET /api/spaces/me/pages'] = () => json({ detail: 'boom' }, 500);
    const store = new PageStore('me');
    store.acquire();
    await settle();
    expect(store.snapshot().status).toBe('error');
  });

  it('watches a project space while held, and lets go afterwards', async () => {
    fake.routes['GET /api/spaces/p:p1/pages'] = () => json([]);
    const store = new PageStore('p:p1');
    const release = store.acquire();
    await settle();
    expect(fake.watches[fake.watches.length - 1]).toEqual({ slot: 'pages:p:p1', target: { projects: ['p1'] } });
    release();
    expect(fake.watches[fake.watches.length - 1]).toEqual({ slot: 'pages:p:p1', target: null });
  });

  it('does not watch the personal space', async () => {
    const store = new PageStore('me');
    store.acquire();
    await settle();
    expect(fake.watches).toEqual([]);
  });
});

describe('live events', () => {
  it('refetches after a page_changed event and shows the change', async () => {
    const store = new PageStore('me', { debounceMs: 100 });
    store.acquire();
    await settle();
    server = [...server, node('c', null, 2)];
    fake.emit('page_changed', { pageId: 'c', change: 'created' });
    await vi.advanceTimersByTimeAsync(150);
    expect(store.snapshot().model.roots.map((n) => n.page.id)).toEqual(['a', 'b', 'c']);
  });

  it('coalesces a burst of events into one request', async () => {
    const store = new PageStore('me', { debounceMs: 100 });
    store.acquire();
    await settle();
    expect(listCalls()).toBe(1);
    for (let i = 0; i < 6; i++) {
      fake.emit('page_changed', { pageId: 'a', change: 'renamed' });
      await vi.advanceTimersByTimeAsync(30);
    }
    await vi.advanceTimersByTimeAsync(200);
    expect(listCalls()).toBe(2);
  });

  it('a project store ignores events of other projects and of the personal space', async () => {
    fake.routes['GET /api/spaces/p:p1/pages'] = () => json([]);
    const store = new PageStore('p:p1', { debounceMs: 50 });
    store.acquire();
    await settle();
    fake.emit('page_changed', { pageId: 'x', change: 'created', project: 'other' });
    fake.emit('page_changed', { pageId: 'x', change: 'created' });
    await vi.advanceTimersByTimeAsync(200);
    expect(fake.fetchCalls.filter((c) => c.path === '/api/spaces/p:p1/pages')).toHaveLength(1);
    fake.emit('page_changed', { pageId: 'x', change: 'created', project: 'p1' });
    await vi.advanceTimersByTimeAsync(200);
    expect(fake.fetchCalls.filter((c) => c.path === '/api/spaces/p:p1/pages')).toHaveLength(2);
  });

  it('the personal store ignores project events', async () => {
    const store = new PageStore('me', { debounceMs: 50 });
    store.acquire();
    await settle();
    fake.emit('page_changed', { pageId: 'x', change: 'created', project: 'p1' });
    await vi.advanceTimersByTimeAsync(200);
    expect(listCalls()).toBe(1);
  });

  it('refetches when the watch is confirmed and after a resync', async () => {
    fake.routes['GET /api/spaces/p:p1/pages'] = () => json([]);
    const store = new PageStore('p:p1', { debounceMs: 50 });
    store.acquire();
    await settle();
    const count = () => fake.fetchCalls.filter((c) => c.path === '/api/spaces/p:p1/pages').length;
    fake.emit('watching', { projects: ['p1'] });
    await vi.advanceTimersByTimeAsync(100);
    expect(count()).toBe(2);
    fake.emit('watching', { projects: ['other'] });
    await vi.advanceTimersByTimeAsync(100);
    expect(count()).toBe(2);
    fake.emit('resync');
    await vi.advanceTimersByTimeAsync(100);
    expect(count()).toBe(3);
  });

  it('stops listening when the last holder lets go', async () => {
    const store = new PageStore('me', { debounceMs: 50 });
    const release = store.acquire();
    await settle();
    release();
    fake.emit('page_changed', { pageId: 'a', change: 'renamed' });
    await vi.advanceTimersByTimeAsync(200);
    expect(listCalls()).toBe(1);
  });

  it('waits for an own change in flight instead of overwriting it', async () => {
    const store = new PageStore('me', { debounceMs: 50 });
    store.acquire();
    await settle();
    let finish!: () => void;
    fake.routes['PATCH /api/pages/a'] = () =>
      new Promise<Response>((resolve) => {
        finish = () => resolve(json(info(node('a', null, 0, 'New'))));
      }) as unknown as Response;
    const done = store.rename('a', 'New');
    fake.emit('page_changed', { pageId: 'a', change: 'renamed' });
    await vi.advanceTimersByTimeAsync(200);
    // The server list still says "a": it must not replace the optimistic title
    expect(store.snapshot().model.byId.get('a')!.page.title).toBe('New');
    expect(listCalls()).toBe(1);
    server = server.map((p) => (p.id === 'a' ? { ...p, title: 'New' } : p));
    finish();
    await done;
    await vi.advanceTimersByTimeAsync(100);
    expect(listCalls()).toBe(2);
    expect(store.snapshot().model.byId.get('a')!.page.title).toBe('New');
  });
});

describe('own changes', () => {
  it('rename shows at once and sends a PATCH', async () => {
    const store = new PageStore('me');
    store.acquire();
    await settle();
    fake.routes['PATCH /api/pages/a'] = () => json(info(node('a', null, 0, 'Renamed')));
    const done = store.rename('a', '  Renamed ');
    expect(store.snapshot().model.byId.get('a')!.page.title).toBe('Renamed');
    expect(await done).toBe(true);
    const call = fake.fetchCalls.find((c) => c.init?.method === 'PATCH')!;
    expect(JSON.parse(call.init!.body as string)).toEqual({ title: '  Renamed ' });
  });

  it('rolls back a rename the server refuses, with a toast', async () => {
    const store = new PageStore('me');
    store.acquire();
    await settle();
    fake.routes['PATCH /api/pages/a'] = () => json({ detail: 'Access denied' }, 403);
    const done = store.rename('a', 'Nope');
    expect(store.snapshot().model.byId.get('a')!.page.title).toBe('Nope');
    expect(await done).toBe(false);
    expect(store.snapshot().model.byId.get('a')!.page.title).toBe('a');
    expect(fake.toasts).toEqual([{ kind: 'error', message: 'Could not rename the page: Access denied' }]);
  });

  it('a blank title becomes Untitled, as on the server', async () => {
    const store = new PageStore('me');
    store.acquire();
    await settle();
    fake.routes['PATCH /api/pages/a'] = () => json(info(node('a', null, 0, 'Untitled')));
    const done = store.rename('a', '   ');
    expect(store.snapshot().model.byId.get('a')!.page.title).toBe('Untitled');
    await done;
  });

  it('move shows the new place at once and rolls back on failure', async () => {
    const store = new PageStore('me');
    store.acquire();
    await settle();
    fake.routes['PATCH /api/pages/b'] = () => json({ detail: 'Parent page not found' }, 400);
    const done = store.move('b', 'a', 5);
    const moved = store.snapshot().model;
    expect(moved.byId.get('a')!.children.map((n) => n.page.id)).toEqual(['a1', 'b']);
    expect(await done).toBe(false);
    const back = store.snapshot().model;
    expect(back.roots.map((n) => n.page.id)).toEqual(['a', 'b']);
    expect(back.byId.get('b')!.page.sortOrder).toBe(1);
    expect(fake.toasts[0]!.message).toContain('Could not move the page');
  });

  it('create adds the page and returns it', async () => {
    const store = new PageStore('me');
    store.acquire();
    await settle();
    fake.routes['POST /api/spaces/me/pages'] = () => json(info(node('n', 'a', 1, 'Untitled')));
    const created = await store.create('a');
    expect(created!.id).toBe('n');
    const call = fake.fetchCalls.find((c) => c.init?.method === 'POST')!;
    expect(JSON.parse(call.init!.body as string)).toEqual({ parentId: 'a' });
    expect(store.snapshot().model.byId.get('a')!.children.map((n) => n.page.id)).toEqual(['a1', 'n']);
  });

  it('create failure gives a toast and null', async () => {
    const store = new PageStore('me');
    store.acquire();
    await settle();
    fake.routes['POST /api/spaces/me/pages'] = () => json({ detail: 'Access denied' }, 403);
    expect(await store.create()).toBeNull();
    expect(fake.toasts[0]).toEqual({ kind: 'error', message: 'Could not create the page: Access denied' });
  });

  it('archive removes the subtree at once; a failure puts it back', async () => {
    const store = new PageStore('me');
    store.acquire();
    await settle();
    fake.routes['PATCH /api/pages/a'] = () => json({ detail: 'nope' }, 500);
    const done = store.archive('a');
    expect([...store.snapshot().model.byId.keys()]).toEqual(['b']);
    expect(await done).toBe(false);
    expect([...store.snapshot().model.byId.keys()].sort()).toEqual(['a', 'a1', 'b']);
    expect(fake.toasts[0]!.message).toContain('Could not archive the page');
  });

  it('archive success keeps the subtree gone and sends archived: true', async () => {
    const store = new PageStore('me');
    store.acquire();
    await settle();
    fake.routes['PATCH /api/pages/a'] = () => json(info(node('a', null, 0), { archived: true }));
    expect(await store.archive('a')).toBe(true);
    expect([...store.snapshot().model.byId.keys()]).toEqual(['b']);
    const call = fake.fetchCalls.find((c) => c.init?.method === 'PATCH')!;
    expect(JSON.parse(call.init!.body as string)).toEqual({ archived: true });
  });
});

describe('archived pages', () => {
  const archivedList = [node('x', null, 0), node('x1', 'x', 0), node('y', null, 1)];

  beforeEach(() => {
    fake.routes['GET /api/spaces/me/pages?archived=1'] = () => json(archivedList);
  });

  it('loads the archived list only when wanted', async () => {
    const store = new PageStore('me');
    store.acquire();
    await settle();
    expect(store.snapshot().archived).toBeNull();
    const release = store.wantArchived();
    await settle();
    expect(store.snapshot().archived!.map((p) => p.id)).toEqual(['x', 'x1', 'y']);
    expect(store.snapshot().archivedModel.roots.map((n) => n.page.id)).toEqual(['x', 'y']);
    release();
  });

  it('restore takes the page and its sub-pages out of the list and refetches the tree', async () => {
    const store = new PageStore('me');
    store.acquire();
    const release = store.wantArchived();
    await settle();
    fake.routes['PATCH /api/pages/x'] = () => json(info(node('x', null, 0)));
    const before = listCalls();
    const done = store.restore('x');
    expect(store.snapshot().archived!.map((p) => p.id)).toEqual(['y']);
    expect(await done).toBe(true);
    await settle();
    expect(listCalls()).toBe(before + 1);
    release();
  });

  it('a failed restore puts the page back', async () => {
    const store = new PageStore('me');
    store.acquire();
    store.wantArchived();
    await settle();
    fake.routes['PATCH /api/pages/x'] = () => json({ detail: 'nope' }, 500);
    expect(await store.restore('x')).toBe(false);
    expect(store.snapshot().archived!.map((p) => p.id).sort()).toEqual(['x', 'x1', 'y']);
  });

  it('delete forever asks first and does nothing when declined', async () => {
    const store = new PageStore('me');
    store.acquire();
    store.wantArchived();
    await settle();
    fake.confirmAnswer = false;
    expect(await store.deleteForever('y', 'y')).toBe(false);
    expect(fake.confirmations[0]!.opts).toMatchObject({ danger: true });
    expect(store.snapshot().archived!.map((p) => p.id)).toContain('y');
    expect(fake.fetchCalls.some((c) => c.init?.method === 'DELETE')).toBe(false);
  });

  it('delete forever removes the subtree; a failure restores the list', async () => {
    const store = new PageStore('me');
    store.acquire();
    store.wantArchived();
    await settle();
    fake.routes['DELETE /api/pages/x'] = () => json({ success: true });
    expect(await store.deleteForever('x', 'x')).toBe(true);
    expect(store.snapshot().archived!.map((p) => p.id)).toEqual(['y']);
    fake.routes['DELETE /api/pages/y'] = () => json({ detail: 'nope' }, 500);
    expect(await store.deleteForever('y', 'y')).toBe(false);
    expect(store.snapshot().archived!.map((p) => p.id)).toEqual(['y']);
  });
});
