import { cleanup, createEvent, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PageInfo, PageNode } from '../../api/pageTree';
import { setPlatform } from '../../platform';
import type { Route } from '../../router';
import type { Space } from '../../shell/registry';
import { createFakePlatform, type FakePlatform } from '../../testing/fakePlatform';
import { resetPageStores } from './pageStore';
import { PageTree } from './PageTree';

const node = (id: string, parentId: string | null, sortOrder: number, title = id): PageNode => ({
  id,
  parentId,
  title,
  icon: null,
  sortOrder,
  kind: 'page',
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const info = (n: PageNode): PageInfo => ({
  ...n,
  space: 'me',
  canEdit: true,
  needsImport: false,
  archived: false,
});

let fake: FakePlatform;
let list: PageNode[];

const personal: Space = { kind: 'personal' };

function patches(id: string): unknown[] {
  return fake.fetchCalls
    .filter((c) => c.init?.method === 'PATCH' && c.path === `/api/pages/${id}`)
    .map((c) => JSON.parse(c.init!.body as string));
}

// A { A1 { A1a }, A2 }   B   C
beforeEach(() => {
  localStorage.clear();
  fake = createFakePlatform();
  setPlatform(fake);
  list = [
    node('A', null, 0),
    node('B', null, 1),
    node('C', null, 2),
    node('A1', 'A', 0),
    node('A2', 'A', 1),
    node('A1a', 'A1', 0),
  ];
  fake.routes['GET /api/spaces/me/pages'] = () => json(list);
  fake.routes['GET /api/spaces/me/pages?archived=1'] = () => json([]);
  // PATCH answers like the server: the page with the change applied
  for (const n of ['A', 'B', 'C', 'A1', 'A2', 'A1a']) {
    fake.routes[`PATCH /api/pages/${n}`] = (_path: string, init?: RequestInit) => {
      const body = JSON.parse(init!.body as string) as Partial<PageNode>;
      return json(info({ ...list.find((p) => p.id === n)!, ...body }));
    };
  }
});

afterEach(() => {
  cleanup(); // unmount while the fake platform is still installed
  setPlatform(null);
  resetPageStores();
});

async function renderTree(route: Route = { kind: 'me' }, space: Space = personal) {
  const view = render(<PageTree space={space} route={route} />);
  await screen.findByRole('tree');
  return view;
}

const row = (name: string) => screen.getByRole('treeitem', { name });

describe('tree', () => {
  it('shows the top level collapsed and expands on the chevron', async () => {
    const user = userEvent.setup();
    await renderTree();
    expect(screen.getAllByRole('treeitem').map((r) => r.getAttribute('aria-label'))).toEqual(['A', 'B', 'C']);
    expect(row('A').getAttribute('aria-expanded')).toBe('false');
    expect(row('B').getAttribute('aria-expanded')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Expand A' }));
    expect(screen.getAllByRole('treeitem').map((r) => r.getAttribute('aria-label'))).toEqual(['A', 'A1', 'A2', 'B', 'C']);
    expect(row('A1').getAttribute('aria-level')).toBe('2');
  });

  it('remembers the expanded pages per space', async () => {
    const user = userEvent.setup();
    const view = await renderTree();
    await user.click(screen.getByRole('button', { name: 'Expand A' }));
    view.unmount();
    await renderTree();
    expect(row('A').getAttribute('aria-expanded')).toBe('true');
    expect(localStorage.getItem('cl-pages-expanded:me')).toBe('["A"]');
  });

  it('highlights the open page and expands its ancestors', async () => {
    await renderTree({ kind: 'mePage', pageId: 'A1a' });
    await waitFor(() => expect(screen.getByRole('treeitem', { name: 'A1a' })).toBeTruthy());
    expect(row('A1a').getAttribute('aria-selected')).toBe('true');
    expect(row('A').getAttribute('aria-selected')).toBe('false');
  });

  it('opens a page on click', async () => {
    const user = userEvent.setup();
    await renderTree();
    await user.click(row('B'));
    expect(fake.navigations).toEqual(['/me/page/B']);
  });

  it('shows an empty state with a create button', async () => {
    list = [];
    const user = userEvent.setup();
    render(<PageTree space={personal} route={{ kind: 'me' }} />);
    expect(await screen.findByText('No pages yet.')).toBeTruthy();
    fake.routes['POST /api/spaces/me/pages'] = () => json(info(node('N', null, 0, 'Untitled')));
    await user.click(screen.getByRole('button', { name: 'New page' }));
    await waitFor(() => expect(fake.navigations).toEqual(['/me/page/N']));
  });
});

describe('creating', () => {
  it('New page creates at the top level, opens it', async () => {
    const user = userEvent.setup();
    await renderTree();
    fake.routes['POST /api/spaces/me/pages'] = () => json(info(node('N', null, 3, 'Untitled')));
    await user.click(screen.getByRole('button', { name: /New page/ }));
    await waitFor(() => expect(fake.navigations).toEqual(['/me/page/N']));
    const post = fake.fetchCalls.find((c) => c.init?.method === 'POST')!;
    expect(JSON.parse(post.init!.body as string)).toEqual({});
    expect(row('Untitled')).toBeTruthy();
  });

  it('the plus button adds a subpage, expands the parent and opens the new page', async () => {
    const user = userEvent.setup();
    await renderTree();
    fake.routes['POST /api/spaces/me/pages'] = () => json(info(node('N', 'B', 0, 'Untitled')));
    await user.click(screen.getByRole('button', { name: 'Add subpage to B' }));
    await waitFor(() => expect(fake.navigations).toEqual(['/me/page/N']));
    const post = fake.fetchCalls.find((c) => c.init?.method === 'POST')!;
    expect(JSON.parse(post.init!.body as string)).toEqual({ parentId: 'B' });
    expect(row('B').getAttribute('aria-expanded')).toBe('true');
  });
});

describe('renaming', () => {
  it('F2 starts, Enter commits', async () => {
    const user = userEvent.setup();
    await renderTree();
    row('B').focus();
    await user.keyboard('{F2}');
    const input = screen.getByRole('textbox', { name: 'Page title' });
    expect(document.activeElement).toBe(input);
    await user.keyboard('Beta{Enter}');
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(patches('B')).toEqual([{ title: 'Beta' }]);
    expect(row('Beta')).toBeTruthy();
  });

  it('Escape cancels without a request', async () => {
    const user = userEvent.setup();
    await renderTree();
    row('B').focus();
    await user.keyboard('{F2}Something{Escape}');
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(patches('B')).toEqual([]);
    expect(row('B')).toBeTruthy();
  });

  it('double click starts renaming; an unchanged or empty title sends nothing', async () => {
    const user = userEvent.setup();
    await renderTree();
    await user.dblClick(row('C'));
    await user.keyboard('{Enter}');
    await user.dblClick(row('C'));
    await user.clear(screen.getByRole('textbox', { name: 'Page title' }));
    await user.keyboard('{Enter}');
    expect(patches('C')).toEqual([]);
  });

  it('blur commits', async () => {
    const user = userEvent.setup();
    await renderTree();
    await user.dblClick(row('C'));
    await user.keyboard('Gamma');
    await user.tab();
    expect(patches('C')).toEqual([{ title: 'Gamma' }]);
  });

  it('a refused rename goes back and shows a toast', async () => {
    const user = userEvent.setup();
    await renderTree();
    fake.routes['PATCH /api/pages/B'] = () => json({ detail: 'Access denied' }, 403);
    row('B').focus();
    await user.keyboard('{F2}X{Enter}');
    await waitFor(() => expect(fake.toasts).toHaveLength(1));
    expect(row('B')).toBeTruthy();
  });
});

describe('keyboard', () => {
  it('arrows move, right expands, left collapses and goes to the parent, Enter opens', async () => {
    const user = userEvent.setup();
    await renderTree();
    row('A').focus();
    await user.keyboard('{ArrowDown}');
    expect(document.activeElement).toBe(row('B'));
    await user.keyboard('{ArrowUp}{ArrowRight}');
    expect(row('A').getAttribute('aria-expanded')).toBe('true');
    await user.keyboard('{ArrowRight}');
    expect(document.activeElement).toBe(row('A1'));
    await user.keyboard('{ArrowDown}{ArrowDown}');
    expect(document.activeElement).toBe(row('B'));
    await user.keyboard('{ArrowUp}{ArrowUp}{ArrowLeft}');
    expect(document.activeElement).toBe(row('A'));
    await user.keyboard('{ArrowLeft}');
    expect(row('A').getAttribute('aria-expanded')).toBe('false');
    await user.keyboard('{Enter}');
    expect(fake.navigations).toEqual(['/me/page/A']);
  });

  it('Home and End jump to the ends', async () => {
    const user = userEvent.setup();
    await renderTree();
    row('B').focus();
    await user.keyboard('{End}');
    expect(document.activeElement).toBe(row('C'));
    await user.keyboard('{Home}');
    expect(document.activeElement).toBe(row('A'));
  });

  it('only one row is in the tab order', async () => {
    await renderTree();
    expect(screen.getAllByRole('treeitem').filter((r) => r.tabIndex === 0)).toHaveLength(1);
  });
});

describe('row menu', () => {
  it('archives the page and its subtree', async () => {
    const user = userEvent.setup();
    await renderTree();
    await user.click(screen.getByRole('button', { name: 'Actions for A' }));
    await user.click(screen.getByRole('menuitem', { name: 'Archive' }));
    expect(patches('A')).toEqual([{ archived: true }]);
    await waitFor(() => expect(screen.queryByRole('treeitem', { name: 'A' })).toBeNull());
  });

  it('Rename from the menu starts inline renaming', async () => {
    const user = userEvent.setup();
    await renderTree();
    await user.click(screen.getByRole('button', { name: 'Actions for B' }));
    await user.click(screen.getByRole('menuitem', { name: 'Rename' }));
    expect(await screen.findByRole('textbox', { name: 'Page title' })).toBeTruthy();
  });

  it('Move to top level only appears for nested pages and moves to the end', async () => {
    const user = userEvent.setup();
    await renderTree({ kind: 'mePage', pageId: 'A1' });
    await user.click(screen.getByRole('button', { name: 'Actions for B' }));
    expect(screen.queryByRole('menuitem', { name: 'Move to top level' })).toBeNull();
    await user.keyboard('{Escape}');
    await user.click(screen.getByRole('button', { name: 'Actions for A1' }));
    await user.click(screen.getByRole('menuitem', { name: 'Move to top level' }));
    expect(patches('A1')).toEqual([{ parentId: null, sortOrder: 3 }]);
  });
});

describe('drag and drop', () => {
  const rect = { top: 0, height: 28, bottom: 28, left: 0, right: 100, width: 100, x: 0, y: 0, toJSON() {} };
  const dataTransfer = { setData() {}, getData: () => '', effectAllowed: '', dropEffect: '' };

  function drag(source: string, target: string, clientY: number, drop = true) {
    const targetRow = row(target);
    targetRow.getBoundingClientRect = () => rect as DOMRect;
    fireEvent.dragStart(row(source), { dataTransfer });
    // jsdom has no DragEvent: put the pointer position on a plain event
    const over = createEvent.dragOver(targetRow, { dataTransfer });
    Object.defineProperty(over, 'clientY', { value: clientY });
    fireEvent(targetRow, over);
    const indicator = targetRow.className;
    if (drop) {
      const dropEvent = createEvent.drop(targetRow, { dataTransfer });
      Object.defineProperty(dropEvent, 'clientY', { value: clientY });
      fireEvent(targetRow, dropEvent);
    }
    else fireEvent.dragEnd(row(source));
    return indicator;
  }

  it('reorders: before / after a sibling', async () => {
    await renderTree();
    expect(drag('C', 'B', 2)).toContain('is-drop-before');
    expect(patches('C')).toEqual([{ parentId: null, sortOrder: 0.5 }]);
    expect(drag('A', 'B', 26)).toContain('is-drop-after');
    expect(patches('A')).toEqual([{ parentId: null, sortOrder: 2 }]); // C moved before B meanwhile
  });

  it('nests: drop in the middle of a row', async () => {
    await renderTree();
    expect(drag('C', 'B', 14)).toContain('is-drop-inside');
    expect(patches('C')).toEqual([{ parentId: 'B', sortOrder: 0 }]);
    await waitFor(() => expect(row('B').getAttribute('aria-expanded')).toBe('true'));
  });

  it('refuses to drop a page into its own descendants', async () => {
    const user = userEvent.setup();
    await renderTree();
    await user.click(screen.getByRole('button', { name: 'Expand A' }));
    const cls = drag('A', 'A1', 14);
    expect(cls).not.toContain('is-drop');
    expect(patches('A')).toEqual([]);
  });

  it('refuses to drop onto itself', async () => {
    await renderTree();
    expect(drag('B', 'B', 14)).not.toContain('is-drop');
    expect(patches('B')).toEqual([]);
  });

  it('dropping below the tree moves to the end of the top level', async () => {
    const user = userEvent.setup();
    await renderTree();
    await user.click(screen.getByRole('button', { name: 'Expand A' }));
    fireEvent.dragStart(row('A2'), { dataTransfer });
    fireEvent.dragOver(screen.getByTestId('tree-tail'), { dataTransfer });
    fireEvent.drop(screen.getByTestId('tree-tail'), { dataTransfer });
    expect(patches('A2')).toEqual([{ parentId: null, sortOrder: 3 }]);
  });

  it('a drag that ends elsewhere changes nothing', async () => {
    await renderTree();
    drag('C', 'B', 2, false);
    expect(patches('C')).toEqual([]);
  });
});

describe('permissions', () => {
  async function renderProject(role: 'editor' | 'viewer', canTasks: boolean) {
    fake.data.user = { id: 'u1', username: 'U', role };
    fake.data.projects = [{ id: 'p1', name: 'Spot', canTasks, isOwner: false }];
    fake.routes['GET /api/spaces/p:p1/pages'] = () => json(list);
    fake.routes['GET /api/spaces/p:p1/pages?archived=1'] = () => json([]);
    return renderTree({ kind: 'projectPages', projectId: 'p1' }, { kind: 'project', projectId: 'p1' });
  }

  it('an editor with task access gets the affordances', async () => {
    await renderProject('editor', true);
    expect(screen.getByRole('button', { name: /New page/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Add subpage to A' })).toBeTruthy();
    expect(row('A').getAttribute('draggable')).toBe('true');
  });

  it.each([
    ['viewer role', 'viewer', true],
    ['no task access', 'editor', false],
  ] as const)('%s: the tree is read-only', async (_name, role, canTasks) => {
    const user = userEvent.setup();
    await renderProject(role, canTasks);
    expect(screen.getAllByRole('treeitem')).toHaveLength(3);
    expect(screen.queryByRole('button', { name: /New page/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Add subpage/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Actions for/ })).toBeNull();
    expect(row('A').getAttribute('draggable')).toBe('false');
    row('B').focus();
    await user.keyboard('{F2}');
    await user.dblClick(row('B'));
    expect(screen.queryByRole('textbox')).toBeNull();
    // still navigable
    fake.navigations.length = 0;
    await user.click(row('B'));
    expect(fake.navigations).toEqual(['/p/p1/page/B']);
    expect(screen.getByRole('button', { name: 'More page options' })).toBeTruthy(); // the archive stays reachable
  });

  it('a viewer role user keeps full rights in the personal space', async () => {
    fake.data.user = { id: 'u1', username: 'U', role: 'viewer' };
    await renderTree();
    expect(screen.getByRole('button', { name: /New page/ })).toBeTruthy();
  });

  it('watches the project while the tree is shown', async () => {
    await renderProject('editor', true);
    expect(fake.watches[fake.watches.length - 1]).toEqual({ slot: 'pages:p:p1', target: { projects: ['p1'] } });
  });
});

describe('archived list', () => {
  it('opens from the Archived entry and restores a page', async () => {
    const user = userEvent.setup();
    let archived = [node('X', null, 0, 'Old plan'), node('X1', 'X', 0, 'Old step')];
    fake.routes['GET /api/spaces/me/pages?archived=1'] = () => json(archived);
    fake.routes['PATCH /api/pages/X'] = () => {
      archived = [];
      return json(info(node('X', null, 0, 'Old plan')));
    };
    await renderTree();
    await user.click(screen.getByRole('button', { name: 'More page options' }));
    await user.click(screen.getByRole('menuitem', { name: 'Archived pages' }));
    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByText('Old plan')).toBeTruthy();
    expect(within(dialog).getByText('Old step')).toBeTruthy();
    await user.click(within(dialog).getByRole('button', { name: 'Restore Old plan' }));
    expect(patches('X')).toEqual([{ archived: false }]);
    await waitFor(() => expect(within(dialog).queryByText('Old plan')).toBeNull());
    expect(within(dialog).getByText('No archived pages.')).toBeTruthy();
  });

  it('delete forever asks for confirmation', async () => {
    const user = userEvent.setup();
    fake.routes['GET /api/spaces/me/pages?archived=1'] = () => json([node('X', null, 0, 'Old plan')]);
    fake.routes['DELETE /api/pages/X'] = () => json({ success: true });
    await renderTree();
    await user.click(screen.getByRole('button', { name: 'More page options' }));
    await user.click(screen.getByRole('menuitem', { name: 'Archived pages' }));
    await user.click(await screen.findByRole('button', { name: 'Delete Old plan forever' }));
    await waitFor(() => expect(fake.fetchCalls.some((c) => c.init?.method === 'DELETE')).toBe(true));
    expect(fake.confirmations).toHaveLength(1);
    expect(fake.confirmations[0]!.opts).toMatchObject({ danger: true });
  });
});
