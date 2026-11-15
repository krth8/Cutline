/**
 * The page list block: the pages that changed most recently (Home's "Recently changed pages"). Importing this
 * file registers the node and its `/pages` slash entry. It is imported by the editor chunk through blocks/index.ts.
 */
import './pageList.css';
import { registerBlock } from '../../registry';
import { PAGE_LIST } from './model';
import { PageList } from './pageListNode';

export { PageList } from './pageListNode';
export { PAGE_LIST } from './model';

registerBlock({
  name: PAGE_LIST,
  node: PageList,
  slash: {
    id: 'page-list',
    title: 'Pages',
    description: 'A list of recently changed pages',
    icon: '\u{1F553}',
    keywords: ['pages', 'recent', 'changed', 'list', 'latest', 'activity'],
    group: 'Advanced',
    run: (editor, range) => {
      editor.chain().focus().deleteRange(range).insertContent({ type: PAGE_LIST, attrs: { scope: 'all', limit: 8 } }).run();
    },
  },
});
