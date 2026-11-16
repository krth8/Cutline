import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PageInfo, PageNode } from '../../api/pageTree';
import type { TemplateInfo } from '../../api/templates';
import { setPlatform } from '../../platform';
import { createFakePlatform, type FakePlatform } from '../../testing/fakePlatform';
import { PageView } from '../PageView';
import { resetPageStores } from '../tree/pageStore';
import { PageTree } from '../tree/PageTree';
import { SaveTemplateDialog } from './SaveTemplateDialog';
import { TemplateDialog } from './TemplateDialog';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const tpl = (id: string, name: string, scope: TemplateInfo['scope'], canDelete = false, description = ''): TemplateInfo => ({
  id,
  name,
  description,
  scope,
  pageCount: 1,
  canDelete,
});

const node: PageNode = { id: 'P1', parentId: null, title: 'Plan', icon: null, sortOrder: 0, kind: 'page' };
const info = (extra: Partial<PageInfo> = {}): PageInfo => ({
  ...node,
  space: 'me',
  canEdit: true,
  needsImport: false,
  archived: false,
  ...extra,
});

let fake: FakePlatform;

beforeEach(() => {
  localStorage.clear();
  fake = createFakePlatform();
  setPlatform(fake);
  fake.routes['GET /api/templates'] = () =>
    json({
      templates: [
        tpl('builtin:blank', 'Blank page', 'builtin', false, 'An empty page.'),
        tpl('builtin:meeting-notes', 'Meeting notes', 'builtin', false, 'Agenda and action items.'),
        tpl('t1', 'My checklist', 'personal', true),
        tpl('t2', 'Company intro', 'workspace', false),
      ],
    });
  fake.routes['GET /api/spaces/me/pages'] = () => json([node]);
  fake.routes['GET /api/spaces/me/pages?archived=1'] = () => json([]);
  fake.routes['GET /api/pages/P1'] = () => json(info());
});

afterEach(() => {
  cleanup();
  setPlatform(null);
  resetPageStores();
});

describe('TemplateDialog', () => {
  it('shows the templates as cards with badges and filters them by search', async () => {
    const user = userEvent.setup();
    render(<TemplateDialog open onClose={() => undefined} space="me" />);
    const cards = await screen.findByRole('list', { name: 'Templates' });
    expect(within(cards).getAllByRole('listitem')).toHaveLength(4);
    expect(within(cards).getByText('Workspace')).toBeTruthy();
    expect(within(cards).getByText('Personal')).toBeTruthy();
    expect(within(cards).getAllByText('Built-in')).toHaveLength(2);
    await user.type(screen.getByRole('searchbox', { name: 'Search templates' }), 'meeting');
    expect(within(cards).getAllByRole('listitem')).toHaveLength(1);
    expect(within(cards).getByText('Meeting notes')).toBeTruthy();
  });

  it('creates the pages in the current space and opens the first one', async () => {
    const user = userEvent.setup();
    fake.routes['POST /api/templates/builtin:meeting-notes/use'] = () => json({ ...info({ id: 'N1' }), pageIds: ['N1'] });
    let closed = false;
    render(<TemplateDialog open onClose={() => (closed = true)} space="p:p1" parentId="X" />);
    await user.click(await screen.findByRole('button', { name: 'Use Meeting notes' }));
    await waitFor(() => expect(fake.navigations).toEqual(['/p/p1/page/N1']));
    const post = fake.fetchCalls.find((c) => c.init?.method === 'POST')!;
    expect(post.path).toBe('/api/templates/builtin:meeting-notes/use');
    expect(JSON.parse(post.init!.body as string)).toEqual({ space: 'p:p1', parentId: 'X' });
    expect(closed).toBe(true);
  });

  it('has delete buttons only on templates the user may delete, and asks first', async () => {
    const user = userEvent.setup();
    fake.routes['DELETE /api/templates/t1'] = () => json({ success: true });
    render(<TemplateDialog open onClose={() => undefined} space="me" manage />);
    await screen.findByRole('list', { name: 'Templates' });
    expect(screen.getAllByRole('button', { name: /^Delete / })).toHaveLength(1);
    await user.click(screen.getByRole('button', { name: 'Delete My checklist' }));
    await waitFor(() => expect(screen.queryByText('My checklist')).toBeNull());
    expect(fake.confirmations).toHaveLength(1);
    expect(fake.fetchCalls.some((c) => c.init?.method === 'DELETE')).toBe(true);
  });

  it('does not create anything when managing', async () => {
    const user = userEvent.setup();
    render(<TemplateDialog open onClose={() => undefined} space="me" manage />);
    const card = await screen.findByRole('button', { name: 'Blank page' });
    await user.click(card);
    expect(fake.fetchCalls.some((c) => c.init?.method === 'POST')).toBe(false);
  });
});

describe('SaveTemplateDialog', () => {
  it('saves a personal template with name and description', async () => {
    fake.data.user = { id: 'u2', username: 'Ed', role: 'editor' };
    const user = userEvent.setup();
    fake.routes['POST /api/templates'] = () => json(tpl('n1', 'Plan', 'personal', true));
    render(<SaveTemplateDialog open pageId="P1" title="Plan" onClose={() => undefined} />);
    expect(screen.queryByLabelText(/Everyone/)).toBeNull(); // only admins may share with everyone
    await user.type(screen.getByLabelText('Template description'), 'For sprints');
    await user.click(screen.getByRole('button', { name: 'Save template' }));
    await waitFor(() => expect(fake.toasts.some((t) => t.message === 'Template saved')).toBe(true));
    const post = fake.fetchCalls.find((c) => c.init?.method === 'POST')!;
    expect(JSON.parse(post.init!.body as string)).toEqual({ pageId: 'P1', name: 'Plan', description: 'For sprints', scope: 'personal' });
  });

  it('lets an admin choose the workspace scope', async () => {
    const user = userEvent.setup();
    fake.routes['POST /api/templates'] = () => json(tpl('n1', 'Plan', 'workspace', true));
    render(<SaveTemplateDialog open pageId="P1" title="Plan" onClose={() => undefined} />);
    await user.click(screen.getByLabelText(/Everyone/));
    await user.click(screen.getByRole('button', { name: 'Save template' }));
    await waitFor(() => expect(fake.fetchCalls.some((c) => c.init?.method === 'POST')).toBe(true));
    const post = fake.fetchCalls.find((c) => c.init?.method === 'POST')!;
    expect(JSON.parse(post.init!.body as string).scope).toBe('workspace');
  });
});

describe('menu items', () => {
  it('the page menu duplicates and opens the copy, and offers Save as template', async () => {
    const user = userEvent.setup();
    fake.routes['POST /api/pages/P1/duplicate'] = () => json({ ...info({ id: 'P2', title: 'Plan (copy)' }), pageIds: ['P2'] });
    render(<PageView route={{ kind: 'mePage', pageId: 'P1' }} />);
    await user.click(await screen.findByRole('button', { name: 'Page menu' }));
    expect(screen.getByRole('menuitem', { name: 'Save as template...' })).toBeTruthy();
    await user.click(screen.getByRole('menuitem', { name: 'Duplicate' }));
    await waitFor(() => expect(fake.navigations).toEqual(['/me/page/P2']));
  });

  it('the tree row menu duplicates a page and the tree offers New from template', async () => {
    const user = userEvent.setup();
    fake.routes['POST /api/pages/P1/duplicate'] = () => json({ ...info({ id: 'P2', title: 'Plan (copy)' }), pageIds: ['P2'] });
    const events: string[] = [];
    window.addEventListener('cutline:open-templates', (e) => events.push(JSON.stringify((e as CustomEvent).detail)), { once: true });
    render(<PageTree space={{ kind: 'personal' }} route={{ kind: 'me' }} />);
    await screen.findByRole('tree');
    await user.click(screen.getByRole('button', { name: 'More page options' }));
    await user.click(screen.getByRole('menuitem', { name: 'New from template...' }));
    expect(events).toEqual(['{"space":"me"}']);
    await user.click(screen.getByRole('button', { name: 'Actions for Plan' }));
    await user.click(screen.getByRole('menuitem', { name: 'Duplicate' }));
    await waitFor(() => expect(fake.navigations).toEqual(['/me/page/P2']));
  });
});
