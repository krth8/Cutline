/**
 * The user's Home page (S4): which personal page Home shows. One value for the whole app, loaded from
 * `GET /api/home`, changed with `PUT /api/home`. `openHome` asks the server for the page and lets it
 * make "My dashboard" the first time. The tree, the page menu and the Home view all read it from here.
 */
import { useEffect, useSyncExternalStore } from 'react';
import { getPlatform } from '../../platform';

/** undefined = not loaded yet, null = the user has no Home page. */
let homeId: string | null | undefined;
const listeners = new Set<() => void>();

function set(next: string | null): void {
  if (homeId === next) return;
  homeId = next;
  listeners.forEach((fn) => fn());
}

/** The Home page id as last loaded (undefined before the first load). */
export const getHomePageId = (): string | null | undefined => homeId;

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** Read the pointer from the server. A failed request leaves the current value alone. */
export async function loadHome(): Promise<void> {
  try {
    const res = await getPlatform().fetch('/api/home');
    if (!res.ok) return;
    set(((await res.json()) as { pageId: string | null }).pageId ?? null);
  } catch {
    /* offline or not signed in: keep what we have */
  }
}

/** The Home page, created ("My dashboard") on first use. Returns null when the server refuses. */
export async function openHome(): Promise<string | null> {
  try {
    const res = await getPlatform().fetch('/api/home/open', { method: 'POST' });
    if (!res.ok) return null;
    const { pageId } = (await res.json()) as { pageId: string };
    set(pageId);
    return pageId;
  } catch {
    return null;
  }
}

/** Make a personal page the Home page. */
export async function setHomePage(pageId: string): Promise<boolean> {
  const platform = getPlatform();
  try {
    const res = await platform.fetch('/api/home', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pageId }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    set(pageId);
    platform.toast('success', 'This page is now your Home');
    return true;
  } catch {
    platform.toast('error', 'Could not set the Home page');
    return false;
  }
}

/**
 * The Home page id while the caller is mounted: loads it once, and again when a page changed (archived,
 * moved or deleted pages stop being Home on the server) or the connection came back.
 */
export function useHomePageId(): string | null | undefined {
  useEffect(() => {
    if (homeId === undefined) void loadHome();
    const platform = getPlatform();
    const offs = [
      platform.live.on('page_changed', (msg) => {
        const change = (msg as { change?: string }).change;
        if (change === 'archived' || change === 'deleted' || change === 'moved') void loadHome();
      }),
      platform.live.on('resync', () => void loadHome()),
    ];
    return () => offs.forEach((off) => off());
  }, []);
  return useSyncExternalStore(subscribe, getHomePageId, getHomePageId);
}

/** Test helper: forget the loaded value. */
export function resetHome(): void {
  homeId = undefined;
  listeners.forEach((fn) => fn());
}
