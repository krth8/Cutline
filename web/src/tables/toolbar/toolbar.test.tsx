import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setPlatform } from '../../platform';
import { createFakePlatform, type FakePlatform } from '../../testing/fakePlatform';
import { createRestViewSource } from '../restViewSource';
import { resetStores, setViewSource } from '../store';
import { Backend, resultOf, rowOf, schemaOf } from '../store/store.testutil';
import { clearLayouts, registerLayout } from '../layouts/registry';
import { FallbackLayout } from '../layouts/fallback/FallbackLayout';
import type { Filter, View } from '../types';
import { ViewShell } from '../ViewShell';
import { appendAt, completeOnly, countConditions, makeLeaf, opsFor, setAt, simplify, toRootGroup } from './queryModel';

describe('queryModel', () => {
  const name = schemaOf('tasks:p1').columns[0]!;

  it('wraps a lone condition and unwraps empty groups', () => {
    const leaf = makeLeaf(name);
    expect(toRootGroup(undefined)).toEqual({ and: [] });
    expect(toRootGroup(leaf)).toEqual({ and: [leaf] });
    expect(simplify({ and: [{ or: [] }] })).toBeUndefined();
    expect(simplify({ and: [{ or: [leaf] }, { and: [] }] })).toEqual({ and: [{ or: [leaf] }] });
  });

  it('edits nested groups by path', () => {
    let root = toRootGroup(undefined);
    root = appendAt(root, [], makeLeaf(name));
    root = appendAt(root, [], { or: [makeLeaf(name)] });
    root = appendAt(root, [1], makeLeaf(name));
    expect(countConditions(root)).toBe(3);
    root = setAt(root, [1, 0], null);
    expect(countConditions(root)).toBe(2);
    root = setAt(root, [0], { column: 'name', op: 'eq', value: 'x' });
    expect(root).toMatchObject({ and: [{ value: 'x' }, { or: [expect.anything()] }] });
  });

  it('keeps half-filled conditions out of the query', () => {
    const half: Filter = { and: [makeLeaf(name), { column: 'name', op: 'empty' }, { or: [makeLeaf(name)] }] };
    expect(completeOnly(half)).toEqual({ and: [{ column: 'name', op: 'empty' }] });
  });

  it('offers operators by column type', () => {
    expect(opsFor('date')).toContain('relative');
    expect(opsFor('checkbox')).toEqual(['eq']);
    expect(opsFor('relation')).toEqual(['empty', 'notEmpty']);
  });
});

let fake: FakePlatform;
let backend: Backend;
let stored: View;

beforeEach(() => {
  fake = createFakePlatform();
  setPlatform(fake);
  backend = new Backend(fake);
  stored = { id: 'v1', tableRef: 'tasks:p1', name: 'Open tasks', layout: 'table', config: { query: {} } };
  backend.on('GET /api/views/v1', () => ({ body: stored }));
  backend.on('PATCH /api/views/v1', (call) => {
    const { config, ...rest } = call.body;
    stored = { ...stored, ...rest, config: { ...stored.config, ...(config ?? {}) } };
    return { body: stored };
  });
  backend.on('GET /api/tables/tasks:p1/schema', () => ({ body: schemaOf('tasks:p1') }));
  backend.on('POST /api/tables/tasks:p1/query', () => ({
    body: resultOf([rowOf('t1', 'Alpha'), rowOf('t2', 'Beta')]),
  }));
  setViewSource(createRestViewSource());
  clearLayouts();
  registerLayout('table', FallbackLayout);
  registerLayout('board', FallbackLayout, { board: { groupBy: 'status', cardColumns: [] } });
});

afterEach(() => {
  vi.useRealTimers();
  resetStores();
  setViewSource(null);
  clearLayouts();
  setPlatform(null);
});

describe('REST view source', () => {
  it('refetches the view on a view_changed event and notifies subscribers', async () => {
    const source = createRestViewSource();
    const seen: string[] = [];
    const off = source.subscribe('v1', (d) => seen.push(d.name ?? ''));
    stored = { ...stored, name: 'Renamed elsewhere' };
    act(() => fake.emit('view_changed', { viewId: 'v1' }));
    await waitFor(() => expect(seen).toEqual(['Renamed elsewhere']));
    act(() => fake.emit('view_changed', { viewId: 'other' }));
    off();
    act(() => fake.emit('view_changed', { viewId: 'v1' }));
    await new Promise((r) => setTimeout(r, 10));
    expect(seen).toHaveLength(1);
    expect(backend.count('GET /api/views/v1')).toBe(1);
  });

  it('sends a patch and notifies about our own update', async () => {
    const source = createRestViewSource();
    const seen: string[] = [];
    source.subscribe('v1', (d) => seen.push(d.layout));
    const d = await source.update('v1', { layout: 'board' });
    expect(d.layout).toBe('board');
    expect(seen).toEqual(['board']);
    expect(backend.calls.find((c) => c.method === 'PATCH')?.body).toEqual({ layout: 'board' });
  });
});

describe('ViewShell', () => {
  it('shows the name, the toolbar and the layout with the rows', async () => {
    render(<ViewShell viewId="v1" />);
    expect(await screen.findByDisplayValue('Open tasks')).toBeTruthy();
    expect(await screen.findByText('Alpha')).toBeTruthy();
    expect(screen.getByTestId('view-toolbar')).toBeTruthy();
  });

  it('opens the Trash dialog from the More menu of a tasks table', async () => {
    backend.on('GET /api/tables/tasks:p1/trash', () => ({ body: { items: [] } }));
    render(<ViewShell viewId="v1" />);
    await screen.findByText('Alpha');
    fireEvent.click(screen.getByTestId('toolbar-more'));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Trash' }));
    expect(await screen.findByRole('dialog', { name: 'Trash' })).toBeTruthy();
    expect(await screen.findByText('The trash is empty.')).toBeTruthy();
  });

  it('has no Trash entry for a viewer', async () => {
    fake.data.user = { id: 'u9', username: 'Vi', role: 'viewer' };
    render(<ViewShell viewId="v1" />);
    await screen.findByText('Alpha');
    expect(screen.queryByTestId('toolbar-more')).toBeNull();
  });

  it('saves sort and group in the view config', async () => {
    render(<ViewShell viewId="v1" />);
    await screen.findByText('Alpha');
    fireEvent.click(screen.getByTestId('toolbar-sort'));
    fireEvent.click(await screen.findByText('+ Add sort'));
    fireEvent.change(screen.getByLabelText('Sort direction'), { target: { value: 'desc' } });
    fireEvent.click(screen.getByTestId('toolbar-group'));
    fireEvent.change(await screen.findByLabelText('Group by'), { target: { value: 'status' } });
    await waitFor(() => expect(stored.config.query).toEqual({ sort: [{ column: 'name', dir: 'desc' }], groupBy: 'status' }), { timeout: 3000 });
  });

  it('builds a nested filter and only saves complete conditions', async () => {
    render(<ViewShell viewId="v1" />);
    await screen.findByText('Alpha');
    fireEvent.click(screen.getByTestId('toolbar-filter'));
    fireEvent.click(await screen.findByText('+ Add filter'));
    expect(screen.getAllByTestId('filter-row')).toHaveLength(1);
    fireEvent.change(screen.getByLabelText('Value'), { target: { value: 'Al' } });
    fireEvent.click(screen.getByText('+ Add group'));
    expect(screen.getAllByTestId('filter-group')).toHaveLength(2);
    fireEvent.change(screen.getAllByLabelText('Operator')[0]!, { target: { value: 'eq' } });
    await waitFor(
      () => expect(stored.config.query.filter).toEqual({ and: [{ column: 'name', op: 'eq', value: 'Al' }] }),
      { timeout: 3000 },
    );
  });

  it('hides and moves columns', async () => {
    render(<ViewShell viewId="v1" />);
    await screen.findByText('Alpha');
    fireEvent.click(screen.getByTestId('toolbar-columns'));
    const rows = await screen.findAllByTestId('column-row');
    fireEvent.click(rows[1]!.querySelector('input')!); // hide status
    fireEvent.click(screen.getByLabelText('Move Priority up'));
    await waitFor(
      () => expect(stored.config.columns).toEqual([{ key: 'name' }, { key: 'priority' }, { key: 'status', hidden: true }]),
      { timeout: 3000 },
    );
    expect(screen.queryByRole('columnheader', { name: 'Status' })).toBeNull();
  });

  it('switches layout and adds the defaults of the new layout', async () => {
    render(<ViewShell viewId="v1" />);
    await screen.findByText('Alpha');
    fireEvent.click(screen.getByTestId('layout-board'));
    await waitFor(() => expect(stored.layout).toBe('board'));
    expect(stored.config.board).toEqual({ groupBy: 'status', cardColumns: [] });
  });

  it('renames the view and creates a row', async () => {
    backend.on('POST /api/tables/tasks:p1/rows', () => ({ body: rowOf('t3', 'Untitled') }));
    render(<ViewShell viewId="v1" />);
    const input = await screen.findByLabelText('View name');
    fireEvent.change(input, { target: { value: 'Everything' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(stored.name).toBe('Everything'));
    fireEvent.click(screen.getByTestId('new-row'));
    await waitFor(() => expect(backend.count('POST /api/tables/tasks:p1/rows')).toBe(1));
    expect(backend.calls.find((c) => c.path.endsWith('/rows'))?.body.values).toEqual({ name: 'Untitled' });
  });

  it('says so when the layout is not registered', async () => {
    stored = { ...stored, layout: 'gantt' };
    render(<ViewShell viewId="v1" />);
    expect(await screen.findByText('The gantt layout is not available yet.')).toBeTruthy();
  });

  it('shows the error when the view cannot be loaded', async () => {
    backend.on('GET /api/views/v1', () => ({ status: 403, body: { detail: 'Access denied' } }));
    render(<ViewShell viewId="v1" />);
    expect((await screen.findByRole('alert')).textContent).toContain('Access denied');
  });
});
