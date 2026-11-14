import { describe, expect, it } from 'vitest';
import { looksLikeMarkdown } from './extensions/markdownPaste';
import { mountEditor, outline, paste, setContent } from './testing/helpers';

async function pasted(data: { text?: string; html?: string }) {
  const m = await mountEditor();
  m.editor.commands.focus();
  paste(m.editor, data);
  const result = { outline: outline(m.editor.getJSON()), json: m.editor.getJSON() as any };
  m.unmount();
  return result;
}

describe('markdown paste', () => {
  const cases: Array<[string, string, string]> = [
    ['heading', '# Title\n\nbody', 'h1(Title) paragraph(body)'],
    ['level 3 heading', '### Small', 'h3(Small)'],
    ['bullet list', '- a\n- b', 'bulletList(listItem(paragraph(a)) listItem(paragraph(b)))'],
    ['numbered list', '1. a\n2. b', 'orderedList(listItem(paragraph(a)) listItem(paragraph(b)))'],
    ['task list', '- [ ] a\n- [x] b', 'taskList(taskItem(paragraph(a)) taskItem(paragraph(b)))'],
    ['quote', '> wise words', 'blockquote(paragraph(wise words))'],
    ['code fence', '```\nlet a = 1\n```', 'codeBlock(let a = 1)'],
    ['emphasis', 'some **bold** and *it* and ~~old~~', 'paragraph(some <bold>bold and <italic>it and <strike>old)'],
    ['inline code', 'run `npm test` now', 'paragraph(run <code>npm test now)'],
    ['link', 'see [the docs](https://example.com/x) now', 'paragraph(see <link>the docs now)'],
    ['rule', 'a\n\n---\n\nb', 'paragraph(a) horizontalRule() paragraph(b)'],
  ];

  it.each(cases)('%s', async (_name, text, expected) => {
    const r = await pasted({ text });
    expect(r.outline).toBe(expected);
  });

  it('keeps the link target', async () => {
    const r = await pasted({ text: '[docs](https://example.com/x)' });
    const mark = r.json.content?.[0]?.content?.[0]?.marks?.[0];
    expect(mark?.type).toBe('link');
    expect(mark?.attrs?.href).toBe('https://example.com/x');
  });

  it('leaves ordinary prose alone', async () => {
    const r = await pasted({ text: 'just a sentence, nothing special' });
    expect(r.outline).toBe('paragraph(just a sentence, nothing special)');
  });

  it('pastes plain text inside a code block without converting it', async () => {
    const m = await mountEditor();
    setContent(m.editor, [{ type: 'codeBlock', content: [{ type: 'text', text: 'x' }] }]);
    m.editor.commands.setTextSelection(2);
    paste(m.editor, { text: '# not a heading' });
    expect(outline(m.editor.getJSON())).toBe('codeBlock(x# not a heading)');
    m.unmount();
  });
});

describe('html paste', () => {
  const cases: Array<[string, string, string]> = [
    ['structure is kept', '<h2>Head</h2><p>text</p><ul><li>a</li><li>b</li></ul>', 'h2(Head) paragraph(text) bulletList(listItem(paragraph(a)) listItem(paragraph(b)))'],
    ['styles are dropped', '<p style="color:red;font-size:30px"><span style="font-family:Comic Sans">plain</span></p>', 'paragraph(plain)'],
    ['marks survive', '<p><strong>b</strong> <em>i</em> <a href="https://e.com">l</a></p>', 'paragraph(<bold>b <italic>i <link>l)'],
    ['quote and code', '<blockquote><p>q</p></blockquote><pre><code>c</code></pre>', 'blockquote(paragraph(q)) codeBlock(c)'],
  ];

  it.each(cases)('%s', async (_name, html, expected) => {
    const r = await pasted({ html, text: 'ignored' });
    expect(r.outline).toBe(expected);
  });

  it('does not store style attributes anywhere in the document', async () => {
    const r = await pasted({ html: '<p style="color:red"><span style="color:blue">x</span></p>', text: 'x' });
    expect(JSON.stringify(r.json)).not.toMatch(/style|color/);
  });
});

describe('url paste', () => {
  it('a URL pasted over a selection makes a link', async () => {
    const m = await mountEditor();
    setContent(m.editor, [{ type: 'paragraph', content: [{ type: 'text', text: 'click here' }] }]);
    m.editor.commands.selectAll();
    paste(m.editor, { text: 'https://example.com/page' });
    const node = (m.editor.getJSON() as any).content?.[0]?.content?.[0];
    expect(node?.text).toBe('click here');
    expect(node?.marks?.[0]?.type).toBe('link');
    expect(node?.marks?.[0]?.attrs?.href).toBe('https://example.com/page');
    m.unmount();
  });
});

describe('looksLikeMarkdown', () => {
  it.each([
    ['# h', true],
    ['- a', true],
    ['1. a', true],
    ['**b**', true],
    ['[a](http://x.y)', true],
    ['plain words', false],
    ['https://example.com', false],
    ['2 * 3 * 4', false],
    ['', false],
  ])('%j -> %s', (text, expected) => {
    expect(looksLikeMarkdown(text)).toBe(expected);
  });
});
