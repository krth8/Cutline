/**
 * The Tiptap node of the chart (PLAN.md 5.8): a block atom that draws a bar, line or donut chart over a view.
 * This file is bundled into the editor chunk: it uses the chunk's Tiptap and gets the React content through
 * ./host, which the chunk build turns into the main bundle's module.
 */
import { Node, mergeAttributes, type Editor } from '@tiptap/core';
import { NodeViewWrapper, ReactNodeViewRenderer, useEditorState, type NodeViewProps } from '@tiptap/react';
import { pageViewIds } from '../summary/summaryNodes';
import * as host from './host';
import { CHART_BLOCK, DEFAULT_ATTRS, clampHeight, cleanBucket, cleanFn, cleanType, type ChartAttrs } from './model';

const editorIds = new WeakMap<Editor, number>();
let editorCount = 0;

/** "<editor>:<n>": which chart of which editor this is, counting charts in document order. */
function openKeyOf(editor: Editor, pos: number | undefined): string {
  if (!editorIds.has(editor)) editorIds.set(editor, ++editorCount);
  let index = 0;
  editor.state.doc.descendants((n, at) => {
    if (n.type.name === CHART_BLOCK && at < (pos ?? 0)) index++;
    return true;
  });
  return `${editorIds.get(editor)}:${index}`;
}

function ChartNodeView({ node, editor, updateAttributes, deleteNode, selected, getPos }: NodeViewProps) {
  const editable = useEditorState({ editor, selector: (s) => s.editor.isEditable });
  const a = node.attrs as Partial<ChartAttrs>;
  const attrs: ChartAttrs = {
    viewId: a.viewId || null,
    type: cleanType(a.type),
    groupBy: a.groupBy || null,
    fn: cleanFn(a.fn),
    column: a.column || null,
    title: typeof a.title === 'string' ? a.title : '',
    height: clampHeight(a.height),
    bucket: cleanBucket(a.bucket),
  };
  return (
    <NodeViewWrapper className="cl-chart-node" contentEditable={false} data-width={node.attrs.width || undefined}>
      <host.ChartContent
        attrs={attrs}
        editable={editable}
        autoOpen={selected && !attrs.viewId}
        openKey={openKeyOf(editor, getPos())}
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

/** A block atom: a chart of one grouped query over a view. */
export const ChartBlock = Node.create({
  name: CHART_BLOCK,
  group: 'block',
  atom: true,
  selectable: true,
  draggable: false,
  addAttributes: () => ({
    viewId: attr('viewId', DEFAULT_ATTRS.viewId, id),
    type: attr('type', DEFAULT_ATTRS.type, cleanType),
    groupBy: attr('groupBy', DEFAULT_ATTRS.groupBy, id),
    fn: attr('fn', DEFAULT_ATTRS.fn, cleanFn),
    column: attr('column', DEFAULT_ATTRS.column, id),
    title: attr('title', DEFAULT_ATTRS.title, text),
    height: attr('height', DEFAULT_ATTRS.height, clampHeight),
    bucket: attr('bucket', DEFAULT_ATTRS.bucket, cleanBucket),
  }),
  parseHTML: () => [{ tag: 'div[data-chart]' }],
  renderHTML: ({ HTMLAttributes }) => ['div', mergeAttributes({ 'data-chart': '' }, HTMLAttributes)],
  addNodeView: () =>
    // Clicks inside belong to the chart (it opens its settings); ProseMirror only sees the frame
    ReactNodeViewRenderer(ChartNodeView, {
      stopEvent: ({ event }) => !!(event.target as HTMLElement | null)?.closest?.('.cl-chart'),
    }),
});
