/** Client of GET /api/search (api/routes/search.py). */
import { requestJson } from '../api/http';

export type SearchType = 'page' | 'task' | 'comment' | 'clip';

export interface SearchItem {
  type: SearchType;
  id: string;
  title: string;
  snippet?: string | null;
  icon?: string | null;
  projectId?: string | null;
  projectName?: string | null;
  /** The address to open (a path with an optional query). */
  route: string;
  /** Comments only: where the comment is. */
  clip?: string | null;
  version?: number | null;
  frame?: number | null;
}

export interface SearchGroup {
  type: SearchType;
  items: SearchItem[];
}

export interface SearchResult {
  groups: SearchGroup[];
  took: number;
}

export function searchAll(query: string, opts: { project?: string | null; limit?: number } = {}): Promise<SearchResult> {
  const params = new URLSearchParams({ q: query });
  if (opts.project) params.set('project', opts.project);
  if (opts.limit) params.set('limit', String(opts.limit));
  return requestJson<SearchResult>('GET', `/api/search?${params.toString()}`);
}
