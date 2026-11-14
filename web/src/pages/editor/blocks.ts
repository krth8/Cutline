import type { ChainedCommands, Editor } from '@tiptap/core';

/** The kinds of block the toolbar and the drag-handle menu can turn a block into. */
export const BLOCK_KINDS = [
  { id: 'paragraph', label: 'Text' },
  { id: 'heading1', label: 'Heading 1' },
  { id: 'heading2', label: 'Heading 2' },
  { id: 'heading3', label: 'Heading 3' },
  { id: 'bulletList', label: 'Bullet list' },
  { id: 'orderedList', label: 'Numbered list' },
  { id: 'taskList', label: 'To-do list' },
  { id: 'blockquote', label: 'Quote' },
  { id: 'codeBlock', label: 'Code block' },
] as const;

export type BlockKind = (typeof BLOCK_KINDS)[number]['id'];

/** Queue the commands that turn the block(s) at the selection into `kind` onto `chain`. */
export function setBlockKind(chain: ChainedCommands, kind: BlockKind): ChainedCommands {
  const flat = chain.clearNodes();
  switch (kind) {
    case 'paragraph':
      return flat;
    case 'heading1':
      return flat.setNode('heading', { level: 1 });
    case 'heading2':
      return flat.setNode('heading', { level: 2 });
    case 'heading3':
      return flat.setNode('heading', { level: 3 });
    case 'bulletList':
      return flat.toggleBulletList();
    case 'orderedList':
      return flat.toggleOrderedList();
    case 'taskList':
      return flat.toggleTaskList();
    case 'blockquote':
      return flat.toggleBlockquote();
    case 'codeBlock':
      return flat.toggleCodeBlock();
  }
}

/** Which kind the selection is in right now (for highlighting the current entry). */
export function currentBlockKind(editor: Editor): BlockKind {
  if (editor.isActive('heading', { level: 1 })) return 'heading1';
  if (editor.isActive('heading', { level: 2 })) return 'heading2';
  if (editor.isActive('heading', { level: 3 })) return 'heading3';
  if (editor.isActive('taskList')) return 'taskList';
  if (editor.isActive('bulletList')) return 'bulletList';
  if (editor.isActive('orderedList')) return 'orderedList';
  if (editor.isActive('blockquote')) return 'blockquote';
  if (editor.isActive('codeBlock')) return 'codeBlock';
  return 'paragraph';
}
