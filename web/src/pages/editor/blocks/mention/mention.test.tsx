import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setPlatform } from '../../../../platform';
import { createFakePlatform, type FakePlatform } from '../../../../testing/fakePlatform';
import { Backlinks } from '../../../backlinks';
import { mountEditor, paste, pressKey, typeText } from '../../testing/helpers';
import { MentionChip } from './MentionChip';
import { parseMentionLink } from './link';
import { flattenResult, MENTION, type MentionSearchResult } from './model';
import { clearMentionCache } from './resolve';
import './index'; // registers the node

const ORIGIN = 'http://localhost:3000';

const SEARCH: MentionSearchResult = {
  people: [{ kind: 'person', id: 'u2', label: 'Grace' }],
  tasks: [{ kind: 'task', id: 't1', label: 'Write script', projectName: 'Spot' }],
  pages: [{ kind: 'page', id: 'pg1', label: 'Plan', icon: '\u{1F4D8}', space: 'p:p1' }],
  clips: [{ kind: 'clip', id: 'p1:shot_010', label: 'shot_010', projectName: 'Spot' }],
};

let fake: FakePlatform;
/** Answers of /api/mentions/resolve by "kind|id"; a missing entry means "no access". */
let known: Record<string, { title: string; route?: string | null; icon?: string }>;
let searches: string[];
let resolveCalls: number;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

beforeEach(() => {
  known = {};
  searches = [];
  resolveCalls = 0;
  clearMentionCache();
  fake = createFakePlatform();
  const base = fake.fetch.bind(fake);
  fake.fetch = async (path, init) => {
    if (path.startsWith('/api/mentions/search')) {
      const q = new URL(path, ORIGIN).searchParams.get('q') ?? '';
      searches.push(q);
      const keep = (items: MentionSearchResult['people']) => items.filter((i) => i.label.toLowerCase().includes(q.toLowerCase()));
      return json({ people: keep(SEARCH.people), tasks: keep(SEARCH.tasks), pages: keep(SEARCH.pages), clips: keep(SEARCH.clips) });
    }
    if (path === '/api/mentions/resolve') {
      resolveCalls++;
      const items = JSON.parse(init!.body as string).items as Array<{ kind: string; id: string }>;
      return json({
        items: items.map(({ kind, id }) => {
          const hit = known[`${kind}|${id}`];
          return hit ? { kind, id, ok: true, ...hit } : { kind, id, ok: false };
        }),
      });
    }
    return base(path, init);
  };
  setPlatform(fake);
});
afterEach(() => {
  cleanup();
  setPlatform(null);
  window.history.replaceState({}, '', '/');
});

async function openMenu(query = '') {
  const m = await mountEditor();
  m.editor.commands.focus();
  await act(async () => {
    typeText(m.editor, '@' + query);
  });
  return m;
}

function mentions(editor: { getJSON(): any }): Array<Record<string, any>> {
  const found: Array<Record<string, any>> = [];
  const walk = (node: any) => {
    if (node.type === MENTION) found.push(node.attrs);
    (node.content ?? []).forEach(walk);
  };
  walk(editor.getJSON());
  return found;
}

describe('the mention node', () => {
  it('stores kind, id and label, and shows the current title of a target the reader can open', async () => {
    known['task|t1'] = { title: 'Write script (renamed)', route: '?task=t1' };
    const m = await mountEditor();
    m.editor.commands.insertContent({ type: MENTION, attrs: { kind: 'task', id: 't1', label: 'Write script' } });
    expect(mentions(m.editor)).toEqual([{ kind: 'task', id: 't1', label: 'Write script' }]);
    await screen.findByTestId('mention-chip');
    await waitFor(() => expect(screen.getByTestId('mention-chip').getAttribute('data-state')).toBe('ready'));
    expect(screen.getByTestId('mention-chip').textContent).toContain('Write script (renamed)');
    m.unmount();
  });

  it('a chip whose target the reader cannot open shows the stored label, greyed, "No access" and no link', async () => {
    render(<MentionChip kind="page" id="secret" label="Stored name" />);
    const chip = await screen.findByTestId('mention-chip');
    await waitFor(() => expect(chip.getAttribute('data-state')).toBe('denied'));
    expect(chip.textContent).toContain('Stored name');
    expect(chip.textContent).toContain('No access');
    expect(chip.tagName).not.toBe('A');
    expect(chip.getAttribute('href')).toBeNull();
  });

  it('keeps the stored label while the server cannot be asked', async () => {
    fake.fetch = async () => new Response('x', { status: 500 });
    render(<MentionChip kind="task" id="t9" label="Offline name" />);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 40));
    });
    const chip = screen.getByTestId('mention-chip');
    expect(chip.textContent).toBe('☑Offline name');
    expect(chip.getAttribute('data-state')).toBe('loading');
  });

  it('a task chip opens the task panel on the current route; a page chip goes to its route; a person chip is no link', async () => {
    window.history.replaceState({}, '', '/p/p1/page/pg9');
    known['task|t1'] = { title: 'Task one', route: '?task=t1' };
    known['page|pg1'] = { title: 'Plan', route: '/p/p1/page/pg1' };
    known['person|u2'] = { title: 'Grace' };
    render(
      <>
        <MentionChip kind="task" id="t1" label="" />
        <MentionChip kind="page" id="pg1" label="" />
        <MentionChip kind="person" id="u2" label="" />
      </>,
    );
    await waitFor(() => expect(screen.getAllByTestId('mention-chip').every((c) => c.getAttribute('data-state') === 'ready')).toBe(true));
    const [task, page, person] = screen.getAllByTestId('mention-chip');
    expect(task!.getAttribute('href')).toBe('/p/p1/page/pg9?task=t1');
    fireEvent.click(task!);
    fireEvent.click(page!);
    expect(fake.navigations).toEqual(['/p/p1/page/pg9?task=t1', '/p/p1/page/pg1']);
    expect(person!.tagName).toBe('SPAN');
    expect(person!.getAttribute('title')).toBe('Person');
  });

  it('asks the server once for all chips that appear together', async () => {
    known['task|a'] = { title: 'A', route: '?task=a' };
    render(
      <>
        <MentionChip kind="task" id="a" label="" />
        <MentionChip kind="task" id="b" label="" />
        <MentionChip kind="task" id="a" label="" />
      </>,
    );
    await waitFor(() => expect(screen.getAllByTestId('mention-chip').every((c) => c.getAttribute('data-state') !== 'loading')).toBe(true));
    expect(resolveCalls).toBe(1);
  });
});

describe('the @ menu', () => {
  it('opens on "@", lists people, tasks, pages and clips, and is not opened in the middle of a word', async () => {
    const m = await mountEditor();
    m.editor.commands.focus();
    await act(async () => typeText(m.editor, 'mail@'));
    expect(screen.queryByTestId('mention-menu')).toBeNull();
    await act(async () => typeText(m.editor, ' @'));
    await screen.findByTestId('mention-menu');
    await waitFor(() => expect(screen.getAllByRole('option')).toHaveLength(4));
    expect(['People', 'Tasks', 'Pages', 'Clips'].every((t) => screen.getByText(t))).toBe(true);
    m.unmount();
  });

  it('filters while typing', async () => {
    const m = await openMenu('scr');
    await waitFor(() => expect(screen.getAllByRole('option')).toHaveLength(1));
    expect(screen.getByRole('option').textContent).toContain('Write script');
    expect(searches[searches.length - 1]).toBe('scr');
    await act(async () => typeText(m.editor, 'zzz'));
    await waitFor(() => expect(screen.getByText('No matches')).toBeTruthy());
    m.unmount();
  });

  it('arrow keys move, Enter inserts the chip in place of "@query" and a space after it', async () => {
    const m = await openMenu();
    await waitFor(() => expect(screen.getAllByRole('option')).toHaveLength(4));
    expect(screen.getAllByRole('option')[0]!.getAttribute('aria-selected')).toBe('true');
    await act(async () => void pressKey(m.editor, 'ArrowDown'));
    expect(screen.getAllByRole('option')[1]!.getAttribute('aria-selected')).toBe('true');
    await act(async () => void pressKey(m.editor, 'ArrowUp'));
    await act(async () => void pressKey(m.editor, 'ArrowUp')); // wraps to the last
    expect(screen.getAllByRole('option')[3]!.getAttribute('aria-selected')).toBe('true');
    await act(async () => void pressKey(m.editor, 'ArrowDown')); // back to the first: the person
    await act(async () => void pressKey(m.editor, 'Enter'));
    expect(mentions(m.editor)).toEqual([{ kind: 'person', id: 'u2', label: 'Grace' }]);
    expect(m.editor.getText()).toBe('@Grace ');
    expect(screen.queryByTestId('mention-menu')).toBeNull();
    m.unmount();
  });

  it('a click picks an entry; Escape closes without inserting', async () => {
    const m = await openMenu();
    await waitFor(() => expect(screen.getAllByRole('option')).toHaveLength(4));
    fireEvent.click(screen.getByRole('option', { name: /Write script/ }));
    expect(mentions(m.editor)).toEqual([{ kind: 'task', id: 't1', label: 'Write script' }]);
    await act(async () => typeText(m.editor, '@'));
    await screen.findByTestId('mention-menu');
    await act(async () => void pressKey(m.editor, 'Escape'));
    expect(screen.queryByTestId('mention-menu')).toBeNull();
    expect(mentions(m.editor)).toHaveLength(1);
    m.unmount();
  });

  it('stays open when another plugin is registered meanwhile (that re-creates every plugin view)', async () => {
    const m = await openMenu();
    await waitFor(() => expect(screen.getAllByRole('option')).toHaveLength(4));
    await act(async () => m.editor.registerPlugin(new Plugin({ key: new PluginKey('someOtherPlugin') })));
    expect(screen.getAllByRole('option')).toHaveLength(4);
    await act(async () => typeText(m.editor, 'Gra'));
    await waitFor(() => expect(screen.getAllByRole('option')).toHaveLength(1));
    m.unmount();
  });

  it('lists the results in menu order for the keyboard', () => {
    expect(flattenResult(SEARCH).map((i) => i.kind)).toEqual(['person', 'task', 'page', 'clip']);
  });
});

describe('pasting a link', () => {
  it('turns a Cutline page or task link into a chip and fills in its name', async () => {
    known['page|pg1'] = { title: 'Plan', route: '/p/p1/page/pg1' };
    known['task|t1'] = { title: 'Write script', route: '?task=t1' };
    const m = await mountEditor();
    m.editor.commands.focus();
    await act(async () => paste(m.editor, { text: `${window.location.origin}/p/p1/page/pg1` }));
    await act(async () => paste(m.editor, { text: `${window.location.origin}/p/p1/pages?task=t1` }));
    expect(mentions(m.editor).map(({ kind, id }) => ({ kind, id }))).toEqual([
      { kind: 'page', id: 'pg1' },
      { kind: 'task', id: 't1' },
    ]);
    await waitFor(() => expect(mentions(m.editor).map((a) => a.label)).toEqual(['Plan', 'Write script']));
    m.unmount();
  });

  it('leaves other links alone: other origin, unknown route, text around it, or a selection to link', async () => {
    const m = await mountEditor();
    m.editor.commands.focus();
    for (const text of ['https://example.com/p/p1/page/pg1', `${window.location.origin}/dev/ui`, `see ${window.location.origin}/p/p1/page/pg1`]) {
      await act(async () => paste(m.editor, { text }));
    }
    expect(mentions(m.editor)).toEqual([]);
    m.editor.commands.setContent('<p>word</p>');
    m.editor.commands.selectAll();
    await act(async () => paste(m.editor, { text: `${window.location.origin}/p/p1/page/pg1` }));
    expect(mentions(m.editor)).toEqual([]);
    m.unmount();
  });

  it('parseMentionLink: same origin and a known route only; a task parameter wins', () => {
    expect(parseMentionLink(`${ORIGIN}/me/page/a1`, ORIGIN)).toEqual({ kind: 'page', id: 'a1' });
    expect(parseMentionLink(`${ORIGIN}/p/x/review?task=t5`, ORIGIN)).toEqual({ kind: 'task', id: 't5' });
    expect(parseMentionLink(`${ORIGIN}/p/x/page/a1?task=t5`, ORIGIN)).toEqual({ kind: 'task', id: 't5' });
    expect(parseMentionLink(`${ORIGIN}/p/x/review`, ORIGIN)).toBeNull();
    expect(parseMentionLink('http://other.test/me/page/a1', ORIGIN)).toBeNull();
    expect(parseMentionLink('mailto:a@b.c', ORIGIN)).toBeNull();
    expect(parseMentionLink('hello', ORIGIN)).toBeNull();
    expect(parseMentionLink('/me/page/a1', ORIGIN)).toEqual({ kind: 'page', id: 'a1' });
  });
});

describe('<Backlinks>', () => {
  it('shows nothing when no page mentions the target', async () => {
    fake.routes['/api/backlinks?kind=task&id=t1'] = { pages: [] };
    render(<Backlinks kind="task" id="t1" />);
    await waitFor(() => expect(fake.fetchCalls).toHaveLength(1));
    expect(screen.queryByTestId('backlinks')).toBeNull();
  });

  it('is collapsed with a count, opens to the pages and navigates on click', async () => {
    fake.routes['/api/backlinks?kind=task&id=t1'] = {
      pages: [
        { id: 'a', title: 'Plan', icon: null, space: 'p:p1', projectId: 'p1', route: '/p/p1/page/a', updatedAt: '' },
        { id: 'b', title: 'Notes', icon: null, space: 'me', projectId: null, route: '/me/page/b', updatedAt: '' },
      ],
    };
    render(<Backlinks kind="task" id="t1" />);
    const toggle = await screen.findByRole('button', { name: /Mentioned in 2 pages/ });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByText('Plan')).toBeNull();
    fireEvent.click(toggle);
    fireEvent.click(screen.getByText(/Notes/));
    expect(fake.navigations).toEqual(['/me/page/b']);
  });
});
