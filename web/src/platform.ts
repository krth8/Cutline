/**
 * The typed bridge to the legacy page (PLAN.md 5.2).
 *
 * This is the only module that reads the legacy globals (`window.AppState`,
 * `Live`, `Toast`, `Confirm`, `openSocket` and the patched `window.fetch`).
 * Everything else in the bundle goes through `getPlatform()`, and tests
 * replace the implementation with `setPlatform(fake)`.
 */

export interface Platform {
  user(): { id: string; username: string; role: 'admin' | 'editor' | 'viewer'; profileImage?: string } | null;
  fetch(path: string, init?: RequestInit): Promise<Response>; // adds auth, CSRF, idle headers; handles 401
  openSocket(path: string): Promise<WebSocket>; // one-time ticket
  live: {
    on(type: string, handler: (msg: any) => void): () => void; // returns unsubscribe
    watch(slot: string, target: { projects?: string[]; allTasks?: boolean } | null): void;
  };
  toast(kind: 'info' | 'success' | 'error', message: string): void;
  confirm(message: string, opts?: { danger?: boolean; confirmLabel?: string }): Promise<boolean>;
  navigate(route: string): void;
  projects(): Array<{ id: string; name: string; canTasks: boolean; isOwner: boolean }>;
  statuses(): Array<{ id: string; name: string; color: string }>;
  members(projectId: string): Promise<Array<{ id: string; username: string; profileImage?: string }>>;
}

/** Fired on `window` after `navigate()` changed the URL (`popstate` covers back/forward). */
export const NAVIGATE_EVENT = 'cutline:navigate';

// ---- The legacy globals, as far as the bridge uses them ----

interface LegacyGlobals {
  AppState?: {
    adminUser?: { id?: string; username?: string; role?: string; isAdmin?: boolean; profileImage?: string | null } | null;
    projects?: Array<{ id: string; name: string; canTasks?: boolean; isOwner?: boolean }>;
    statuses?: Array<{ id: string; name: string; color: string }>;
    isAdmin?: boolean;
  };
  Live?: {
    on(type: string, fn: (msg: any) => void): void;
    watch(slot: string, projectId: string | null): void;
  };
  Toast?: Record<'info' | 'success' | 'error', (message: string) => unknown>;
  Confirm?: { show(options: { message: string; type?: string; confirmText?: string }): Promise<boolean> };
  openSocket?: (path: string) => Promise<WebSocket>;
}

function legacy(): LegacyGlobals {
  return window as unknown as LegacyGlobals;
}

const WATCH_PREFIX = 'pages:';

export function createLegacyPlatform(): Platform {
  // Live.on cannot be undone, so we register once per event type and keep our own handler sets
  const handlers = new Map<string, Set<(msg: any) => void>>();
  // Legacy slot names held per caller slot, so a changed target releases the old projects
  const heldSlots = new Map<string, Set<string>>();

  function requireLive(): NonNullable<LegacyGlobals['Live']> {
    const live = legacy().Live;
    if (!live) throw new Error('Platform: the legacy Live module is not loaded');
    return live;
  }

  function dispatch(type: string, msg: any): void {
    // Copy: a handler may unsubscribe itself while we iterate
    for (const fn of [...(handlers.get(type) ?? [])]) {
      try {
        fn(msg);
      } catch (e) {
        console.error(`Platform: live handler for ${type} failed`, e);
      }
    }
  }

  const platform: Platform = {
    user() {
      const state = legacy().AppState;
      const u = state?.adminUser;
      if (!u || !u.id || !u.username) return null; // not logged in (share-link guests included)
      const role: 'admin' | 'editor' | 'viewer' =
        u.isAdmin || u.role === 'admin' || state?.isAdmin ? 'admin' : u.role === 'viewer' ? 'viewer' : 'editor';
      return { id: u.id, username: u.username, role, ...(u.profileImage ? { profileImage: u.profileImage } : {}) };
    },

    // window.fetch is patched by the legacy api.js: headers are added and a 401 ends the login
    fetch(path, init) {
      return window.fetch(path, init);
    },

    openSocket(path) {
      const open = legacy().openSocket;
      if (!open) return Promise.reject(new Error('Platform: the legacy openSocket is not loaded'));
      return open(path);
    },

    live: {
      on(type, handler) {
        let set = handlers.get(type);
        if (!set) {
          set = new Set();
          handlers.set(type, set);
          requireLive().on(type, (msg) => dispatch(type, msg));
        }
        set.add(handler);
        return () => {
          handlers.get(type)?.delete(handler);
        };
      },

      watch(slot, target) {
        const live = requireLive();
        if (target?.allTasks) {
          // TODO(S2): the server has no "all tasks" subscription yet. WP S2 adds it to the
          // watch message; then send it from here instead of throwing.
          throw new Error('Platform.live.watch: allTasks is not supported yet (waiting for server support, WP S2)');
        }
        // The legacy Live follows ONE project per slot, so each project gets a slot derived from ours
        const wanted = new Map<string, string>();
        for (const id of target?.projects ?? []) wanted.set(`${WATCH_PREFIX}${slot}:${id}`, id);
        for (const legacySlot of heldSlots.get(slot) ?? []) {
          if (!wanted.has(legacySlot)) live.watch(legacySlot, null);
        }
        for (const [legacySlot, id] of wanted) live.watch(legacySlot, id);
        if (wanted.size) heldSlots.set(slot, new Set(wanted.keys()));
        else heldSlots.delete(slot);
      },
    },

    toast(kind, message) {
      const toast = legacy().Toast;
      if (toast) toast[kind](message);
      else console[kind === 'error' ? 'error' : 'log'](`[toast:${kind}] ${message}`);
    },

    async confirm(message, opts) {
      const confirm = legacy().Confirm;
      if (!confirm) return window.confirm(message);
      return confirm.show({
        message,
        type: opts?.danger ? 'danger' : 'default',
        ...(opts?.confirmLabel ? { confirmText: opts.confirmLabel } : {}),
      });
    },

    navigate(route) {
      window.history.pushState({}, '', route);
      window.dispatchEvent(new CustomEvent(NAVIGATE_EVENT, { detail: { route } }));
    },

    projects() {
      const admin = platform.user()?.role === 'admin';
      return (legacy().AppState?.projects ?? []).map((p) => ({
        id: p.id,
        name: p.name,
        // The admin's project list is the unfiltered one and carries no per-project flags
        canTasks: p.canTasks ?? admin,
        isOwner: p.isOwner ?? admin,
      }));
    },

    statuses() {
      return (legacy().AppState?.statuses ?? []).map((s) => ({ id: s.id, name: s.name, color: s.color }));
    },

    async members(projectId) {
      const res = await platform.fetch(`/api/projects/${encodeURIComponent(projectId)}/members`);
      if (!res.ok) throw new Error(`Could not load members (HTTP ${res.status})`);
      const data = (await res.json()) as {
        members?: Array<{ id: string; username: string; profileImage?: string | null }>;
      };
      return (data.members ?? []).map((m) => ({
        id: m.id,
        username: m.username,
        ...(m.profileImage ? { profileImage: m.profileImage } : {}),
      }));
    },
  };
  return platform;
}

// ---- Injection point ----

let current: Platform | null = null;

/** The platform in use: the legacy bridge unless a test or another WP injected one. */
export function getPlatform(): Platform {
  if (!current) current = createLegacyPlatform();
  return current;
}

/** Replace the platform (tests, fakes). Pass null to go back to the legacy bridge. */
export function setPlatform(platform: Platform | null): void {
  current = platform;
}
