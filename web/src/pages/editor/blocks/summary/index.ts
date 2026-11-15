/**
 * Summary numbers in pages: the `summary` block and the inline `summaryInline` node, with the `/summary` and
 * `/number` slash entries. Importing this file registers both. It is imported by the editor chunk.
 */
import type { Editor, Range } from '@tiptap/core';
import { registerBlock, type SlashItem } from '../../registry';
import { SUMMARY_BLOCK, SUMMARY_INLINE } from './model';
import { SummaryBlock, SummaryInline, selectFreshNode } from './summaryNodes';

export { SummaryBlock, SummaryInline } from './summaryNodes';
export { SUMMARY_BLOCK, SUMMARY_INLINE } from './model';

/** Replace the typed `/command` with an empty summary node and select it, which opens its settings. */
function insert(name: string) {
  return (editor: Editor, range: Range) => {
    editor.chain().focus().deleteRange(range).insertContent({ type: name }).run();
    selectFreshNode(editor, name);
  };
}

export const summarySlashItems: SlashItem[] = [
  {
    id: 'summary-block',
    title: 'Summary',
    description: 'A number or progress bar from a view',
    icon: '∑',
    keywords: ['count', 'sum', 'progress', 'percent', 'total', 'kpi', 'stat'],
    group: 'Numbers',
    run: insert(SUMMARY_BLOCK),
  },
  {
    id: 'summary-inline',
    title: 'Number',
    description: 'A live number from a view, inside a sentence',
    icon: '#',
    keywords: ['count', 'sum', 'inline', 'percent', 'total', 'summary'],
    group: 'Numbers',
    run: insert(SUMMARY_INLINE),
  },
];

registerBlock({ name: SUMMARY_BLOCK, node: SummaryBlock, slash: summarySlashItems[0]! });
registerBlock({ name: SUMMARY_INLINE, node: SummaryInline, slash: summarySlashItems[1]! });
