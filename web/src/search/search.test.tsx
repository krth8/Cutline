import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NAVIGATE_EVENT, setPlatform } from '../platform';
import { createFakePlatform, type FakePlatform } from '../testing/fakePlatform';
import { registerBuiltinCommands } from './builtins';
import { clearCommands, listCommands, registerCommand, registerCommandProvider, type CommandContext } from './commands';
import { Palette } from './Palette';
import { OPEN_SEARCH_EVENT, PaletteHost } from './PaletteHost';
import { loadRecent, rememberOpened } from './recent';
import { fold, highlightParts, queryWords } from './text';
import type { SearchResult } from './api';

let fake: FakePlatform;

const RESULT: SearchResult = {
  took: 2,
  groups: [
    {
      type: 'page',
      items: [
        { type: 'page', id: 'pg1', title: 'Launch plan', snippet: '...we agree on the plan for Friday...', projectId: 'p1', projectName: 'Project One', route: '/p/p1/page/pg1' },
        { type: 'page', id: 'pg2', title: 'Diary', projectId: null, route: '/me/page/pg2' },
      ],
    },
    { type: 'task', items: [{ type: 'task', id: 't1', title: 'Plan the shoot', projectId: 'p1', projectName: 'Project One', route: '/p/p1/tasks?task=t1' }] },
    {
      type: 'comment',
      items: [
        { type: 'comment', id: 'c1', title: 'Fix the plan here', snippet: 'shot_1 v2 - ann', projectId: 'p1', projectName: 'Project One', clip: 'shot_1', version: 2, frame: 48, route: '/p/p1/review?clip=shot_1&v=2&frame=48' },
      ],
    },
    { type: 'clip', items: [{ type: 'clip', id: 'p1:plan_reel', title: 'plan_reel', projectId: 'p1', projectName: 'Project One', route: '/p/p1/review?clip=plan_reel' }] },
  ],
};

function setup(path = '/p/p1/pages') {
  fake = createFakePlatform({
    projects: [
      { id: 'p1', name: 'Project One', canTasks: true, isOwner: true },
      { id: 'p2', name: 'Project Two', canTasks: false, isOwner: false },
    ],
  });
  fake.routes['/api/search?q=plan&project=p1'] = RESULT;
  fake.routes['/api/search?q=plan'] = RESULT;
  setPlatform(fake);
  window.history.replaceState({}, '', path);
}

function renderPalette() {
  const onClose = vi.fn();
  render(<Palette open onClose={onClose} />);
  return { onClose, input: screen.getByTestId('search-input') as HTMLInputElement };
}

const last = <T,>(list: T[]): T | undefined => list[list.length - 1];
const options = () => screen.queryAllByTestId('search-result');

beforeEach(() => {
  localStorage.clear();
  clearCommands();
  registerBuiltinCommands();
  setup();
});

afterEach(() => {
  cleanup();
  setPlatform(null);
  clearCommands();
  document.body.innerHTML = '';
});

describe('text helpers', () => {
  it('folds case and accents and keeps the length', () => {
    expect(fold('Café ÉCLAIR')).toBe('cafe eclair');
    expect(fold('straße').length).toBe('straße'.length);
    expect(queryWords('  Plan  PLAN shoot ')).toEqual(['plan', 'shoot']);
  });

  it('cuts text into matching and plain parts', () => {
    expect(highlightParts('Launch plan for Plans', ['plan'])).toEqual([
      { text: 'Launch ', match: false },
      { text: 'plan', match: true },
      { text: ' for ', match: false },
      { text: 'Plan', match: true },
      { text: 's', match: false },
    ]);
    expect(highlightParts('Café', ['cafe'])).toEqual([{ text: 'Café', match: true }]);
    expect(highlightParts('abc', [])).toEqual([{ text: 'abc', match: false }]);
  });
});

describe('Palette', () => {
  it('shows commands and recent items when the query is empty', () => {
    rememberOpened('u1', RESULT.groups[0]!.items[0]!, 'launch');
    const { input } = renderPalette();
    expect(document.activeElement).toBe(input);
    expect(screen.getByText('Recent')).toBeTruthy();
    expect(screen.getByText('Launch plan')).toBeTruthy();
    expect(screen.getByText('Recent searches')).toBeTruthy();
    expect(screen.getByText('launch')).toBeTruthy();
    expect(screen.getByText('New page')).toBeTruthy();
    expect(options().length).toBeGreaterThan(2);
  });

  it('searches after a pause, groups the results and marks the matches', async () => {
    const { input } = renderPalette();
    await userEvent.type(input, 'plan');
    expect(fake.fetchCalls.filter((c) => c.path.startsWith('/api/search')).length).toBe(0); // still debouncing
    await screen.findByText('Pages');
    const headings = Array.from(document.querySelectorAll('.cl-search__heading')).map((h) => h.textContent);
    expect(headings.slice(0, 4)).toEqual(['Pages', 'Tasks', 'Comments', 'Clips']);
    // one request for the whole word, not one per key
    expect(fake.fetchCalls.filter((c) => c.path.startsWith('/api/search')).map((c) => c.path)).toEqual(['/api/search?q=plan&project=p1']);
    const marks = Array.from(document.querySelectorAll('mark')).map((m) => m.textContent);
    expect(marks).toContain('plan');
    expect(within(options()[0]!).getAllByText('plan', { selector: 'mark' }).length).toBe(2); // title and snippet
    expect(options().map((o) => o.getAttribute('data-type')).slice(0, 5)).toEqual(['page', 'page', 'task', 'comment', 'clip']);
  });

  it('moves with the arrow keys (wrapping) and opens with Enter', async () => {
    const { input, onClose } = renderPalette();
    await userEvent.type(input, 'plan');
    await screen.findByText('Pages');
    expect(options()[0]!.getAttribute('aria-selected')).toBe('true');
    await userEvent.keyboard('{ArrowDown}{ArrowDown}');
    expect(options()[2]!.getAttribute('aria-selected')).toBe('true');
    expect(input.getAttribute('aria-activedescendant')).toBe(options()[2]!.id);
    await userEvent.keyboard('{ArrowUp}{ArrowUp}{ArrowUp}');
    const last = options().length - 1;
    expect(options()[last]!.getAttribute('aria-selected')).toBe('true'); // wrapped to the end
    await userEvent.keyboard('{ArrowDown}{Enter}');
    expect(fake.navigations).toEqual(['/p/p1/page/pg1']);
    expect(onClose).toHaveBeenCalled();
    expect(loadRecent('u1').items[0]!.id).toBe('pg1');
    expect(loadRecent('u1').queries).toEqual(['plan']);
  });

  it('opens a comment and a clip at their review links, and a task over the project tasks outside the shell', async () => {
    const { input } = renderPalette();
    await userEvent.type(input, 'plan');
    await screen.findByText('Pages');
    await userEvent.click(options()[3]!);
    expect(last(fake.navigations)).toBe('/p/p1/review?clip=shot_1&v=2&frame=48');
    cleanup();
    const again = renderPalette();
    await userEvent.type(again.input, 'plan');
    await screen.findByText('Pages');
    await userEvent.click(options()[2]!);
    // no shell on screen (a legacy tab): the task opens over the project's Tasks view
    expect(last(fake.navigations)).toBe('/p/p1/tasks?task=t1');
  });

  it('opens a task over the current route when the shell is mounted', async () => {
    const shell = document.createElement('div');
    shell.className = 'cl-shell';
    document.body.appendChild(shell);
    const { input } = renderPalette();
    await userEvent.type(input, 'plan');
    await screen.findByText('Pages');
    await userEvent.click(options()[2]!);
    expect(last(fake.navigations)).toBe('/p/p1/pages?task=t1');
  });

  it('closes on Escape', async () => {
    const { onClose } = renderPalette();
    await userEvent.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalled();
  });

  it('has a scope chip for the current project that can be switched off', async () => {
    const { input } = renderPalette();
    const chip = screen.getByTestId('search-scope');
    expect(chip.textContent).toContain('In Project One');
    expect(chip.getAttribute('aria-pressed')).toBe('true');
    await userEvent.type(input, 'plan');
    await screen.findByText('Pages');
    await userEvent.click(chip);
    expect(chip.getAttribute('aria-pressed')).toBe('false');
    await waitFor(() => expect(last(fake.fetchCalls)!.path).toBe('/api/search?q=plan'));
  });

  it('has no scope chip outside a project', () => {
    setup('/me');
    renderPalette();
    expect(screen.queryByTestId('search-scope')).toBeNull();
  });

  it('says so when nothing matches and when the search fails', async () => {
    fake.routes['/api/search?q=zzz&project=p1'] = { groups: [], took: 1 };
    fake.routes['/api/search?q=boom&project=p1'] = () => new Response('{}', { status: 500 });
    const { input } = renderPalette();
    await userEvent.type(input, 'zzz');
    await screen.findByText(/No results for/);
    await userEvent.clear(input);
    await userEvent.type(input, 'boom');
    await screen.findByRole('alert');
  });

  it('ignores a slow answer for text that was replaced', async () => {
    let release: () => void = () => {};
    fake.routes['/api/search?q=pl&project=p1'] = () => new Response(JSON.stringify({ took: 1, groups: [{ type: 'clip', items: [{ type: 'clip', id: 'old', title: 'old result', route: '/x' }] }] }));
    const original = fake.fetch.bind(fake);
    let asked = false;
    fake.fetch = async (path, init) => {
      if (path === '/api/search?q=pl&project=p1') {
        asked = true;
        await new Promise<void>((r) => (release = r));
      }
      return original(path, init);
    };
    const { input } = renderPalette();
    await userEvent.type(input, 'pl');
    await waitFor(() => expect(asked).toBe(true));
    await userEvent.type(input, 'an');
    await screen.findByText('Pages');
    await act(async () => release());
    expect(screen.queryByText('old result')).toBeNull();
  });
});

describe('commands', () => {
  it('lists every command after ">" and filters them by title or keyword', async () => {
    const { input } = renderPalette();
    await userEvent.type(input, '>');
    const all = options().map((o) => o.textContent);
    expect(all).toEqual(expect.arrayContaining(['New page', 'New task', 'Go to Home', 'Go to Personal space', 'Go to Project One: Review', 'Go to Project One: Tasks', 'Go to Project One: Pages', 'Toggle old/new task list', 'Log out']));
    expect(all).not.toContain('Go to Project Two: Tasks'); // no task access there
    expect(all).not.toContain('Set this page as home'); // only on a personal page
    expect(fake.fetchCalls).toHaveLength(0); // no search in command mode
    await userEvent.type(input, 'sign out');
    expect(options().map((o) => o.textContent)).toEqual(['Log out']);
  });

  it('shows "Set this page as home" on a personal page and runs it', async () => {
    setup('/me/page/pg9');
    fake.routes['PUT /api/home'] = { pageId: 'pg9' };
    const { input, onClose } = renderPalette();
    await userEvent.type(input, '>set this');
    await userEvent.keyboard('{Enter}');
    expect(onClose).toHaveBeenCalled();
    await waitFor(() => expect(fake.fetchCalls.some((c) => c.path === '/api/home' && c.init?.method === 'PUT')).toBe(true));
    expect(JSON.parse(String(fake.fetchCalls.find((c) => c.path === '/api/home')!.init!.body))).toEqual({ pageId: 'pg9' });
  });

  it('"New page" creates a page in the current project and opens it', async () => {
    fake.routes['POST /api/spaces/p:p1/pages'] = { id: 'newpage', title: 'Untitled' };
    const { input } = renderPalette();
    await userEvent.type(input, '>new page');
    await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(fake.navigations).toEqual(['/p/p1/page/newpage']));
  });

  it('"New page" outside a project creates a personal page', async () => {
    setup('/home');
    fake.routes['POST /api/spaces/me/pages'] = { id: 'mine', title: 'Untitled' };
    const { input } = renderPalette();
    await userEvent.type(input, '>new page');
    await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(fake.navigations).toEqual(['/me/page/mine']));
  });

  it('"New task" creates the task in the current project and opens its panel', async () => {
    fake.routes['POST /api/tables/tasks%3Ap1/rows'] = { id: 'nt1', tableRef: 'tasks:p1', values: { name: 'New task' }, canEdit: true };
    const { input } = renderPalette();
    await userEvent.type(input, '>new task');
    await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(fake.navigations).toEqual(['/p/p1/tasks?task=nt1']));
  });

  it('goes to a project area', async () => {
    const { input } = renderPalette();
    await userEvent.type(input, '>project one tasks');
    await userEvent.keyboard('{Enter}');
    expect(fake.navigations).toEqual(['/p/p1/tasks']);
  });

  it('logs out through the platform and reports a failing command', async () => {
    const logout = vi.fn().mockResolvedValue(undefined);
    fake.logout = logout;
    const { input } = renderPalette();
    await userEvent.type(input, '>log out');
    await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(logout).toHaveBeenCalled());

    registerCommand({ id: 'boom', title: 'Boom', run: () => Promise.reject(new Error('nope')) });
    cleanup();
    const again = renderPalette();
    await userEvent.type(again.input, '>boom');
    await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(fake.toasts).toEqual([{ kind: 'error', message: 'nope' }]));
  });

  it('also offers matching commands under the results', async () => {
    registerCommand({ id: 'plan-cmd', title: 'Plan the week', keywords: ['calendar'], run: () => {} });
    const { input } = renderPalette();
    await userEvent.type(input, 'plan');
    await screen.findByText('Pages');
    const row = last(options())!;
    expect(row.getAttribute('data-type')).toBe('command');
    expect(row.textContent).toBe('Plan the week');
  });
});

describe('command registry', () => {
  const ctx = (over: Partial<CommandContext> = {}): CommandContext => ({
    route: { kind: 'home' },
    projectId: null,
    user: { id: 'u1', username: 'x', role: 'editor' },
    projects: [],
    ...over,
  });

  it('registers, filters with when(), provides context commands and unregisters', () => {
    clearCommands();
    const off = registerCommand({ id: 'a', title: 'A', run: () => {} });
    registerCommand({ id: 'b', title: 'B', run: () => {}, when: (c) => c.projectId === 'p1' });
    registerCommandProvider('p', (c) => c.projects.map((p) => ({ id: `x:${p.id}`, title: p.name, run: () => {} })));
    registerCommand({ id: 'bad', title: 'Bad', run: () => {}, when: () => { throw new Error('x'); } });
    expect(listCommands(ctx()).map((c) => c.id)).toEqual(['a']);
    expect(listCommands(ctx({ projectId: 'p1', projects: [{ id: 'p1', name: 'One', canTasks: true, isOwner: true }] })).map((c) => c.id)).toEqual(['a', 'b', 'x:p1']);
    off();
    expect(listCommands(ctx()).map((c) => c.id)).toEqual([]);
  });
});

describe('PaletteHost', () => {
  const press = (init: KeyboardEventInit) => act(() => void document.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })));

  it('opens and closes with Ctrl+K and Cmd+K', () => {
    render(<PaletteHost />);
    expect(screen.queryByTestId('search-palette')).toBeNull();
    press({ key: 'k', ctrlKey: true });
    expect(screen.getByTestId('search-palette')).toBeTruthy();
    press({ key: 'k', metaKey: true });
    expect(screen.queryByTestId('search-palette')).toBeNull();
    press({ key: 'K', metaKey: true });
    expect(screen.getByTestId('search-palette')).toBeTruthy();
  });

  it('opens from the search buttons', () => {
    render(<PaletteHost />);
    act(() => void window.dispatchEvent(new CustomEvent(OPEN_SEARCH_EVENT)));
    expect(screen.getByTestId('search-palette')).toBeTruthy();
  });

  it('opens from inside a text box, but leaves a key that something else handled alone', () => {
    render(
      <>
        <PaletteHost />
        <textarea data-testid="box" />
      </>,
    );
    const box = screen.getByTestId('box');
    box.addEventListener('keydown', (e) => {
      if (box.dataset.claim) e.preventDefault();
    });
    fireEvent.keyDown(box, { key: 'k', ctrlKey: true });
    expect(screen.getByTestId('search-palette')).toBeTruthy();
    fireEvent.keyDown(screen.getByTestId('search-input'), { key: 'k', ctrlKey: true });
    expect(screen.queryByTestId('search-palette')).toBeNull();
    box.dataset.claim = '1'; // like the editor's link shortcut
    fireEvent.keyDown(box, { key: 'k', ctrlKey: true });
    expect(screen.queryByTestId('search-palette')).toBeNull();
  });

  it('does nothing for other keys, modifiers or when nobody is logged in', () => {
    render(<PaletteHost />);
    press({ key: 'k' });
    press({ key: 'j', ctrlKey: true });
    press({ key: 'k', ctrlKey: true, shiftKey: true });
    expect(screen.queryByTestId('search-palette')).toBeNull();
    fake.data.user = null;
    press({ key: 'k', ctrlKey: true });
    act(() => void window.dispatchEvent(new CustomEvent(OPEN_SEARCH_EVENT)));
    expect(screen.queryByTestId('search-palette')).toBeNull();
  });
});

describe('recent', () => {
  it('keeps recents per user, newest first, without duplicates, and survives broken storage', () => {
    const item = RESULT.groups[0]!.items[0]!;
    rememberOpened('a', item, 'one');
    rememberOpened('a', RESULT.groups[0]!.items[1]!, '>command');
    rememberOpened('a', item, 'two');
    expect(loadRecent('a').items.map((i) => i.id)).toEqual(['pg1', 'pg2']);
    expect(loadRecent('a').queries).toEqual(['two', 'one']); // commands are not remembered as searches
    expect(loadRecent('b')).toEqual({ items: [], queries: [] });
    localStorage.setItem('cl-search-recent:c', '{not json');
    expect(loadRecent('c')).toEqual({ items: [], queries: [] });
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('full');
    });
    expect(() => rememberOpened('a', item, 'x')).not.toThrow();
    spy.mockRestore();
  });
});

// The sidebar and the router react to the same navigations; make sure the event name did not drift
describe('wiring', () => {
  it('uses the platform navigate event name', () => {
    expect(NAVIGATE_EVENT).toBe('cutline:navigate');
  });
});
