/** `GET /api/backlinks`: the pages that mention a person, task, page or clip (only pages the caller may read). */
import { getPlatform } from '../../platform';

export type BacklinkKind = 'person' | 'task' | 'page' | 'clip';

export interface Backlink {
  id: string;
  title: string;
  icon: string | null;
  /** 'me' or 'p:<projectId>' */
  space: string;
  projectId: string | null;
  /** The app route of the page. */
  route: string;
  updatedAt: string;
}

export async function getBacklinks(kind: BacklinkKind, id: string): Promise<Backlink[]> {
  const res = await getPlatform().fetch(`/api/backlinks?kind=${encodeURIComponent(kind)}&id=${encodeURIComponent(id)}`);
  if (!res.ok) throw new Error(`Could not load backlinks (${res.status})`);
  return ((await res.json()) as { pages: Backlink[] }).pages;
}
