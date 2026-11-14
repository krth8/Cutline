import { Node, type AnyExtension } from '@tiptap/core';
import { NodeViewContent, NodeViewWrapper, ReactNodeViewRenderer, type NodeViewProps } from '@tiptap/react';
import * as Y from 'yjs';

/** What the scan of a document learned about one node type that this editor does not know. */
export interface UnknownNodeInfo {
  attrs: Set<string>;
  /** What the element contains: nothing, other elements (blocks), or text (inline content). */
  content: 'none' | 'block' | 'inline';
  /** True when the element sits inside text (it is an inline node). */
  inline: boolean;
}

/** Walk the Y fragment and collect the element types that `known` does not contain. */
export function scanUnknownNodes(fragment: Y.XmlFragment, known: (name: string) => boolean): Map<string, UnknownNodeInfo> {
  const found = new Map<string, UnknownNodeInfo>();
  const visit = (parent: Y.XmlFragment | Y.XmlElement) => {
    const children = parent.toArray();
    const parentHoldsText = children.some((c) => c instanceof Y.XmlText);
    for (const child of children) {
      if (!(child instanceof Y.XmlElement)) continue;
      if (!known(child.nodeName)) {
        const info = found.get(child.nodeName) ?? { attrs: new Set<string>(), content: 'none' as const, inline: false };
        for (const key of Object.keys(child.getAttributes())) info.attrs.add(key);
        const kids = child.toArray();
        if (kids.some((k) => k instanceof Y.XmlText)) info.content = 'inline';
        else if (kids.length > 0 && info.content === 'none') info.content = 'block';
        if (parentHoldsText) info.inline = true;
        found.set(child.nodeName, info);
      }
      visit(child);
    }
  };
  visit(fragment);
  return found;
}

function UnsupportedView({ node }: NodeViewProps) {
  const type = node.type.name;
  const body = node.type.spec.content ? <NodeViewContent className="cl-unsupported__content" /> : null;
  const Tag = node.type.isInline ? 'span' : 'div';
  return (
    <NodeViewWrapper as={Tag} className="cl-unsupported" data-unsupported={type}>
      <span className="cl-unsupported__label" contentEditable={false}>
        Unsupported block ({type})
      </span>
      {body}
    </NodeViewWrapper>
  );
}

/**
 * A node type with the exact name and attributes found in the document, so the
 * data round-trips through the editor untouched while a neutral placeholder is
 * shown. (Without it the Yjs binding deletes elements its schema does not know.)
 */
export function unsupportedNode(name: string, info: UnknownNodeInfo): AnyExtension {
  const attrs = Object.fromEntries([...info.attrs].map((k) => [k, { default: null, rendered: false }]));
  return Node.create({
    name,
    group: info.inline ? 'inline' : 'block',
    inline: info.inline,
    atom: info.content === 'none',
    selectable: true,
    draggable: !info.inline,
    ...(info.content === 'none' ? {} : { content: info.content === 'inline' ? 'inline*' : 'block*' }),
    addAttributes: () => attrs,
    parseHTML: () => [{ tag: `div[data-unsupported="${name}"]` }],
    renderHTML: () => [info.inline ? 'span' : 'div', { 'data-unsupported': name }, ...(info.content === 'none' ? [] : [0])] as never,
    addNodeView: () => ReactNodeViewRenderer(UnsupportedView),
  });
}
