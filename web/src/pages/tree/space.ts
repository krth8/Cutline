/**
 * Helpers shared by the tree, the overview and the page view: which space a
 * route or sidebar section is about, its name, whether the user may edit in it,
 * and a React hook that holds the space's store.
 */
import { useEffect, useSyncExternalStore } from 'react';
import type { SpaceKey } from '../../api/pageTree';
import { getPlatform } from '../../platform';
import { navigate, type Route } from '../../router';
import type { Space } from '../../shell/registry';
import { getPageStore, spaceProject, type PageStore, type StoreSnapshot } from './pageStore';

export function spaceKeyOf(space: Space): SpaceKey {
  return space.kind === 'personal' ? 'me' : `p:${space.projectId}`;
}

export function spaceFromKey(key: SpaceKey): Space {
  const projectId = spaceProject(key);
  return projectId ? { kind: 'project', projectId } : { kind: 'personal' };
}

export function spaceName(key: SpaceKey): string {
  const projectId = spaceProject(key);
  if (!projectId) return 'Personal space';
  return getPlatform().projects().find((p) => p.id === projectId)?.name ?? 'Project';
}

/**
 * May the user create, rename, move and archive pages in the space? Personal pages: always
 * (the owner). Project pages: task access to the project and not the viewer role, the same
 * rule the server applies.
 */
export function canEditSpace(key: SpaceKey): boolean {
  const platform = getPlatform();
  const projectId = spaceProject(key);
  if (!projectId) return true;
  const user = platform.user();
  if (!user || user.role === 'viewer') return false;
  return platform.projects().find((p) => p.id === projectId)?.canTasks === true;
}

export function pageRoute(key: SpaceKey, pageId: string): Route {
  const projectId = spaceProject(key);
  return projectId ? { kind: 'projectPage', projectId, pageId } : { kind: 'mePage', pageId };
}

export function overviewRoute(key: SpaceKey): Route {
  const projectId = spaceProject(key);
  return projectId ? { kind: 'projectPages', projectId } : { kind: 'me' };
}

export function openPage(key: SpaceKey, pageId: string): void {
  navigate(pageRoute(key, pageId));
}

/** The page open in this space according to the route, if any. */
export function activePageId(key: SpaceKey, route: Route): string | null {
  const projectId = spaceProject(key);
  if (!projectId) return route.kind === 'mePage' ? route.pageId : null;
  return route.kind === 'projectPage' && route.projectId === projectId ? route.pageId : null;
}

/** The space's shared store, kept loaded and live while the calling component is mounted. */
export function usePageStore(key: SpaceKey): { store: PageStore; snap: StoreSnapshot } {
  const store = getPageStore(key);
  useEffect(() => store.acquire(), [store]);
  const snap = useSyncExternalStore(store.subscribe, store.snapshot, store.snapshot);
  return { store, snap };
}

// ---- "focus the title of the page that was just created" ----

let titleFocusFor: string | null = null;

/** Ask the page view to focus (and select) the title of this page when it opens. */
export function requestTitleFocus(pageId: string): void {
  titleFocusFor = pageId;
}

/** True once for the page that asked for it. */
export function consumeTitleFocus(pageId: string): boolean {
  if (titleFocusFor !== pageId) return false;
  titleFocusFor = null;
  return true;
}

/** Create a page in the space (under `parentId`), open it and put the cursor in its title. */
export async function createAndOpen(key: SpaceKey, parentId: string | null = null): Promise<string | null> {
  const info = await getPageStore(key).create(parentId);
  if (!info) return null;
  requestTitleFocus(info.id);
  openPage(key, info.id);
  return info.id;
}
