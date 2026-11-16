import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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
import './index'; // registers the node
import { BarChart } from './BarChart';
import { ChartContent, type ChartContentProps } from './ChartContent';
import { DonutChart } from './DonutChart';
import { LineChart } from './LineChart';
import { DEFAULT_ATTRS, formatNumber, type ChartAttrs, type Point } from './model';

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
        { value: 's1', label: 'To do', color: '#e03131' },
        { value: 's2', label: 'Doing', color: '#f08c00' },
        { value: 's3', label: 'Done', color: '#2f9e44' },
      ],
    },
    { key: 'estimate', name: 'Estimate', type: 'number', builtin: false },
    { key: 'dueDate', name: 'Due date', type: 'date', builtin: true },
  ],
};

let fake: FakePlatform;
let statusOf: string[];
let views: Map<string, { id: string; tableRef: string; name: string; layout: string; config: { query: Query }; ownerPageId: string | null; canEdit: boolean }>;
let deniedTables: Set<string>;
let queries: Array<{ ref: string; body: Query }>;
let groupsOverride: QueryResult['groups'] | null;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** What the real engine answers for a grouped query with limit 0. */
function answer(body: Query): QueryResult {
  const result: QueryResult = { rows: [], total: statusOf.length };
  if (body.groupBy === 'status') {
    result.groups =
      groupsOverride ??
      SCHEMA.columns[1]!.options!.map((o) => ({
        key: o.value,
        label: o.label,
        color: o.color,
        count: statusOf.filter((s) => s === o.value).length,
        ...(body.summaries ? { summaries: { estimate: statusOf.filter((s) => s === o.value).length * 10 } } : {}),
      }));
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
  statusOf = ['s1', 's3', 's3', 's2', 's3'];
  groupsOverride = null;
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
  vi.restoreAllMocks();
});

const pt = (label: string, value: number | null, color = '#2f9e44', key: string | null = label): Point => ({ key, label, full: label, value, color });
const SIZE = { width: 560, height: 220 };
const marks = () => screen.getAllByTestId('chart-mark');
const names = () => marks().map((m) => m.getAttribute('aria-label'));

describe('BarChart', () => {
  const points = [pt('To do', 1), pt('Doing', 1), pt('Done', 3)];

  it('draws a bar and a value label per category, with round ticks and focusable named marks', () => {
    const { container } = render(<BarChart points={points} size={SIZE} measure="Count" integer />);
    expect(container.querySelectorAll('rect.cl-chart__bar')).toHaveLength(3);
    expect([...container.querySelectorAll('.cl-chart__value')].map((e) => e.textContent)).toEqual(['1', '1', '3']);
    expect([...container.querySelectorAll('.cl-chart__tick')].map((e) => e.textContent)).toEqual(['0', '1', '2', '3']);
    expect([...container.querySelectorAll('.cl-chart__label')].map((e) => e.textContent)).toEqual(['To do', 'Doing', 'Done']);
    expect(names()).toEqual(['To do: 1', 'Doing: 1', 'Done: 3']);
    expect(marks().every((m) => m.getAttribute('tabindex') === '0')).toBe(true);
    expect(screen.getByTestId('chart-plot').getAttribute('data-orientation')).toBe('vertical');
  });

  it('a mark shows the exact value in a tooltip on keyboard focus and hides it again', () => {
    render(<BarChart points={[pt('Done', 1234.5)]} size={SIZE} measure="Sum" integer={false} />);
    fireEvent.focus(marks()[0]!);
    expect(screen.getByRole('tooltip').textContent).toBe(`Done${formatNumber(1234.5)}`);
    fireEvent.blur(marks()[0]!);
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('runs sideways with many categories and shortens long labels', () => {
    const many = Array.from({ length: 12 }, (_, i) => pt(`Category number ${i + 1} with a long name`, i + 1, '#228be6', `k${i}`));
    const { container } = render(<BarChart points={many} size={SIZE} measure="Count" integer />);
    expect(screen.getByTestId('chart-plot').getAttribute('data-orientation')).toBe('horizontal');
    const labels = [...container.querySelectorAll('.cl-chart__label')].map((e) => e.textContent ?? '');
    expect(labels).toHaveLength(12);
    expect(labels.every((l) => l.length <= 30)).toBe(true);
    expect(labels[0]!.endsWith('…')).toBe(true);
    expect(names()[0]).toBe('Category number 1 with a long name: 1'); // the accessible name keeps the full text
  });

  it('uses the first slot for a null value and draws no bar for it', () => {
    const { container } = render(<BarChart points={[pt('A', null), pt('B', 2)]} size={SIZE} measure="Average" integer={false} />);
    expect(names()).toEqual(['A: no value', 'B: 2']);
    expect(container.querySelectorAll('rect.cl-chart__bar')[0]!.getAttribute('height')).toBe('0');
  });
});

describe('LineChart', () => {
  it('draws a point per group, a line through them, and breaks the line at a missing value', () => {
    const pts = [pt('W1', 1), pt('W2', 3), pt('W3', null), pt('W4', 2)];
    const { container } = render(<LineChart points={pts} size={SIZE} measure="Count" integer />);
    expect(container.querySelectorAll('circle.cl-chart__dot')).toHaveLength(3);
    expect(container.querySelectorAll('path.cl-chart__line')).toHaveLength(2);
    expect(names()).toEqual(['W1: 1', 'W2: 3', 'W3: no value', 'W4: 2']);
    expect([...container.querySelectorAll('.cl-chart__label')].map((e) => e.textContent)).toEqual(['W1', 'W2', 'W3', 'W4']);
  });

  it('thins out crowded labels', () => {
    const pts = Array.from({ length: 40 }, (_, i) => pt(`Nov ${i + 1}`, i, '#228be6', `d${i}`));
    const { container } = render(<LineChart points={pts} size={{ width: 300, height: 220 }} measure="Count" integer />);
    expect(container.querySelectorAll('.cl-chart__label').length).toBeLessThan(40);
    expect(marks()).toHaveLength(40);
  });
});

describe('DonutChart', () => {
  it('draws a slice per group, the total in the middle and a legend with values and percentages', () => {
    const { container } = render(<DonutChart points={[pt('To do', 1), pt('Doing', 1), pt('Done', 2)]} size={SIZE} measure="Count" integer fn="count" />);
    expect(container.querySelectorAll('path.cl-chart__slice')).toHaveLength(3);
    expect(screen.getByTestId('chart-total').textContent).toBe('4');
    const legend = within(screen.getByTestId('chart-legend'));
    expect(legend.getAllByRole('listitem').map((li) => li.textContent)).toEqual(['To do125%', 'Doing125%', 'Done250%']);
    expect(names()).toEqual(['To do: 1 (25%)', 'Doing: 1 (25%)', 'Done: 2 (50%)']);
  });

  it('a single group is a full ring, and an average shows no total or percentages', () => {
    const { container } = render(<DonutChart points={[pt('Only', 5)]} size={SIZE} measure="Average" integer={false} fn="avg" />);
    const d = container.querySelector('path.cl-chart__slice')!.getAttribute('d')!;
    expect(d).not.toContain('NaN');
    expect(screen.getByTestId('chart-total').textContent).toBe('');
    expect(screen.getByTestId('chart-legend').textContent).toBe('Only5');
    expect(names()).toEqual(['Only: 5']);
  });
});

const props = (over: Omit<Partial<ChartContentProps>, 'attrs'> & { attrs?: Partial<ChartAttrs> } = {}): ChartContentProps => ({
  editable: true,
  autoOpen: false,
  pageViewIds: () => [],
  setAttrs: vi.fn(),
  removeNode: vi.fn(),
  ...over,
  attrs: { ...DEFAULT_ATTRS, viewId: 'v1', groupBy: 'status', ...over.attrs },
});

describe('ChartContent', () => {
  it('shows a skeleton in a frame of the final height, then the bars from ONE grouped query with limit 0', async () => {
    addView({ config: { query: { filter: { column: 'status', op: 'neq', value: 's9' }, sort: [{ column: 'name', dir: 'asc' }], groupBy: 'dueDate' } } });
    render(<ChartContent {...props({ attrs: { height: 300 } })} />);
    expect(screen.getByTestId('chart-state').getAttribute('data-state')).toBe('loading');
    expect(screen.getByTestId('chart').style.height).toBe('300px');
    await waitFor(() => expect(screen.getByTestId('chart-state').getAttribute('data-state')).toBe('ready'));
    expect(queries.map((q) => q.body)).toEqual([{ filter: { column: 'status', op: 'neq', value: 's9' }, groupBy: 'status', limit: 0 }]);
    expect(names()).toEqual(['To do: 1', 'Doing: 1', 'Done: 3']);
    expect(screen.getByTestId('chart').style.height).toBe('300px');
  });

  it('uses the options colours and the default height', async () => {
    addView();
    const { container } = render(<ChartContent {...props()} />);
    await screen.findAllByTestId('chart-mark');
    expect([...container.querySelectorAll('rect.cl-chart__bar')].map((r) => r.getAttribute('fill'))).toEqual(['#e03131', '#f08c00', '#2f9e44']);
    expect(screen.getByTestId('chart').style.height).toBe('280px');
  });

  it('has a hidden table with the data as the text alternative', async () => {
    addView();
    render(<ChartContent {...props({ attrs: { title: 'Tasks by status' } })} />);
    await screen.findAllByTestId('chart-mark');
    const table = screen.getByTestId('chart-table');
    expect(table.querySelector('caption')!.textContent).toBe('Tasks by status');
    expect([...table.querySelectorAll('tbody tr')].map((r) => r.textContent)).toEqual(['To do1', 'Doing1', 'Done3']);
    expect(screen.getByTestId('chart-title').textContent).toBe('Tasks by status');
  });

  it('a measure sends one summary and reads it per group', async () => {
    addView();
    render(<ChartContent {...props({ attrs: { fn: 'sum', column: 'estimate' } })} />);
    await screen.findAllByTestId('chart-mark');
    expect(queries[0]!.body).toEqual({ groupBy: 'status', summaries: { estimate: 'sum' }, limit: 0 });
    expect(names()).toEqual(['To do: 10', 'Doing: 10', 'Done: 30']);
    expect(screen.getByTestId('chart-table').querySelector('thead')!.textContent).toBe('StatusSum of Estimate');
  });

  it('a date group column asks for the bucket', async () => {
    addView();
    render(<ChartContent {...props({ attrs: { groupBy: 'dueDate', bucket: 'month' } })} />);
    await waitFor(() => expect(queries.length).toBeGreaterThan(0));
    expect(queries[0]!.body).toEqual({ groupBy: 'dueDate', groupBucket: 'month', limit: 0 });
  });

  it('switching the type keeps the numbers and adds no request', async () => {
    addView();
    const p = props();
    const { rerender } = render(<ChartContent {...p} />);
    await screen.findAllByTestId('chart-mark');
    rerender(<ChartContent {...p} attrs={{ ...p.attrs, type: 'donut' }} />);
    await waitFor(() => expect(screen.getByTestId('chart-total').textContent).toBe('5'));
    expect(names()).toEqual(['To do: 1 (20%)', 'Doing: 1 (20%)', 'Done: 3 (60%)']);
    rerender(<ChartContent {...p} attrs={{ ...p.attrs, type: 'line' }} />);
    await waitFor(() => expect(names()).toEqual(['To do: 1', 'Doing: 1', 'Done: 3']));
    expect(queries).toHaveLength(1);
  });

  it('a donut merges everything past eight slices into Other and leaves out empty groups', async () => {
    addView();
    groupsOverride = [
      ...Array.from({ length: 10 }, (_, i) => ({ key: `g${i}`, label: `Group ${i}`, count: i + 1 })),
      { key: 'zero', label: 'Nobody', count: 0 },
    ];
    // The fake answers with these groups for a groupBy on the status
    render(<ChartContent {...props({ attrs: { type: 'donut' } })} />);
    await waitFor(() => expect(marks()).toHaveLength(8));
    const last = names()[7]!;
    // Ten groups of 1..10 rows: the seven largest stay, the three smallest (1 + 2 + 3) become Other
    expect(last).toMatch(/^Other: 6 /);
    expect(screen.getByTestId('chart-total').textContent).toBe('55');
    // The hidden table keeps every group
    expect(screen.getByTestId('chart-table').querySelectorAll('tbody tr')).toHaveLength(11);
  });

  it('follows rows_changed without a reload', async () => {
    addView();
    render(<ChartContent {...props()} />);
    await screen.findAllByTestId('chart-mark');
    statusOf.push('s1', 's1');
    statusOf[1] = 's2';
    await act(async () => fake.emit('rows_changed', { tableRef: 'tasks:p1', ids: ['x'], change: 'updated' }));
    await waitFor(() => expect(names()).toEqual(['To do: 3', 'Doing: 2', 'Done: 2']));
  });

  it('two charts of the same view and settings share one request', async () => {
    addView();
    render(
      <>
        <ChartContent {...props()} />
        <ChartContent {...props({ attrs: { type: 'donut' } })} />
      </>,
    );
    await waitFor(() => expect(screen.getAllByTestId('chart-mark').length).toBe(6));
    expect(queries).toHaveLength(1);
  });

  it('without access it says so quietly: no toast, no alert', async () => {
    addView({ tableRef: 'tasks:secret' });
    deniedTables.add('tasks:secret');
    render(<ChartContent {...props({ editable: false })} />);
    await waitFor(() => expect(screen.getByTestId('chart-state').getAttribute('data-state')).toBe('denied'));
    expect(screen.getByTestId('chart-state').textContent).toBe("You don't have access to this view");
    expect(fake.toasts).toEqual([]);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('a query the server denies after the schema was readable is also the quiet state', async () => {
    addView();
    const base = fake.fetch;
    fake.fetch = async (path, init) => (path.endsWith('/query') ? json({ detail: 'Access denied' }, 403) : base(path, init));
    render(<ChartContent {...props()} />);
    await waitFor(() => expect(screen.getByTestId('chart-state').getAttribute('data-state')).toBe('denied'));
    expect(fake.toasts).toEqual([]);
  });

  it('a deleted view shows "View deleted" with Remove for an editor only', async () => {
    const p = props({ attrs: { viewId: 'gone' } });
    const { unmount } = render(<ChartContent {...p} />);
    await waitFor(() => expect(screen.getByTestId('chart-state').getAttribute('data-state')).toBe('gone'));
    fireEvent.click(screen.getByTestId('chart-remove'));
    expect(p.removeNode).toHaveBeenCalledOnce();
    expect(screen.queryByTestId('chart-setup')).toBeNull();
    unmount();
    render(<ChartContent {...props({ attrs: { viewId: 'gone' }, editable: false })} />);
    await waitFor(() => expect(screen.getByTestId('chart-state').textContent).toBe('View deleted'));
    expect(screen.queryByTestId('chart-remove')).toBeNull();
  });

  it('a column that no longer fits says which setting to fix', async () => {
    addView();
    const { unmount } = render(<ChartContent {...props({ attrs: { groupBy: 'removed' } })} />);
    await waitFor(() => expect(screen.getByTestId('chart-state').getAttribute('data-state')).toBe('problem'));
    expect(screen.getByTestId('chart-state').textContent).toMatch(/^Group by: this column no longer exists/);
    unmount();
    render(<ChartContent {...props({ attrs: { fn: 'sum', column: 'name' } })} />);
    await waitFor(() => expect(screen.getByTestId('chart-state').textContent).toBe('Measure: Name is not a number column.'));
  });

  it('no rows: "No rows to chart"', async () => {
    addView();
    statusOf = [];
    render(<ChartContent {...props()} />);
    await waitFor(() => expect(screen.getByTestId('chart-state').textContent).toBe('No rows to chart'));
  });

  it('no view yet: a prompt for an editor, a quiet note for a reader', () => {
    const { unmount } = render(<ChartContent {...props({ attrs: { viewId: null } })} />);
    expect(screen.getByTestId('chart-choose')).toBeTruthy();
    unmount();
    render(<ChartContent {...props({ attrs: { viewId: null }, editable: false })} />);
    expect(screen.getByTestId('chart-state').textContent).toBe('No view chosen');
  });

  it('fills the width of its box and follows it when it changes', async () => {
    addView();
    let width = 600;
    let observe: (() => void) | null = null;
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(() => width);
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(() => 240);
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(cb: () => void) {
          observe = cb;
        }
        observe() {}
        disconnect() {}
      },
    );
    const { container } = render(<ChartContent {...props()} />);
    await screen.findAllByTestId('chart-mark');
    expect(container.querySelector('svg')!.getAttribute('width')).toBe('600');
    width = 280;
    await act(async () => observe!());
    expect(container.querySelector('svg')!.getAttribute('width')).toBe('280');
    expect(names()).toEqual(['To do: 1', 'Doing: 1', 'Done: 3']);
    vi.unstubAllGlobals();
  });

  it('on a read-only page there are no controls and a click opens nothing', async () => {
    addView();
    render(<ChartContent {...props({ editable: false })} />);
    await screen.findAllByTestId('chart-mark');
    expect(screen.queryByTestId('chart-settings-btn')).toBeNull();
    expect(screen.queryByTestId('chart-resize')).toBeNull();
    fireEvent.click(screen.getByTestId('chart'));
    expect(screen.queryByTestId('chart-setup')).toBeNull();
  });

  it('the bottom edge resizes by keyboard and by drag, and a double click resets', async () => {
    addView();
    const p = props({ attrs: { height: 300 } });
    render(<ChartContent {...p} />);
    const edge = screen.getByTestId('chart-resize');
    fireEvent.keyDown(edge, { key: 'ArrowDown' });
    expect(p.setAttrs).toHaveBeenLastCalledWith({ height: 320 });
    fireEvent.keyDown(edge, { key: 'ArrowUp' });
    expect(p.setAttrs).toHaveBeenLastCalledWith({ height: 280 });
    fireEvent.pointerDown(edge, { clientY: 100 });
    fireEvent(window, Object.assign(new Event('pointermove'), { clientY: 160 }));
    expect(screen.getByTestId('chart').style.height).toBe('360px'); // jsdom measures 0, so the start height is 0 -> clamped
    fireEvent(window, new Event('pointerup'));
    expect(p.setAttrs).toHaveBeenCalledTimes(3);
    fireEvent.doubleClick(edge);
    expect(p.setAttrs).toHaveBeenLastCalledWith({ height: null });
  });
});

describe('settings', () => {
  it('clicking an editable chart opens them; every change is written as an attribute', async () => {
    addView();
    const p = props();
    render(<ChartContent {...p} />);
    await screen.findAllByTestId('chart-mark');
    fireEvent.click(screen.getByTestId('chart'));
    expect(await screen.findByTestId('chart-setup')).toBeTruthy();
    expect(screen.queryByTestId('chart-column')).toBeNull(); // count needs no column
    expect(screen.queryByTestId('chart-bucket')).toBeNull(); // status is not a date
    fireEvent.change(screen.getByTestId('chart-type'), { target: { value: 'donut' } });
    expect(p.setAttrs).toHaveBeenLastCalledWith({ type: 'donut' });
    fireEvent.change(screen.getByTestId('chart-fn'), { target: { value: 'avg' } });
    expect(p.setAttrs).toHaveBeenLastCalledWith({ fn: 'avg' });
    fireEvent.change(screen.getByTestId('chart-fn'), { target: { value: 'count' } });
    expect(p.setAttrs).toHaveBeenLastCalledWith({ fn: 'count', column: null });
  });

  it('group by lists only columns that can be grouped, the measure column only number columns', async () => {
    addView();
    render(<ChartContent {...props({ attrs: { fn: 'sum' } })} />);
    fireEvent.click(await screen.findByTestId('chart-settings-btn'));
    await waitFor(() => expect(screen.getByTestId('chart-group').querySelectorAll('option').length).toBeGreaterThan(1));
    expect([...screen.getByTestId('chart-group').querySelectorAll('option')].map((o) => o.textContent)).toEqual(['Choose a column', 'Status', 'Estimate', 'Due date']);
    expect([...screen.getByTestId('chart-column').querySelectorAll('option')].map((o) => o.textContent)).toEqual(['Choose a column', 'Estimate']);
  });

  it('a date column offers the steps (day, week, month)', async () => {
    addView();
    const p = props({ attrs: { groupBy: 'dueDate' } });
    render(<ChartContent {...p} />);
    fireEvent.click(await screen.findByTestId('chart-settings-btn'));
    const bucket = await screen.findByTestId('chart-bucket');
    expect([...bucket.querySelectorAll('option')].map((o) => o.textContent)).toEqual(['Day', 'Week', 'Month']);
    fireEvent.change(bucket, { target: { value: 'month' } });
    expect(p.setAttrs).toHaveBeenLastCalledWith({ bucket: 'month' });
  });

  it('choosing a view lists the page view blocks first, then groups by the status', async () => {
    addView({ id: 'a', name: 'Alpha' });
    addView({ id: 'b', name: 'Beta' });
    const p = props({ attrs: { viewId: null, groupBy: null }, autoOpen: true, pageViewIds: () => ['b'] });
    render(<ChartContent {...p} />);
    fireEvent.click(await screen.findByTestId('chart-pick-view'));
    const list = await screen.findByTestId('view-picker-list');
    expect([...list.querySelectorAll('.cl-viewpicker__name')].map((e) => e.textContent)).toEqual(['Beta', 'Alpha']);
    fireEvent.click(list.querySelector('[data-view-id="b"]')!);
    expect(p.setAttrs).toHaveBeenCalledWith({ viewId: 'b', groupBy: null, column: null });
    await waitFor(() => expect(p.setAttrs).toHaveBeenLastCalledWith({ groupBy: 'status' }));
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
const chartsOf = (editor: TiptapEditor) => {
  const found: Array<Record<string, any>> = [];
  editor.state.doc.descendants((n) => {
    if (n.type.name === 'chart') found.push(n.attrs);
    return true;
  });
  return found;
};

describe('the node in the document', () => {
  it('offers /chart and the three aliases in the slash menu', () => {
    const all = getRegisteredSlashItems();
    expect(filterSlashItems(all, 'chart').map((i) => i.id)).toEqual(expect.arrayContaining(['chart', 'chart-bar', 'chart-line', 'chart-donut']));
    expect(filterSlashItems(all, 'donut chart')[0]!.id).toBe('chart-donut');
    expect(filterSlashItems(all, 'line chart')[0]!.id).toBe('chart-line');
    expect(filterSlashItems(all, 'bar chart')[0]!.id).toBe('chart-bar');
  });

  it('keeps all attributes in the Yjs document and reads them back in a second editor', async () => {
    addView();
    const m = await mount();
    const attrs = { viewId: 'v1', type: 'line', groupBy: 'dueDate', fn: 'sum', column: 'estimate', title: 'Hours per week', height: 360, bucket: 'month' };
    await act(async () => {
      m.editor.commands.insertContent({ type: 'chart', attrs });
    });
    const el = m.doc
      .getXmlFragment(FRAGMENT_NAME)
      .toArray()
      .find((n) => n instanceof Y.XmlElement && n.nodeName === 'chart') as Y.XmlElement;
    expect(el.getAttribute('viewId')).toBe('v1');
    expect(el.getAttribute('type')).toBe('line');
    expect(el.getAttribute('height')).toBe(360);

    const copy = new Y.Doc();
    Y.applyUpdate(copy, Y.encodeStateAsUpdate(m.doc));
    const other = await mount({ doc: copy });
    expect(chartsOf(other.editor)[0]).toMatchObject(attrs);
    await waitFor(() => expect(screen.getAllByTestId('chart').length).toBe(2));
  });

  it('/chart inserts an empty chart, selects it, opens the settings, and the first view fills in the rest', async () => {
    addView();
    const m = await mount();
    await act(async () => {
      getRegisteredSlashItems().find((i) => i.id === 'chart-donut')!.run(m.editor, { from: 1, to: 1 });
    });
    expect(chartsOf(m.editor)).toHaveLength(1);
    expect(chartsOf(m.editor)[0]).toMatchObject({ viewId: null, type: 'donut', groupBy: null, fn: 'count', height: null });
    expect(await screen.findByTestId('chart-setup')).toBeTruthy();
    fireEvent.click(screen.getByTestId('chart-pick-view'));
    fireEvent.click(await screen.findByText('Board'));
    await waitFor(() => expect(chartsOf(m.editor)[0]).toMatchObject({ viewId: 'v1', groupBy: 'status' }));
    await waitFor(() => expect(screen.getByTestId('chart-total').textContent).toBe('5'));
    fireEvent.change(screen.getByTestId('chart-type'), { target: { value: 'bar' } });
    await waitFor(() => expect(chartsOf(m.editor)[0]?.type).toBe('bar'));
    fireEvent.change(screen.getByTestId('chart-fn'), { target: { value: 'sum' } });
    await waitFor(() => expect(chartsOf(m.editor)[0]?.fn).toBe('sum'));
    await waitFor(() => expect(screen.getByTestId('chart-state').getAttribute('data-state')).toBe('problem'));
    fireEvent.change(screen.getByTestId('chart-column'), { target: { value: 'estimate' } });
    await waitFor(() => expect(names()).toEqual(['To do: 10', 'Doing: 10', 'Done: 30']));
  });

  it('a read-only editor shows the chart without controls', async () => {
    addView();
    const m = await mount({ editable: false });
    await act(async () => {
      m.editor.commands.insertContent({ type: 'chart', attrs: { viewId: 'v1', groupBy: 'status' } });
    });
    await waitFor(() => expect(marks()).toHaveLength(3));
    expect(screen.queryByTestId('chart-settings-btn')).toBeNull();
    fireEvent.click(screen.getByTestId('chart'));
    expect(screen.queryByTestId('chart-setup')).toBeNull();
  });
});
