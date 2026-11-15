import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError } from '../../../../api/http';
import { getSchema } from '../../../../api/tables';
import { getView } from '../../../../api/views';
import { getPlatform } from '../../../../platform';
import type { View } from '../../../../tables/types';

export type ViewWithOwner = View & { ownerPageId?: string | null; canEdit?: boolean };

export type ViewAccess =
  | { state: 'loading' }
  | { state: 'ready'; view: ViewWithOwner }
  | { state: 'denied' } // no access to the view or to its table: shown as a quiet empty state
  | { state: 'gone' } // the view was deleted
  | { state: 'error'; message: string; retry(): void };

/**
 * Can the current user open this view and read its table? Checks the view and the schema of its table,
 * and checks again when the server says the view changed (it may have been deleted or its access changed).
 */
export function useViewAccess(viewId: string | null): ViewAccess {
  const [access, setAccess] = useState<ViewAccess>({ state: 'loading' });
  const run = useRef(0);

  const check = useCallback(async () => {
    if (!viewId) return;
    const n = ++run.current;
    const set = (a: ViewAccess) => {
      if (run.current !== n) return;
      // Keep the same object while nothing changed, so a live event does not make the view flicker
      setAccess((prev) => (prev.state === a.state && a.state !== 'ready' && a.state !== 'error' ? prev : a));
    };
    try {
      const view = (await getView(viewId)) as ViewWithOwner;
      await getSchema(view.tableRef);
      set({ state: 'ready', view });
    } catch (e) {
      if (e instanceof ApiError && (e.status === 403 || e.status === 401)) set({ state: 'denied' });
      else if (e instanceof ApiError && e.status === 404) set({ state: 'gone' });
      else set({ state: 'error', message: e instanceof Error ? e.message : 'Could not load the view', retry: () => void check() });
    }
  }, [viewId]);

  useEffect(() => {
    setAccess({ state: 'loading' });
    void check();
    if (!viewId) return undefined;
    let off: (() => void) | undefined;
    try {
      off = getPlatform().live.on('view_changed', (msg: { viewId?: string }) => {
        if (msg.viewId === viewId) void check();
      });
    } catch {
      /* no live connection in this environment: the view is checked once */
    }
    return () => {
      run.current++;
      off?.();
    };
  }, [viewId, check]);

  return access;
}
