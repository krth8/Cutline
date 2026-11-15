/**
 * Plain logic of the page list block (no React, no Tiptap, no platform): the node name, its attributes and
 * how they are cleaned. Used by the node (editor chunk) and by the host (main bundle).
 */

/** The node name in the document. */
export const PAGE_LIST = 'pageList';

/** `me` = the reader's personal pages, `p:<projectId>` = one project, `all` = everything the reader may read. */
export type PageListScope = 'me' | 'all' | `p:${string}`;

export interface PageListAttrs {
  scope: PageListScope;
  limit: number;
}

export const DEFAULT_SCOPE: PageListScope = 'all';
export const DEFAULT_LIMIT = 8;
export const MAX_LIMIT = 50;
export const LIMIT_CHOICES = [5, 8, 15, 30];

export function cleanScope(value: unknown): PageListScope {
  if (value === 'me' || value === 'all') return value;
  if (typeof value === 'string' && value.startsWith('p:') && value.length > 2) return value as PageListScope;
  return DEFAULT_SCOPE;
}

export function cleanLimit(value: unknown): number {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN;
  if (!Number.isFinite(n) || n < 1) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.floor(n));
}

/** The request path for a list. */
export function recentPath(attrs: PageListAttrs): string {
  return `/api/pages/recent?scope=${encodeURIComponent(attrs.scope)}&limit=${attrs.limit}`;
}
