import { act, fireEvent, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { filterSlashItems } from './filter';
import { BASE_SLASH_ITEMS } from './baseSlash';
import { mountEditor, outline, pressKey, setContent, typeText } from './testing/helpers';

const titles = (query: string) => filterSlashItems(BASE_SLASH_ITEMS, query).map((i) => i.title);

describe('slash filtering', () => {
  it('an empty query keeps every item in order', () => {
    expect(titles('')).toHaveLength(BASE_SLASH_ITEMS.length);
  });
  it('matches titles by prefix first', () => {
    expect(titles('head')).toEqual(['Heading 1', 'Heading 2', 'Heading 3']);
  });
  it('matches keywords', () => {
    expect(titles('checkbox')).toEqual(['To-do list']);
    expect(titles('hr')).toContain('Divider');
  });
  it('matches fuzzily', () => {
    expect(titles('tdl')).toContain('To-do list');
    expect(titles('nmbrd')).toContain('Numbered list');
  });
  it('ranks a title prefix above a keyword hit', () => {
    expect(titles('code')[0]).toBe('Code block');
  });
  it('finds nothing for nonsense', () => {
    expect(titles('zzzq')).toEqual([]);
  });
});

async function openMenu(query = '') {
  const m = await mountEditor();
  m.editor.commands.focus();
  await act(async () => {
    typeText(m.editor, '/' + query);
  });
  return m;
}

describe('slash menu', () => {
  it('opens on "/" at the start of a block and lists the base blocks grouped', async () => {
    const m = await openMenu();
    expect(screen.getByRole('listbox')).toBeTruthy();
    expect(screen.getAllByRole('option')).toHaveLength(BASE_SLASH_ITEMS.length);
    expect(screen.getByText('Basic')).toBeTruthy();
    expect(screen.getByText('Lists')).toBeTruthy();
    m.unmount();
  });

  it('opens after a space but not in the middle of a word', async () => {
    const m = await mountEditor();
    m.editor.commands.focus();
    await act(async () => typeText(m.editor, 'a/'));
    expect(screen.queryByRole('listbox')).toBeNull();
    await act(async () => typeText(m.editor, ' /'));
    expect(screen.getByRole('listbox')).toBeTruthy();
    m.unmount();
  });

  it('filters while typing and shows an empty state', async () => {
    const m = await openMenu('head');
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toHaveLength(3);
    await act(async () => typeText(m.editor, 'zzz'));
    expect(screen.queryAllByRole('option')).toHaveLength(0);
    expect(screen.getByText('No matching blocks')).toBeTruthy();
    m.unmount();
  });

  it('Enter runs the highlighted item and removes the typed query', async () => {
    const m = await openMenu('head');
    await act(async () => {
      pressKey(m.editor, 'ArrowDown');
    });
    await act(async () => {
      pressKey(m.editor, 'Enter');
    });
    expect(outline(m.editor.getJSON())).toBe('h2()');
    expect(screen.queryByRole('listbox')).toBeNull();
    m.unmount();
  });

  it('ArrowUp wraps to the last item', async () => {
    const m = await openMenu();
    await act(async () => {
      pressKey(m.editor, 'ArrowUp');
    });
    const options = screen.getAllByRole('option');
    expect(options[options.length - 1]!.getAttribute('aria-selected')).toBe('true');
    m.unmount();
  });

  it('a click runs the item', async () => {
    const m = await openMenu('quote');
    await act(async () => {
      fireEvent.click(screen.getByRole('option', { name: /Quote/ }));
    });
    expect(outline(m.editor.getJSON())).toBe('blockquote(paragraph())');
    m.unmount();
  });

  it('Escape closes the menu and keeps the typed text', async () => {
    const m = await openMenu('hea');
    await act(async () => {
      pressKey(m.editor, 'Escape');
    });
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(outline(m.editor.getJSON())).toBe('paragraph(/hea)');
    m.unmount();
  });

  it('closes when the cursor leaves the query', async () => {
    const m = await openMenu('hea');
    await act(async () => {
      m.editor.commands.setTextSelection(1);
    });
    expect(screen.queryByRole('listbox')).toBeNull();
    m.unmount();
  });

  it('does not act on Enter while an IME composition is running', async () => {
    const m = await openMenu('head');
    const event = new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true, cancelable: true });
    await act(async () => {
      m.editor.view.someProp('handleKeyDown', (f) => f(m.editor.view, event));
    });
    expect(outline(m.editor.getJSON())).toBe('paragraph(/head)');
    m.unmount();
  });

  it('each base item turns the block into what it says', async () => {
    const expected: Record<string, string> = {
      Text: 'paragraph()',
      'Heading 1': 'h1()',
      'Heading 2': 'h2()',
      'Heading 3': 'h3()',
      Quote: 'blockquote(paragraph())',
      Divider: 'horizontalRule()',
      'Bullet list': 'bulletList(listItem(paragraph()))',
      'Numbered list': 'orderedList(listItem(paragraph()))',
      'To-do list': 'taskList(taskItem(paragraph()))',
      'Code block': 'codeBlock()',
      Callout: 'callout(paragraph())',
    };
    const m = await mountEditor();
    for (const [title, want] of Object.entries(expected)) {
      setContent(m.editor, [{ type: 'paragraph' }]);
      m.editor.commands.setTextSelection(1);
      const item = BASE_SLASH_ITEMS.find((i) => i.title === title)!;
      item.run(m.editor, { from: 1, to: 1 });
      const out = outline(m.editor.getJSON());
      expect(out.startsWith(want.replace(/\(\)$/, '')), `${title}: ${out}`).toBe(true);
    }
    m.unmount();
  });
});
