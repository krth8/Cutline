/**
 * What the mention node needs from the main bundle. The node lives in the editor chunk (it must use the
 * chunk's own @tiptap/core), but the chip and menu components, the router and the platform exist once, in
 * the main bundle. The chunk build (web/build.mjs) replaces every import of this file in the chunk with
 * `window.__clShared['mention-host']`, which loadEditor.ts fills with this module. Keep this file the only
 * way the node reaches main-bundle code.
 */
export { searchMentions } from './api';
export { parseMentionLink } from './link';
export { MentionChip, type MentionChipProps } from './MentionChip';
export { MentionMenu, type MentionMenuState, type MentionMenuStore } from './MentionMenu';
export { resolveMention } from './resolve';
