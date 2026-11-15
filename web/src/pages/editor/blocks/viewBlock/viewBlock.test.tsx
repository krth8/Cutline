import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { Editor as TiptapEditor } from '@tiptap/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Awareness } from 'y-protocols/awareness';
import * as Y from 'yjs';
import { setPlatform } from '../../../../platform';
import { createFakePlatform, type FakePlatform } from '../../../../testing/fakePlatform';
import { Editor } from '../../Editor';
import { FRAGMENT_NAME } from '../../buildExtensions';
import { filterSlashItems } from '../../filter';
import { getRegisteredSlashItems } from '../../registry';
import { LinkedNetwork } from '../../testing/linkedProvider';
import { ViewBlockContent } from './ViewBlockContent';
import { clampHeight, type PageContext, findNewDuplicates, newViewSpec, ownsView } from './model';
import './index'; // registers the block

// The real shell needs the whole store; the block only has to put it in the right place
vi.mock('../../../../tables/ViewShell', () => ({
  ViewShell: ({ viewId }: { viewId: string }) => <div data-testid="shell-stub">{viewId}</div>,
}));

interface StoredView {
  id: string;
  tableRef: string;
  name: string;
  layout: string;
  config: Record<string, unknown>;
  ownerPageId: string | null;
  canEdit: boolean;
}

let fake: FakePlatform;
let views: Map<string, StoredView>;
let counter: number;
/** Table refs the fake user may not read. */
let deniedTables: Set<string>;
/** The space the fake server reports for the page. */
let pageSpace = 'p:p1';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** A tiny in-memory version of the view endpoints. */
function installServer() {
  const base = fake.fetch.bind(fake);
  fake.fetch = async (path, init) => {
    const method = (init?.method ?? 'GET').toUpperCase();
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    const one = /^\/api\/views\/([^/?]+)$/.exec(path);
    if (method === 'POST' && path === '/api/views') {
      const id = `v${++counter}`;
      const view = { id, canEdit: true, ownerPageId: null, config: {}, ...body } as StoredView;
      views.set(id, view);
      fake.fetchCalls.push({ path, ...(init ? { init } : {}) });
      return json(view);
    }
    if (method === 'GET' && path.startsWith('/api/views')) {
      fake.fetchCalls.push({ path, ...(init ? { init } : {}) });
      if (one) {
        const v = views.get(decodeURIComponent(one[1]!));
        return v ? json(v) : json({ detail: 'View not found' }, 404);
      }
      return json({ views: [...views.values()] });
    }
    if (method === 'DELETE' && one) {
      fake.fetchCalls.push({ path, ...(init ? { init } : {}) });
      return views.delete(decodeURIComponent(one[1]!)) ? json({ success: true }) : json({ detail: 'View not found' }, 404);
    }
    if (method === 'GET' && path === '/api/pages/page1') return json({ id: 'page1', space: pageSpace });
    const schema = /^\/api\/tables\/(.+)\/schema$/.exec(path);
    if (schema) {
      return deniedTables.has(decodeURIComponent(schema[1]!)) ? json({ detail: 'Task access denied' }, 403) : json({ columns: [] });
    }
    return base(path, init);
  };
}

function addView(extra: Partial<StoredView> = {}): StoredView {
  const id = extra.id ?? `v${++counter}`;
  const view: StoredView = {
    id,
    tableRef: 'tasks:p1',
    name: 'Tasks',
    layout: 'board',
    config: { query: { search: 'x' } },
    ownerPageId: 'page1',
    canEdit: true,
    ...extra,
  };
  views.set(id, view);
  return view;
}

const CONTEXT: PageContext = { pageId: 'page1', space: 'p:p1' };

async function mount(opts: { doc?: Y.Doc; editable?: boolean; context?: PageContext } = {}) {
  const doc = opts.doc ?? new Y.Doc();
  let editor: TiptapEditor | null = null;
  const result = await act(async () =>
    render(
      <Editor
        doc={doc}
        awareness={new Awareness(doc)}
        user={{ id: 'u1', name: 'Ada', color: '#e8590c' }}
        editable={opts.editable ?? true}
        pageId={(opts.context ?? CONTEXT).pageId}
        onReady={(e) => {
          editor = e;
        }}
      />,
    ),
  );
  return { editor: editor as unknown as TiptapEditor, doc, result };
}

const blocks = (editor: TiptapEditor) => (editor.getJSON().content ?? []).filter((n) => n.type === 'viewBlock');
const ids = (editor: TiptapEditor) => blocks(editor).map((b) => b.attrs?.viewId);

beforeEach(() => {
  views = new Map();
  counter = 100; // ids made by the fake server never collide with the fixed ids used in the tests
  deniedTables = new Set();
  pageSpace = 'p:p1';
  fake = createFakePlatform();
  installServer();
  setPlatform(fake);
});
afterEach(() => {
  cleanup();
  setPlatform(null);
});

describe('model', () => {
  it('a new view in a project page shows that project, in a personal page the tasks assigned to me', () => {
    expect(newViewSpec('board', 'p:abc')).toMatchObject({ tableRef: 'tasks:abc', layout: 'board', config: { query: {} } });
    const mine = newViewSpec('list', 'me');
    expect(mine.tableRef).toBe('tasks:*');
    expect(mine.config.query).toEqual({ filter: { and: [{ column: 'assignees', op: 'in', value: ['@me'] }] } });
  });

  it('height is kept within limits; owned means the view belongs to this page', () => {
    expect(clampHeight(10)).toBe(160);
    expect(clampHeight(99999)).toBe(1600);
    expect(clampHeight('abc')).toBeNull();
    expect(clampHeight(null)).toBeNull();
    expect(ownsView({ ownerPageId: 'a' }, 'a')).toBe(true);
    expect(ownsView({ ownerPageId: 'b' }, 'a')).toBe(false);
    expect(ownsView({ ownerPageId: null }, 'a')).toBe(false);
  });
});

describe('slash entries', () => {
  it('offers the five layouts and an existing view, whether or not the layout has a component', () => {
    const titles = getRegisteredSlashItems()
      .filter((i) => i.group === 'Views')
      .map((i) => i.title);
    expect(titles).toEqual(['Table', 'Board', 'Calendar', 'Gantt', 'List', 'Existing view']);
    expect(filterSlashItems(getRegisteredSlashItems(), 'board').map((i) => i.title)).toContain('Board');
  });

  it('inserting a layout creates a view owned by the page and puts a block with its id in the document', async () => {
    const m = await mount();
    const item = getRegisteredSlashItems().find((i) => i.id === 'view-board')!;
    m.editor.commands.focus();
    await act(async () => {
      item.run(m.editor, { from: 1, to: 1 });
    });
    await waitFor(() => expect(ids(m.editor)).toHaveLength(1));
    const created = [...views.values()][0]!;
    expect(created).toMatchObject({ tableRef: 'tasks:p1', layout: 'board', ownerPageId: 'page1' });
    expect(ids(m.editor)).toEqual([created.id]);
  });

  it('in a personal page the new view is "my tasks" across projects', async () => {
    pageSpace = 'me';
    const m = await mount();
    await act(async () => {
      getRegisteredSlashItems().find((i) => i.id === 'view-calendar')!.run(m.editor, { from: 1, to: 1 });
    });
    await waitFor(() => expect(ids(m.editor)).toHaveLength(1));
    expect([...views.values()][0]).toMatchObject({ tableRef: 'tasks:*', layout: 'calendar', ownerPageId: 'page1' });
  });
});

describe('the node in the document', () => {
  it('keeps viewId and height in the Yjs document and renders the same in a second editor', async () => {
    addView({ id: 'v1' });
    const m = await mount();
    await act(async () => {
      m.editor.commands.insertContent({ type: 'viewBlock', attrs: { viewId: 'v1', height: 320 } });
    });
    const el = m.doc
      .getXmlFragment(FRAGMENT_NAME)
      .toArray()
      .find((n) => n instanceof Y.XmlElement && n.nodeName === 'viewBlock') as Y.XmlElement;
    expect(el.getAttribute('viewId')).toBe('v1');
    expect(el.getAttribute('height')).toBe(320);

    const copy = new Y.Doc();
    Y.applyUpdate(copy, Y.encodeStateAsUpdate(m.doc));
    const other = await mount({ doc: copy });
    expect(blocks(other.editor)[0]?.attrs).toMatchObject({ viewId: 'v1', height: 320, copyOf: null, copyToken: null });
    await waitFor(() => expect(screen.getAllByTestId('shell-stub').length).toBeGreaterThan(0));
  });

  it('a duplicated block of an owned view gets a fresh copy of the view', async () => {
    addView({ id: 'v1', name: 'Board', config: { query: { search: 'x' } } });
    const m = await mount();
    await act(async () => {
      m.editor.commands.insertContent({ type: 'viewBlock', attrs: { viewId: 'v1' } });
    });
    expect(views.size).toBe(1);
    // The same block inserted again after the first (what paste and "Duplicate" do)
    await act(async () => {
      m.editor.commands.insertContentAt(m.editor.state.doc.content.size, { type: 'viewBlock', attrs: { viewId: 'v1' } });
    });
    await waitFor(() => expect(new Set(ids(m.editor)).size).toBe(2));
    expect(views.size).toBe(2);
    const copy = [...views.values()].find((v) => v.id !== 'v1')!;
    expect(copy).toMatchObject({ name: 'Board', layout: 'board', ownerPageId: 'page1', config: { query: { search: 'x' } } });
    expect(blocks(m.editor).every((b) => b.attrs?.copyToken == null && b.attrs?.copyOf == null)).toBe(true);
  });

  it('a duplicated block of a picked view (owned by another page) keeps showing the same view', async () => {
    addView({ id: 'shared', ownerPageId: 'other-page' });
    const m = await mount();
    await act(async () => {
      m.editor.commands.insertContent({ type: 'viewBlock', attrs: { viewId: 'shared' } });
      m.editor.commands.insertContentAt(m.editor.state.doc.content.size, { type: 'viewBlock', attrs: { viewId: 'shared' } });
    });
    await waitFor(() => expect(blocks(m.editor).every((b) => b.attrs?.copyToken == null)).toBe(true));
    expect(ids(m.editor)).toEqual(['shared', 'shared']);
    expect(views.size).toBe(1);
  });

  it('moving a block does not copy its view, and neither does a change that arrives from another client', async () => {
    addView({ id: 'v1' });
    const m = await mount();
    await act(async () => {
      m.editor.commands.insertContent([
        { type: 'viewBlock', attrs: { viewId: 'v1' } },
        { type: 'paragraph', content: [{ type: 'text', text: 'after' }] },
      ]);
    });
    // Move: delete here and insert at the end in one transaction
    await act(async () => {
      const { state, view } = m.editor;
      const node = state.doc.firstChild!;
      view.dispatch(state.tr.delete(0, node.nodeSize).insert(state.doc.content.size - node.nodeSize, node));
    });
    // A remote client adds a second block with the same view id
    const remote = new Y.Doc();
    Y.applyUpdate(remote, Y.encodeStateAsUpdate(m.doc));
    const frag = remote.getXmlFragment(FRAGMENT_NAME);
    const dup = new Y.XmlElement('viewBlock');
    dup.setAttribute('viewId', 'v1');
    frag.insert(frag.length, [dup]);
    await act(async () => {
      Y.applyUpdate(m.doc, Y.encodeStateAsUpdate(remote, Y.encodeStateVector(m.doc)));
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(views.size).toBe(1);
    expect(ids(m.editor).filter((i) => i === 'v1')).toHaveLength(2);
  });

  it('a block inserted and later removed in one editor appears and disappears in a linked editor', async () => {
    addView({ id: 'v1' });
    const net = new LinkedNetwork();
    const a = net.join();
    const b = net.join();
    const ea = await mount({ doc: a.doc });
    const eb = await mount({ doc: b.doc });
    await act(async () => {
      ea.editor.commands.insertContent([{ type: 'viewBlock', attrs: { viewId: 'v1' } }, { type: 'paragraph' }]);
    });
    expect(ids(eb.editor)).toEqual(['v1']);
    await act(async () => {
      const node = ea.editor.state.doc.firstChild!;
      ea.editor.view.dispatch(ea.editor.state.tr.delete(0, node.nodeSize));
    });
    expect(ids(ea.editor)).toEqual([]);
    expect(ids(eb.editor)).toEqual([]);
    net.dispose();
  });

  it('findNewDuplicates reports only blocks that no earlier block maps onto', async () => {
    addView({ id: 'v1' });
    const m = await mount();
    await act(async () => {
      m.editor.commands.insertContent({ type: 'viewBlock', attrs: { viewId: 'v1' } });
    });
    const before = m.editor.state.doc;
    const node = before.firstChild!;
    const tr = m.editor.state.tr.insert(0, node); // a copy placed BEFORE the original
    const found = findNewDuplicates(before, tr.doc, tr.mapping);
    expect(found).toEqual([{ pos: 0, id: 'v1' }]);
  });
});

describe('ViewBlockContent', () => {
  const baseProps = (over: Partial<Parameters<typeof ViewBlockContent>[0]> = {}) => ({
    viewId: 'v1' as string | null,
    copying: false,
    height: null,
    editable: true,
    context: CONTEXT,
    setAttrs: vi.fn(),
    removeBlock: vi.fn(),
    ...over,
  });

  it('shows the view with its name, a link to the full page, and the view itself', async () => {
    addView({ id: 'v1', name: 'Sprint board' });
    render(<ViewBlockContent {...baseProps()} />);
    expect((await screen.findByTestId('shell-stub')).textContent).toBe('v1');
    expect((screen.getByTestId('viewblock-name') as HTMLInputElement).value).toBe('Sprint board');
    expect(screen.getByTestId('viewblock-open').getAttribute('href')).toBe('/p/p1/view/v1');
  });

  it('a reader without access to the view or its table gets a quiet empty state, no error and no toast', async () => {
    addView({ id: 'v1', tableRef: 'tasks:secret' });
    deniedTables.add('tasks:secret');
    const { unmount } = render(<ViewBlockContent {...baseProps()} editable={false} />);
    expect((await screen.findByTestId('viewblock-denied')).textContent).toContain("You don't have access to this view.");
    expect(screen.queryByRole('alert')).toBeNull();
    expect(fake.toasts).toEqual([]);
    unmount();

    // The view itself refuses (403 from GET /api/views/<id>)
    const base = fake.fetch;
    fake.fetch = async (path, init) => (path === '/api/views/v9' ? json({ detail: 'Access denied' }, 403) : base(path, init));
    render(<ViewBlockContent {...baseProps({ viewId: 'v9', editable: false })} />);
    expect(await screen.findByTestId('viewblock-denied')).toBeTruthy();
    expect(fake.toasts).toEqual([]);
  });

  it('a deleted view shows "This view was deleted" with a remove button', async () => {
    const props = baseProps({ viewId: 'gone' });
    render(<ViewBlockContent {...props} />);
    expect((await screen.findByTestId('viewblock-gone')).textContent).toContain('This view was deleted.');
    fireEvent.click(screen.getByTestId('viewblock-remove-gone'));
    expect(props.removeBlock).toHaveBeenCalledOnce();
  });

  it('turns into "deleted" when the server says the view changed and it is gone', async () => {
    addView({ id: 'v1' });
    render(<ViewBlockContent {...baseProps()} />);
    await screen.findByTestId('shell-stub');
    views.delete('v1');
    await act(async () => fake.emit('view_changed', { viewId: 'v1' }));
    expect(await screen.findByTestId('viewblock-gone')).toBeTruthy();
  });

  it('removing a block of an owned view asks first, then deletes the view and the block', async () => {
    addView({ id: 'v1', ownerPageId: 'page1' });
    const props = baseProps();
    render(<ViewBlockContent {...props} />);
    await screen.findByTestId('shell-stub');

    fake.confirmAnswer = false;
    fireEvent.click(screen.getByTestId('viewblock-remove'));
    await waitFor(() => expect(fake.confirmations).toHaveLength(1));
    expect(views.has('v1')).toBe(true);
    expect(props.removeBlock).not.toHaveBeenCalled();

    fake.confirmAnswer = true;
    fireEvent.click(screen.getByTestId('viewblock-remove'));
    await waitFor(() => expect(props.removeBlock).toHaveBeenCalledOnce());
    expect(views.has('v1')).toBe(false);
    expect(fake.confirmations[1]?.opts?.danger).toBe(true);
  });

  it('removing a block of a picked view never deletes the view and does not ask', async () => {
    addView({ id: 'v1', ownerPageId: 'somewhere-else' });
    const props = baseProps();
    render(<ViewBlockContent {...props} />);
    await screen.findByTestId('shell-stub');
    fireEvent.click(screen.getByTestId('viewblock-remove'));
    await waitFor(() => expect(props.removeBlock).toHaveBeenCalledOnce());
    expect(fake.confirmations).toEqual([]);
    expect(views.has('v1')).toBe(true);
  });

  it('on a read-only page the view is shown but cannot be removed or resized', async () => {
    addView({ id: 'v1' });
    render(<ViewBlockContent {...baseProps({ editable: false })} />);
    await screen.findByTestId('shell-stub');
    expect(screen.queryByTestId('viewblock-remove')).toBeNull();
    expect(screen.queryByTestId('viewblock-resize')).toBeNull();
  });

  it('the resize handle writes a height within the limits', async () => {
    addView({ id: 'v1' });
    const props = baseProps({ height: 300 });
    render(<ViewBlockContent {...props} />);
    await screen.findByTestId('shell-stub');
    fireEvent.keyDown(screen.getByTestId('viewblock-resize'), { key: 'ArrowDown' });
    expect(props.setAttrs).toHaveBeenCalledWith({ height: 340 });
    fireEvent.doubleClick(screen.getByTestId('viewblock-resize'));
    expect(props.setAttrs).toHaveBeenLastCalledWith({ height: null });
  });

  it('an empty block lets you pick an existing view from a list', async () => {
    addView({ id: 'v1', name: 'First' });
    addView({ id: 'v2', name: 'Second', ownerPageId: null });
    const props = baseProps({ viewId: null });
    render(<ViewBlockContent {...props} />);
    fireEvent.click(screen.getByTestId('viewblock-pick'));
    const list = await screen.findByTestId('view-picker-list');
    expect(list.textContent).toContain('First');
    fireEvent.click(screen.getByText('Second'));
    expect(props.setAttrs).toHaveBeenCalledWith({ viewId: 'v2' });
  });
});
