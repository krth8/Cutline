import { useRef, useState } from 'react';
import { DragHandle } from '@tiptap/extension-drag-handle-react';
import type { Node as PMNode } from '@tiptap/pm/model';
import { TextSelection } from '@tiptap/pm/state';
import type { Editor } from '@tiptap/react';
import { Menu, type MenuItem } from '../../ui';
import { BLOCK_KINDS, setBlockKind } from './blocks';

/**
 * The handle beside the hovered top-level block: drag it to reorder; click it for
 * delete, duplicate and turn into.
 */
export function BlockHandle({ editor }: { editor: Editor }) {
  const target = useRef<{ node: PMNode; pos: number } | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);

  /** Put a text selection over the whole block so block commands apply to all of it. */
  function selectBlock(node: PMNode, pos: number) {
    const tr = editor.state.tr;
    const sel = TextSelection.between(tr.doc.resolve(pos + 1), tr.doc.resolve(pos + node.nodeSize - 1));
    editor.view.dispatch(tr.setSelection(sel));
  }

  function items(): MenuItem[] {
    const t = target.current;
    if (!t) return [];
    const { node, pos } = t;
    return [
      {
        id: 'duplicate',
        label: 'Duplicate',
        onSelect: () => editor.chain().focus().insertContentAt(pos + node.nodeSize, node.toJSON()).run(),
      },
      { type: 'separator' },
      ...BLOCK_KINDS.map((k) => ({
        id: `turn-${k.id}`,
        label: `Turn into ${k.label}`,
        disabled: node.type.name === 'image' || node.type.name === 'horizontalRule',
        onSelect: () => {
          selectBlock(node, pos);
          setBlockKind(editor.chain().focus(), k.id).run();
        },
      })),
      { type: 'separator' },
      {
        id: 'delete',
        label: 'Delete',
        danger: true,
        onSelect: () => editor.chain().focus().deleteRange({ from: pos, to: pos + node.nodeSize }).run(),
      },
    ];
  }

  return (
    <>
      <DragHandle
        editor={editor}
        className="cl-handle"
        onNodeChange={({ node, pos }) => {
          target.current = node ? { node, pos } : null;
        }}
        computePositionConfig={{ placement: 'left-start', strategy: 'absolute' }}
      >
        <button
          ref={button}
          type="button"
          className="cl-handle__grip"
          aria-label="Drag to move, click for options"
          title="Drag to move, click for options"
          aria-haspopup="menu"
          onClick={() => target.current && setOpen((o) => !o)}
        >
          {'⋮⋮'}
        </button>
      </DragHandle>
      <Menu open={open} onOpenChange={setOpen} anchorRef={button} items={open ? items() : []} placement="bottom-start" aria-label="Block options" />
    </>
  );
}
