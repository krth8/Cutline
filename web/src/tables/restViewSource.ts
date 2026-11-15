/**
 * The ViewSource on top of /api/views. Loads a view, saves changes, and tells subscribers when the view
 * changed: after our own update, and after a `view_changed` live event (the view is fetched again).
 */
import { getView, updateView } from '../api/views';
import { getPlatform } from '../platform';
import type { View } from './types';
import type { ViewDescriptor, ViewPatch, ViewSource } from './store/viewSource';

function toDescriptor(v: View): ViewDescriptor {
  return { id: v.id, tableRef: v.tableRef, layout: v.layout, config: v.config, name: v.name };
}

export function createRestViewSource(): ViewSource {
  const listeners = new Map<string, Set<(v: ViewDescriptor) => void>>();
  let liveOff: (() => void) | null = null;
  // Per view: the newest request number that started, so an older answer never overwrites a newer one
  const latest = new Map<string, number>();
  let counter = 0;

  const notify = (d: ViewDescriptor) => {
    for (const cb of [...(listeners.get(d.id) ?? [])]) cb(d);
  };

  async function refetch(id: string): Promise<void> {
    const n = ++counter;
    latest.set(id, n);
    try {
      const view = await getView(id);
      if (latest.get(id) === n) notify(toDescriptor(view));
    } catch {
      /* the view is gone or not readable now: the next explicit get reports it */
    }
  }

  function startLive() {
    if (liveOff) return;
    liveOff = getPlatform().live.on('view_changed', (msg: { viewId?: string }) => {
      if (msg.viewId && listeners.has(msg.viewId)) void refetch(msg.viewId);
    });
  }

  function stopLive() {
    if (listeners.size === 0 && liveOff) {
      liveOff();
      liveOff = null;
    }
  }

  return {
    async get(id) {
      const n = ++counter;
      latest.set(id, n);
      return toDescriptor(await getView(id));
    },
    async update(id, patch: ViewPatch) {
      const n = ++counter;
      latest.set(id, n);
      const d = toDescriptor(await updateView(id, patch));
      notify(d);
      return d;
    },
    subscribe(id, cb) {
      let set = listeners.get(id);
      if (!set) listeners.set(id, (set = new Set()));
      set.add(cb);
      startLive();
      return () => {
        set!.delete(cb);
        if (set!.size === 0) listeners.delete(id);
        stopLive();
      };
    },
  };
}
