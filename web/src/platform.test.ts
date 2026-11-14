import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLegacyPlatform, getPlatform, NAVIGATE_EVENT, setPlatform, type Platform } from './platform';
import { createFakePlatform } from './testing/fakePlatform';

type W = Record<string, any>;
const w = window as unknown as W;

/** Stub of the legacy Live: records registrations like the real one (no unsubscribe). */
function stubLive() {
  const registered: Record<string, Array<(m: any) => void>> = {};
  const live = {
    on: vi.fn((type: string, fn: (m: any) => void) => {
      (registered[type] ??= []).push(fn);
    }),
    watch: vi.fn(),
  };
  w.Live = live;
  return { live, fire: (type: string, msg: any) => registered[type]?.forEach((fn) => fn(msg)) };
}

describe('legacy platform bridge', () => {
  let platform: Platform;

  beforeEach(() => {
    w.AppState = {
      adminUser: { id: 'u1', username: 'kris', role: 'editor', profileImage: '/profiles/u1.png' },
      projects: [
        { id: 'p1', name: 'One', canTasks: true, isOwner: false },
        { id: 'p2', name: 'Two', canTasks: false, isOwner: true },
      ],
      statuses: [{ id: 's1', name: 'Done', color: '#0f0', extra: 1 }],
    };
    platform = createLegacyPlatform();
  });

  afterEach(() => {
    for (const key of ['AppState', 'Live', 'Toast', 'Confirm', 'openSocket']) delete w[key];
    vi.restoreAllMocks();
  });

  describe('user()', () => {
    it('maps the logged-in user', () => {
      expect(platform.user()).toEqual({ id: 'u1', username: 'kris', role: 'editor', profileImage: '/profiles/u1.png' });
    });
    it('is null when nobody is logged in (guests included)', () => {
      w.AppState.adminUser = null;
      expect(platform.user()).toBeNull();
    });
    it('detects admins by role or flag', () => {
      w.AppState.adminUser.role = 'admin';
      expect(platform.user()?.role).toBe('admin');
      w.AppState.adminUser = { id: 'u2', username: 'x', isAdmin: true };
      expect(platform.user()?.role).toBe('admin');
    });
    it('omits profileImage when there is none', () => {
      w.AppState.adminUser = { id: 'u3', username: 'y', role: 'viewer', profileImage: null };
      expect(platform.user()).toEqual({ id: 'u3', username: 'y', role: 'viewer' });
    });
  });

  describe('fetch()', () => {
    it('goes through the (patched) window.fetch', async () => {
      const patched = vi.fn().mockResolvedValue(new Response('{}'));
      vi.stubGlobal('fetch', patched);
      window.fetch = patched;
      await platform.fetch('/api/x', { method: 'POST' });
      expect(patched).toHaveBeenCalledWith('/api/x', { method: 'POST' });
    });
  });

  describe('openSocket()', () => {
    it('delegates to the legacy openSocket', async () => {
      const socket = {} as WebSocket;
      w.openSocket = vi.fn().mockResolvedValue(socket);
      await expect(platform.openSocket('/ws/live')).resolves.toBe(socket);
      expect(w.openSocket).toHaveBeenCalledWith('/ws/live');
    });
    it('rejects clearly when the legacy page is missing', async () => {
      await expect(platform.openSocket('/ws/live')).rejects.toThrow(/openSocket/);
    });
  });

  describe('live.on()', () => {
    it('registers once per event type and fans out to all handlers', () => {
      const { live, fire } = stubLive();
      const a = vi.fn();
      const b = vi.fn();
      platform.live.on('task_updated', a);
      platform.live.on('task_updated', b);
      expect(live.on).toHaveBeenCalledTimes(1);
      fire('task_updated', { id: 1 });
      expect(a).toHaveBeenCalledWith({ id: 1 });
      expect(b).toHaveBeenCalledWith({ id: 1 });
    });
    it('unsubscribes only the given handler', () => {
      const { fire } = stubLive();
      const a = vi.fn();
      const b = vi.fn();
      const offA = platform.live.on('x', a);
      platform.live.on('x', b);
      offA();
      fire('x', {});
      expect(a).not.toHaveBeenCalled();
      expect(b).toHaveBeenCalledTimes(1);
    });
    it('keeps delivering to others when one handler throws', () => {
      const { fire } = stubLive();
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const good = vi.fn();
      platform.live.on('x', () => {
        throw new Error('boom');
      });
      platform.live.on('x', good);
      fire('x', {});
      expect(good).toHaveBeenCalled();
    });
    it('a handler may unsubscribe itself while being called', () => {
      const { fire } = stubLive();
      const other = vi.fn();
      const off = platform.live.on('x', () => off());
      platform.live.on('x', other);
      fire('x', {});
      expect(other).toHaveBeenCalledTimes(1);
    });
  });

  describe('live.watch()', () => {
    it('uses one derived legacy slot per project', () => {
      const { live } = stubLive();
      platform.live.watch('tasks', { projects: ['a', 'b'] });
      expect(live.watch).toHaveBeenCalledWith('pages:tasks:a', 'a');
      expect(live.watch).toHaveBeenCalledWith('pages:tasks:b', 'b');
    });
    it('releases projects that are no longer wanted', () => {
      const { live } = stubLive();
      platform.live.watch('tasks', { projects: ['a', 'b'] });
      live.watch.mockClear();
      platform.live.watch('tasks', { projects: ['b', 'c'] });
      expect(live.watch).toHaveBeenCalledWith('pages:tasks:a', null);
      expect(live.watch).toHaveBeenCalledWith('pages:tasks:c', 'c');
    });
    it('null clears everything this slot held, and not other slots', () => {
      const { live } = stubLive();
      platform.live.watch('s1', { projects: ['a'] });
      platform.live.watch('s2', { projects: ['z'] });
      live.watch.mockClear();
      platform.live.watch('s1', null);
      expect(live.watch).toHaveBeenCalledTimes(1);
      expect(live.watch).toHaveBeenCalledWith('pages:s1:a', null);
    });
    it('throws a descriptive error for allTasks until the server supports it', () => {
      stubLive();
      expect(() => platform.live.watch('dash', { allTasks: true })).toThrow(/allTasks.*S2/);
    });
    it('throws when Live is not loaded', () => {
      expect(() => platform.live.watch('x', null)).toThrow(/Live/);
    });
  });

  describe('toast() and confirm()', () => {
    it('forwards toasts by kind', () => {
      w.Toast = { info: vi.fn(), success: vi.fn(), error: vi.fn() };
      platform.toast('success', 'Saved');
      platform.toast('error', 'Nope');
      expect(w.Toast.success).toHaveBeenCalledWith('Saved');
      expect(w.Toast.error).toHaveBeenCalledWith('Nope');
    });
    it('maps confirm options to the legacy dialog', async () => {
      w.Confirm = { show: vi.fn().mockResolvedValue(true) };
      await expect(platform.confirm('Delete?', { danger: true, confirmLabel: 'Delete' })).resolves.toBe(true);
      expect(w.Confirm.show).toHaveBeenCalledWith({ message: 'Delete?', type: 'danger', confirmText: 'Delete' });
      await platform.confirm('Sure?');
      expect(w.Confirm.show).toHaveBeenLastCalledWith({ message: 'Sure?', type: 'default' });
    });
  });

  describe('navigate()', () => {
    it('pushes history and announces the change', () => {
      const seen = vi.fn();
      window.addEventListener(NAVIGATE_EVENT, seen);
      platform.navigate('/me/page/abc');
      window.removeEventListener(NAVIGATE_EVENT, seen);
      expect(window.location.pathname).toBe('/me/page/abc');
      expect(seen).toHaveBeenCalledTimes(1);
      expect((seen.mock.calls[0]![0] as CustomEvent).detail).toEqual({ route: '/me/page/abc' });
    });
  });

  describe('projects() and statuses()', () => {
    it('maps project access flags', () => {
      expect(platform.projects()).toEqual([
        { id: 'p1', name: 'One', canTasks: true, isOwner: false },
        { id: 'p2', name: 'Two', canTasks: false, isOwner: true },
      ]);
    });
    it('treats flag-less projects as full access for admins only', () => {
      w.AppState.projects = [{ id: 'p', name: 'P' }];
      expect(platform.projects()[0]).toMatchObject({ canTasks: false, isOwner: false });
      w.AppState.adminUser.role = 'admin';
      expect(platform.projects()[0]).toMatchObject({ canTasks: true, isOwner: true });
    });
    it('returns only the contract fields for statuses', () => {
      expect(platform.statuses()).toEqual([{ id: 's1', name: 'Done', color: '#0f0' }]);
    });
    it('returns empty lists when the legacy state is empty', () => {
      delete w.AppState;
      expect(platform.projects()).toEqual([]);
      expect(platform.statuses()).toEqual([]);
    });
  });

  describe('members()', () => {
    it('reads /api/projects/{id}/members and maps the fields', async () => {
      const patched = vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            members: [
              { id: 'u1', username: 'a', profileImage: '/p.png', role: 'admin', canTasks: true },
              { id: 'u2', username: 'b', profileImage: null, role: 'editor', canTasks: true },
            ],
          }),
        ),
      );
      window.fetch = patched;
      await expect(platform.members('p 1')).resolves.toEqual([
        { id: 'u1', username: 'a', profileImage: '/p.png' },
        { id: 'u2', username: 'b' },
      ]);
      expect(patched).toHaveBeenCalledWith('/api/projects/p%201/members', undefined);
    });
    it('throws on an error response', async () => {
      window.fetch = vi.fn().mockResolvedValue(new Response('{}', { status: 404 }));
      await expect(platform.members('nope')).rejects.toThrow(/404/);
    });
  });
});

describe('getPlatform / setPlatform', () => {
  afterEach(() => setPlatform(null));

  it('returns the injected platform and falls back to the legacy bridge', () => {
    const fake = createFakePlatform();
    setPlatform(fake);
    expect(getPlatform()).toBe(fake);
    setPlatform(null);
    expect(getPlatform()).not.toBe(fake);
  });

  it('the fake platform delivers events and records calls', async () => {
    const fake = createFakePlatform();
    const handler = vi.fn();
    const off = fake.live.on('task_updated', handler);
    fake.emit('task_updated', { id: 5 });
    off();
    fake.emit('task_updated', { id: 6 });
    expect(handler).toHaveBeenCalledTimes(1);
    fake.live.watch('s', { projects: ['p1'] });
    fake.toast('info', 'hi');
    fake.navigate('/x');
    expect(fake.watches).toHaveLength(1);
    expect(fake.toasts).toEqual([{ kind: 'info', message: 'hi' }]);
    expect(fake.navigations).toEqual(['/x']);
    fake.routes['/api/ping'] = { ok: true };
    expect(await (await fake.fetch('/api/ping')).json()).toEqual({ ok: true });
    expect((await fake.fetch('/api/missing')).status).toBe(404);
  });
});
