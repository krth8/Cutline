/**
 * What the chart node needs from the main bundle. Same arrangement as summary/host.ts: the Tiptap node lives
 * in the editor chunk, but the React content, the row store and the API exist once, in the main bundle. The
 * chunk build (web/build.mjs) replaces every import of this file in the chunk with
 * `window.__clShared['chart-host']`, which loadEditor.ts fills with this module. Keep this file the only way
 * the node reaches main-bundle code.
 */
export { ChartContent, type ChartContentProps } from './ChartContent';
