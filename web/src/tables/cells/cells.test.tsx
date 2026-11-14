import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import type { Column, ColumnType } from '../types';
import { CellHost, CellsDemo, getCell, setCellClock, type CellEditorProps } from './index';

const col = (type: ColumnType, extra: Partial<Column> = {}): Column => ({ key: type, name: type, type, builtin: false, ...extra });

const STATUS = [
  { value: 'todo', label: 'To do', color: '#6b7280' },
  { value: 'doing', label: 'In progress', color: '#3b82f6' },
  { value: 'done', label: 'Done', color: '#fde047' },
];
const USERS = [
  { value: 'u1', label: 'Ada Lovelace' },
  { value: 'u2', label: 'Grace Hopper' },
  { value: 'u3', label: 'Alan Turing' },
  { value: 'u4', label: 'Linus Torvalds' },
  { value: 'u5', label: 'Margaret Hamilton' },
];

beforeEach(() => setCellClock(() => new Date(2026, 5, 15, 10, 0, 0))); // Monday 2026-06-15
afterEach(() => setCellClock(null));

function setupEditor(column: Column, value: unknown, extra: Partial<CellEditorProps> = {}) {
  const user = userEvent.setup();
  const onCommit = vi.fn();
  const onCancel = vi.fn();
  const Editor = getCell(column.type).Editor;
  const utils = render(<Editor column={column} value={value} onCommit={onCommit} onCancel={onCancel} {...extra} />);
  return { user, onCommit, onCancel, ...utils };
}

function renderDisplay(column: Column, value: unknown, extra: Record<string, unknown> = {}) {
  const Display = getCell(column.type).Display;
  return render(<Display column={column} value={value} {...extra} />);
}

describe('displays', () => {
  it.each<[ColumnType, unknown]>([
    ['text', null], ['longtext', ''], ['number', null], ['date', null], ['select', null], ['multiselect', []], ['status', null],
    ['priority', null], ['person', null], ['people', []], ['url', ''], ['clip', null], ['relation', []], ['formula', null],
  ])('%s shows a subtle placeholder when empty', (type, value) => {
    renderDisplay(col(type, { options: STATUS }), value);
    expect(screen.getByLabelText('Empty')).toBeTruthy();
  });

  it('text shows the value with a tooltip for truncated text', () => {
    renderDisplay(col('text'), 'A long title');
    expect(screen.getByText('A long title').getAttribute('title')).toBe('A long title');
  });

  it('number is formatted and right-aligned', () => {
    const { container } = renderDisplay(col('number', { config: { decimals: 2 } }), 1234.5);
    expect(container.textContent).toMatch(/1.?234[.,]50/);
    expect(container.querySelector('.cl-cell--end')).toBeTruthy();
  });

  it('url is a safe external link, javascript: stays text', () => {
    const { unmount } = renderDisplay(col('url'), 'example.com/x');
    const a = screen.getByRole('link') as HTMLAnchorElement;
    expect(a.href).toBe('https://example.com/x');
    expect(a.target).toBe('_blank');
    expect(a.rel).toContain('noopener');
    unmount();
    renderDisplay(col('url'), 'javascript:alert(1)');
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('checkbox toggles directly when onToggle is given and is read-only otherwise', async () => {
    const user = userEvent.setup();
    const onToggle = vi.fn();
    const { unmount } = renderDisplay(col('checkbox'), false, { onToggle });
    await user.click(screen.getByRole('checkbox'));
    expect(onToggle).toHaveBeenCalledWith(true);
    unmount();
    renderDisplay(col('checkbox'), true);
    expect((screen.getByRole('checkbox') as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(true);
  });

  it('status pill uses the option colour with a readable text colour', () => {
    renderDisplay(col('status', { options: STATUS }), 'doing');
    const pill = screen.getByText('In progress').closest('.cl-pill') as HTMLElement;
    expect(pill.style.background).toBe('rgb(59, 130, 246)');
    expect(pill.style.color).toBe('rgb(0, 0, 0)'); // black beats white on this blue
    renderDisplay(col('status', { options: STATUS }), 'done');
    expect((screen.getByText('Done').closest('.cl-pill') as HTMLElement).style.color).toBe('rgb(0, 0, 0)');
    renderDisplay(col('status', { options: STATUS }), 'todo');
    expect((screen.getByText('To do').closest('.cl-pill') as HTMLElement).style.color).toBe('rgb(255, 255, 255)');
  });

  it('shows an unknown option value as plain text', () => {
    renderDisplay(col('select', { options: STATUS }), 'gone');
    expect(screen.getByText('gone').closest('.cl-pill--neutral')).toBeTruthy();
  });

  it('multiselect shows one pill per value', () => {
    renderDisplay(col('multiselect', { options: STATUS }), ['todo', 'done']);
    expect(screen.getByText('To do')).toBeTruthy();
    expect(screen.getByText('Done')).toBeTruthy();
  });

  it('person shows avatar with initials (or the profile image) and the name', () => {
    const { container } = renderDisplay(col('person', { options: USERS, config: { avatars: { u2: '/img/grace.png' } } }), 'u2');
    expect(screen.getAllByText('Grace Hopper').length).toBeGreaterThan(0);
    expect(container.querySelector('img')?.getAttribute('src')).toBe('/img/grace.png');
    renderDisplay(col('person', { options: USERS }), 'u1');
    expect(screen.getByText('AL')).toBeTruthy();
  });

  it('person in compact mode shows only the avatar', () => {
    renderDisplay(col('person', { options: USERS }), 'u1', { compact: true });
    expect(screen.queryByText('Ada Lovelace')).toBeNull();
    expect(screen.getByRole('img', { name: 'Ada Lovelace' })).toBeTruthy();
  });

  it('people collapses the overflow into "+N"', () => {
    renderDisplay(col('people', { options: USERS }), ['u1', 'u2', 'u3', 'u4', 'u5']);
    expect(screen.getAllByRole('img')).toHaveLength(4);
    expect(screen.getByText('+1')).toBeTruthy();
    renderDisplay(col('people', { options: USERS, config: { maxAvatars: 2 } }), ['u1', 'u2', 'u3', 'u4', 'u5']);
    expect(screen.getByText('+3')).toBeTruthy();
  });

  it('people with an unknown user id does not crash', () => {
    renderDisplay(col('people', { options: USERS }), ['u1', 'ghost']);
    expect(screen.getAllByRole('img')).toHaveLength(2);
  });

  it('clip shows the base name and version', () => {
    renderDisplay(col('clip'), { baseName: 'sh010', version: 3 });
    expect(screen.getByText('sh010')).toBeTruthy();
    expect(screen.getByText('v3')).toBeTruthy();
  });

  it('relation shows a count; formula shows number, text and booleans', () => {
    renderDisplay(col('relation'), ['a', 'b']);
    expect(screen.getByText('2 linked rows')).toBeTruthy();
    renderDisplay(col('formula'), 'abc');
    expect(screen.getByText('abc')).toBeTruthy();
    renderDisplay(col('formula'), true);
    expect(screen.getByText('✓')).toBeTruthy();
  });
});

describe('date display', () => {
  it('shows Today and Tomorrow', () => {
    const { container, rerender } = renderDisplay(col('date'), '2026-06-15');
    expect(screen.getByText('Today')).toBeTruthy();
    const D = getCell('date').Display;
    rerender(<D column={col('date')} value="2026-06-16" />);
    expect(container.textContent).toBe('Tomorrow');
  });

  it('marks overdue dates in the danger style, but not future dates or read-only columns', () => {
    const { container, rerender } = renderDisplay(col('date'), '2026-06-01');
    expect(container.querySelector('.is-overdue')).toBeTruthy();
    const D = getCell('date').Display;
    rerender(<D column={col('date')} value="2026-06-30" />);
    expect(container.querySelector('.is-overdue')).toBeNull();
    rerender(<D column={col('date', { readonly: true })} value="2026-06-01" />);
    expect(container.querySelector('.is-overdue')).toBeNull();
    rerender(<D column={col('date', { readonly: true, config: { overdue: true } })} value="2026-06-01" />);
    expect(container.querySelector('.is-overdue')).toBeTruthy();
  });

  it('shows the year only when it differs', () => {
    const { container, rerender } = renderDisplay(col('date'), '2026-08-20');
    expect(container.textContent).not.toContain('2026');
    const D = getCell('date').Display;
    rerender(<D column={col('date')} value="2027-08-20" />);
    expect(container.textContent).toContain('2027');
  });
});

describe('text-like editors', () => {
  it.each<ColumnType>(['text', 'url', 'clip'])('%s: typing and Enter commits, Escape cancels, nothing is reported twice', async (type) => {
    const { user, onCommit, onCancel } = setupEditor(col(type), null);
    const input = screen.getByRole('textbox');
    expect(document.activeElement).toBe(input);
    await user.type(input, 'abc{Enter}');
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith(type === 'clip' ? { baseName: 'abc' } : 'abc');
    await user.tab(); // blur after Enter must not commit again
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('Escape cancels without committing', async () => {
    const { user, onCommit, onCancel } = setupEditor(col('text'), 'old');
    await user.type(screen.getByRole('textbox'), 'x{Escape}');
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('Tab commits and is not trapped', async () => {
    const user = userEvent.setup();
    const onCommit = vi.fn();
    const Editor = getCell('text').Editor;
    render(
      <>
        <Editor column={col('text')} value="a" onCommit={onCommit} onCancel={() => {}} />
        <button>next</button>
      </>,
    );
    await user.type(screen.getByRole('textbox'), 'b');
    await user.tab();
    expect(onCommit).toHaveBeenCalledWith('ab');
    expect(document.activeElement).toBe(screen.getByText('next'));
  });

  it('selects the old text on focus so typing replaces it', async () => {
    const { user, onCommit } = setupEditor(col('text'), 'old');
    await user.keyboard('new{Enter}');
    expect(onCommit).toHaveBeenCalledWith('new');
  });

  it('a click outside commits', async () => {
    const { user, onCommit } = setupEditor(col('text'), 'a');
    await user.type(screen.getByRole('textbox'), 'b');
    await user.click(document.body);
    expect(onCommit).toHaveBeenCalledWith('ab');
  });

  it('initialKey replaces the value', async () => {
    const { user, onCommit } = setupEditor(col('text'), 'old', { initialKey: 'x' });
    expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe('x');
    await user.keyboard('yz{Enter}');
    expect(onCommit).toHaveBeenCalledWith('xyz');
  });

  it('empty text commits null', async () => {
    const { user, onCommit } = setupEditor(col('text'), 'old');
    await user.clear(screen.getByRole('textbox'));
    await user.keyboard('{Enter}');
    expect(onCommit).toHaveBeenCalledWith(null);
  });

  it('url trims', async () => {
    const { user, onCommit } = setupEditor(col('url'), null);
    await user.type(screen.getByRole('textbox'), '  https://a.b  {Enter}');
    expect(onCommit).toHaveBeenCalledWith('https://a.b');
  });

  it('autoFocus=false leaves focus alone', () => {
    setupEditor(col('text'), 'a', { autoFocus: false });
    expect(document.activeElement).toBe(document.body);
  });

  it('clip understands a version suffix', async () => {
    const { user, onCommit } = setupEditor(col('clip'), null);
    await user.type(screen.getByRole('textbox'), 'sh010_anim v4{Enter}');
    expect(onCommit).toHaveBeenCalledWith({ baseName: 'sh010_anim', version: 4 });
  });
});

describe('number editor', () => {
  it.each([
    ['1,5', 1.5],
    ['1.5', 1.5],
    ['-3', -3],
    ['', null],
  ])('%j commits %j', async (typed, expected) => {
    const { user, onCommit } = setupEditor(col('number'), 7);
    await user.clear(screen.getByRole('textbox'));
    if (typed) await user.type(screen.getByRole('textbox'), typed);
    await user.keyboard('{Enter}');
    expect(onCommit).toHaveBeenCalledWith(expected);
  });

  it('rejects garbage, restores the old value and commits nothing', async () => {
    const { user, onCommit, onCancel } = setupEditor(col('number'), 7);
    await user.clear(screen.getByRole('textbox'));
    await user.type(screen.getByRole('textbox'), 'abc{Enter}');
    expect(onCommit).not.toHaveBeenCalled();
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe('7');
  });

  it('rejects garbage on blur too', async () => {
    const { user, onCommit, onCancel } = setupEditor(col('number'), 7);
    await user.type(screen.getByRole('textbox'), '1x');
    await user.click(document.body);
    expect(onCommit).not.toHaveBeenCalled();
    expect(onCancel).toHaveBeenCalled();
  });

  it('initialKey starts with the typed digit', async () => {
    const { user, onCommit } = setupEditor(col('number'), 7, { initialKey: '4' });
    await user.keyboard('2{Enter}');
    expect(onCommit).toHaveBeenCalledWith(42);
  });
});

describe('longtext editor', () => {
  it('Enter commits, Shift+Enter inserts a newline', async () => {
    const { user, onCommit } = setupEditor(col('longtext'), null);
    await user.type(screen.getByRole('textbox'), 'line one{Shift>}{Enter}{/Shift}line two{Enter}');
    expect(onCommit).toHaveBeenCalledWith('line one\nline two');
  });

  it('grows with its content', async () => {
    const { user } = setupEditor(col('longtext'), null);
    const ta = screen.getByRole('textbox') as HTMLTextAreaElement;
    Object.defineProperty(ta, 'scrollHeight', { configurable: true, get: () => 20 + ta.value.split('\n').length * 20 });
    await user.type(ta, 'a{Shift>}{Enter}{/Shift}b{Shift>}{Enter}{/Shift}c');
    expect(ta.style.height).toBe('80px');
  });

  it('Escape cancels', async () => {
    const { user, onCancel, onCommit } = setupEditor(col('longtext'), 'x');
    await user.keyboard('{Escape}');
    expect(onCancel).toHaveBeenCalled();
    expect(onCommit).not.toHaveBeenCalled();
  });
});

describe('checkbox editor', () => {
  it('Space toggles and commits, Escape cancels', async () => {
    const { user, onCommit } = setupEditor(col('checkbox'), false);
    await user.keyboard(' ');
    expect(onCommit).toHaveBeenCalledWith(true);
  });

  it('Enter toggles', async () => {
    const { user, onCommit } = setupEditor(col('checkbox'), true);
    await user.keyboard('{Enter}');
    expect(onCommit).toHaveBeenCalledWith(false);
  });

  it('Escape cancels', async () => {
    const { user, onCommit, onCancel } = setupEditor(col('checkbox'), true);
    await user.keyboard('{Escape}');
    expect(onCancel).toHaveBeenCalled();
    expect(onCommit).not.toHaveBeenCalled();
  });
});

describe('date editor', () => {
  it('typing a date and pressing Enter commits it', async () => {
    const { user, onCommit } = setupEditor(col('date'), null);
    await user.type(screen.getByLabelText('date date'), '2026-07-04{Enter}');
    expect(onCommit).toHaveBeenCalledWith('2026-07-04');
  });

  it('understands typed day.month.year and keywords', async () => {
    const { user, onCommit } = setupEditor(col('date'), null);
    await user.type(screen.getByLabelText('date date'), '4.7.2026{Enter}');
    expect(onCommit).toHaveBeenCalledWith('2026-07-04');
  });

  it('keeps the popover open and marks invalid text instead of committing', async () => {
    const { user, onCommit, onCancel } = setupEditor(col('date'), null);
    const input = screen.getByLabelText('date date');
    await user.type(input, '2026-13-45{Enter}');
    expect(onCommit).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();
    expect(input.getAttribute('aria-invalid')).toBe('true');
  });

  it('quick choices use the injected clock', async () => {
    for (const [label, expected] of [['Today', '2026-06-15'], ['Tomorrow', '2026-06-16'], ['Next week', '2026-06-22'], ['Clear', null]] as const) {
      const { user, onCommit, unmount } = setupEditor(col('date'), '2026-01-01');
      await user.click(screen.getByRole('button', { name: label }));
      expect(onCommit, label).toHaveBeenCalledWith(expected);
      unmount();
    }
  });

  it('picking a day in the calendar commits it', async () => {
    const { user, onCommit } = setupEditor(col('date'), '2026-06-10');
    await user.click(screen.getByRole('button', { name: '20 June 2026' }));
    expect(onCommit).toHaveBeenCalledWith('2026-06-20');
  });

  it('ArrowDown moves into the calendar and Enter picks the focused day', async () => {
    const { user, onCommit } = setupEditor(col('date'), '2026-06-10');
    await user.keyboard('{ArrowDown}{ArrowRight}{Enter}');
    expect(onCommit).toHaveBeenCalledWith('2026-06-11');
  });

  it('Escape cancels, Tab commits typed text', async () => {
    const a = setupEditor(col('date'), '2026-06-10');
    await a.user.keyboard('{Escape}');
    expect(a.onCancel).toHaveBeenCalled();
    a.unmount();
    const b = setupEditor(col('date'), '2026-06-10', { initialKey: '2' });
    expect((screen.getByLabelText('date date') as HTMLInputElement).value).toBe('2');
    await b.user.keyboard('026-02-03{Tab}');
    expect(b.onCommit).toHaveBeenCalledWith('2026-02-03');
  });

  it('a click outside closes without a change', async () => {
    const { user, onCommit, onCancel } = setupEditor(col('date'), '2026-06-10');
    await user.click(document.body);
    expect(onCancel).toHaveBeenCalled();
    expect(onCommit).not.toHaveBeenCalled();
  });
});

describe('select-like editors', () => {
  it.each<ColumnType>(['select', 'status', 'priority'])('%s: click commits the option value', async (type) => {
    const { user, onCommit } = setupEditor(col(type, { options: STATUS }), null);
    await user.click(screen.getByRole('option', { name: /In progress/ }));
    expect(onCommit).toHaveBeenCalledWith('doing');
  });

  it('type-to-filter and Enter picks the first match', async () => {
    const { user, onCommit } = setupEditor(col('status', { options: STATUS }), null);
    await user.keyboard('prog');
    expect(screen.getAllByRole('option')).toHaveLength(1);
    await user.keyboard('{Enter}');
    expect(onCommit).toHaveBeenCalledWith('doing');
  });

  it('arrow keys move the highlight and Enter picks it', async () => {
    const { user, onCommit } = setupEditor(col('status', { options: STATUS }), null);
    await user.keyboard('{ArrowDown}{Enter}'); // starts on the first option (To do)
    expect(onCommit).toHaveBeenCalledWith('doing');
  });

  it('starts on the current value', async () => {
    const { user, onCommit } = setupEditor(col('status', { options: STATUS }), 'doing');
    await user.keyboard('{Enter}');
    expect(onCommit).toHaveBeenCalledWith('doing');
  });

  it('has a clear entry that commits null', async () => {
    const { user, onCommit } = setupEditor(col('status', { options: STATUS }), 'doing');
    await user.click(screen.getByRole('option', { name: 'None' }));
    expect(onCommit).toHaveBeenCalledWith(null);
  });

  it('shows the no-match state', async () => {
    const { user } = setupEditor(col('status', { options: STATUS }), null);
    await user.keyboard('zzz');
    expect(screen.getByText('No match')).toBeTruthy();
  });

  it('Escape and a click outside cancel', async () => {
    const a = setupEditor(col('status', { options: STATUS }), 'doing');
    await a.user.keyboard('{Escape}');
    expect(a.onCancel).toHaveBeenCalledTimes(1);
    expect(a.onCommit).not.toHaveBeenCalled();
    a.unmount();
    const b = setupEditor(col('status', { options: STATUS }), 'doing');
    await b.user.click(document.body);
    expect(b.onCancel).toHaveBeenCalledTimes(1);
  });

  it('Tab reports the unchanged value and does not trap focus', async () => {
    const { user, onCommit } = setupEditor(col('status', { options: STATUS }), 'doing');
    await user.tab();
    expect(onCommit).toHaveBeenCalledWith('doing');
  });

  it('Tab after filtering picks the highlighted match', async () => {
    const { user, onCommit } = setupEditor(col('status', { options: STATUS }), null);
    await user.keyboard('don{Tab}');
    expect(onCommit).toHaveBeenCalledWith('done');
  });

  it('initialKey filters the list', async () => {
    setupEditor(col('status', { options: STATUS }), null, { initialKey: 't' });
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['To do']);
  });

  it('shows colours in the list', () => {
    setupEditor(col('status', { options: STATUS }), null);
    const list = screen.getByRole('listbox');
    expect(list.querySelectorAll('.cl-pill').length).toBe(3);
  });

  it('person picker lists names with avatars and commits the user id', async () => {
    const { user, onCommit } = setupEditor(col('person', { options: USERS }), null);
    await user.keyboard('turing');
    await user.keyboard('{Enter}');
    expect(onCommit).toHaveBeenCalledWith('u3');
  });
});

describe('multi-select editors', () => {
  it.each<ColumnType>(['multiselect', 'people'])('%s: clicks toggle, Escape commits the selection', async (type) => {
    const options = type === 'people' ? USERS : STATUS;
    const first = options[0]!;
    const second = options[1]!;
    const { user, onCommit, onCancel } = setupEditor(col(type, { options }), [second.value]);
    await user.click(screen.getByRole('option', { name: new RegExp(first.label) }));
    await user.click(screen.getByRole('option', { name: new RegExp(second.label) }));
    expect(onCommit).not.toHaveBeenCalled();
    await user.keyboard('{Escape}');
    expect(onCommit).toHaveBeenCalledWith([first.value]);
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('shows checkmarks for the selected entries', () => {
    setupEditor(col('multiselect', { options: STATUS }), ['done']);
    const sel = screen.getAllByRole('option').filter((o) => o.getAttribute('aria-selected') === 'true');
    expect(sel).toHaveLength(1);
    expect(within(sel[0]!).getByText('✓')).toBeTruthy();
  });

  it('Space toggles the highlighted entry and Enter commits', async () => {
    const { user, onCommit } = setupEditor(col('multiselect', { options: STATUS }), []);
    await user.keyboard(' '); // starts on the first option
    await user.keyboard('{ArrowDown} ');
    await user.keyboard('{Enter}');
    expect(onCommit).toHaveBeenCalledWith(['todo', 'doing']);
  });

  it('with filter text Enter toggles the match and clears the text', async () => {
    const { user, onCommit } = setupEditor(col('people', { options: USERS }), ['u1']);
    await user.keyboard('turing{Enter}');
    expect(onCommit).not.toHaveBeenCalled();
    expect((screen.getByRole('combobox') as HTMLInputElement).value).toBe('');
    await user.keyboard('{Enter}');
    expect(onCommit).toHaveBeenCalledWith(['u1', 'u3']);
  });

  it('a click outside commits (close = commit)', async () => {
    const { user, onCommit } = setupEditor(col('people', { options: USERS }), ['u1']);
    await user.click(screen.getByRole('option', { name: /Grace/ }));
    await user.click(document.body);
    expect(onCommit).toHaveBeenCalledWith(['u1', 'u2']);
  });

  it('Clear all empties the selection', async () => {
    const { user, onCommit } = setupEditor(col('people', { options: USERS }), ['u1', 'u2']);
    await user.click(screen.getByRole('option', { name: 'Clear all' }));
    await user.keyboard('{Enter}');
    expect(onCommit).toHaveBeenCalledWith([]);
  });

  it('Tab commits and does not trap', async () => {
    const { user, onCommit } = setupEditor(col('people', { options: USERS }), ['u1']);
    await user.tab();
    expect(onCommit).toHaveBeenCalledWith(['u1']);
  });
});

describe('readonly editors', () => {
  it.each<ColumnType>(['formula', 'relation'])('%s leaves immediately', (type) => {
    const { onCancel, onCommit } = setupEditor(col(type), null);
    expect(onCancel).toHaveBeenCalled();
    expect(onCommit).not.toHaveBeenCalled();
  });
});

describe('registry: toText / parseText / isEmpty / compare', () => {
  const cases: Array<[Column, unknown]> = [
    [col('text'), 'Hello, world'],
    [col('longtext'), 'a\nb'],
    [col('url'), 'https://example.com/a?b=1'],
    [col('number'), 12.5],
    [col('number'), -3],
    [col('checkbox'), true],
    [col('checkbox'), false],
    [col('date'), '2026-02-28'],
    [col('select', { options: STATUS }), 'doing'],
    [col('status', { options: STATUS }), 'todo'],
    [col('priority', { options: STATUS }), 'done'],
    [col('multiselect', { options: STATUS }), ['todo', 'done']],
    [col('person', { options: USERS }), 'u2'],
    [col('people', { options: USERS }), ['u1', 'u3']],
    [col('clip'), { baseName: 'sh010_anim', version: 3 }],
    [col('clip'), { baseName: 'sh010_anim' }],
  ];

  it.each(cases)('round trips %j via text', (column, value) => {
    const cell = getCell(column.type);
    const parsed = cell.parseText!(cell.toText(value, column), column);
    expect(parsed).toEqual({ value });
  });

  it('empty values parse to the empty value', () => {
    expect(getCell('text').parseText!('', col('text'))).toEqual({ value: null });
    expect(getCell('number').parseText!('', col('number'))).toEqual({ value: null });
    expect(getCell('multiselect').parseText!('', col('multiselect'))).toEqual({ value: [] });
    expect(getCell('date').parseText!('', col('date'))).toEqual({ value: null });
    expect(getCell('clip').parseText!('', col('clip'))).toEqual({ value: null });
  });

  it('parseText reports invalid input as null', () => {
    expect(getCell('number').parseText!('abc', col('number'))).toBeNull();
    expect(getCell('date').parseText!('someday', col('date'))).toBeNull();
    expect(getCell('status').parseText!('nope', col('status', { options: STATUS }))).toBeNull();
    expect(getCell('people').parseText!('Ada Lovelace, Nobody', col('people', { options: USERS }))).toBeNull();
    expect(getCell('checkbox').parseText!('maybe', col('checkbox'))).toBeNull();
  });

  it('toText uses labels, and parseText accepts labels case-insensitively', () => {
    const c = col('status', { options: STATUS });
    expect(getCell('status').toText('doing', c)).toBe('In progress');
    expect(getCell('status').parseText!('in PROGRESS', c)).toEqual({ value: 'doing' });
    expect(getCell('people').toText(['u1', 'u2'], col('people', { options: USERS }))).toBe('Ada Lovelace, Grace Hopper');
  });

  it('read-only types have no parseText', () => {
    expect(getCell('formula').parseText).toBeUndefined();
    expect(getCell('relation').parseText).toBeUndefined();
    expect(getCell('formula').toText(1.5, col('formula'))).toMatch(/1[.,]5/);
    expect(getCell('relation').toText(['a', 'b'], col('relation'))).toBe('a, b');
  });

  it('isEmpty', () => {
    expect(getCell('text').isEmpty(null)).toBe(true);
    expect(getCell('text').isEmpty('  ')).toBe(true);
    expect(getCell('text').isEmpty('a')).toBe(false);
    expect(getCell('number').isEmpty(0)).toBe(false);
    expect(getCell('number').isEmpty(null)).toBe(true);
    expect(getCell('checkbox').isEmpty(false)).toBe(true);
    expect(getCell('checkbox').isEmpty(true)).toBe(false);
    expect(getCell('people').isEmpty([])).toBe(true);
    expect(getCell('people').isEmpty(['u1'])).toBe(false);
    expect(getCell('clip').isEmpty(null)).toBe(true);
    expect(getCell('clip').isEmpty({ baseName: 'x' })).toBe(false);
    expect(getCell('date').isEmpty('not a date')).toBe(true);
  });

  const sorted = (column: Column, values: unknown[]) => {
    const cmp = getCell(column.type).compare!;
    return [...values].sort((a, b) => cmp(a, b, column));
  };

  it('compare sorts every type and puts empty values last', () => {
    expect(sorted(col('text'), ['b', null, 'a10', 'a2'])).toEqual(['a2', 'a10', 'b', null]);
    expect(sorted(col('number'), [3, null, -1, 2])).toEqual([-1, 2, 3, null]);
    expect(sorted(col('checkbox'), [true, false, true])).toEqual([false, true, true]);
    expect(sorted(col('date'), ['2026-03-01', null, '2025-12-31'])).toEqual(['2025-12-31', '2026-03-01', null]);
    expect(sorted(col('status', { options: STATUS }), ['done', null, 'todo', 'doing'])).toEqual(['todo', 'doing', 'done', null]);
    expect(sorted(col('person', { options: USERS }), ['u3', 'u1', null, 'u2'])).toEqual(['u1', 'u3', 'u2', null]);
    expect(sorted(col('multiselect', { options: STATUS }), [['todo', 'done'], [], ['todo']])).toEqual([['todo'], ['todo', 'done'], []]);
    expect(sorted(col('clip'), [{ baseName: 'b' }, { baseName: 'a', version: 2 }, { baseName: 'a', version: 1 }, null])).toEqual([
      { baseName: 'a', version: 1 },
      { baseName: 'a', version: 2 },
      { baseName: 'b' },
      null,
    ]);
    expect(sorted(col('formula'), [5, null, 2])).toEqual([2, 5, null]);
  });
});

function Hosted({ column, initial, readOnly, row }: { column: Column; initial: unknown; readOnly?: boolean; row?: import('../types').Row }) {
  const [v, setV] = useState(initial);
  return (
    <>
      <span data-testid="value">{JSON.stringify(v)}</span>
      <CellHost column={column} value={v} {...(readOnly ? { readOnly } : {})} {...(row ? { row } : {})} onChange={setV} />
      <button>after</button>
    </>
  );
}
const valueOf = () => screen.getByTestId('value').textContent;
const cellOf = (c: Column) => document.querySelector(`[data-column="${c.key}"]`) as HTMLElement;

describe('CellHost', () => {
  it('click starts editing, Enter commits and focus returns to the cell', async () => {
    const user = userEvent.setup();
    const c = col('text');
    render(<Hosted column={c} initial="a" />);
    await user.click(cellOf(c));
    await user.keyboard('bc{Enter}');
    expect(valueOf()).toBe('"bc"');
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(document.activeElement).toBe(cellOf(c));
  });

  it('Escape cancels and returns focus to the cell', async () => {
    const user = userEvent.setup();
    const c = col('text');
    render(<Hosted column={c} initial="a" />);
    await user.click(cellOf(c));
    await user.keyboard('zzz{Escape}');
    expect(valueOf()).toBe('"a"');
    expect(document.activeElement).toBe(cellOf(c));
  });

  it('Enter and F2 on the focused cell start editing', async () => {
    const user = userEvent.setup();
    const c = col('text');
    render(<Hosted column={c} initial="a" />);
    await user.tab();
    await user.keyboard('{Enter}');
    expect(screen.getByRole('textbox')).toBeTruthy();
    await user.keyboard('{Escape}{F2}');
    expect(screen.getByRole('textbox')).toBeTruthy();
  });

  it('typing a character starts editing with it', async () => {
    const user = userEvent.setup();
    const c = col('text');
    render(<Hosted column={c} initial="old" />);
    await user.tab();
    await user.keyboard('Q');
    expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe('Q');
    await user.keyboard('x{Enter}');
    expect(valueOf()).toBe('"Qx"');
  });

  it('Tab commits and moves on to the next focusable element', async () => {
    const user = userEvent.setup();
    const c = col('text');
    render(<Hosted column={c} initial="a" />);
    await user.click(cellOf(c));
    await user.keyboard('b{Tab}'); // the old text was selected, so it is replaced
    expect(valueOf()).toBe('"b"');
    expect(document.activeElement).toBe(screen.getByText('after'));
  });

  it('a click elsewhere commits without stealing focus', async () => {
    const user = userEvent.setup();
    const c = col('text');
    render(<Hosted column={c} initial="a" />);
    await user.click(cellOf(c));
    await user.keyboard('b');
    await user.click(screen.getByText('after'));
    expect(valueOf()).toBe('"b"');
    expect(document.activeElement).toBe(screen.getByText('after'));
  });

  it('does not report unchanged values', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const c = col('text');
    render(<CellHost column={c} value="a" onChange={onChange} />);
    await user.click(cellOf(c));
    await user.keyboard('{Enter}');
    expect(onChange).not.toHaveBeenCalled();
  });

  it('read-only cells do not edit', async () => {
    const user = userEvent.setup();
    const c = col('text');
    render(<Hosted column={c} initial="a" readOnly />);
    await user.click(cellOf(c));
    await user.keyboard('{Enter}x');
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  it('respects row.canEdit and read-only columns and types', async () => {
    const user = userEvent.setup();
    const c = col('text');
    const row = { id: 'r', tableRef: 't', values: {}, canEdit: false };
    const { unmount } = render(<Hosted column={c} initial="a" row={row} />);
    await user.click(cellOf(c));
    expect(screen.queryByRole('textbox')).toBeNull();
    unmount();
    const f = col('formula');
    render(<Hosted column={f} initial={3} />);
    await user.click(cellOf(f));
    await user.keyboard('{Enter}');
    expect(valueOf()).toBe('3');
  });

  it('checkbox toggles directly on click and with Space', async () => {
    const user = userEvent.setup();
    const c = col('checkbox');
    render(<Hosted column={c} initial={false} />);
    await user.click(screen.getByRole('checkbox'));
    expect(valueOf()).toBe('true');
    cellOf(c).focus();
    await user.keyboard(' ');
    expect(valueOf()).toBe('false');
  });

  it('a picker opens on Enter, picks with the keyboard and returns focus', async () => {
    const user = userEvent.setup();
    const c = col('status', { options: STATUS });
    render(<Hosted column={c} initial="todo" />);
    await user.tab();
    await user.keyboard('{Enter}');
    expect(screen.getByRole('listbox')).toBeTruthy();
    await user.keyboard('{ArrowDown}{Enter}');
    expect(valueOf()).toBe('"doing"');
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(document.activeElement).toBe(cellOf(c));
  });

  it('typing on a picker cell pre-fills the filter', async () => {
    const user = userEvent.setup();
    const c = col('status', { options: STATUS });
    render(<Hosted column={c} initial={null} />);
    await user.tab();
    await user.keyboard('d');
    expect((screen.getByRole('combobox') as HTMLInputElement).value).toBe('d');
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['To do', 'Done']);
  });

  it('Escape on a picker cancels', async () => {
    const user = userEvent.setup();
    const c = col('status', { options: STATUS });
    render(<Hosted column={c} initial="todo" />);
    await user.click(cellOf(c));
    await user.keyboard('{Escape}');
    expect(valueOf()).toBe('"todo"');
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('multi pickers commit on close', async () => {
    const user = userEvent.setup();
    const c = col('people', { options: USERS });
    render(<Hosted column={c} initial={[]} />);
    await user.click(cellOf(c));
    await user.click(screen.getByRole('option', { name: /Ada/ }));
    await user.click(screen.getByRole('option', { name: /Alan/ }));
    await user.click(screen.getByText('after'));
    expect(valueOf()).toBe('["u1","u3"]');
  });

  it('Delete clears a filled cell', async () => {
    const user = userEvent.setup();
    const c = col('date');
    render(<Hosted column={c} initial="2026-06-20" />);
    await user.tab();
    await user.keyboard('{Delete}');
    expect(valueOf()).toBe('null');
  });

  it('date: typing starts editing in the date field', async () => {
    const user = userEvent.setup();
    const c = col('date');
    render(<Hosted column={c} initial={null} />);
    await user.tab();
    await user.keyboard('2026-09-01{Enter}');
    expect(valueOf()).toBe('"2026-09-01"');
  });
});

describe('CellsDemo', () => {
  it('renders every column type in three states', () => {
    render(<CellsDemo />);
    const rows = document.querySelectorAll('tbody tr');
    expect(rows).toHaveLength(15);
    for (const r of Array.from(rows)) expect(r.querySelectorAll('td')).toHaveLength(3);
  });
});
