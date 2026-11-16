import { act } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { BASE_SLASH_ITEMS } from './baseSlash';
import { cleanWidth } from './extensions/layout';
import { mountEditor, setContent, typeText } from './testing/helpers';

const columns = (width?: string) => ({
  type: 'columns',
  ...(width ? { attrs: { width } } : {}),
  content: [
    { type: 'column', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Left' }] }] },
    { type: 'column', content: [{ type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Right' }] }] },
  ],
});

describe('columns', () => {
  it('holds ordinary blocks side by side and renders its width', async () => {
    const m = await mountEditor();
    await act(async () => setContent(m.editor, [columns('wide'), { type: 'paragraph' }]));
    const root = m.editor.view.dom.querySelector('.cl-columns')!;
    expect(root.getAttribute('data-width')).toBe('wide');
    expect([...root.querySelectorAll(':scope > .cl-column')].map((c) => c.textContent)).toEqual(['Left', 'Right']);
    expect(root.querySelector('.cl-column h2')?.textContent).toBe('Right');
    // the text width is the default and is not written out
    await act(async () => setContent(m.editor, [columns(), { type: 'paragraph' }]));
    expect(m.editor.view.dom.querySelector('.cl-columns')!.hasAttribute('data-width')).toBe(false);
    expect(m.editor.getJSON().content![0]!.attrs).toEqual({ width: 'text' });
  });

  it('the slash entries insert two or three empty columns with the caret in the first', async () => {
    for (const [id, count] of [['columns-2', 2], ['columns-3', 3]] as const) {
      const m = await mountEditor();
      m.editor.commands.focus();
      await act(async () => typeText(m.editor, '/col'));
      const item = BASE_SLASH_ITEMS.find((i) => i.id === id)!;
      const { from } = m.editor.state.selection;
      await act(async () => item.run(m.editor, { from: from - 4, to: from }));
      const doc = m.editor.getJSON().content!;
      const block = doc.find((n) => n.type === 'columns')!;
      expect(block.content).toHaveLength(count);
      expect(block.attrs).toEqual({ width: 'wide' });
      await act(async () => typeText(m.editor, 'Hi'));
      expect(m.editor.view.dom.querySelector('.cl-column')!.textContent).toBe('Hi');
      expect(doc[doc.length - 1]!.type).toBe('paragraph'); // a line to continue on after the columns
    }
  });
});

describe('block width', () => {
  it('accepts text, wide and full, and falls back to text', () => {
    expect([cleanWidth('wide'), cleanWidth('full'), cleanWidth('text'), cleanWidth('huge'), cleanWidth(null)]).toEqual(['wide', 'full', 'text', 'text', 'text']);
  });
});
