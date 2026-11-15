import type { Editor } from '@tiptap/core';
import { getEditorPageId } from '../pageFiles';
import type { PageContext } from './model';

/** The page of this editor (from the shared `pageId` plumbing); its space is asked of the server when needed. */
export function getEditorContext(editor: Editor): PageContext | undefined {
  const pageId = getEditorPageId(editor);
  return pageId ? { pageId } : undefined;
}
