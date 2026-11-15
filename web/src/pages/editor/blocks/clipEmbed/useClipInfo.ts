import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { ApiError } from '../../../../api/http';
import { getPlatform } from '../../../../platform';
import { getClipSummary } from './clipApi';
import type { ClipSummary } from './model';

export type ClipInfo =
  | { state: 'loading' }
  | { state: 'ready'; clip: ClipSummary }
  | { state: 'denied' } // no review access to the project: nothing about the clip is shown
  | { state: 'gone' } // the clip was deleted
  | { state: 'error'; message: string; retry(): void };

/**
 * The card data of a clip, kept current: while the block is mounted the project is watched, and a changed
 * clip (a new status or version), a new or deleted comment or a deleted clip updates the card without a reload.
 */
export function useClipInfo(projectId: string | null, baseName: string | null, version: number | null): ClipInfo {
  const [info, setInfo] = useState<ClipInfo>({ state: 'loading' });
  const run = useRef(0);
  const slot = `clip-embed-${useId()}`;

  const load = useCallback(async () => {
    if (!projectId || !baseName) return;
    const n = ++run.current;
    const set = (next: ClipInfo) => {
      if (run.current === n) setInfo(next);
    };
    try {
      set({ state: 'ready', clip: await getClipSummary(projectId, baseName, version) });
    } catch (e) {
      if (e instanceof ApiError && (e.status === 403 || e.status === 401)) set({ state: 'denied' });
      else if (e instanceof ApiError && e.status === 404) set({ state: 'gone' });
      else set({ state: 'error', message: e instanceof Error ? e.message : 'Could not load the clip', retry: () => void load() });
    }
  }, [projectId, baseName, version]);

  useEffect(() => {
    setInfo({ state: 'loading' });
    void load();
    if (!projectId || !baseName) return undefined;

    let timer: ReturnType<typeof setTimeout> | undefined;
    // Several events often arrive together (a comment and a status): one reload covers them
    const reloadSoon = () => {
      clearTimeout(timer);
      timer = setTimeout(() => void load(), 150);
    };
    const offs: Array<() => void> = [];
    const forMe = (msg: { project?: string }) => msg.project === projectId;
    try {
      const platform = getPlatform();
      platform.live.watch(slot, { projects: [projectId] });
      offs.push(
        platform.live.on('clip_updated', (msg) => forMe(msg) && msg.baseName === baseName && reloadSoon()),
        platform.live.on('clip_deleted', (msg) => {
          if (forMe(msg) && msg.baseName === baseName) {
            run.current++;
            setInfo({ state: 'gone' });
          }
        }),
        platform.live.on('comment_added', (msg) => forMe(msg) && reloadSoon()),
        platform.live.on('comment_deleted', (msg) => forMe(msg) && reloadSoon()),
        platform.live.on('access_removed', (msg) => {
          if (forMe(msg)) {
            run.current++;
            setInfo({ state: 'denied' });
          }
        }),
      );
    } catch {
      /* no live connection in this environment: the card is loaded once */
    }
    return () => {
      run.current++;
      clearTimeout(timer);
      for (const off of offs) off();
      try {
        getPlatform().live.watch(slot, null);
      } catch {
        /* nothing to release */
      }
    };
  }, [projectId, baseName, version, load, slot]);

  return info;
}
