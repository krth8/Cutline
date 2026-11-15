/** Typed client for the page REST endpoints the collaboration client needs (PLAN.md 5.7). */
import { getPlatform } from '../platform';

export interface PageInfo {
  id: string;
  title: string;
  icon: string | null;
  kind: string;
  space: string;
  parentId: string | null;
  sortOrder: number;
  canEdit: boolean;
  needsImport: boolean;
  archived: boolean;
  /** Only present while `needsImport` is true. */
  legacyHtml?: string;
}

/** A failed page request; `status` is the HTTP status (403 and 404 both mean "not available"). */
export class PageApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'PageApiError';
  }
}

async function failure(res: Response): Promise<PageApiError> {
  let detail = `HTTP ${res.status}`;
  try {
    const body = (await res.json()) as { detail?: unknown };
    if (typeof body.detail === 'string') detail = body.detail;
  } catch {
    // not JSON: keep the status text
  }
  return new PageApiError(res.status, detail);
}

export async function getPage(pageId: string): Promise<PageInfo> {
  const res = await getPlatform().fetch(`/api/pages/${encodeURIComponent(pageId)}`);
  if (!res.ok) throw await failure(res);
  return (await res.json()) as PageInfo;
}

/** Ask to do the one-time import of the legacy HTML. Exactly one caller ever gets `true`. */
export async function claimImport(pageId: string): Promise<boolean> {
  const res = await getPlatform().fetch(`/api/pages/${encodeURIComponent(pageId)}/claim-import`, { method: 'POST' });
  if (!res.ok) throw await failure(res);
  return ((await res.json()) as { granted: boolean }).granted === true;
}
