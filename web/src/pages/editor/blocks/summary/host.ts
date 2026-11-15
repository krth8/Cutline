/**
 * What the summary nodes need from the main bundle. Same arrangement as viewBlock/host.ts: the Tiptap nodes live
 * in the editor chunk, but the React content, the row store and the API exist once, in the main bundle. The
 * chunk build (web/build.mjs) replaces every import of this file in the chunk with
 * `window.__clShared['summary-host']`, which loadEditor.ts fills with this module. Keep this file the only way
 * the nodes reach main-bundle code.
 */
export { SummaryContent, type SummaryContentProps } from './SummaryContent';
