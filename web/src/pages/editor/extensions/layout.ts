/**
 * Layout of blocks on a page: how wide a block is, and blocks side by side.
 *
 * Width: text stays in the reading column; the blocks that hold data (views, charts, clips, columns) have a
 * `width` attribute: `text` (the reading column, the default), `wide` (up to 1200 px) or `full` (all the room
 * the page has). It is chosen in the block handle's menu.
 *
 * Columns: a `columns` node holds two to four `column` nodes, each with ordinary blocks inside. They share the
 * width by their `grow` share (equal by default) and stack on a narrow screen. While editing, the gap between two
 * columns is a handle: drag it to move the split, double-click it to make the two equal again.
 */
import { Extension, Node, mergeAttributes, type Editor, type Range } from '@tiptap/core';
import { Plugin, PluginKey, TextSelection } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';

export const BLOCK_WIDTHS = ['text', 'wide', 'full'] as const;
export type BlockWidth = (typeof BLOCK_WIDTHS)[number];
export const WIDTH_LABELS: Record<BlockWidth, string> = { text: 'Text width', wide: 'Wide', full: 'Full width' };

/** The node types that can be made wider than the text. */
export const WIDTH_TYPES = ['viewBlock', 'chart', 'clipEmbed', 'columns'];

export const cleanWidth = (v: unknown): BlockWidth => ((BLOCK_WIDTHS as readonly unknown[]).includes(v) ? (v as BlockWidth) : 'text');

/** Adds the `width` attribute to the node types of WIDTH_TYPES (those that are part of the schema). */
export const BlockWidthAttr = Extension.create({
  name: 'blockWidth',
  addGlobalAttributes() {
    return [
      {
        types: WIDTH_TYPES,
        attributes: {
          width: {
            default: 'text',
            parseHTML: (el: HTMLElement) => cleanWidth(el.getAttribute('data-width')),
            renderHTML: (attrs: Record<string, unknown>) => (cleanWidth(attrs.width) === 'text' ? {} : { 'data-width': cleanWidth(attrs.width) }),
          },
        },
      },
    ];
  },
});

export const COLUMNS = 'columns';
export const COLUMN = 'column';
export const MIN_COLUMNS = 2;
export const MAX_COLUMNS = 4;

/** A column's share of the width: 1 is the default, kept between 0.25 and 4 (so no column gets too thin). */
export function cleanGrow(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n) || n <= 0) return 1;
  return Math.min(4, Math.max(0.25, Math.round(n * 100) / 100));
}

/** One column: ordinary blocks. Only exists inside `columns`. */
export const Column = Node.create({
  name: COLUMN,
  content: 'block+',
  isolating: true,
  addAttributes() {
    return {
      grow: {
        default: 1,
        parseHTML: (el: HTMLElement) => cleanGrow(el.getAttribute('data-grow')),
        renderHTML: (attrs: Record<string, unknown>) => {
          const g = cleanGrow(attrs.grow);
          return g === 1 ? {} : { 'data-grow': String(g), style: `--cl-col-grow: ${g}` };
        },
      },
    };
  },
  parseHTML: () => [{ tag: 'div[data-column]' }],
  renderHTML: ({ HTMLAttributes }) => ['div', mergeAttributes({ 'data-column': '', class: 'cl-column' }, HTMLAttributes), 0],
});

/** Blocks side by side. */
export const Columns = Node.create({
  name: COLUMNS,
  group: 'block',
  content: `${COLUMN}{${MIN_COLUMNS},${MAX_COLUMNS}}`,
  isolating: true,
  defining: true,
  parseHTML: () => [{ tag: 'div[data-columns]' }],
  renderHTML: ({ HTMLAttributes }) => ['div', mergeAttributes({ 'data-columns': '', class: 'cl-columns' }, HTMLAttributes), 0],
  addProseMirrorPlugins() {
    return [columnResizePlugin()];
  },
});

/** The two columns either side of the gap a pointer event is in, or null (not in a gap, or the columns are stacked). */
function columnsAtGap(view: EditorView, event: MouseEvent) {
  if (!view.editable) return null;
  const right = (event.target as HTMLElement | null)?.closest?.<HTMLElement>('.cl-column');
  if (!right || !view.dom.contains(right)) return null;
  const rr = right.getBoundingClientRect();
  if (event.clientX >= rr.left) return null; // the handle sits in the gap left of the column
  const left = right.previousElementSibling as HTMLElement | null;
  if (!left?.classList.contains('cl-column')) return null;
  const lr = left.getBoundingClientRect();
  if (Math.abs(lr.top - rr.top) > 2) return null; // wrapped onto separate rows
  const posA = view.posAtDOM(left, 0) - 1;
  const posB = view.posAtDOM(right, 0) - 1;
  const a = view.state.doc.nodeAt(posA);
  const b = view.state.doc.nodeAt(posB);
  if (a?.type.name !== COLUMN || b?.type.name !== COLUMN) return null;
  return { posA, posB, a, b, lr, rr };
}

function setGrow(view: EditorView, posA: number, posB: number, ga: number, gb: number) {
  const { doc, tr } = view.state;
  const a = doc.nodeAt(posA);
  const b = doc.nodeAt(posB);
  if (a?.type.name !== COLUMN || b?.type.name !== COLUMN) return;
  if (cleanGrow(a.attrs.grow) === cleanGrow(ga) && cleanGrow(b.attrs.grow) === cleanGrow(gb)) return;
  view.dispatch(tr.setNodeMarkup(posA, undefined, { ...a.attrs, grow: cleanGrow(ga) }).setNodeMarkup(posB, undefined, { ...b.attrs, grow: cleanGrow(gb) }));
}

/** Drag the gap between two columns to change how they share the width; double-click it to share equally. */
export function columnResizePlugin(): Plugin {
  return new Plugin({
    key: new PluginKey('clColumnResize'),
    props: {
      handleDOMEvents: {
        mousedown(view, event) {
          if (event.button !== 0 || event.detail > 1) return false;
          const hit = columnsAtGap(view, event);
          if (!hit) return false;
          event.preventDefault();
          const { posA, posB, a, b, lr, rr } = hit;
          const sum = cleanGrow(a.attrs.grow) + cleanGrow(b.attrs.grow);
          const gap = rr.left - lr.right;
          const span = rr.right - lr.left - gap;
          let frame = 0;
          let last = event.clientX;
          const apply = () => {
            frame = 0;
            const share = Math.min(0.85, Math.max(0.15, (last - lr.left - gap / 2) / span));
            setGrow(view, posA, posB, sum * share, sum * (1 - share));
          };
          const move = (e: MouseEvent) => {
            last = e.clientX;
            if (!frame) frame = requestAnimationFrame(apply);
          };
          const up = () => {
            window.removeEventListener('mousemove', move);
            window.removeEventListener('mouseup', up);
            document.body.classList.remove('cl-col-resizing');
            if (frame) cancelAnimationFrame(frame);
            apply();
          };
          document.body.classList.add('cl-col-resizing');
          window.addEventListener('mousemove', move);
          window.addEventListener('mouseup', up);
          return true;
        },
        dblclick(view, event) {
          const hit = columnsAtGap(view, event);
          if (!hit) return false;
          event.preventDefault();
          const sum = cleanGrow(hit.a.attrs.grow) + cleanGrow(hit.b.attrs.grow);
          setGrow(view, hit.posA, hit.posB, sum / 2, sum / 2);
          return true;
        },
      },
    },
  });
}

/** Slash command: replace the typed "/query" with `count` empty columns and put the caret in the first. */
export const insertColumns =
  (count: number) =>
  (editor: Editor, range: Range): void => {
    const columns = Array.from({ length: count }, () => ({ type: COLUMN, content: [{ type: 'paragraph' }] }));
    editor
      .chain()
      .focus()
      .deleteRange(range)
      .insertContent([{ type: COLUMNS, attrs: { width: 'wide' }, content: columns }, { type: 'paragraph' }])
      .command(({ tr, dispatch }) => {
        // The caret goes into the first column: columns > column > paragraph is three steps in
        let at = -1;
        tr.doc.descendants((node, pos) => {
          if (at < 0 && node.type.name === COLUMNS && pos + node.nodeSize >= range.from) at = pos;
          return at < 0;
        });
        if (at >= 0 && dispatch) tr.setSelection(TextSelection.near(tr.doc.resolve(at + 3)));
        return true;
      })
      .run();
  };
