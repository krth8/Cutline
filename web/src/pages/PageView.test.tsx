import { ExportHost } from '../export';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PageInfo, PageNode } from '../api/pageTree';
import { setPlatform } from '../platform';
import { createFakePlatform, type FakePlatform } from '../testing/fakePlatform';
import { PageView, registerPageBody } from './PageView';
import { resetPageStores } from './tree/pageStore';
import { requestTitleFocus } from './tree/space';

const node = (id: string, parentId: string | null, sortOrder: number, title = id, icon: string | null = null): PageNode => ({
  id,
  parentId,
  title,
  icon,
  sortOrder,
  kind: 'page',
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

let fake: FakePlatform;
let tree: PageNode[];
/** What GET /api/pages/P2 answers; null = 404. */
let current: PageInfo | null;

const infoOf = (n: PageNode, extra: Partial<PageInfo> = {}): PageInfo => ({
  ...n,
  space: 'me',
  canEdit: true,
  needsImport: false,
  archived: false,
  ...extra,
});

// Bodies registered by a test are removed again afterwards
const registered: Array<() => void> = [];
function plug(component: Parameters<typeof registerPageBody>[0]): () => void {
  const off = registerPageBody(component);
  registered.push(off);
  return off;
}

const route = { kind: 'mePage', pageId: 'P2' } as const;

function patchBodies(): unknown[] {
  return fake.fetchCalls.filter((c) => c.init?.method === 'PATCH').map((c) => JSON.parse(c.init!.body as string));
}

beforeEach(() => {
  document.title = 'Cutline';
  fake = createFakePlatform();
  setPlatform(fake);
  // P1 { P2 }   P3
  tree = [node('P1', null, 0, 'Plans', '\u{1F4CB}'), node('P3', null, 1), node('P2', 'P1', 0, 'Budget')];
  current = infoOf(tree[2]!);
  fake.routes['GET /api/spaces/me/pages'] = () => json(tree);
  fake.routes['GET /api/spaces/me/pages?archived=1'] = () => json([]);
  fake.routes['GET /api/pages/P2'] = () => (current ? json(current) : json({ detail: 'Page not found' }, 404));
  fake.routes['PATCH /api/pages/P2'] = (_p: string, init?: RequestInit) => {
    const body = JSON.parse(init!.body as string);
    current = { ...current!, ...body };
    if ('archived' in body) current = { ...current!, archived: body.archived };
    return json(current);
  };
});

afterEach(() => {
  cleanup();
  registered.splice(0).forEach((off) => off());
  setPlatform(null);
  resetPageStores();
  vi.useRealTimers();
});

describe('PageView states', () => {
  it('shows a skeleton while loading, then the page', async () => {
    render(<PageView route={route} />);
    expect(screen.getByTestId('page-skeleton')).toBeTruthy();
    expect(await screen.findByRole('textbox', { name: 'Page title' })).toBeTruthy();
    expect((screen.getByRole('textbox', { name: 'Page title' }) as HTMLTextAreaElement).value).toBe('Budget');
    expect(screen.queryByTestId('page-skeleton')).toBeNull();
  });

  it.each([404, 403])('shows "not available" with a link back for status %i', async (status) => {
    fake.routes['GET /api/pages/P2'] = () => json({ detail: 'x' }, status);
    render(<PageView route={route} />);
    expect(await screen.findByText('This page is not available')).toBeTruthy();
    const link = screen.getByRole('link', { name: 'Back to Personal space' });
    expect(link.getAttribute('href')).toBe('/me');
  });

  it('a project page links back to the project', async () => {
    fake.routes['GET /api/pages/P2'] = () => json({ detail: 'x' }, 403);
    fake.routes['GET /api/spaces/p:p1/pages'] = () => json([]);
    render(<PageView route={{ kind: 'projectPage', projectId: 'p1', pageId: 'P2' }} />);
    const link = await screen.findByRole('link', { name: 'Back to Project One' });
    expect(link.getAttribute('href')).toBe('/p/p1/pages');
  });

  it('a page of another space counts as not available', async () => {
    current = infoOf(tree[2]!, { space: 'p:p1' });
    render(<PageView route={route} />);
    expect(await screen.findByText('This page is not available')).toBeTruthy();
  });

  it('offers a retry after a server error', async () => {
    fake.routes['GET /api/pages/P2'] = () => json({ detail: 'boom' }, 500);
    render(<PageView route={route} />);
    expect(await screen.findByText('Could not load this page')).toBeTruthy();
    fake.routes['GET /api/pages/P2'] = () => json(current);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('textbox', { name: 'Page title' })).toBeTruthy();
  });

  it('shows the archived banner; Restore brings the page back', async () => {
    const user = userEvent.setup();
    current = infoOf(tree[2]!, { archived: true });
    render(<PageView route={route} />);
    const banner = await screen.findByText('This page is archived.');
    expect(banner).toBeTruthy();
    expect(screen.queryByRole('textbox', { name: 'Page title' })).toBeNull(); // read-only while archived
    await user.click(screen.getByRole('button', { name: 'Restore' }));
    await waitFor(() => expect(screen.queryByText('This page is archived.')).toBeNull());
    expect(patchBodies()).toEqual([{ archived: false }]);
    expect(screen.getByRole('textbox', { name: 'Page title' })).toBeTruthy();
  });

  it('Delete forever asks (danger), deletes, and goes to the space', async () => {
    const user = userEvent.setup();
    current = infoOf(tree[2]!, { archived: true });
    fake.routes['DELETE /api/pages/P2'] = () => json({ success: true });
    render(<PageView route={route} />);
    await user.click(await screen.findByRole('button', { name: 'Delete forever' }));
    await waitFor(() => expect(fake.navigations).toEqual(['/me']));
    expect(fake.confirmations[0]!.opts).toMatchObject({ danger: true });
  });

  it('declining the confirmation deletes nothing', async () => {
    const user = userEvent.setup();
    current = infoOf(tree[2]!, { archived: true });
    fake.confirmAnswer = false;
    render(<PageView route={route} />);
    await user.click(await screen.findByRole('button', { name: 'Delete forever' }));
    await waitFor(() => expect(fake.confirmations).toHaveLength(1));
    expect(fake.fetchCalls.some((c) => c.init?.method === 'DELETE')).toBe(false);
    expect(fake.navigations).toEqual([]);
  });
});

describe('header', () => {
  it('shows breadcrumbs with the ancestors as links', async () => {
    render(<PageView route={route} />);
    const nav = await screen.findByRole('navigation', { name: 'Breadcrumb' });
    await waitFor(() => expect(nav.textContent).toContain('Plans'));
    const links = Array.from(nav.querySelectorAll('a')).map((a) => [a.textContent?.trim(), a.getAttribute('href')]);
    expect(links).toEqual([
      ['Personal space', '/me'],
      ['\u{1F4CB} Plans', '/me/page/P1'],
    ]);
    expect(nav.querySelector('[aria-current="page"]')!.textContent).toBe('Budget');
  });

  it('follows the page title in the browser tab and restores it afterwards', async () => {
    const { unmount } = render(<PageView route={route} />);
    await waitFor(() => expect(document.title).toBe('Budget - Cutline'));
    unmount();
    expect(document.title).toBe('Cutline');
  });

  it('blur commits a changed title; the tree entry follows at once', async () => {
    const user = userEvent.setup();
    render(<PageView route={route} />);
    const title = await screen.findByRole('textbox', { name: 'Page title' });
    await user.clear(title);
    await user.type(title, 'Forecast');
    await user.tab();
    await waitFor(() => expect(patchBodies()).toContainEqual({ title: 'Forecast' }));
    expect((screen.getByRole('textbox', { name: 'Page title' }) as HTMLTextAreaElement).value).toBe('Forecast');
    await waitFor(() => expect(document.title).toBe('Forecast - Cutline'));
  });

  it('renames while typing after a pause (debounced), not on every key', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(<PageView route={route} />);
    const title = await screen.findByRole('textbox', { name: 'Page title' });
    fireEvent.change(title, { target: { value: 'F' } });
    fireEvent.change(title, { target: { value: 'Fo' } });
    fireEvent.change(title, { target: { value: 'Foo' } });
    expect(patchBodies()).toEqual([]);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(700);
    });
    expect(patchBodies()).toEqual([{ title: 'Foo' }]);
  });

  it('Enter in the title moves the cursor into the body', async () => {
    const user = userEvent.setup();
    plug(() => <div contentEditable suppressContentEditableWarning role="textbox" aria-label="Body" />);
    render(<PageView route={route} />);
    const title = await screen.findByRole('textbox', { name: 'Page title' });
    await user.click(title);
    await user.keyboard('{Enter}');
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Body');
    expect((title as HTMLTextAreaElement).value).toBe('Budget'); // no line break added
  });

  it('puts the cursor in the title of a page that was just created', async () => {
    requestTitleFocus('P2');
    render(<PageView route={route} />);
    const title = await screen.findByRole('textbox', { name: 'Page title' });
    await waitFor(() => expect(document.activeElement).toBe(title));
  });

  it('a refused rename shows a toast and goes back', async () => {
    const user = userEvent.setup();
    fake.routes['PATCH /api/pages/P2'] = () => json({ detail: 'Access denied' }, 403);
    render(<PageView route={route} />);
    const title = await screen.findByRole('textbox', { name: 'Page title' });
    await user.type(title, '!');
    await user.tab();
    await waitFor(() => expect(fake.toasts).toHaveLength(1));
    await waitFor(() => expect((screen.getByRole('textbox', { name: 'Page title' }) as HTMLTextAreaElement).value).toBe('Budget'));
  });
});

describe('icon', () => {
  it('picks an icon from the grid', async () => {
    const user = userEvent.setup();
    render(<PageView route={route} />);
    await user.click(await screen.findByRole('button', { name: 'Add icon' }));
    await user.click(screen.getByRole('button', { name: 'Icon \u{1F680}' }));
    await waitFor(() => expect(patchBodies()).toEqual([{ icon: '\u{1F680}' }]));
    expect(await screen.findByRole('button', { name: 'Change icon' })).toBeTruthy();
  });

  it('removes the icon', async () => {
    const user = userEvent.setup();
    tree = tree.map((p) => (p.id === 'P2' ? { ...p, icon: '\u{1F680}' } : p));
    current = infoOf(tree[2]!);
    render(<PageView route={route} />);
    await user.click(await screen.findByRole('button', { name: 'Change icon' }));
    await user.click(screen.getByRole('button', { name: 'Remove icon' }));
    await waitFor(() => expect(patchBodies()).toEqual([{ icon: null }]));
    expect(await screen.findByRole('button', { name: 'Add icon' })).toBeTruthy();
  });
});

describe('menu', () => {
  it('Add subpage creates under this page and opens it', async () => {
    const user = userEvent.setup();
    fake.routes['POST /api/spaces/me/pages'] = () => json(infoOf(node('N', 'P2', 0, 'Untitled')));
    render(<PageView route={route} />);
    await user.click(await screen.findByRole('button', { name: 'Page menu' }));
    await user.click(screen.getByRole('menuitem', { name: 'Add subpage' }));
    await waitFor(() => expect(fake.navigations).toEqual(['/me/page/N']));
    const post = fake.fetchCalls.find((c) => c.init?.method === 'POST')!;
    expect(JSON.parse(post.init!.body as string)).toEqual({ parentId: 'P2' });
  });

  it('Archive archives and shows the banner', async () => {
    const user = userEvent.setup();
    render(<PageView route={route} />);
    await user.click(await screen.findByRole('button', { name: 'Page menu' }));
    await user.click(screen.getByRole('menuitem', { name: 'Archive' }));
    expect(await screen.findByText('This page is archived.')).toBeTruthy();
    expect(patchBodies()).toEqual([{ archived: true }]);
  });

  it('Copy link writes the page URL to the clipboard', async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    render(<PageView route={route} />);
    await user.click(await screen.findByRole('button', { name: 'Page menu' }));
    await user.click(screen.getByRole('menuitem', { name: 'Copy link' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/me/page/P2`));
    expect(fake.toasts).toEqual([{ kind: 'success', message: 'Link copied' }]);
  });
});

describe('export menu', () => {
  it('downloads the page as Markdown, with and without sub-pages', async () => {
    const user = userEvent.setup();
    const hrefs: string[] = [];
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      hrefs.push(this.getAttribute('href') ?? '');
    });
    render(
      <>
        <PageView route={route} />
        <ExportHost />
      </>,
    );
    await user.click(await screen.findByRole('button', { name: 'Page menu' }));
    await user.click(screen.getByRole('menuitem', { name: 'Export...' }));
    await user.click(screen.getByRole('button', { name: /^Markdown\.?This page/ }));
    await waitFor(() => expect(hrefs).toHaveLength(1));
    await user.click(screen.getByRole('button', { name: 'Page menu' }));
    await user.click(screen.getByRole('menuitem', { name: 'Export...' }));
    await user.click(screen.getByRole('button', { name: /^Markdown with sub-pages/ }));
    await waitFor(() => expect(hrefs).toHaveLength(2));
    expect(hrefs).toEqual(['/api/pages/P2/export?format=md', '/api/pages/P2/export?format=md&subpages=1']);
    click.mockRestore();
  });

  it('Print / Save as PDF calls window.print and restores the page afterwards', async () => {
    const user = userEvent.setup();
    const print = vi.spyOn(window, 'print').mockImplementation(() => {
      expect(document.documentElement.classList.contains('cl-print-page')).toBe(true);
    });
    render(
      <>
        <PageView route={route} />
        <ExportHost />
      </>,
    );
    await user.click(await screen.findByRole('button', { name: 'Page menu' }));
    await user.click(screen.getByRole('menuitem', { name: 'Export...' }));
    await user.click(screen.getByRole('button', { name: /^Print \/ Save as PDF/ }));
    await waitFor(() => expect(print).toHaveBeenCalledTimes(1));
    window.dispatchEvent(new Event('afterprint'));
    expect(document.documentElement.classList.contains('cl-print-page')).toBe(false);
    print.mockRestore();
  });
});

describe('read-only', () => {
  beforeEach(() => {
    current = infoOf(tree[2]!, { canEdit: false });
  });

  it('shows a plain heading, no icon picker and only History, Export and Copy link in the menu', async () => {
    const user = userEvent.setup();
    render(<PageView route={route} />);
    expect(await screen.findByRole('heading', { name: 'Budget' })).toBeTruthy();
    expect(screen.queryByRole('textbox', { name: 'Page title' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Add icon' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Page menu' }));
    expect(screen.getAllByRole('menuitem').map((m) => m.textContent)).toEqual([
      'History',
      'Export...',
      'Copy link',
    ]);
  });

  it('passes editable=false to the body', async () => {
    const seen: boolean[] = [];
    plug(({ editable }) => {
      seen.push(editable);
      return <div>body</div>;
    });
    render(<PageView route={route} />);
    await screen.findByText('body');
    expect(seen.every((e) => e === false)).toBe(true);
  });
});

describe('body slot', () => {
  it('shows a placeholder when no editor is registered', async () => {
    render(<PageView route={route} />);
    expect(await screen.findByText('The editor is not loaded')).toBeTruthy();
  });

  it('renders the registered body with the page id and edit right', async () => {
    const unregister = plug(({ pageId, editable }) => <div>{`body ${pageId} ${editable}`}</div>);
    render(<PageView route={route} />);
    expect(await screen.findByText('body P2 true')).toBeTruthy();
    expect(screen.queryByText('The editor is not loaded')).toBeNull();
    act(() => unregister());
    expect(await screen.findByText('The editor is not loaded')).toBeTruthy();
  });
});

describe('live updates', () => {
  it('a rename by somebody else shows without reload', async () => {
    render(<PageView route={route} />);
    await screen.findByRole('textbox', { name: 'Page title' });
    tree = tree.map((p) => (p.id === 'P2' ? { ...p, title: 'Renamed remotely', icon: '\u{1F525}' } : p));
    current = { ...current!, title: 'Renamed remotely', icon: '\u{1F525}' };
    fake.emit('page_changed', { pageId: 'P2', change: 'renamed' });
    await waitFor(() => expect((screen.getByRole('textbox', { name: 'Page title' }) as HTMLTextAreaElement).value).toBe('Renamed remotely'));
    expect(screen.getByRole('button', { name: 'Change icon' }).textContent).toBe('\u{1F525}');
    await waitFor(() => expect(document.title).toBe('Renamed remotely - Cutline'));
  });

  it('the breadcrumb follows a renamed ancestor', async () => {
    render(<PageView route={route} />);
    const nav = await screen.findByRole('navigation', { name: 'Breadcrumb' });
    await waitFor(() => expect(nav.textContent).toContain('Plans'));
    tree = tree.map((p) => (p.id === 'P1' ? { ...p, title: 'Roadmap' } : p));
    fake.emit('page_changed', { pageId: 'P1', change: 'renamed' });
    await waitFor(() => expect(nav.textContent).toContain('Roadmap'));
  });

  it('deleted while open: "not available"', async () => {
    render(<PageView route={route} />);
    await screen.findByRole('textbox', { name: 'Page title' });
    current = null;
    fake.emit('page_changed', { pageId: 'P2', change: 'deleted' });
    expect(await screen.findByText('This page is not available')).toBeTruthy();
  });

  it('archived by somebody else: the banner appears', async () => {
    render(<PageView route={route} />);
    await screen.findByRole('textbox', { name: 'Page title' });
    current = { ...current!, archived: true };
    tree = tree.filter((p) => p.id !== 'P2');
    fake.emit('page_changed', { pageId: 'P2', change: 'archived' });
    expect(await screen.findByText('This page is archived.')).toBeTruthy();
  });

  it('access lost on reload: "not available"', async () => {
    render(<PageView route={route} />);
    await screen.findByRole('textbox', { name: 'Page title' });
    fake.routes['GET /api/pages/P2'] = () => json({ detail: 'Access denied' }, 403);
    fake.emit('resync');
    expect(await screen.findByText('This page is not available')).toBeTruthy();
  });
});
