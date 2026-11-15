/**
 * What the mention node asks the server for the `@` menu: the page's space and the search itself.
 * Runs in the main bundle (the editor chunk reaches it through host.ts).
 */
import { getPage } from '../../../../api/pageTree';
import { getPlatform } from '../../../../platform';
import { EMPTY_RESULT, type MentionSearchResult } from './model';

const spaces = new Map<string, Promise<string>>();

/** The space of a page ('me' or 'p:<projectId>'), asked of the server once per page. */
function spaceOfPage(pageId: string): Promise<string> {
  let space = spaces.get(pageId);
  if (!space) {
    space = getPage(pageId).then((page) => page.space);
    space.catch(() => spaces.delete(pageId));
    spaces.set(pageId, space);
  }
  return space;
}

/** `GET /api/mentions/search` for the page being edited: what the caller may mention, at most 8 of each kind. */
export async function searchMentions(query: string, pageId: string | undefined): Promise<MentionSearchResult> {
  const space = pageId ? await spaceOfPage(pageId).catch(() => 'me') : 'me';
  const res = await getPlatform().fetch(`/api/mentions/search?q=${encodeURIComponent(query)}&space=${encodeURIComponent(space)}`);
  if (!res.ok) return EMPTY_RESULT;
  const body = (await res.json()) as Partial<MentionSearchResult>;
  return { people: body.people ?? [], tasks: body.tasks ?? [], pages: body.pages ?? [], clips: body.clips ?? [] };
}
