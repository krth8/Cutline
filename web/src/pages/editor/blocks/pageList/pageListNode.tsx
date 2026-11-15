/**
 * The Tiptap node of the page list block: `pageList` with the attributes `scope` and `limit`. Bundled into the
 * editor chunk; the React content comes through ./host (the main bundle's module).
 */
import { Node, mergeAttributes } from '@tiptap/core';
import { NodeViewWrapper, ReactNodeViewRenderer, useEditorState, type NodeViewProps } from '@tiptap/react';
import * as host from './host';
import { DEFAULT_LIMIT, DEFAULT_SCOPE, PAGE_LIST, cleanLimit, cleanScope } from './model';

function PageListNodeView({ node, editor, updateAttributes }: NodeViewProps) {
  const editable = useEditorState({ editor, selector: (s) => s.editor.isEditable });
  return (
    <NodeViewWrapper className="cl-pagelist-node" contentEditable={false}>
      <host.PageListContent
        attrs={{ scope: cleanScope(node.attrs.scope), limit: cleanLimit(node.attrs.limit) }}
        editable={editable}
        setAttrs={(patch) => updateAttributes(patch)}
      />
    </NodeViewWrapper>
  );
}

/** A block atom: the pages that changed most recently. */
export const PageList = Node.create({
  name: PAGE_LIST,
  group: 'block',
  atom: true,
  selectable: true,
  draggable: false, // moving goes through the block handle

  addAttributes() {
    return {
      scope: {
        default: DEFAULT_SCOPE,
        parseHTML: (el: HTMLElement) => cleanScope(el.getAttribute('data-scope')),
        renderHTML: (attrs: Record<string, unknown>) => ({ 'data-scope': cleanScope(attrs.scope) }),
      },
      limit: {
        default: DEFAULT_LIMIT,
        parseHTML: (el: HTMLElement) => cleanLimit(el.getAttribute('data-limit')),
        renderHTML: (attrs: Record<string, unknown>) => ({ 'data-limit': String(cleanLimit(attrs.limit)) }),
      },
    };
  },

  parseHTML: () => [{ tag: 'div[data-page-list]' }],
  renderHTML: ({ HTMLAttributes }) => ['div', mergeAttributes({ 'data-page-list': '' }, HTMLAttributes)],
  addNodeView: () => ReactNodeViewRenderer(PageListNodeView),
});
