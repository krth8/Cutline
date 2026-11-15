import { describe, expect, it } from 'vitest';
import { normalizeUrl } from './Toolbar';
import { BLOCK_KINDS, currentBlockKind, setBlockKind } from './blocks';
import { mountEditor, outline, setContent } from './testing/helpers';

describe('normalizeUrl', () => {
  it.each([
    ['example.com', 'https://example.com'],
    ['  http://a.b/c  ', 'http://a.b/c'],
    ['mailto:a@b.c', 'mailto:a@b.c'],
    ['/p/abc/pages', '/p/abc/pages'],
    ['#section', '#section'],
    ['', ''],
  ])('%j -> %j', (input, expected) => {
    expect(normalizeUrl(input)).toBe(expected);
  });
});

describe('bubble toolbar actions', () => {
  it('marks toggle on the selected text', async () => {
    const m = await mountEditor();
    setContent(m.editor, [{ type: 'paragraph', content: [{ type: 'text', text: 'hello' }] }]);
    m.editor.commands.setTextSelection({ from: 1, to: 6 });
    m.editor.chain().focus().extendMarkRange('link').setLink({ href: 'https://example.com' }).run();
    expect(m.editor.getAttributes('link').href).toBe('https://example.com');
    for (const [cmd, mark] of [['toggleBold', 'bold'], ['toggleItalic', 'italic'], ['toggleStrike', 'strike'], ['toggleCode', 'code']] as const) {
      (m.editor.chain().focus() as any)[cmd]().run();
      expect(m.editor.isActive(mark), mark).toBe(true);
    }
    m.unmount();
  });

  it('"turn into" changes the block and reports the current kind', async () => {
    const m = await mountEditor();
    for (const k of BLOCK_KINDS) {
      setContent(m.editor, [{ type: 'paragraph', content: [{ type: 'text', text: 'x' }] }]);
      m.editor.commands.setTextSelection({ from: 1, to: 2 });
      setBlockKind(m.editor.chain().focus(), k.id).run();
      expect(currentBlockKind(m.editor), k.id).toBe(k.id);
    }
    setBlockKind(m.editor.chain().focus(), 'paragraph').run();
    expect(outline(m.editor.getJSON())).toBe('paragraph(x)');
    m.unmount();
  });
});
