import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import '../editor/testing/helpers'; // jsdom geometry stubs for ProseMirror
import type { PageVersion } from '../../api/history';
import { setPlatform } from '../../platform';
import { createFakePlatform, type FakePlatform } from '../../testing/fakePlatform';
import { HistoryDialog, groupByDay } from './HistoryDialog';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function stateOf(text: string): string {
  const doc = new Y.Doc();
  const p = new Y.XmlElement('paragraph');
  p.insert(0, [new Y.XmlText(text)]);
  doc.getXmlFragment('default').insert(0, [p]);
  const bytes = Y.encodeStateAsUpdate(doc);
  let binary = '';
  bytes.forEach((b) => (binary += String.fromCharCode(b)));
  return btoa(binary);
}

const version = (id: string, createdAt: string, extra: Partial<PageVersion> = {}): PageVersion => ({
  id,
  pageId: 'pg1',
  kind: 'auto',
  name: null,
  createdAt,
  createdBy: null,
  editors: [{ id: 'u2', name: 'Ben' }],
  textLength: 3,
  excerpt: '',
  ...extra,
});

const NOW = '2026-06-02T10:30:00';
const LIST = [
  version('v3', NOW, { kind: 'named', name: 'Final draft' }),
  version('v2', '2026-06-02T08:00:00'),
  version('v1', '2026-06-01T09:00:00', { kind: 'before_restore' }),
];

let fake: FakePlatform;

beforeEach(() => {
  fake = createFakePlatform();
  setPlatform(fake);
  fake.routes['GET /api/pages/pg1/versions'] = () => json(LIST);
  for (const [id, text] of [
    ['v3', 'Final text'],
    ['v2', 'Auto text'],
    ['v1', 'Old text'],
  ] as const) {
    fake.routes[`GET /api/pages/pg1/versions/${id}`] = () => json({ ...LIST.find((v) => v.id === id), state: stateOf(text) });
  }
});

afterEach(() => {
  cleanup();
  setPlatform(null);
});

describe('groupByDay', () => {
  it('keeps the order and starts a group when the day changes', () => {
    const groups = groupByDay(LIST);
    expect(groups.map((g) => g.versions.map((v) => v.id))).toEqual([['v3', 'v2'], ['v1']]);
  });
});

describe('<HistoryDialog>', () => {
  it('lists versions by day with names and editors, and shows a read-only preview of the selected one', async () => {
    render(<HistoryDialog open pageId="pg1" canEdit onClose={() => {}} />);
    const list = await screen.findByRole('navigation', { name: 'Versions' });
    expect(within(list).getByText('Final draft')).toBeTruthy();
    expect(within(list).getByText('Automatic')).toBeTruthy();
    expect(within(list).getByText('Before restore')).toBeTruthy();
    expect(within(list).getAllByText('Ben').length).toBe(3);
    expect(within(list).getAllByRole('heading').length).toBe(2);

    await userEvent.click(within(list).getByText('Final draft'));
    const box = await screen.findByTestId('history-preview', undefined, { timeout: 5000 });
    await waitFor(() => expect(within(box).getByRole('textbox').textContent).toContain('Final text'));
    expect(within(box).getByRole('textbox').getAttribute('contenteditable')).toBe('false');
    // nothing was sent to the server except reading the version
    expect(fake.fetchCalls.every((c) => !c.init?.method || c.init.method === 'GET')).toBe(true);
  });

  it('restores after a confirmation, then closes', async () => {
    fake.routes['POST /api/pages/pg1/versions/v2/restore'] = () => json({ ok: true });
    const onClose = vi.fn();
    const onRestored = vi.fn();
    render(<HistoryDialog open pageId="pg1" canEdit onClose={onClose} onRestored={onRestored} />);
    await userEvent.click(await screen.findByText('Automatic'));
    const button = await screen.findByRole('button', { name: 'Restore this version' });
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
    await userEvent.click(button);
    expect(fake.fetchCalls.some((c) => c.init?.method === 'POST')).toBe(false); // asks first
    await userEvent.click(within(screen.getByRole('alert').parentElement as HTMLElement).getByRole('button', { name: 'Restore' }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(fake.fetchCalls.some((c) => c.path === '/api/pages/pg1/versions/v2/restore' && c.init?.method === 'POST')).toBe(true);
    expect(onRestored).toHaveBeenCalled();
  });

  it('does not restore when the confirmation is cancelled', async () => {
    const onClose = vi.fn();
    render(<HistoryDialog open pageId="pg1" canEdit onClose={onClose} />);
    await userEvent.click(await screen.findByText('Automatic'));
    const button = await screen.findByRole('button', { name: 'Restore this version' });
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
    await userEvent.click(button);
    await userEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
    expect(onClose).not.toHaveBeenCalled();
    expect(fake.fetchCalls.some((c) => c.init?.method === 'POST')).toBe(false);
  });

  it('saves a named version now', async () => {
    fake.routes['POST /api/pages/pg1/versions'] = () => json(version('v4', NOW, { kind: 'named', name: 'Mine' }), 201);
    render(<HistoryDialog open pageId="pg1" canEdit onClose={() => {}} />);
    await screen.findByText('Final draft');
    const save = screen.getByRole('button', { name: 'Save version now' }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    await userEvent.type(screen.getByLabelText('Version name'), 'Mine');
    await userEvent.click(save);
    await waitFor(() => {
      const call = fake.fetchCalls.find((c) => c.init?.method === 'POST');
      expect(call && JSON.parse(String(call.init?.body))).toEqual({ name: 'Mine' });
    });
  });

  it('names an automatic version', async () => {
    fake.routes['PATCH /api/pages/pg1/versions/v2'] = () => json(version('v2', NOW, { name: 'Kept' }));
    render(<HistoryDialog open pageId="pg1" canEdit onClose={() => {}} />);
    await userEvent.click(await screen.findByText('Automatic'));
    await userEvent.click(await screen.findByRole('button', { name: 'Name this version' }));
    await userEvent.type(screen.getByLabelText('New name'), 'Kept{Enter}');
    await waitFor(() => {
      const call = fake.fetchCalls.find((c) => c.init?.method === 'PATCH');
      expect(call && JSON.parse(String(call.init?.body))).toEqual({ name: 'Kept' });
    });
  });

  it('gives readers the list and the preview but no actions', async () => {
    render(<HistoryDialog open pageId="pg1" canEdit={false} onClose={() => {}} />);
    await userEvent.click(await screen.findByText('Final draft'));
    await screen.findByTestId('history-preview', undefined, { timeout: 5000 });
    expect(screen.queryByRole('button', { name: 'Restore this version' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Save version now' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Rename' })).toBeNull();
  });
});
