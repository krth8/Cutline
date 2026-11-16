/**
 * The Tiptap node of the clip block (PLAN.md 5.8). This file is bundled into the editor chunk: it uses the
 * chunk's Tiptap and gets everything else (the React content, the platform) through ./host, which the chunk
 * build turns into the main bundle's module.
 */
import { Node } from '@tiptap/core';
import { NodeViewWrapper, ReactNodeViewRenderer, useEditorState, type NodeViewProps } from '@tiptap/react';
import { getEditorPageId } from '../pageFiles';
import * as host from './host';
import { CLIP_EMBED, cleanCount, type ClipEmbedAttrs } from './model';

function ClipEmbedNodeView({ node, editor, updateAttributes, deleteNode }: NodeViewProps) {
  const editable = useEditorState({ editor, selector: (s) => s.editor.isEditable });
  return (
    <NodeViewWrapper className="cl-clipembed-node" contentEditable={false} data-clip-embed="" data-width={node.attrs.width || undefined}>
      <host.ClipEmbedContent
        attrs={node.attrs as ClipEmbedAttrs}
        editable={editable}
        pageId={getEditorPageId(editor) ?? null}
        setAttrs={(attrs) => updateAttributes(attrs)}
        removeBlock={() => deleteNode()}
      />
    </NodeViewWrapper>
  );
}

/** An attribute stored as `data-<name>` in HTML. */
function textAttr(name: string, dataName: string) {
  return {
    default: null,
    parseHTML: (el: HTMLElement) => el.getAttribute(dataName) || null,
    renderHTML: (attrs: Record<string, unknown>) => {
      const value = attrs[name];
      return value === null || value === undefined ? {} : { [dataName]: String(value) };
    },
  };
}

/** A number attribute stored as `data-<name>` in HTML (anything that is not a whole number >= 0 becomes null). */
function countAttr(name: string, dataName: string) {
  return {
    default: null,
    parseHTML: (el: HTMLElement) => cleanCount(el.getAttribute(dataName)),
    renderHTML: (attrs: Record<string, unknown>) => {
      const value = cleanCount(attrs[name]);
      return value === null ? {} : { [dataName]: String(value) };
    },
  };
}

/** An atom block that shows one clip: its thumbnail, status and a link that opens the review. */
export const ClipEmbed = Node.create({
  name: CLIP_EMBED,
  group: 'block',
  atom: true,
  selectable: true,
  draggable: false, // moving goes through the block handle

  addAttributes() {
    return {
      projectId: textAttr('projectId', 'data-project-id'),
      baseName: textAttr('baseName', 'data-clip'),
      version: countAttr('version', 'data-version'),
      frame: countAttr('frame', 'data-frame'),
    };
  },

  parseHTML() {
    return [{ tag: 'div[data-clip-embed]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ['div', { 'data-clip-embed': '', ...HTMLAttributes }];
  },

  addNodeView() {
    return ReactNodeViewRenderer(ClipEmbedNodeView, {
      // Buttons inside the card (change, remove) are the card's own; ProseMirror must not treat them as selection
      stopEvent: ({ event }) => !!(event.target as HTMLElement | null)?.closest?.('.cl-clipembed__actions, .cl-clipembed__state button'),
    });
  },
});
