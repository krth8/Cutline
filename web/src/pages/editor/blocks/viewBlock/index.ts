/**
 * The view block: shows one view (a table, board, list, calendar or gantt of the tasks) inside a page.
 * Importing this file registers the block. It is imported by the editor chunk (sync/editorChunk.ts).
 */
import type { Editor, Range } from '@tiptap/core';
import type { Transaction } from '@tiptap/pm/state';
import { registerBlock, type SlashItem } from '../../registry';
import { getEditorContext } from './context';
import * as host from './host';
import { VIEW_BLOCK, VIEW_LAYOUTS, type PageContext } from './model';
import { ViewBlock } from './viewBlockNode';

export { ViewBlock } from './viewBlockNode';
export { VIEW_BLOCK, VIEW_LAYOUTS } from './model';

const ICONS: Record<string, string> = { table: '▦', board: '▥', calendar: '▤', gantt: '▬', list: '≣' };
const DESCRIPTIONS: Record<string, string> = {
  table: 'Tasks as a table',
  board: 'Tasks as a board of cards',
  calendar: 'Tasks on a calendar',
  gantt: 'Tasks on a timeline',
  list: 'Tasks as a list',
};

/**
 * Create the view for this page, then replace the typed `/command` with a block holding its id, in ONE
 * transaction (deleting the text first and inserting later, in two steps, made the collaboration binding
 * lose the deletion for the other editors). The range is followed through any edits made meanwhile.
 */
async function insertNewView(
  editor: Editor,
  range: Range,
  create: (ctx: PageContext) => Promise<{ id: string }>,
): Promise<void> {
  const ctx = getEditorContext(editor);
  if (!ctx) {
    host.showError('This page cannot show views here');
    return;
  }
  let { from, to } = range;
  const follow = ({ transaction }: { transaction: Transaction }) => {
    if (!transaction.docChanged) return;
    from = transaction.mapping.map(from, -1);
    to = transaction.mapping.map(to, 1);
  };
  editor.on('transaction', follow);
  try {
    const view = await create(ctx);
    if (!editor.isDestroyed) {
      editor.chain().focus().deleteRange({ from, to }).insertContent({ type: VIEW_BLOCK, attrs: { viewId: view.id } }).run();
    }
  } catch (e) {
    host.showError(e instanceof Error ? e.message : 'Could not create the view');
  } finally {
    editor.off('transaction', follow);
  }
}

/** One slash entry per layout (the five of the plan plus any other registered layout), one for a new table and one for an existing view. */
export function viewSlashItems(layoutNames: string[]): SlashItem[] {
  const known = VIEW_LAYOUTS as readonly string[];
  const names = [...VIEW_LAYOUTS, ...layoutNames.filter((n) => !known.includes(n))];
  const items: SlashItem[] = names.map((layout) => ({
    id: `view-${layout}`,
    title: layout.charAt(0).toUpperCase() + layout.slice(1),
    description: DESCRIPTIONS[layout] ?? `Tasks as a ${layout}`,
    icon: ICONS[layout] ?? '▦',
    keywords: ['view', 'tasks', layout],
    group: 'Views',
    run: (editor, range) => void insertNewView(editor, range, (ctx) => host.createViewForPage(layout, ctx)),
  }));
  // A table of the page's own: a custom table in the page's space (Name and Notes) with a table view owned by the page
  items.push({
    id: 'view-new-table',
    title: 'New table',
    description: 'A table with rows of your own',
    icon: '▦',
    keywords: ['table', 'new', 'database', 'spreadsheet', 'rows', 'custom'],
    group: 'Views',
    run: (editor, range) => void insertNewView(editor, range, (ctx) => host.createTableViewForPage(ctx)),
  });
  items.push({
    id: 'view-existing',
    title: 'Existing view',
    description: 'Show a view that already exists',
    icon: '⧉',
    keywords: ['view', 'pick', 'choose', 'embed'],
    group: 'Views',
    run: (editor, range) => {
      editor.chain().focus().deleteRange(range).insertContent({ type: VIEW_BLOCK, attrs: { viewId: null } }).run();
    },
  });
  return items;
}

registerBlock({ name: VIEW_BLOCK, node: ViewBlock, slash: viewSlashItems(host.registeredLayoutNames()) });
