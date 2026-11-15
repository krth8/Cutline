import type * as Y from 'yjs';
import { claimImport, type PageInfo } from '../../api/pages';
import { loadEditor, type EditorChunk } from './loadEditor';
import type { PageProvider } from './PageProvider';
import { FRAGMENT_NAME } from './protocol';

export type ImportResult = 'imported' | 'not-granted' | 'skipped';

/** True for a fragment with no content, or just the one empty paragraph an editor may leave behind. */
export function isDocEmpty(doc: Y.Doc): boolean {
  const fragment = doc.getXmlFragment(FRAGMENT_NAME);
  if (fragment.length === 0) return true;
  if (fragment.length > 1) return false;
  const only = fragment.get(0) as { nodeName?: string; length?: number } | undefined;
  return only?.nodeName === 'paragraph' && only.length === 0;
}

export interface ImportDeps {
  claim?: (pageId: string) => Promise<boolean>;
  load?: () => Promise<Pick<EditorChunk, 'writeHtmlIntoDoc'>>;
}

/**
 * The one-time import of a page's legacy HTML (PLAN.md 5.7).
 *
 * After the first sync, and only while the document is still empty, ask the server for the import.
 * Exactly one caller is granted; it writes the converted HTML into the document in one transaction
 * and the others receive the content over sync. Not being granted is not an error: do nothing.
 */
export async function importLegacyIfNeeded(
  page: Pick<PageInfo, 'id' | 'needsImport' | 'canEdit' | 'legacyHtml'>,
  doc: Y.Doc,
  provider: Pick<PageProvider, 'whenSynced'>,
  deps: ImportDeps = {},
): Promise<ImportResult> {
  if (!page.needsImport || !page.canEdit || !page.legacyHtml) return 'skipped';
  await provider.whenSynced();
  if (!isDocEmpty(doc)) return 'skipped'; // somebody else's import (or an edit) already arrived

  const granted = await (deps.claim ?? claimImport)(page.id);
  if (!granted) return 'not-granted';

  const chunk = await (deps.load ?? loadEditor)();
  // We hold the only claim, but a person may have started typing meanwhile: never overwrite
  if (!isDocEmpty(doc)) return 'skipped';
  chunk.writeHtmlIntoDoc(doc, page.legacyHtml);
  return 'imported';
}
