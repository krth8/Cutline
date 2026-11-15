/**
 * What the clip block needs from the main bundle. Like viewBlock/host.ts: the block's Tiptap node lives in
 * the editor chunk, its React content and the platform exist once, in the main bundle. The chunk build
 * (web/build.mjs) replaces every import of this file in the chunk with `window.__clShared['clip-embed-host']`,
 * which loadEditor.ts fills with this module. Keep this file the only way the node reaches main-bundle code.
 */
import { getPlatform } from '../../../../platform';

export { ClipEmbedContent, type ClipEmbedContentProps } from './ClipEmbedContent';
export { markFreshClipBlock } from './freshInsert';

/** A short error message for the user. */
export function showError(message: string): void {
  getPlatform().toast('error', message);
}
