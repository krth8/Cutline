import type { Editor, Range } from '@tiptap/core';
import { setBlockKind, type BlockKind } from './blocks';
import type { SlashItem } from './registry';
import type { CalloutTone } from './extensions/callout';

const kind =
  (k: BlockKind) =>
  (editor: Editor, range: Range) => {
    setBlockKind(editor.chain().focus().deleteRange(range), k).run();
  };

const callout =
  (tone: CalloutTone) =>
  (editor: Editor, range: Range) => {
    editor.chain().focus().deleteRange(range).clearNodes().setCallout(tone).run();
  };

/** The slash entries of the base schema. */
export const BASE_SLASH_ITEMS: SlashItem[] = [
  { title: 'Text', description: 'Plain paragraph', icon: 'T', keywords: ['paragraph', 'plain', 'p'], group: 'Basic', run: kind('paragraph') },
  { title: 'Heading 1', description: 'Large section heading', icon: 'H1', keywords: ['h1', 'title', 'header'], group: 'Basic', run: kind('heading1') },
  { title: 'Heading 2', description: 'Medium section heading', icon: 'H2', keywords: ['h2', 'subtitle', 'header'], group: 'Basic', run: kind('heading2') },
  { title: 'Heading 3', description: 'Small section heading', icon: 'H3', keywords: ['h3', 'header'], group: 'Basic', run: kind('heading3') },
  { title: 'Quote', description: 'Quote or excerpt', icon: '“', keywords: ['blockquote', 'citation'], group: 'Basic', run: kind('blockquote') },
  { title: 'Divider', description: 'A horizontal line', icon: '—', keywords: ['hr', 'rule', 'separator', 'line'], group: 'Basic', run: (editor, range) => {
      editor.chain().focus().deleteRange(range).setHorizontalRule().run();
    } },
  { title: 'Bullet list', description: 'A simple list of points', icon: '•', keywords: ['ul', 'unordered', 'points'], group: 'Lists', run: kind('bulletList') },
  { title: 'Numbered list', description: 'A list with numbers', icon: '1.', keywords: ['ol', 'ordered', 'steps'], group: 'Lists', run: kind('orderedList') },
  { title: 'To-do list', description: 'Checkable items', icon: '☐', keywords: ['task', 'checkbox', 'todo', 'checklist'], group: 'Lists', run: kind('taskList') },
  { title: 'Code block', description: 'Monospaced code', icon: '</>', keywords: ['code', 'snippet', 'pre'], group: 'Advanced', run: kind('codeBlock') },
  { id: 'callout-info', title: 'Callout', description: 'Highlighted note', icon: 'i', keywords: ['note', 'info', 'tip', 'admonition'], group: 'Advanced', run: callout('info') },
  { id: 'callout-success', title: 'Success callout', description: 'Green highlighted note', icon: '✓', keywords: ['callout', 'done', 'ok'], group: 'Advanced', run: callout('success') },
  { id: 'callout-warning', title: 'Warning callout', description: 'Amber highlighted note', icon: '!', keywords: ['callout', 'caution', 'attention'], group: 'Advanced', run: callout('warning') },
  { id: 'callout-danger', title: 'Danger callout', description: 'Red highlighted note', icon: '×', keywords: ['callout', 'error', 'alert'], group: 'Advanced', run: callout('danger') },
];
