/** Duplicating a page and opening the result; the event that opens the template dialog. */
import type { SpaceKey } from '../../api/pageTree';
import { duplicatePage } from '../../api/templates';
import { getPlatform } from '../../platform';
import { getPageStore } from '../tree/pageStore';
import { openPage } from '../tree/space';

/** Fired on `window` to open the template dialog; `detail` says where new pages go. */
export const OPEN_TEMPLATES_EVENT = 'cutline:open-templates';

export interface OpenTemplatesDetail {
  space: SpaceKey;
  parentId?: string | null;
  /** Manage templates (delete buttons only) instead of picking one. */
  manage?: boolean;
}

export function openTemplates(detail: OpenTemplatesDetail): void {
  window.dispatchEvent(new CustomEvent<OpenTemplatesDetail>(OPEN_TEMPLATES_EVENT, { detail }));
}

/** Copy a page with its sub-pages next to the original and open the copy. Returns the copy's id, or null after a toast. */
export async function duplicateAndOpen(space: SpaceKey, pageId: string): Promise<string | null> {
  try {
    const copy = await duplicatePage(pageId);
    getPageStore(space).scheduleRefresh();
    openPage(space, copy.id);
    return copy.id;
  } catch (e) {
    getPlatform().toast('error', `Could not duplicate the page: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}
