import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setPlatform } from '../platform';
import { createFakePlatform, type FakePlatform } from '../testing/fakePlatform';
import { filenameFrom, pageExportUrl } from './download';
import { viewExportItem } from './menus';
import { buildPrintTable, installBeforePrint, parseCsv, preparePrint, PRINT_CLASS, PRINT_ROW_CAP } from './print';

let fake: FakePlatform;

beforeEach(() => {
  fake = createFakePlatform();
  setPlatform(fake);
  document.body.innerHTML = '';
  document.documentElement.removeAttribute('data-theme');
  document.documentElement.classList.remove(PRINT_CLASS);
});
afterEach(() => vi.restoreAllMocks());

describe('helpers', () => {
  it('builds the export address', () => {
    expect(pageExportUrl('a/b')).toBe('/api/pages/a%2Fb/export?format=md');
    expect(pageExportUrl('x', { subpages: true })).toBe('/api/pages/x/export?format=md&subpages=1');
  });

  it('reads the file name from Content-Disposition', () => {
    expect(filenameFrom("attachment; filename=\"a.csv\"; filename*=UTF-8''%C3%A4%20b.csv", 'x')).toBe('ä b.csv');
    expect(filenameFrom('attachment; filename="a.csv"', 'x')).toBe('a.csv');
    expect(filenameFrom(null, 'fallback.csv')).toBe('fallback.csv');
  });

  it('parses CSV with quotes, commas, newlines and a BOM', () => {
    expect(parseCsv('﻿A,B\r\n"x, ""y""","l1\nl2"\r\n')).toEqual([
      ['A', 'B'],
      ['x, "y"', 'l1\nl2'],
    ]);
  });

  it('caps the static table at 500 rows and says so', () => {
    const rows = [['Name'], ...Array.from({ length: PRINT_ROW_CAP + 20 }, (_, i) => [`r${i}`])];
    const table = buildPrintTable(rows);
    expect(table.querySelectorAll('tbody tr')).toHaveLength(PRINT_ROW_CAP);
    expect(table.textContent).toContain('Showing the first 500 of 520 rows.');
  });
});

describe('view menu item', () => {
  it('posts the view state as it is on screen and downloads the answer', async () => {
    fake.routes['POST /api/tables/tasks%3Ap1/export'] = () =>
      new Response('Name\r\n', { headers: { 'Content-Disposition': 'attachment; filename="V.csv"' } });
    URL.createObjectURL = vi.fn(() => 'blob:x');
    URL.revokeObjectURL = vi.fn();
    const clicked: string[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      clicked.push(`${this.getAttribute('href')}|${this.download}`);
    });
    const item = viewExportItem({ tableRef: 'tasks:p1', name: 'V', config: { query: { search: 'x' }, columns: [{ key: 'name' }] } });
    expect('id' in item && item.label).toBe('Export CSV');
    if ('onSelect' in item) item.onSelect();
    await vi.waitFor(() => expect(clicked).toEqual(['blob:x|V.csv']));
    const call = fake.fetchCalls.find((c) => c.init?.method === 'POST')!;
    expect(JSON.parse(call.init!.body as string)).toEqual({ query: { search: 'x' }, columns: [{ key: 'name' }], name: 'V' });
  });

  it('toasts the server message when the export is refused', async () => {
    fake.routes['POST /api/tables/tasks%3Ap1/export'] = () => new Response(JSON.stringify({ detail: 'Nope' }), { status: 403 });
    const item = viewExportItem({ tableRef: 'tasks:p1', name: 'V', config: { query: {} } });
    if ('onSelect' in item) item.onSelect();
    await vi.waitFor(() => expect(fake.toasts).toEqual([{ kind: 'error', message: 'Nope' }]));
  });
});

describe('print mode', () => {
  function pageDom() {
    document.body.innerHTML = `<article class="cl-page"><h1 class="cl-page__title">My page</h1>
      <div class="cl-viewshell" data-view-id="v1"><div>live grid</div></div></article>`;
  }

  it('switches to a light theme with static tables, and restores everything', async () => {
    pageDom();
    document.documentElement.setAttribute('data-theme', 'dark');
    document.title = 'Cutline';
    fake.routes['/api/views/v1/export?format=csv'] = () => new Response('﻿Name\r\nA\r\nB\r\n');
    const restore = await preparePrint();
    const html = document.documentElement;
    expect(html.classList.contains(PRINT_CLASS)).toBe(true);
    expect(html.getAttribute('data-theme')).toBe('light');
    expect(document.title).toBe('My page');
    expect(document.querySelectorAll('.cl-print-table tbody tr')).toHaveLength(2);
    restore();
    expect(html.classList.contains(PRINT_CLASS)).toBe(false);
    expect(html.getAttribute('data-theme')).toBe('dark');
    expect(document.title).toBe('Cutline');
    expect(document.querySelector('.cl-print-table')).toBeNull();
  });

  it('does nothing when no page is on screen', async () => {
    const restore = await preparePrint();
    expect(document.documentElement.classList.contains(PRINT_CLASS)).toBe(false);
    restore();
  });

  it('keeps the live view when its rows cannot be fetched', async () => {
    pageDom();
    fake.routes['/api/views/v1/export?format=csv'] = () => new Response('{}', { status: 403 });
    const restore = await preparePrint();
    expect(document.querySelector('.cl-print-table')).toBeNull();
    restore();
  });

  it('beforeprint and afterprint toggle the class (Ctrl+P)', () => {
    pageDom();
    const off = installBeforePrint();
    window.dispatchEvent(new Event('beforeprint'));
    expect(document.documentElement.classList.contains(PRINT_CLASS)).toBe(true);
    window.dispatchEvent(new Event('afterprint'));
    expect(document.documentElement.classList.contains(PRINT_CLASS)).toBe(false);
    off();
  });
});

describe('palette commands', () => {
  it('are offered on a page only', async () => {
    const { registerBuiltinCommands } = await import('../search/builtins');
    const { listCommands } = await import('../search/commands');
    registerBuiltinCommands();
    const ctx = (route: object) => ({ route, projectId: null, user: { id: 'u', username: 'u', role: 'editor' as const }, projects: [] }) as never;
    const ids = (route: object) => listCommands(ctx(route)).map((c) => c.id);
    expect(ids({ kind: 'mePage', pageId: 'p' })).toEqual(expect.arrayContaining(['export-page-md', 'print-page']));
    expect(ids({ kind: 'home' })).not.toContain('print-page');
    expect(ids({ kind: 'home' })).not.toContain('export-page-md');
  });
});
