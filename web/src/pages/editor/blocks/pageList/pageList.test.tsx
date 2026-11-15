import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Editor as TiptapEditor } from '@tiptap/core';
import { Awareness } from 'y-protocols/awareness';
import * as Y from 'yjs';
import { setPlatform } from '../../../../platform';
import { createFakePlatform, type FakePlatform } from '../../../../testing/fakePlatform';
import { Editor } from '../../Editor';
import { getRegisteredSlashItems } from '../../registry';
import { PageListContent } from './PageListContent';
import { DEFAULT_LIMIT, cleanLimit, cleanScope, recentPath } from './model';
import './index'; // registers the block

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const recent = (id: string, title: string, space = 'me', projectName: string | null = null) => ({
  id,
  title,
  icon: null,
  space,
  updatedAt: new Date().toISOString(),
  projectName,
});

let fake: FakePlatform;
let served: unknown[];

beforeEach(() => {
  fake = createFakePlatform();
  setPlatform(fake);
  served = [recent('a', 'Alpha'), recent('b', 'Beta', 'p:p1', 'Project One')];
  fake.routes['/api/pages/recent?scope=all&limit=8'] = () => json({ pages: served });
  fake.routes['/api/pages/recent?scope=me&limit=8'] = () => json({ pages: [recent('a', 'Alpha')] });
});
afterEach(() => {
  cleanup();
  setPlatform(null);
});

describe('model', () => {
  it('cleans the attributes', () => {
    expect(cleanScope('me')).toBe('me');
    expect(cleanScope('p:abc')).toBe('p:abc');
    expect(cleanScope('p:')).toBe('all');
    expect(cleanScope(undefined)).toBe('all');
    expect(cleanLimit('15')).toBe(15);
    expect(cleanLimit(0)).toBe(DEFAULT_LIMIT);
    expect(cleanLimit(500)).toBe(50);
    expect(recentPath({ scope: 'p:a b', limit: 5 })).toBe('/api/pages/recent?scope=p%3Aa%20b&limit=5');
  });
});

describe('PageListContent', () => {
  it('lists the pages as links to the right routes', async () => {
    render(<PageListContent attrs={{ scope: 'all', limit: 8 }} editable={false} setAttrs={() => {}} />);
    const alpha = await screen.findByRole('link', { name: /Alpha/ });
    expect(alpha.getAttribute('href')).toBe('/me/page/a');
    expect(screen.getByRole('link', { name: /Beta/ }).getAttribute('href')).toBe('/p/p1/page/b');
    expect(screen.getByText(/Project One/)).toBeTruthy();
    expect(screen.queryByLabelText('Which pages')).toBeNull(); // read-only: no settings
  });

  it('navigates without a reload on a plain click', async () => {
    render(<PageListContent attrs={{ scope: 'all', limit: 8 }} editable={false} setAttrs={() => {}} />);
    fireEvent.click(await screen.findByRole('link', { name: /Alpha/ }));
    expect(fake.navigations).toEqual(['/me/page/a']);
  });

  it('refreshes on a live page_changed and after a resync', async () => {
    render(<PageListContent attrs={{ scope: 'all', limit: 8 }} editable={false} setAttrs={() => {}} />);
    await screen.findByRole('link', { name: /Alpha/ });
    served = [recent('c', 'Gamma')];
    act(() => fake.emit('page_changed', { pageId: 'c', change: 'renamed' }));
    expect(await screen.findByRole('link', { name: /Gamma/ })).toBeTruthy();
    served = [recent('d', 'Delta')];
    act(() => fake.emit('resync'));
    expect(await screen.findByRole('link', { name: /Delta/ })).toBeTruthy();
  });

  it('shows an empty state and a failure state', async () => {
    served = [];
    const first = render(<PageListContent attrs={{ scope: 'all', limit: 8 }} editable={false} setAttrs={() => {}} />);
    expect(await screen.findByText('No pages yet')).toBeTruthy();
    first.unmount();
    fake.routes['/api/pages/recent?scope=all&limit=8'] = () => json({ detail: 'no' }, 500);
    render(<PageListContent attrs={{ scope: 'all', limit: 8 }} editable={false} setAttrs={() => {}} />);
    expect(await screen.findByText('Not available')).toBeTruthy();
  });

  it('an editor can change the scope and the count', async () => {
    const changes: unknown[] = [];
    render(<PageListContent attrs={{ scope: 'all', limit: 8 }} editable setAttrs={(p) => changes.push(p)} />);
    fireEvent.change(await screen.findByLabelText('Which pages'), { target: { value: 'me' } });
    fireEvent.change(screen.getByLabelText('How many'), { target: { value: '15' } });
    expect(changes).toEqual([{ scope: 'me' }, { limit: 15 }]);
  });
});

describe('the block in the editor', () => {
  async function mount(): Promise<TiptapEditor> {
    const doc = new Y.Doc();
    let editor: TiptapEditor | null = null;
    await act(async () => {
      render(
        <Editor
          doc={doc}
          awareness={new Awareness(doc)}
          user={{ id: 'u1', name: 'Ada', color: '#e8590c' }}
          editable
          pageId="page1"
          onReady={(e) => {
            editor = e;
          }}
        />,
      );
    });
    return editor as unknown as TiptapEditor;
  }

  it('offers /pages, stores scope and limit, renders the list and survives an HTML round trip', async () => {
    expect(getRegisteredSlashItems().find((i) => i.id === 'page-list')?.title).toBe('Pages');
    const editor = await mount();
    await act(async () => {
      editor.commands.insertContent({ type: 'pageList', attrs: { scope: 'me', limit: 5 } });
    });
    const stored = (editor.getJSON().content ?? []).find((n) => n.type === 'pageList');
    expect(stored?.attrs).toEqual({ scope: 'me', limit: 5 });
    const html = editor.getHTML();
    expect(html).toContain('data-page-list');
    expect(html).toContain('data-scope="me"');
    expect(html).toContain('data-limit="5"');
    await act(async () => {
      editor.commands.setContent(html);
    });
    const again = (editor.getJSON().content ?? []).find((n) => n.type === 'pageList');
    expect(again?.attrs).toEqual({ scope: 'me', limit: 5 });
  });

  it('a stored block with no attributes shows all pages, 8 of them', async () => {
    fake.routes['/api/pages/recent?scope=all&limit=8'] = () => json({ pages: [recent('a', 'Alpha')] });
    const editor = await mount();
    await act(async () => {
      editor.commands.insertContent({ type: 'pageList' });
    });
    await waitFor(() => expect(screen.getByRole('link', { name: /Alpha/ })).toBeTruthy());
  });
});
