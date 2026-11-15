/**
 * The Tiptap nodes of the summary (PLAN.md 5.8): `summary`, a block with a label and a number or progress bar,
 * and `summaryInline`, an atom that shows only the number inside a sentence. This file is bundled into the
 * editor chunk: it uses the chunk's Tiptap and gets the React content through ./host, which the chunk build
 * turns into the main bundle's module.
 */
import { Node, mergeAttributes, type Editor } from '@tiptap/core';
import { NodeSelection } from '@tiptap/pm/state';
import { NodeViewWrapper, ReactNodeViewRenderer, useEditorState, type NodeViewProps } from '@tiptap/react';
import { VIEW_BLOCK } from '../viewBlock/model';
import * as host from './host';
import { DEFAULT_ATTRS, SUMMARY_BLOCK, SUMMARY_INLINE, cleanDisplay, cleanFn, cleanTarget, type SummaryAttrs } from './model';

/** The view ids of the view blocks on this page, in document order, without repeats. */
export function pageViewIds(editor: Editor): string[] {
  const ids: string[] = [];
  editor.state.doc.descendants((n) => {
    const id = n.type.name === VIEW_BLOCK ? (n.attrs.viewId as string | null) : null;
    if (id && !ids.includes(id)) ids.push(id);
    return true;
  });
  return ids;
}

/** Select the first summary node of this type that has no view yet (the one a slash entry just inserted). */
export function selectFreshNode(editor: Editor, name: string): void {
  let found = -1;
  editor.state.doc.descendants((n, pos) => {
    if (found < 0 && n.type.name === name && !n.attrs.viewId) found = pos;
    return found < 0;
  });
  if (found >= 0) editor.view.dispatch(editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, found)));
}

function SummaryNodeView({ node, editor, updateAttributes, deleteNode, selected }: NodeViewProps) {
  const editable = useEditorState({ editor, selector: (s) => s.editor.isEditable });
  const inline = node.type.name === SUMMARY_INLINE;
  const a = node.attrs as Partial<SummaryAttrs>;
  const attrs: SummaryAttrs = {
    viewId: a.viewId || null,
    fn: cleanFn(a.fn),
    column: a.column || null,
    label: typeof a.label === 'string' ? a.label : '',
    display: cleanDisplay(a.display),
    target: cleanTarget(a.target),
  };
  return (
    <NodeViewWrapper as={inline ? 'span' : 'div'} className={inline ? 'cl-summary-node cl-summary-node--inline' : 'cl-summary-node'} contentEditable={false}>
      <host.SummaryContent
        variant={inline ? 'inline' : 'block'}
        attrs={attrs}
        editable={editable}
        autoOpen={selected && !attrs.viewId}
        pageViewIds={() => pageViewIds(editor)}
        setAttrs={(patch) => updateAttributes(patch)}
        removeNode={() => deleteNode()}
      />
    </NodeViewWrapper>
  );
}

/** One attribute stored in the document and written to HTML as `data-<name>`. */
function attr<T>(name: string, fallback: T, clean: (v: unknown) => T) {
  const dataName = `data-${name.toLowerCase()}`;
  return {
    default: fallback,
    parseHTML: (el: HTMLElement) => clean(el.getAttribute(dataName)),
    renderHTML: (attrs: Record<string, any>) => {
      const v = attrs[name];
      return v === null || v === undefined || v === '' ? {} : { [dataName]: String(v) };
    },
  };
}

const text = (v: unknown): string => (typeof v === 'string' ? v : '');
const id = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

/** Attributes the block has and the inline node leaves out. */
function blockOnly() {
  return {
    label: attr('label', DEFAULT_ATTRS.label, text),
    display: attr('display', DEFAULT_ATTRS.display, cleanDisplay),
    target: attr('target', DEFAULT_ATTRS.target, cleanTarget),
  };
}

function commonAttributes() {
  return {
    viewId: attr('viewId', DEFAULT_ATTRS.viewId, id),
    fn: attr('fn', DEFAULT_ATTRS.fn, cleanFn),
    column: attr('column', DEFAULT_ATTRS.column, id),
  };
}

const nodeView = () =>
  // Clicks inside belong to the summary (it opens its settings); ProseMirror only sees the frame
  ReactNodeViewRenderer(SummaryNodeView, {
    stopEvent: ({ event }) => !!(event.target as HTMLElement | null)?.closest?.('.cl-summary'),
  });

/** A block atom: a label and one number or progress bar from a view's summary. */
export const SummaryBlock = Node.create({
  name: SUMMARY_BLOCK,
  group: 'block',
  atom: true,
  selectable: true,
  draggable: false,
  addAttributes: () => ({ ...commonAttributes(), ...blockOnly() }),
  parseHTML: () => [{ tag: 'div[data-summary]' }],
  renderHTML: ({ HTMLAttributes }) => ['div', mergeAttributes({ 'data-summary': '' }, HTMLAttributes)],
  addNodeView: nodeView,
});

/** An inline atom that shows only the number, to be used inside a sentence. */
export const SummaryInline = Node.create({
  name: SUMMARY_INLINE,
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  draggable: false,
  addAttributes: () => commonAttributes(),
  parseHTML: () => [{ tag: 'span[data-summary-inline]' }],
  renderHTML: ({ HTMLAttributes }) => ['span', mergeAttributes({ 'data-summary-inline': '' }, HTMLAttributes)],
  addNodeView: nodeView,
});
