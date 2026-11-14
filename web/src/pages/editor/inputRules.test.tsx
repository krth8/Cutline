import { describe, expect, it } from 'vitest';
import { mountEditor, outline, pressKey, setContent, typeText } from './testing/helpers';

async function typed(text: string) {
  const m = await mountEditor();
  m.editor.commands.focus();
  typeText(m.editor, text);
  const result = { outline: outline(m.editor.getJSON()), json: m.editor.getJSON() as any };
  m.unmount();
  return result;
}

describe('markdown input rules', () => {
  const cases: Array<[string, string, string]> = [
    ['heading 1', '# Title', 'h1(Title)'],
    ['heading 2', '## Title', 'h2(Title)'],
    ['heading 3', '### Title', 'h3(Title)'],
    ['bullet list with -', '- item', 'bulletList(listItem(paragraph(item)))'],
    ['bullet list with *', '* item', 'bulletList(listItem(paragraph(item)))'],
    ['ordered list', '1. item', 'orderedList(listItem(paragraph(item)))'],
    ['task item []', '[] todo', 'taskList(taskItem(paragraph(todo)))'],
    ['task item [ ]', '[ ] todo', 'taskList(taskItem(paragraph(todo)))'],
    ['task item [x]', '[x] done', 'taskList(taskItem(paragraph(done)))'],
    ['blockquote', '> quoted', 'blockquote(paragraph(quoted))'],
    ['code block', '``` code', 'codeBlock(code)'],
    ['callout', '!> note', 'callout(paragraph(note))'],
    ['bold', '**bold** x', 'paragraph(<bold>bold x)'],
    ['italic', '*it* x', 'paragraph(<italic>it x)'],
    ['strike', '~~gone~~ x', 'paragraph(<strike>gone x)'],
    ['inline code', 'a `code` x', 'paragraph(a <code>code x)'],
  ];

  it.each(cases)('%s', async (_name, input, expected) => {
    const r = await typed(input);
    // Marks stay open after the rule fires, so what follows the rule is marked too: compare the structure only
    expect(r.outline.replace(/<[a-z]+>/g, (m) => (expected.includes(m) ? m : ''))).toBe(expected);
  });

  it('[x] makes a checked task item, [ ] an unchecked one', async () => {
    const checked = await typed('[x] done');
    const open = await typed('[ ] todo');
    expect(checked.json.content?.[0]?.content?.[0]?.attrs?.checked).toBe(true);
    expect(open.json.content?.[0]?.content?.[0]?.attrs?.checked).toBe(false);
  });

  it('--- makes a horizontal rule', async () => {
    const r = await typed('---');
    expect(r.json.content?.map((n: any) => n.type)).toContain('horizontalRule');
  });
});

describe('keyboard', () => {
  it('Mod+Alt+1..3 set headings', async () => {
    const m = await mountEditor();
    for (const level of [1, 2, 3]) {
      setContent(m.editor, [{ type: 'paragraph', content: [{ type: 'text', text: 'x' }] }]);
      pressKey(m.editor, String(level), { ctrl: true, alt: true });
      expect(outline(m.editor.getJSON())).toBe(`h${level}(x)`);
    }
    m.unmount();
  });

  it('Mod+Shift+7/8/9 set ordered, bullet and task lists', async () => {
    const m = await mountEditor();
    const expected: Record<string, string> = { '7': 'orderedList', '8': 'bulletList', '9': 'taskList' };
    for (const key of ['7', '8', '9']) {
      setContent(m.editor, [{ type: 'paragraph', content: [{ type: 'text', text: 'x' }] }]);
      pressKey(m.editor, key, { ctrl: true, shift: true });
      expect(m.editor.getJSON().content?.[0]?.type).toBe(expected[key]);
      m.editor.commands.clearNodes();
    }
    m.unmount();
  });

  it('Tab nests a list item, Shift+Tab lifts it back', async () => {
    const m = await mountEditor();
    m.editor.commands.focus();
    typeText(m.editor, '- a');
    pressKey(m.editor, 'Enter');
    typeText(m.editor, 'b');
    expect(pressKey(m.editor, 'Tab')).toBe(true);
    expect(outline(m.editor.getJSON())).toBe('bulletList(listItem(paragraph(a) bulletList(listItem(paragraph(b)))))');
    pressKey(m.editor, 'Tab', { shift: true });
    expect(outline(m.editor.getJSON())).toBe('bulletList(listItem(paragraph(a)) listItem(paragraph(b)))');
    m.unmount();
  });

  it('Tab nests a task item', async () => {
    const m = await mountEditor();
    m.editor.commands.focus();
    typeText(m.editor, '[ ] a');
    pressKey(m.editor, 'Enter');
    typeText(m.editor, 'b');
    pressKey(m.editor, 'Tab');
    expect(outline(m.editor.getJSON())).toBe('taskList(taskItem(paragraph(a) taskList(taskItem(paragraph(b)))))');
    m.unmount();
  });

  it('Enter on an empty list item exits the list', async () => {
    const m = await mountEditor();
    m.editor.commands.focus();
    typeText(m.editor, '- a');
    pressKey(m.editor, 'Enter');
    pressKey(m.editor, 'Enter');
    expect(outline(m.editor.getJSON())).toBe('bulletList(listItem(paragraph(a))) paragraph()');
    m.unmount();
  });

  it('Backspace at the start of a heading turns it into a paragraph', async () => {
    const m = await mountEditor();
    m.editor.commands.focus();
    typeText(m.editor, '## T');
    m.editor.commands.setTextSelection(m.editor.state.selection.$from.start());
    expect(pressKey(m.editor, 'Backspace')).toBe(true);
    expect(outline(m.editor.getJSON())).toBe('paragraph(T)');
    m.unmount();
  });

  it('Backspace at the start of a quote or callout turns it into a paragraph', async () => {
    for (const [input, name] of [['> q', 'blockquote'], ['!> q', 'callout']] as const) {
      const m = await mountEditor();
      m.editor.commands.focus();
      typeText(m.editor, input);
      m.editor.commands.setTextSelection(m.editor.state.selection.$from.start());
      expect(pressKey(m.editor, 'Backspace')).toBe(true);
      expect(outline(m.editor.getJSON())).toBe('paragraph(q)');
      expect(name).toBeTruthy();
      m.unmount();
    }
  });
});
