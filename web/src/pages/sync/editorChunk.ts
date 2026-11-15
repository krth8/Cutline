/**
 * The lazily loaded part of the page editor: everything that pulls in Tiptap.
 * The production build turns this file into its own bundle, static/dist/pages-editor.js.
 */
export { Editor, type EditorProps } from '../editor';
export { writeHtmlIntoDoc, legacyHtmlToNode } from './htmlImport';
