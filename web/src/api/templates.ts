/**
 * Typed client for duplicating pages and for templates (H4). Every function throws `PageApiError`
 * when the server answers with an error status.
 */
import { getPlatform } from '../platform';
import { PageApiError, type PageInfo, type SpaceKey } from './pageTree';

export type TemplateScope = 'builtin' | 'personal' | 'workspace';

/** One entry of `GET /api/templates`. */
export interface TemplateInfo {
  id: string;
  name: string;
  description: string;
  scope: TemplateScope;
  icon?: string | null;
  pageCount: number;
  canDelete: boolean;
}

/** The root page of a copy plus every page the copy created. */
export type CreatedPages = PageInfo & { pageIds: string[] };

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

/** Copy a page (and by default its sub-pages). Without `space` and `parentId` the copy lands next to the original. */
export function duplicatePage(
  id: string,
  body: { space?: SpaceKey; parentId?: string | null; withSubpages?: boolean; title?: string } = {},
): Promise<CreatedPages> {
  return request<CreatedPages>(`/api/pages/${encodeURIComponent(id)}/duplicate`, json('POST', body));
}

export async function listTemplates(): Promise<TemplateInfo[]> {
  return (await request<{ templates: TemplateInfo[] }>('/api/templates')).templates;
}

export function saveTemplate(body: {
  pageId: string;
  name: string;
  description?: string;
  scope: 'personal' | 'workspace';
}): Promise<TemplateInfo> {
  return request<TemplateInfo>('/api/templates', json('POST', body));
}

export async function deleteTemplate(id: string): Promise<void> {
  await request<{ success: boolean }>(`/api/templates/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

/** Create pages from a template in a space (end of the top level, or under `parentId`). */
export function useTemplate(id: string, body: { space: SpaceKey; parentId?: string | null; title?: string }): Promise<CreatedPages> {
  return request<CreatedPages>(`/api/templates/${encodeURIComponent(id)}/use`, json('POST', body));
}
