import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { Editor as TiptapEditor } from '@tiptap/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Awareness } from 'y-protocols/awareness';
import * as Y from 'yjs';
import { setPlatform } from '../../../../platform';
import { resetStores } from '../../../../tables/store';
import type { Query, QueryResult, TableSchema } from '../../../../tables/types';
import { createFakePlatform, type FakePlatform } from '../../../../testing/fakePlatform';
import { Editor } from '../../Editor';
import { FRAGMENT_NAME } from '../../buildExtensions';
import { filterSlashItems } from '../../filter';
import { getRegisteredSlashItems } from '../../registry';
import './index'; // registers the nodes
import { SummaryContent, type SummaryContentProps } from './SummaryContent';
import {
  DEFAULT_ATTRS,
  formatNumber,
  formatValue,
  progressFraction,
  progressText,
  type SummaryAttrs,
} from './model';
import { planSummary, summaryQuery } from './plan';

const SCHEMA: TableSchema = {
  ref: 'tasks:p1',
  name: 'Tasks',
  titleColumn: 'name',
  capabilities: { create: true, delete: true, hierarchy: true, editSchema: true },
  columns: [
    { key: 'name', name: 'Name', type: 'text', builtin: true },
    {
      key: 'status',
      name: 'Status',
      type: 'status',
      builtin: true,
      options: [
        { value: 's1', label: 'To do' },
        { value: 's2', label: 'Doing' },
        { value: 's3', label: 'Done' },
      ],
    },
    { key: 'estimate', name: 'Estimate', type: 'number', builtin: false },
    { key: 'dueDate', name: 'Due date', type: 'date', builtin: true },
  ],
};

interface Row {
  status: string;
  estimate: number | null;
}
let fake: FakePlatform;
let rows: Row[];
let views: Map<string, { id: string; tableRef: string; name: string; layout: string; config: { query: Query }; ownerPageId: string | null; canEdit: boolean }>;
let deniedTables: Set<string>;
let queries: Array<{ ref: string; body: Query }>;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** What the real engine would answer for the queries a summary sends (limit 0: totals only). */
function answer(body: Query): QueryResult {
  const filtered = rows.filter((r) => {
    const f = body.filter as { column?: string; op?: string; value?: unknown } | undefined;
    return !f || f.op !== 'eq' || (r as unknown as Record<string, unknown>)[f.column!] === f.value;
  });
  const result: QueryResult = { rows: [], total: filtered.length };
  if (body.groupBy === 'status') {
    result.groups = ['s1', 's2', 's3'].map((k) => ({ key: k, label: k, count: filtered.filter((r) => r.status === k).length }));
  }
  const spec = body.summaries ?? {};
  if (Object.keys(spec).length) {
    result.summaries = {};
    for (const [col, fn] of Object.entries(spec)) {
      const nums = filtered.map((r) => r.estimate).filter((n): n is number => n !== null);
      result.summaries[col] = fn === 'sum' ? nums.reduce((a, b) => a + b, 0) : fn === 'max' ? (nums.length ? Math.max(...nums) : null) : null;
    }
  }
  return result;
}

function installServer() {
  const base = fake.fetch.bind(fake);
  fake.fetch = async (path, init) => {
    const method = (init?.method ?? 'GET').toUpperCase();
    const one = /^\/api\/views\/([^/?]+)$/.exec(path);
    if (method === 'GET' && one) {
      const v = views.get(decodeURIComponent(one[1]!));
      return v ? json(v) : json({ detail: 'View not found' }, 404);
    }
    if (method === 'GET' && path.startsWith('/api/views')) return json({ views: [...views.values()] });
    const schema = /^\/api\/tables\/(.+)\/schema$/.exec(path);
    if (schema) {
      const ref = decodeURIComponent(schema[1]!);
      return deniedTables.has(ref) ? json({ detail: 'Task access denied' }, 403) : json({ ...SCHEMA, ref });
    }
    const q = /^\/api\/tables\/(.+)\/query$/.exec(path);
    if (q && method === 'POST') {
      const ref = decodeURIComponent(q[1]!);
      const body = JSON.parse(init!.body as string) as Query;
      queries.push({ ref, body });
      return deniedTables.has(ref) ? json({ detail: 'Task access denied' }, 403) : json(answer(body));
    }
    return base(path, init);
  };
}

function addView(extra: Partial<(typeof views extends Map<string, infer V> ? V : never)> = {}) {
  const v = { id: 'v1', tableRef: 'tasks:p1', name: 'Board', layout: 'board', config: { query: {} }, ownerPageId: 'page1', canEdit: true, ...extra };
  views.set(v.id, v);
  return v;
}

beforeEach(() => {
  rows = [
    { status: 's1', estimate: 5 },
    { status: 's3', estimate: 3 },
    { status: 's3', estimate: 1200 },
    { status: 's2', estimate: null },
  ];
  views = new Map();
  deniedTables = new Set();
  queries = [];
  fake = createFakePlatform();
  installServer();
  setPlatform(fake);
});
afterEach(() => {
  cleanup();
  resetStores();
  setPlatform(null);
});

describe('model', () => {
  it('formats numbers with thin grouping and at most 2 decimals, percent as a whole number, a dash for nothing', () => {
    expect(formatNumber(1234567.891)).toBe('1 234 567.89');
    expect(formatNumber(3)).toBe('3');
    expect(formatValue('sum', 12.5)).toBe('12.5');
    expect(formatValue('percentDone', 66.666)).toBe('67%');
    expect(formatValue('percentChecked', 0)).toBe('0%');
    expect(formatValue('avg', null)).toBe('—');
    expect(formatValue('min', '2026-01-02')).toBe('2026-01-02');
  });

  it('progress is measured against 100 for percentages and against the target otherwise', () => {
    expect(progressFraction('percentDone', 40, null)).toBe(0.4);
    expect(progressFraction('count', 5, 20)).toBe(0.25);
    expect(progressFraction('count', 50, 20)).toBe(1);
    expect(progressFraction('count', 5, null)).toBeNull();
    expect(progressText('count', 5, 20)).toBe('5 / 20');
    expect(progressText('percentDone', 40, null)).toBe('40%');
  });

  it('the request keeps the view filter and search, drops sort, grouping and paging, and asks for totals only', () => {
    const filter = { column: 'assignees', op: 'in' as const, value: ['@me'] };
    const q = summaryQuery({ filter, search: 'x', sort: [{ column: 'name', dir: 'asc' }], groupBy: 'status', limit: 50, offset: 10, parentId: null }, {});
    expect(q).toEqual({ filter, search: 'x', parentId: null, limit: 0 });
  });

  it('plans each function', () => {
    const count = planSummary(SCHEMA, 'count', null);
    expect(count.ok && count.extra).toEqual({});
    expect(count.ok && count.read({ rows: [], total: 7 })).toBe(7);

    const sum = planSummary(SCHEMA, 'sum', 'estimate');
    expect(sum.ok && sum.extra).toEqual({ summaries: { estimate: 'sum' } });
    expect(sum.ok && sum.read({ rows: [], total: 2, summaries: { estimate: 9 } })).toBe(9);

    const done = planSummary(SCHEMA, 'percentDone', null);
    expect(done.ok && done.extra).toEqual({ groupBy: 'status' });
    expect(
      done.ok &&
        done.read({ rows: [], total: 4, groups: [{ key: 's1', label: '', count: 1 }, { key: 's3', label: '', count: 2 }, { key: null, label: '', count: 1 }] }),
    ).toBe(50);
    expect(done.ok && done.read({ rows: [], total: 0 })).toBeNull();

    expect(planSummary(SCHEMA, 'sum', null)).toMatchObject({ ok: false, reason: 'Choose a column' });
    expect(planSummary(SCHEMA, 'sum', 'name')).toMatchObject({ ok: false });
    expect(planSummary(SCHEMA, 'avg', 'gone')).toMatchObject({ ok: false, reason: 'This column no longer exists' });
    expect(planSummary(SCHEMA, 'percentChecked', 'estimate')).toMatchObject({ ok: false });
    expect(planSummary({ ...SCHEMA, columns: [SCHEMA.columns[0]!] }, 'percentDone', null)).toMatchObject({ ok: false });
  });

  it('percent done with a checkbox as the done flag asks the engine for percentChecked', () => {
    const schema: TableSchema = { ...SCHEMA, columns: [SCHEMA.columns[0]!, { key: 'ok', name: 'OK', type: 'checkbox', builtin: false }] };
    const plan = planSummary(schema, 'percentDone', null);
    expect(plan.ok && plan.extra).toEqual({ summaries: { ok: 'percentChecked' } });
  });
});

const props = (over: Omit<Partial<SummaryContentProps>, 'attrs'> & { attrs?: Partial<SummaryAttrs> } = {}): SummaryContentProps => ({
  variant: 'block',
  editable: true,
  autoOpen: false,
  pageViewIds: () => [],
  setAttrs: vi.fn(),
  removeNode: vi.fn(),
  ...over,
  attrs: { ...DEFAULT_ATTRS, viewId: 'v1', ...over.attrs },
});

describe('SummaryContent', () => {
  it('shows a skeleton first, then the count, asking the server for the total only', async () => {
    addView({ config: { query: { filter: { column: 'status', op: 'eq', value: 's3' }, sort: [{ column: 'name', dir: 'asc' }] } } });
    render(<SummaryContent {...props()} />);
    expect(document.querySelector('.cl-summary__skeleton')).toBeTruthy();
    expect((await screen.findByTestId('summary-value')).textContent).toBe('2');
    expect(screen.getByTestId('summary-label').textContent).toBe('Count');
    const sent = queries.map((q) => q.body);
    expect(sent).toEqual([{ filter: { column: 'status', op: 'eq', value: 's3' }, limit: 0 }]);
  });

  it('shows the label, and a sum with grouping and no more than two decimals', async () => {
    addView();
    render(<SummaryContent {...props({ attrs: { fn: 'sum', column: 'estimate', label: 'Hours' } })} />);
    expect((await screen.findByTestId('summary-value')).textContent).toBe('1 208');
    expect(screen.getByTestId('summary-label').textContent).toBe('Hours');
    expect(queries[0]!.body).toEqual({ summaries: { estimate: 'sum' }, limit: 0 });
  });

  it('percent done uses one grouped count by status and shows a progress bar with the value beside it', async () => {
    addView();
    render(<SummaryContent {...props({ attrs: { fn: 'percentDone', display: 'progress' } })} />);
    expect((await screen.findByTestId('summary-value')).textContent).toBe('50%');
    expect(screen.getByTestId('summary-bar').getAttribute('aria-valuenow')).toBe('50');
    expect(queries).toHaveLength(1);
    expect(queries[0]!.body).toEqual({ groupBy: 'status', limit: 0 });
  });

  it('a progress bar with a target shows "value / target"', async () => {
    addView();
    render(<SummaryContent {...props({ attrs: { display: 'progress', target: 8 } })} />);
    expect((await screen.findByTestId('summary-value')).textContent).toBe('4 / 8');
    expect(screen.getByTestId('summary-bar').getAttribute('aria-valuenow')).toBe('50');
  });

  it('an empty result shows 0 for a count or sum and a dash for an average or percentage', async () => {
    addView();
    rows = [];
    const { unmount } = render(<SummaryContent {...props()} />);
    expect((await screen.findByTestId('summary-value')).textContent).toBe('0');
    unmount();
    render(<SummaryContent {...props({ attrs: { fn: 'percentDone' } })} />);
    await waitFor(() => expect(screen.getByTestId('summary-value').textContent).toBe('—'));
    expect(screen.getByTestId('summary-state').getAttribute('data-state')).toBe('ready');
  });

  it('follows rows_changed without a reload', async () => {
    addView();
    render(<SummaryContent {...props()} />);
    await waitFor(() => expect(screen.getByTestId('summary-value').textContent).toBe('4'));
    rows.push({ status: 's1', estimate: 1 }, { status: 's1', estimate: 1 });
    await act(async () => fake.emit('rows_changed', { tableRef: 'tasks:p1', ids: ['x'], change: 'created' }));
    await waitFor(() => expect(screen.getByTestId('summary-value').textContent).toBe('6'));
  });

  it('two summaries of the same view share one request', async () => {
    addView();
    render(
      <>
        <SummaryContent {...props()} />
        <SummaryContent {...props({ variant: 'inline' })} />
      </>,
    );
    await waitFor(() => expect(screen.getByTestId('summary-inline').textContent).toBe('4'));
    expect(queries).toHaveLength(1);
  });

  it('without access it shows a dash, no toast and no error', async () => {
    addView({ tableRef: 'tasks:secret' });
    deniedTables.add('tasks:secret');
    render(<SummaryContent {...props({ editable: false })} />);
    await waitFor(() => expect(screen.getByTestId('summary-state').getAttribute('data-state')).toBe('denied'));
    expect(screen.getByTestId('summary-value').textContent).toBe('—');
    fireEvent.focus(screen.getByTestId('summary-value'));
    expect((await screen.findByRole('tooltip')).textContent).toBe("You don't have access to this view");
    expect(fake.toasts).toEqual([]);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('a view that denies the rows after its schema was readable also shows the dash', async () => {
    addView();
    const base = fake.fetch;
    fake.fetch = async (path, init) => (path.endsWith('/query') ? json({ detail: 'Access denied' }, 403) : base(path, init));
    render(<SummaryContent {...props({ variant: 'inline' })} />);
    await waitFor(() => expect(screen.getByTestId('summary-state').getAttribute('data-state')).toBe('denied'));
    expect(fake.toasts).toEqual([]);
  });

  it('a deleted view shows "View deleted" with a remove button for an editor, and none for a reader', async () => {
    const p = props({ attrs: { viewId: 'gone' } });
    const { unmount } = render(<SummaryContent {...p} />);
    expect((await screen.findByTestId('summary-value')).textContent).toBe('View deleted');
    fireEvent.click(screen.getByTestId('summary-remove'));
    expect(p.removeNode).toHaveBeenCalledOnce();
    expect(screen.queryByTestId('summary-setup')).toBeNull(); // the click on the button does not open the settings
    unmount();
    render(<SummaryContent {...props({ attrs: { viewId: 'gone' }, editable: false })} />);
    expect((await screen.findByTestId('summary-value')).textContent).toBe('View deleted');
    expect(screen.queryByTestId('summary-remove')).toBeNull();
  });

  it('a column that no longer fits shows a dash with the reason', async () => {
    addView();
    render(<SummaryContent {...props({ attrs: { fn: 'sum', column: 'removed' }, editable: false })} />);
    await waitFor(() => expect(screen.getByTestId('summary-state').getAttribute('data-state')).toBe('problem'));
    fireEvent.focus(screen.getByTestId('summary-value'));
    expect((await screen.findByRole('tooltip')).textContent).toBe('This column no longer exists');
  });

  it('on a read-only page the value is shown without controls', async () => {
    addView();
    render(<SummaryContent {...props({ editable: false })} />);
    await waitFor(() => expect(screen.getByTestId('summary-value').textContent).toBe('4'));
    const block = screen.getByTestId('summary-block');
    expect(block.getAttribute('role')).toBeNull();
    fireEvent.click(block);
    expect(screen.queryByTestId('summary-setup')).toBeNull();
  });

  it('clicking an editable block opens the settings; changes are written as attributes', async () => {
    addView();
    const p = props();
    render(<SummaryContent {...p} />);
    await waitFor(() => expect(screen.getByTestId('summary-value').textContent).toBe('4'));
    fireEvent.click(screen.getByTestId('summary-block'));
    expect(await screen.findByTestId('summary-setup')).toBeTruthy();
    expect(screen.queryByTestId('summary-column')).toBeNull(); // count needs no column
    fireEvent.change(screen.getByTestId('summary-fn'), { target: { value: 'sum' } });
    expect(p.setAttrs).toHaveBeenLastCalledWith({ fn: 'sum' });
    fireEvent.change(screen.getByTestId('summary-display'), { target: { value: 'progress' } });
    expect(p.setAttrs).toHaveBeenLastCalledWith({ display: 'progress' });
    fireEvent.change(screen.getByTestId('summary-fn'), { target: { value: 'percentDone' } });
    expect(p.setAttrs).toHaveBeenLastCalledWith({ fn: 'percentDone', column: null });
  });

  it('the column list only offers columns the function can read', async () => {
    addView();
    render(<SummaryContent {...props({ attrs: { fn: 'sum' } })} />);
    fireEvent.click(await screen.findByTestId('summary-block'));
    await waitFor(() => expect(screen.getByTestId('summary-column').querySelectorAll('option').length).toBeGreaterThan(1));
    const names = [...screen.getByTestId('summary-column').querySelectorAll('option')].map((o) => o.textContent);
    expect(names).toEqual(['Choose a column', 'Estimate']);
  });

  it('choosing a view lists the view blocks of the page first', async () => {
    addView({ id: 'a', name: 'Alpha' });
    addView({ id: 'b', name: 'Beta' });
    const p = props({ attrs: { viewId: null }, autoOpen: true, pageViewIds: () => ['b'] });
    render(<SummaryContent {...p} />);
    fireEvent.click(await screen.findByTestId('summary-pick-view'));
    const list = await screen.findByTestId('view-picker-list');
    expect([...list.querySelectorAll('.cl-viewpicker__name')].map((e) => e.textContent)).toEqual(['Beta', 'Alpha']);
    expect(list.textContent).toContain('on this page');
    fireEvent.click(list.querySelector('[data-view-id="b"]')!);
    expect(p.setAttrs).toHaveBeenCalledWith({ viewId: 'b', column: null });
  });
});

const CONTEXT = { pageId: 'page1' };
async function mount(opts: { doc?: Y.Doc; editable?: boolean } = {}) {
  const doc = opts.doc ?? new Y.Doc();
  let editor: TiptapEditor | null = null;
  await act(async () =>
    render(
      <Editor
        doc={doc}
        awareness={new Awareness(doc)}
        user={{ id: 'u1', name: 'Ada', color: '#e8590c' }}
        editable={opts.editable ?? true}
        pageId={CONTEXT.pageId}
        onReady={(e) => {
          editor = e;
        }}
      />,
    ),
  );
  return { editor: editor as unknown as TiptapEditor, doc };
}
const nodesOf = (editor: TiptapEditor, type: string) => {
  const found: Array<Record<string, any>> = [];
  editor.state.doc.descendants((n) => {
    if (n.type.name === type) found.push(n.attrs);
    return true;
  });
  return found;
};

describe('the nodes in the document', () => {
  it('offers /summary and /number in the slash menu', () => {
    const all = getRegisteredSlashItems();
    expect(filterSlashItems(all, 'summary').map((i) => i.id)).toContain('summary-block');
    expect(filterSlashItems(all, 'number').map((i) => i.id)).toContain('summary-inline');
  });

  it('keeps all attributes in the Yjs document and reads them back in a second editor', async () => {
    addView();
    const m = await mount();
    const attrs = { viewId: 'v1', fn: 'sum', column: 'estimate', label: 'Hours', display: 'progress', target: 40 };
    await act(async () => {
      m.editor.commands.insertContent([{ type: 'summary', attrs }, { type: 'paragraph', content: [{ type: 'text', text: 'Open: ' }, { type: 'summaryInline', attrs: { viewId: 'v1', fn: 'count' } }] }]);
    });
    const el = m.doc
      .getXmlFragment(FRAGMENT_NAME)
      .toArray()
      .find((n) => n instanceof Y.XmlElement && n.nodeName === 'summary') as Y.XmlElement;
    expect(el.getAttribute('viewId')).toBe('v1');
    expect(el.getAttribute('fn')).toBe('sum');
    expect(el.getAttribute('target')).toBe(40);

    const copy = new Y.Doc();
    Y.applyUpdate(copy, Y.encodeStateAsUpdate(m.doc));
    const other = await mount({ doc: copy });
    expect(nodesOf(other.editor, 'summary')[0]).toMatchObject(attrs);
    expect(nodesOf(other.editor, 'summaryInline')[0]).toMatchObject({ viewId: 'v1', fn: 'count', column: null });
    await waitFor(() => expect(screen.getAllByTestId('summary-value').length).toBeGreaterThan(1));
  });

  it('/summary inserts an empty block, selects it and opens the settings; /number does the same inline', async () => {
    addView();
    const m = await mount();
    await act(async () => {
      getRegisteredSlashItems().find((i) => i.id === 'summary-block')!.run(m.editor, { from: 1, to: 1 });
    });
    expect(nodesOf(m.editor, 'summary')).toHaveLength(1);
    expect(nodesOf(m.editor, 'summary')[0]).toMatchObject({ viewId: null, fn: 'count', display: 'number' });
    expect(await screen.findByTestId('summary-setup')).toBeTruthy();
    fireEvent.click(screen.getByTestId('summary-pick-view'));
    fireEvent.click(await screen.findByText('Board'));
    await waitFor(() => expect(nodesOf(m.editor, 'summary')[0]?.viewId).toBe('v1'));
    await waitFor(() => expect(screen.getByTestId('summary-value').textContent).toBe('4'));
    fireEvent.change(screen.getByTestId('summary-fn'), { target: { value: 'sum' } });
    await waitFor(() => expect(nodesOf(m.editor, 'summary')[0]?.fn).toBe('sum'));
  });

  it('a read-only editor shows the number and no settings', async () => {
    addView();
    const m = await mount({ editable: false });
    await act(async () => {
      m.editor.commands.insertContent({ type: 'summaryInline', attrs: { viewId: 'v1', fn: 'count' } });
    });
    await waitFor(() => expect(screen.getByTestId('summary-inline').textContent).toBe('4'));
    fireEvent.click(screen.getByTestId('summary-inline'));
    expect(screen.queryByTestId('summary-setup')).toBeNull();
  });
});
