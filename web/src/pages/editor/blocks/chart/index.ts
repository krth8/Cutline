/**
 * Charts in pages: the `chart` block with the `/chart` slash entry and its aliases `/bar chart`, `/line chart`
 * and `/donut chart`. Importing this file registers the block. It is imported by the editor chunk.
 */
import type { Editor, Range } from '@tiptap/core';
import { registerBlock, type SlashItem } from '../../registry';
import { selectFreshNode } from '../summary/summaryNodes';
import { ChartBlock } from './chartNodes';
import { CHART_BLOCK, type ChartType } from './model';

export { ChartBlock } from './chartNodes';
export { CHART_BLOCK } from './model';

/** Replace the typed `/command` with an empty chart of this type and select it, which opens its settings. */
function insert(type: ChartType) {
  return (editor: Editor, range: Range) => {
    editor.chain().focus().deleteRange(range).insertContent({ type: CHART_BLOCK, attrs: { type } }).run();
    selectFreshNode(editor, CHART_BLOCK);
  };
}

export const chartSlashItems: SlashItem[] = [
  {
    id: 'chart',
    title: 'Chart',
    description: 'A bar, line or donut chart from a view',
    icon: '▥',
    keywords: ['graph', 'plot', 'bar', 'line', 'donut', 'pie', 'statistics'],
    group: 'Numbers',
    run: insert('bar'),
  },
  {
    id: 'chart-bar',
    title: 'Bar chart',
    description: 'Compare groups of a view as bars',
    icon: '▥',
    keywords: ['chart', 'graph', 'columns'],
    group: 'Numbers',
    run: insert('bar'),
  },
  {
    id: 'chart-line',
    title: 'Line chart',
    description: 'Follow a measure over dates or steps',
    icon: '↗',
    keywords: ['chart', 'graph', 'trend', 'over time'],
    group: 'Numbers',
    run: insert('line'),
  },
  {
    id: 'chart-donut',
    title: 'Donut chart',
    description: 'Show shares of a whole',
    icon: '◔',
    keywords: ['chart', 'pie', 'share', 'percent'],
    group: 'Numbers',
    run: insert('donut'),
  },
];

registerBlock({ name: CHART_BLOCK, node: ChartBlock, slash: chartSlashItems });
