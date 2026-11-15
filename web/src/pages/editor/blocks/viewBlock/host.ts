/**
 * What the view block needs from the main bundle. The block's Tiptap node lives in the editor chunk (it
 * must use the chunk's own @tiptap/core), but the React content, the row store, the layout registry and
 * the platform exist once, in the main bundle. The chunk build (web/build.mjs) replaces every import of this
 * file in the chunk with `window.__clShared['view-block-host']`, which loadEditor.ts fills with this module.
 * Keep this file the only way the node reaches main-bundle code.
 */
import { getPlatform } from '../../../../platform';
import { listLayouts } from '../../../../tables/layouts';

export { ViewBlockContent, type ViewBlockContentProps } from './ViewBlockContent';
export { copyViewForPaste, createViewForPage, createTableViewForPage, confirmAndDeleteViewOf } from './viewApi';

/** Names of the layouts that have a component registered right now. */
export function registeredLayoutNames(): string[] {
  return listLayouts().map((l) => l.name);
}

/** A short error message for the user. */
export function showError(message: string): void {
  getPlatform().toast('error', message);
}
