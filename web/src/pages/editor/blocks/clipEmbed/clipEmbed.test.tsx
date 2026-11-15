import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { Editor as TiptapEditor } from '@tiptap/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Awareness } from 'y-protocols/awareness';
import * as Y from 'yjs';
import { setPlatform } from '../../../../platform';
import { createFakePlatform, type FakePlatform } from '../../../../testing/fakePlatform';
import { Editor } from '../../Editor';
import { getRegisteredSlashItems } from '../../registry';
import { loadPickerProjects } from './clipApi';
import { ClipEmbedContent } from './ClipEmbedContent';
import { matchesSearch } from './ClipPicker';
import { markFreshClipBlock } from './freshInsert';
import { cleanCount, frameLabel, reviewLink, thumbnailSrc, type ClipSummary } from './model';
import './index'; // registers the block

let fake: FakePlatform;
/** What the fake server knows: project id -> clips. A project missing here answers 403. */
let clipsByProject: Record<string, ClipSummary[]>;
let pageSpace: string;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function summary(over: Partial<ClipSummary> = {}): ClipSummary {
  return {
    projectId: 'p1',
    baseName: 'shot_010',
    version: 2,
    versionStr: 'v2',
    activeVersion: 2,
    versionCount: 2,
    thumbnail: 'p1_shot_010_v2.jpg',
    mediaType: 'video',
    status: { id: 's1', name: 'In review', color: '#3b82f6' },
    commentCount: 3,
    ...over,
  };
}

function installServer() {
  fake.fetch = async (path, init) => {
    fake.fetchCalls.push({ path, ...(init ? { init } : {}) });
    const one = /^\/api\/projects\/([^/]+)\/clips\/([^/]+)\/summary/.exec(path);
    if (one) {
      const clips = clipsByProject[decodeURIComponent(one[1]!)];
      if (!clips) return json({ detail: 'Access denied' }, 403);
      const clip = clips.find((c) => c.baseName === decodeURIComponent(one[2]!));
      return clip ? json(clip) : json({ detail: 'Clip not found' }, 404);
    }
    const list = /^\/api\/projects\/([^/]+)\/clip-summaries$/.exec(path);
    if (list) {
      const clips = clipsByProject[decodeURIComponent(list[1]!)];
      return clips ? json({ clips }) : json({ detail: 'Access denied' }, 403);
    }
    if (path === '/api/pages/page1') return json({ id: 'page1', space: pageSpace });
    return json({ detail: 'Not found' }, 404);
  };
}

beforeEach(() => {
  clipsByProject = { p1: [summary(), summary({ baseName: 'shot_020', thumbnail: null, status: null, commentCount: 1 })] };
  pageSpace = 'p:p1';
  fake = createFakePlatform();
  installServer();
  setPlatform(fake);
});
afterEach(() => {
  cleanup();
  setPlatform(null);
});

const attrs = (over: Record<string, unknown> = {}) => ({ projectId: 'p1', baseName: 'shot_010', version: null, frame: null, ...over });

function renderContent(over: Partial<Parameters<typeof ClipEmbedContent>[0]> = {}) {
  const calls = { set: [] as unknown[], removed: 0 };
  const result = render(
    <ClipEmbedContent
      attrs={attrs()}
      editable
      pageId="page1"
      setAttrs={(a) => calls.set.push(a)}
      removeBlock={() => {
        calls.removed++;
      }}
      {...over}
    />,
  );
  return { ...result, calls };
}

describe('model', () => {
  it('builds the review link with the clip, the version and the frame when they are set', () => {
    expect(reviewLink(attrs())).toBe('/p/p1/review?clip=shot_010');
    expect(reviewLink(attrs({ version: 3, frame: 120 }))).toBe('/p/p1/review?clip=shot_010&v=3&frame=120');
    expect(reviewLink(attrs({ projectId: 'a b', baseName: 'x&y' }))).toBe('/p/a%20b/review?clip=x%26y');
  });

  it('only whole numbers from zero up count as a frame or version', () => {
    expect(cleanCount('12')).toBe(12);
    expect(cleanCount(0)).toBe(0);
    for (const bad of ['', 'abc', -1, 1.5, null, undefined]) expect(cleanCount(bad)).toBeNull();
    expect(frameLabel(48)).toBe('Frame 48');
    expect(frameLabel(null)).toBe('');
    expect(thumbnailSrc('a b.jpg')).toBe('/thumbnail/a%20b.jpg');
  });

  it('search matches the clip name or the project name', () => {
    expect(matchesSearch({ name: 'Spot' }, { baseName: 'shot_010' }, 'SHOT')).toBe(true);
    expect(matchesSearch({ name: 'Spot' }, { baseName: 'shot_010' }, 'spo')).toBe(true);
    expect(matchesSearch({ name: 'Spot' }, { baseName: 'shot_010' }, 'zzz')).toBe(false);
    expect(matchesSearch({ name: 'Spot' }, { baseName: 'shot_010' }, '  ')).toBe(true);
  });
});

describe('the picker data', () => {
  it('lists the page project first, then the others, and leaves out projects it may not review or that have no clips', async () => {
    fake.data.projects = [
      { id: 'p0', name: 'Other', canTasks: true, isOwner: false },
      { id: 'p1', name: 'This one', canTasks: true, isOwner: false },
      { id: 'p2', name: 'Locked', canTasks: false, isOwner: false },
      { id: 'p3', name: 'Empty', canTasks: true, isOwner: false },
    ];
    clipsByProject = {
      p0: [summary({ projectId: 'p0', baseName: 'a' })],
      p1: [summary()],
      p3: [],
    };
    expect((await loadPickerProjects('page1')).map((p) => p.id)).toEqual(['p1', 'p0']);
    pageSpace = 'me'; // a personal page: the usual order
    expect((await loadPickerProjects('page1')).map((p) => p.id)).toEqual(['p0', 'p1']);
  });
});

describe('the card', () => {
  it('shows the thumbnail, name, version, status, comments and frame, and opens the review at that frame', async () => {
    renderContent({ attrs: attrs({ frame: 48 }) });
    await screen.findByTestId('clip-embed-name');
    expect(screen.getByTestId('clip-embed-name').textContent).toBe('shot_010');
    expect(screen.getByTestId('clip-embed-version').textContent).toBe('v2');
    expect(screen.getByTestId('clip-embed-status').textContent).toBe('In review');
    expect(screen.getByTestId('clip-embed-comments').textContent).toBe('3 comments');
    expect(screen.getByTestId('clip-embed-frame').textContent).toBe('Frame 48');
    expect(screen.getByTestId('clip-embed-thumb').getAttribute('src')).toBe('/thumbnail/p1_shot_010_v2.jpg');
    const link = screen.getByTestId('clip-embed-open');
    expect(link.getAttribute('href')).toBe('/p/p1/review?clip=shot_010&frame=48');
    fireEvent.click(link);
    expect(fake.navigations).toEqual(['/p/p1/review?clip=shot_010&frame=48']);
  });

  it('asks for the stored version and shows the placeholder when the clip has no thumbnail or status', async () => {
    renderContent({ attrs: attrs({ baseName: 'shot_020', version: 1 }) });
    await screen.findByTestId('clip-embed-name');
    expect(screen.queryByTestId('clip-embed-thumb')).toBeNull();
    expect(screen.getByTestId('clip-embed-status').textContent).toBe('No status');
    expect(screen.getByTestId('clip-embed-comments').textContent).toBe('1 comment');
    expect(fake.fetchCalls.some((c) => c.path === '/api/projects/p1/clips/shot_020/summary?version=1')).toBe(true);
  });

  it('shows a quiet no-access card that does not name the clip', async () => {
    clipsByProject = {};
    const { container } = renderContent();
    await screen.findByTestId('clip-embed-denied');
    expect(container.textContent).toBe("You don't have access to this clip.");
    expect(container.querySelector('[data-clip]')?.getAttribute('data-state')).toBe('denied');
  });

  it('says the clip was deleted and lets an editor remove the block', async () => {
    clipsByProject = { p1: [] };
    const { calls } = renderContent();
    await screen.findByTestId('clip-embed-gone');
    fireEvent.click(screen.getByTestId('clip-embed-remove-gone'));
    expect(calls.removed).toBe(1);
  });

  it('read-only: the card has no controls, and a deleted clip has no remove button', async () => {
    const first = renderContent({ editable: false });
    await screen.findByTestId('clip-embed-name');
    expect(screen.queryByTestId('clip-embed-change')).toBeNull();
    expect(screen.queryByTestId('clip-embed-remove')).toBeNull();
    first.unmount();
    clipsByProject = { p1: [] };
    renderContent({ editable: false });
    await screen.findByTestId('clip-embed-gone');
    expect(screen.queryByTestId('clip-embed-remove-gone')).toBeNull();
  });

  it('watches the project while mounted and lets go of it afterwards', async () => {
    const { unmount } = renderContent();
    await screen.findByTestId('clip-embed-name');
    const mine = fake.watches.find((w) => w.target?.projects?.[0] === 'p1');
    expect(mine).toBeTruthy();
    unmount();
    expect(fake.watches[fake.watches.length - 1]).toEqual({ slot: mine!.slot, target: null });
  });

  it('follows a status change, a new comment and a deleted clip from the live connection', async () => {
    renderContent();
    await screen.findByTestId('clip-embed-name');
    // The server now holds a new status and one more comment
    clipsByProject.p1 = [summary({ status: { id: 's2', name: 'Approved', color: '#22c55e' }, commentCount: 4 })];
    act(() => fake.emit('clip_updated', { project: 'p1', baseName: 'shot_010' }));
    await waitFor(() => expect(screen.getByTestId('clip-embed-status').textContent).toBe('Approved'));
    expect(screen.getByTestId('clip-embed-comments').textContent).toBe('4 comments');

    // Events about another clip or project are ignored
    const calls = fake.fetchCalls.length;
    act(() => {
      fake.emit('clip_updated', { project: 'p1', baseName: 'other' });
      fake.emit('clip_updated', { project: 'p9', baseName: 'shot_010' });
    });
    await new Promise((r) => setTimeout(r, 250));
    expect(fake.fetchCalls.length).toBe(calls);

    act(() => fake.emit('clip_deleted', { project: 'p1', baseName: 'shot_010' }));
    await screen.findByTestId('clip-embed-gone');
  });

  it('turns into the no-access card when the access is removed', async () => {
    renderContent();
    await screen.findByTestId('clip-embed-name');
    act(() => fake.emit('access_removed', { project: 'p1' }));
    await screen.findByTestId('clip-embed-denied');
  });
});

describe('choosing a clip', () => {
  it('an empty block asks for a clip; picking one writes the project, the clip and the frame', async () => {
    const { calls } = renderContent({ attrs: attrs({ projectId: null, baseName: null }) });
    expect(screen.getByTestId('clip-embed-empty')).toBeTruthy();
    fireEvent.click(screen.getByTestId('clip-embed-pick'));
    await screen.findByTestId('clip-picker-list');
    fireEvent.change(screen.getByLabelText('Open at frame (optional)'), { target: { value: '24' } });
    fireEvent.click(document.querySelector('[data-clip="shot_020"]')!);
    expect(calls.set).toEqual([{ projectId: 'p1', baseName: 'shot_020', frame: 24, version: null }]);
  });

  it('the picker searches by name and refuses a frame that is not a number', async () => {
    renderContent({ attrs: attrs({ projectId: null, baseName: null }) });
    fireEvent.click(screen.getByTestId('clip-embed-pick'));
    await screen.findByTestId('clip-picker-list');
    expect(document.querySelectorAll('.cl-clippicker__item')).toHaveLength(2);
    fireEvent.change(screen.getByLabelText('Search clips'), { target: { value: '020' } });
    expect(document.querySelectorAll('.cl-clippicker__item')).toHaveLength(1);
    fireEvent.change(screen.getByLabelText('Open at frame (optional)'), { target: { value: 'x' } });
    expect((document.querySelector('.cl-clippicker__item') as HTMLButtonElement).disabled).toBe(true);
  });

  it('only a block inserted in this browser opens the picker by itself', async () => {
    renderContent({ attrs: attrs({ projectId: null, baseName: null }) });
    expect(screen.queryByText('Pick a clip', { selector: 'h2, h3, [role=dialog] *' })).toBeNull();
    cleanup();
    markFreshClipBlock();
    renderContent({ attrs: attrs({ projectId: null, baseName: null }) });
    await screen.findByTestId('clip-picker-list');
  });
});

describe('the node in the editor', () => {
  async function mount(editable = true) {
    const doc = new Y.Doc();
    let editor: TiptapEditor | null = null;
    await act(async () => {
      render(
        <Editor
          doc={doc}
          awareness={new Awareness(doc)}
          user={{ id: 'u1', name: 'Ada', color: '#e8590c' }}
          editable={editable}
          pageId="page1"
          onReady={(e) => {
            editor = e;
          }}
        />,
      );
    });
    return editor as unknown as TiptapEditor;
  }

  it('offers /clip in the slash menu', () => {
    const item = getRegisteredSlashItems().find((i) => i.id === 'clip-embed');
    expect(item?.title).toBe('Clip');
  });

  it('stores project, clip, version and frame, renders the card, and survives an HTML round trip', async () => {
    const editor = await mount();
    await act(async () => {
      editor.commands.insertContent({ type: 'clipEmbed', attrs: { projectId: 'p1', baseName: 'shot_010', version: 2, frame: 48 } });
    });
    await screen.findByTestId('clip-embed-name');
    const stored = (editor.getJSON().content ?? []).find((n) => n.type === 'clipEmbed');
    expect(stored?.attrs).toEqual({ projectId: 'p1', baseName: 'shot_010', version: 2, frame: 48 });
    const html = editor.getHTML();
    expect(html).toContain('data-clip-embed');
    expect(html).toContain('data-project-id="p1"');
    expect(html).toContain('data-clip="shot_010"');
    expect(html).toContain('data-version="2"');
    expect(html).toContain('data-frame="48"');
    await act(async () => {
      editor.commands.setContent(html);
    });
    const again = (editor.getJSON().content ?? []).find((n) => n.type === 'clipEmbed');
    expect(again?.attrs).toEqual({ projectId: 'p1', baseName: 'shot_010', version: 2, frame: 48 });
  });

  it('inserting with the slash entry puts an empty block in and opens the picker', async () => {
    const editor = await mount();
    editor.commands.focus();
    await act(async () => {
      getRegisteredSlashItems().find((i) => i.id === 'clip-embed')!.run(editor, { from: 1, to: 1 });
    });
    const stored = (editor.getJSON().content ?? []).find((n) => n.type === 'clipEmbed');
    expect(stored?.attrs).toEqual({ projectId: null, baseName: null, version: null, frame: null });
    await screen.findByTestId('clip-picker-list');
  });

  it('a read-only editor shows the card without controls', async () => {
    const editor = await mount(false);
    await act(async () => {
      editor.commands.insertContent({ type: 'clipEmbed', attrs: { projectId: 'p1', baseName: 'shot_010' } });
    });
    await screen.findByTestId('clip-embed-name');
    expect(screen.queryByTestId('clip-embed-change')).toBeNull();
    expect(screen.queryByTestId('clip-embed-remove')).toBeNull();
  });
});
