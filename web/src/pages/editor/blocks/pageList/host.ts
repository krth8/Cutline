/**
 * What the page list node needs from the main bundle. Same arrangement as summary/host.ts: the Tiptap node
 * lives in the editor chunk, the React content, the platform and the router exist once, in the main bundle.
 * The chunk build (web/build.mjs) replaces every import of this file in the chunk with
 * `window.__clShared['page-list-host']`, which loadEditor.ts fills with this module. Keep this file the only
 * way the node reaches main-bundle code.
 */
export { PageListContent, type PageListContentProps } from './PageListContent';
