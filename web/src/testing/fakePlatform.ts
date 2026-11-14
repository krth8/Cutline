import type { Platform } from '../platform';

type RouteHandler = (path: string, init?: RequestInit) => Response;

export interface FakePlatform extends Platform {
  // ---- Test helpers ----
  /** Deliver a live event to everything subscribed with `live.on(type, ...)`. */
  emit(type: string, msg?: Record<string, unknown>): void;
  toasts: Array<{ kind: string; message: string }>;
  navigations: string[];
  watches: Array<{ slot: string; target: { projects?: string[]; allTasks?: boolean } | null }>;
  confirmAnswer: boolean;
  confirmations: Array<{ message: string; opts?: { danger?: boolean; confirmLabel?: string } }>;
  fetchCalls: Array<{ path: string; init?: RequestInit }>;
  /** Responses for fetch, keyed "METHOD /path" or "/path": a JSON body, or a function returning a Response. */
  routes: Record<string, unknown>;
  data: {
    user: ReturnType<Platform['user']>;
    projects: ReturnType<Platform['projects']>;
    statuses: ReturnType<Platform['statuses']>;
    members: Record<string, Awaited<ReturnType<Platform['members']>>>;
  };
}

/** A complete in-memory Platform for vitest: no globals, everything observable. */
export function createFakePlatform(overrides: Partial<FakePlatform['data']> = {}): FakePlatform {
  const listeners = new Map<string, Set<(msg: any) => void>>();

  const fake: FakePlatform = {
    toasts: [],
    navigations: [],
    watches: [],
    confirmAnswer: true,
    confirmations: [],
    fetchCalls: [],
    routes: {},
    data: {
      user: { id: 'u1', username: 'Test User', role: 'admin' },
      projects: [{ id: 'p1', name: 'Project One', canTasks: true, isOwner: true }],
      statuses: [{ id: 's1', name: 'In progress', color: '#3b82f6' }],
      members: { p1: [{ id: 'u1', username: 'Test User' }] },
      ...overrides,
    },

    emit(type, msg = {}) {
      for (const fn of [...(listeners.get(type) ?? [])]) fn({ type, ...msg });
    },

    user: () => fake.data.user,

    async fetch(path, init) {
      fake.fetchCalls.push({ path, ...(init ? { init } : {}) });
      const method = (init?.method ?? 'GET').toUpperCase();
      const route = fake.routes[`${method} ${path}`] ?? fake.routes[path];
      if (route === undefined) return new Response(JSON.stringify({ detail: 'Not found' }), { status: 404 });
      if (typeof route === 'function') return (route as RouteHandler)(path, init);
      return new Response(JSON.stringify(route), { status: 200, headers: { 'content-type': 'application/json' } });
    },

    async openSocket() {
      throw new Error('FakePlatform.openSocket: provide your own socket in the test');
    },

    live: {
      on(type, handler) {
        if (!listeners.has(type)) listeners.set(type, new Set());
        listeners.get(type)!.add(handler);
        return () => {
          listeners.get(type)?.delete(handler);
        };
      },
      watch(slot, target) {
        fake.watches.push({ slot, target });
      },
    },

    toast(kind, message) {
      fake.toasts.push({ kind, message });
    },

    async confirm(message, opts) {
      fake.confirmations.push({ message, ...(opts ? { opts } : {}) });
      return fake.confirmAnswer;
    },

    navigate(route) {
      fake.navigations.push(route);
    },

    projects: () => fake.data.projects,
    statuses: () => fake.data.statuses,
    async members(projectId) {
      return fake.data.members[projectId] ?? [];
    },
  };
  return fake;
}
