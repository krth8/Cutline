/**
 * Layout of blocks on a page: how wide a block is, and blocks side by side.
 *
 * Width: text stays in the reading column; the blocks that hold data (views, charts, clips, columns) have a
 * `width` attribute: `text` (the reading column, the default), `wide` (up to 1200 px) or `full` (all the room
 * the page has). It is chosen in the block handle's menu.
 *
 * Columns: a `columns` node holds two to four `column` nodes, each with ordinary blocks inside. They share the
 * width equally and stack on a narrow screen.
 */
import { Extension, Node, mergeAttributes, type Editor, type Range } from '@tiptap/core';
import { TextSelection } from '@tiptap/pm/state';

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

/** One column: ordinary blocks. Only exists inside `columns`. */
export const Column = Node.create({
  name: COLUMN,
  content: 'block+',
  isolating: true,
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
});

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
