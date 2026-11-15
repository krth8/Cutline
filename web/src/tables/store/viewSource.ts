/**
 * Where views are loaded from and saved to. The store works on a ViewDescriptor; WP T4 adds an
 * implementation on top of /api/views (api/views.ts) and installs it with `setViewSource`.
 */
import { ApiError } from '../../api/http';
import type { View } from '../types';

export interface ViewDescriptor {
  id: string;
  tableRef: string;
  layout: View['layout'];
  config: View['config'];
  name?: string;
}

/** `config` is merged shallowly: each key given replaces that key of the stored config. */
export interface ViewPatch {
  name?: string;
  layout?: View['layout'];
  config?: Partial<View['config']>;
}

export interface ViewSource {
  get(id: string): Promise<ViewDescriptor>;
  update(id: string, patch: ViewPatch): Promise<ViewDescriptor>;
  /** Called when the view changes (also for our own updates). Returns the unsubscribe function. */
  subscribe(id: string, cb: (view: ViewDescriptor) => void): () => void;
}

export interface MemoryViewSource extends ViewSource {
  /** Add or replace a view (notifies subscribers). */
  set(view: ViewDescriptor): void;
}

export function applyViewPatch(view: ViewDescriptor, patch: ViewPatch): ViewDescriptor {
  return {
    ...view,
    ...(patch.name !== undefined ? { name: patch.name } : {}),
    ...(patch.layout !== undefined ? { layout: patch.layout } : {}),
    config: { ...view.config, ...(patch.config ?? {}) },
  };
}

export function createMemoryViewSource(initial: ViewDescriptor[] = []): MemoryViewSource {
  const views = new Map(initial.map((v) => [v.id, v]));
  const listeners = new Map<string, Set<(v: ViewDescriptor) => void>>();
  const notify = (v: ViewDescriptor) => {
    for (const cb of [...(listeners.get(v.id) ?? [])]) cb(v);
  };
  return {
    async get(id) {
      const v = views.get(id);
      if (!v) throw new ApiError(404, 'View not found');
      return v;
    },
    async update(id, patch) {
      const v = views.get(id);
      if (!v) throw new ApiError(404, 'View not found');
      const next = applyViewPatch(v, patch);
      views.set(id, next);
      notify(next);
      return next;
    },
    subscribe(id, cb) {
      let set = listeners.get(id);
      if (!set) listeners.set(id, (set = new Set()));
      set.add(cb);
      return () => {
        set.delete(cb);
      };
    },
    set(view) {
      views.set(view.id, view);
      notify(view);
    },
  };
}

let current: ViewSource | null = null;

/** The view source in use; the in-memory one until WP T4 installs the REST one. */
export function getViewSource(): ViewSource {
  if (!current) current = createMemoryViewSource();
  return current;
}

export function setViewSource(source: ViewSource | null): void {
  current = source;
}
