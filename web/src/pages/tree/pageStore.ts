/**
 * The page store: one instance per space ('me' or 'p:<projectId>'), shared by the
 * sidebar tree, the page view and the overview.
 *
 * - Loads the flat list and builds the tree (`snapshot().model`).
 * - Keeps in step with `page_changed` live events by refetching the list, debounced,
 *   so a burst of events costs one request. Project spaces call `live.watch` while
 *   somebody holds the store (`acquire`).
 * - Own changes show at once and are rolled back with a toast when the server refuses.
 * - A refetch never overwrites an own change that is still in flight: it waits.
 */
import {
  createPage,
  deletePage,
  listPages,
  movePageToSpace,
  updatePage,
  type PageInfo,
  type PageNode,
  type PageUpdate,
  type SpaceKey,
} from '../../api/pageTree';
import { getPlatform } from '../../platform';
import { buildTree, subtreeIds, type PageTreeModel } from './treeModel';

export type LoadStatus = 'idle' | 'loading' | 'ready' | 'error';

export interface StoreSnapshot {
  status: LoadStatus;
  /** The active pages as the server sent them (plus own changes not confirmed yet). */
  pages: PageNode[];
  model: PageTreeModel;
  /** Archived pages, once somebody asked for them (`wantArchived`); null before. */
  archived: PageNode[] | null;
  archivedModel: PageTreeModel;
}

export interface StoreOptions {
  /** Quiet time before a live event triggers a refetch (default 200 ms). */
  debounceMs?: number;
}

const EMPTY_MODEL = buildTree([]);

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function spaceProject(key: SpaceKey): string | null {
  return key.startsWith('p:') ? key.slice(2) : null;
}

export class PageStore {
  private snap: StoreSnapshot = {
    status: 'idle',
    pages: [],
    model: EMPTY_MODEL,
    archived: null,
    archivedModel: EMPTY_MODEL,
  };
  private listeners = new Set<() => void>();
  private refs = 0;
  private offLive: Array<() => void> = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private inflight = false;
  private dirty = false;
  private pending = 0; // own changes on their way to the server
  private epoch = 0; // bumped by every local change; a fetch started before one is stale
  private archivedWanted = 0;
  private readonly debounceMs: number;
  private readonly projectId: string | null;

  constructor(
    readonly key: SpaceKey,
    options: StoreOptions = {},
  ) {
    this.debounceMs = options.debounceMs ?? 200;
    this.projectId = spaceProject(key);
  }

  // ---- subscription (useSyncExternalStore) ----

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  snapshot = (): StoreSnapshot => this.snap;

  private set(patch: Partial<Omit<StoreSnapshot, 'model' | 'archivedModel'>>): void {
    const next = { ...this.snap, ...patch };
    next.model = patch.pages ? buildTree(patch.pages) : this.snap.model;
    next.archivedModel = 'archived' in patch ? buildTree(patch.archived ?? []) : this.snap.archivedModel;
    this.snap = next;
    for (const fn of [...this.listeners]) fn();
  }

  // ---- life cycle ----

  /** Start following the space (load, live events, watch). Call the result to let go. */
  acquire(): () => void {
    if (this.refs++ === 0) this.start();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (--this.refs === 0) this.stop();
    };
  }

  private slot(): string {
    return `pages:${this.key}`;
  }

  private start(): void {
    const platform = getPlatform();
    const mine = (msg: { project?: string }) => (this.projectId ? msg.project === this.projectId : msg.project === undefined);
    this.offLive = [
      platform.live.on('page_changed', (msg) => {
        if (mine(msg)) this.scheduleRefresh();
      }),
      platform.live.on('resync', () => this.scheduleRefresh()),
      // The server only sends changes made after it started watching: fetch once more when it confirms
      platform.live.on('watching', (msg) => {
        if (this.projectId && Array.isArray(msg.projects) && msg.projects.includes(this.projectId)) this.scheduleRefresh();
      }),
    ];
    if (this.projectId) platform.live.watch(this.slot(), { projects: [this.projectId] });
    if (this.snap.status !== 'ready') this.set({ status: 'loading' });
    void this.refresh();
  }

  private stop(): void {
    for (const off of this.offLive) off();
    this.offLive = [];
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.projectId) getPlatform().live.watch(this.slot(), null);
  }

  // ---- loading ----

  /** Refetch soon; events arriving meanwhile share the request. */
  scheduleRefresh(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.refresh();
    }, this.debounceMs);
  }

  /** Fetch the list now (once at a time; waits while an own change is in flight). */
  async refresh(): Promise<void> {
    if (this.inflight || this.pending > 0) {
      this.dirty = true;
      return;
    }
    this.inflight = true;
    this.dirty = false;
    const startedAt = this.epoch;
    try {
      const wantArchived = this.archivedWanted > 0;
      const [pages, archived] = await Promise.all([
        listPages(this.key),
        wantArchived ? listPages(this.key, { archived: true }) : Promise.resolve(null),
      ]);
      if (this.epoch !== startedAt || this.pending > 0) {
        this.dirty = true; // an own change happened meanwhile: this answer may predate it
      } else {
        this.set({ status: 'ready', pages, ...(archived ? { archived } : {}) });
      }
    } catch {
      if (this.snap.status !== 'ready') this.set({ status: 'error' });
    } finally {
      this.inflight = false;
      if (this.dirty && this.pending === 0) void this.refresh();
    }
  }

  /** The archived list is wanted while the caller holds the returned release function. */
  wantArchived(): () => void {
    this.archivedWanted += 1;
    void this.refresh();
    let released = false;
    return () => {
      if (!released) {
        released = true;
        this.archivedWanted -= 1;
      }
    };
  }

  // ---- own changes ----

  private begin(): void {
    this.pending += 1;
    this.epoch += 1;
  }

  private end(): void {
    this.pending -= 1;
    if (this.pending === 0 && this.dirty) void this.refresh();
  }

  private fail(what: string, e: unknown): void {
    getPlatform().toast('error', `Could not ${what}: ${errorText(e)}`);
  }

  private mapPage(id: string, fn: (p: PageNode) => PageNode): void {
    if (!this.snap.pages.some((p) => p.id === id)) return;
    this.set({ pages: this.snap.pages.map((p) => (p.id === id ? fn(p) : p)) });
  }

  /** Change title, icon, parent and/or sortOrder: shown at once, undone if the server refuses. */
  async update(
    id: string,
    patch: Pick<PageUpdate, 'title' | 'icon' | 'parentId' | 'sortOrder'>,
    what = 'save the page',
  ): Promise<boolean> {
    const before = this.snap.pages.find((p) => p.id === id);
    const optimistic: Partial<PageNode> = {};
    if (patch.title !== undefined) optimistic.title = patch.title.trim().slice(0, 300) || 'Untitled';
    if (patch.icon !== undefined) optimistic.icon = patch.icon;
    if (patch.parentId !== undefined) optimistic.parentId = patch.parentId;
    if (patch.sortOrder !== undefined) optimistic.sortOrder = patch.sortOrder;
    this.begin();
    this.mapPage(id, (p) => ({ ...p, ...optimistic }));
    try {
      const info = await updatePage(id, patch);
      this.mapPage(id, (p) => ({ ...p, title: info.title, icon: info.icon, parentId: info.parentId, sortOrder: info.sortOrder }));
      return true;
    } catch (e) {
      if (before) {
        // Undo only what is still our value; a newer change of the same field stays
        this.mapPage(id, (p) => {
          const back: Record<string, unknown> = { ...p };
          for (const k of Object.keys(optimistic) as Array<keyof PageNode>) {
            if (p[k] === optimistic[k]) back[k] = before[k];
          }
          return back as unknown as PageNode;
        });
      }
      this.fail(what, e);
      return false;
    } finally {
      this.end();
    }
  }

  rename(id: string, title: string): Promise<boolean> {
    return this.update(id, { title }, 'rename the page');
  }

  setIcon(id: string, icon: string | null): Promise<boolean> {
    return this.update(id, { icon }, 'change the icon');
  }

  move(id: string, parentId: string | null, sortOrder: number): Promise<boolean> {
    return this.update(id, { parentId, sortOrder }, 'move the page');
  }

  /** Create a page (at the end of its siblings). Returns it, or null after a toast. */
  async create(parentId: string | null = null, title?: string): Promise<PageInfo | null> {
    this.begin();
    try {
      const info = await createPage(this.key, { ...(title ? { title } : {}), ...(parentId ? { parentId } : {}) });
      if (!this.snap.pages.some((p) => p.id === info.id)) {
        const node: PageNode = {
          id: info.id,
          parentId: info.parentId,
          title: info.title,
          icon: info.icon,
          sortOrder: info.sortOrder,
          kind: info.kind,
        };
        this.set({ pages: [...this.snap.pages, node] });
      }
      return info;
    } catch (e) {
      this.fail('create the page', e);
      return null;
    } finally {
      this.end();
    }
  }

  /**
   * Move a page with its sub-pages to another space. They leave this tree at once (put back with a toast if the
   * server refuses) and the destination space's store reloads. Returns the page as it is now, or null.
   */
  async moveToSpace(id: string, destination: SpaceKey, parentId: string | null = null): Promise<PageInfo | null> {
    const gone = new Set(subtreeIds(this.snap.model, id));
    const removed = this.snap.pages.filter((p) => gone.has(p.id));
    this.begin();
    this.set({ pages: this.snap.pages.filter((p) => !gone.has(p.id)) });
    try {
      const info = await movePageToSpace(id, destination, parentId);
      this.invalidateArchived();
      getPageStore(destination).scheduleRefresh();
      return info;
    } catch (e) {
      const have = new Set(this.snap.pages.map((p) => p.id));
      this.set({ pages: [...this.snap.pages, ...removed.filter((p) => !have.has(p.id))] });
      this.fail('move the page', e);
      return null;
    } finally {
      this.end();
    }
  }

  /** Archive a page with its sub-pages: they leave the tree at once. */
  async archive(id: string): Promise<boolean> {
    const gone = new Set(subtreeIds(this.snap.model, id));
    const removed = this.snap.pages.filter((p) => gone.has(p.id));
    this.begin();
    this.set({ pages: this.snap.pages.filter((p) => !gone.has(p.id)) });
    try {
      await updatePage(id, { archived: true });
      this.invalidateArchived();
      return true;
    } catch (e) {
      const have = new Set(this.snap.pages.map((p) => p.id));
      this.set({ pages: [...this.snap.pages, ...removed.filter((p) => !have.has(p.id))] });
      this.fail('archive the page', e);
      return false;
    } finally {
      this.end();
    }
  }

  /** Bring an archived page (with its sub-pages) back. */
  async restore(id: string): Promise<boolean> {
    const removed = this.dropFromArchived(id);
    this.begin();
    try {
      await updatePage(id, { archived: false });
      this.dirty = true; // the active list gained pages: fetch it when the last change settles
      return true;
    } catch (e) {
      this.putBackToArchived(removed);
      this.fail('restore the page', e);
      return false;
    } finally {
      this.end();
    }
  }

  /** Ask, then delete an archived page and its sub-pages for good. */
  async deleteForever(id: string, title: string): Promise<boolean> {
    const ok = await getPlatform().confirm(`Delete "${title || 'Untitled'}" and its sub-pages forever? This cannot be undone.`, {
      danger: true,
      confirmLabel: 'Delete forever',
    });
    if (!ok) return false;
    const removed = this.dropFromArchived(id);
    this.begin();
    try {
      await deletePage(id);
      return true;
    } catch (e) {
      this.putBackToArchived(removed);
      this.fail('delete the page', e);
      return false;
    } finally {
      this.end();
    }
  }

  private dropFromArchived(id: string): PageNode[] {
    const list = this.snap.archived;
    if (!list) return [];
    const gone = new Set(subtreeIds(this.snap.archivedModel, id));
    this.set({ archived: list.filter((p) => !gone.has(p.id)) });
    return list.filter((p) => gone.has(p.id));
  }

  private putBackToArchived(removed: PageNode[]): void {
    if (!removed.length || !this.snap.archived) return;
    const have = new Set(this.snap.archived.map((p) => p.id));
    this.set({ archived: [...this.snap.archived, ...removed.filter((p) => !have.has(p.id))] });
  }

  private invalidateArchived(): void {
    if (this.archivedWanted > 0) this.dirty = true;
    else if (this.snap.archived) this.set({ archived: null });
  }
}

// ---- one store per space ----

const stores = new Map<SpaceKey, PageStore>();

export function getPageStore(key: SpaceKey): PageStore {
  let store = stores.get(key);
  if (!store) {
    store = new PageStore(key);
    stores.set(key, store);
  }
  return store;
}

/** Test helper: forget every store. */
export function resetPageStores(): void {
  stores.clear();
}
