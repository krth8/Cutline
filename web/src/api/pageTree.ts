/**
 * Typed client for the page tree endpoints (PLAN.md 5.7): the list of a space,
 * create, read, update and delete one page. Every function throws `PageApiError`
 * when the server answers with an error status.
 */
import { getPlatform } from '../platform';

/** 'me' (the personal space) or 'p:<projectId>'. */
export type SpaceKey = 'me' | `p:${string}`;

/** One entry of the flat tree list. */
export interface PageNode {
  id: string;
  parentId: string | null;
  title: string;
  icon: string | null;
  sortOrder: number;
  kind: string;
  /** 'tasks' for the Tasks page of a project (pinned first, cannot be deleted or moved), else null. */
  system?: string | null;
}

/** `GET /api/pages/{id}` (and the body of create / update). */
export interface PageInfo {
  id: string;
  title: string;
  icon: string | null;
  kind: string;
  system?: string | null;
  space: string;
  parentId: string | null;
  sortOrder: number;
  canEdit: boolean;
  needsImport: boolean;
  archived: boolean;
}

export interface PageUpdate {
  title?: string;
  icon?: string | null;
  parentId?: string | null;
  sortOrder?: number;
  archived?: boolean;
}

/** `GET /api/pages/{id}/move-preview`: what moving the page to another space changes. */
export interface MovePreview {
  from: string;
  to: string;
  /** Live sub-pages that move along (the page itself not counted). */
  subPages: number;
  /** People (not the caller) who can see the page after the move but not before. */
  gain: { count: number; names: string[] };
  /** People (not the caller) who can see the page now but not after the move. */
  lose: { count: number; names: string[] };
  /** Views on the pages that read tasks of one project, where some readers of the new space lack task access. */
  limitedViews: Array<{ projectId: string; projectName: string; viewCount: number; readersWithoutAccess: number }>;
}

export class PageApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'PageApiError';
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await getPlatform().fetch(path, init);
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try {
      const body = (await res.json()) as { detail?: unknown };
      if (typeof body.detail === 'string') detail = body.detail;
    } catch {
      /* no JSON body: keep the status text */
    }
    throw new PageApiError(res.status, detail);
  }
  return (await res.json()) as T;
}

function json(method: string, body: unknown): RequestInit {
  return { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

// ':' is legal in a path segment; keep it readable
const spacePath = (space: SpaceKey) => `/api/spaces/${encodeURIComponent(space).replace('%3A', ':')}/pages`;
const pagePath = (id: string) => `/api/pages/${encodeURIComponent(id)}`;

/** The pages of a space, flat and ordered by sortOrder. `archived` lists the archived ones instead. */
export function listPages(space: SpaceKey, opts: { archived?: boolean } = {}): Promise<PageNode[]> {
  return request<PageNode[]>(`${spacePath(space)}${opts.archived ? '?archived=1' : ''}`);
}

/** Create a page at the end of its siblings. */
export function createPage(space: SpaceKey, body: { title?: string; parentId?: string | null } = {}): Promise<PageInfo> {
  return request<PageInfo>(spacePath(space), json('POST', body));
}

export function getPage(id: string): Promise<PageInfo> {
  return request<PageInfo>(pagePath(id));
}

export function updatePage(id: string, patch: PageUpdate): Promise<PageInfo> {
  return request<PageInfo>(pagePath(id), json('PATCH', patch));
}

/** Delete an archived page and its sub-pages for good. */
export async function deletePage(id: string): Promise<void> {
  await request<{ success: boolean }>(pagePath(id), { method: 'DELETE' });
}

export function getMovePreview(id: string, space: SpaceKey): Promise<MovePreview> {
  return request<MovePreview>(`${pagePath(id)}/move-preview?space=${encodeURIComponent(space)}`);
}

/** Move a page with its sub-pages to another space (end of the top level, or under `parentId`). */
export function movePageToSpace(id: string, space: SpaceKey, parentId?: string | null): Promise<PageInfo> {
  return request<PageInfo>(`${pagePath(id)}/move`, json('POST', { space, ...(parentId ? { parentId } : {}) }));
}
