import { act } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setPlatform } from '../../../platform';
import { createFakePlatform, type FakePlatform } from '../../../testing/fakePlatform';
import { mountEditor, outline } from '../testing/helpers';
import { cleanAlign, resizedWidth } from './image';
import { extensionLabel } from './file';
import { checkFileSize, formatBytes, kindOf, MAX_FILE_BYTES, MAX_IMAGE_BYTES, setEditorPageId } from './pageFiles';
import { mapUploads, nodeForFile, reduceUploads, startUpload, type UploadItem } from './uploads';
import './index';

const item = (id: string, pos = 1, progress = 0): UploadItem => ({ id, pos, rel: null, name: `${id}.png`, size: 10, progress });

describe('upload placeholder state', () => {
  it('adds, updates and removes by id', () => {
    let items: UploadItem[] = [];
    items = reduceUploads(items, { type: 'add', item: item('a') });
    items = reduceUploads(items, { type: 'add', item: item('b', 5) });
    items = reduceUploads(items, { type: 'progress', id: 'a', progress: 0.5 });
    expect(items.map((i) => [i.id, i.progress])).toEqual([['a', 0.5], ['b', 0]]);
    items = reduceUploads(items, { type: 'progress', id: 'a', progress: 7 });
    expect(items[0]!.progress).toBe(1);
    items = reduceUploads(items, { type: 'remove', id: 'a' });
    expect(items.map((i) => i.id)).toEqual(['b']);
  });

  it('moves positions through a change', () => {
    expect(mapUploads([item('a', 3), item('b', 9)], (p) => p + 2).map((i) => i.pos)).toEqual([5, 11]);
  });
});

describe('helpers', () => {
  it('limits per kind', () => {
    const big = { name: 'x.png', size: MAX_IMAGE_BYTES + 1 };
    expect(checkFileSize(big, 'image')).toMatch(/too large/);
    expect(checkFileSize(big, 'file')).toBeNull();
    expect(checkFileSize({ name: 'x.zip', size: MAX_FILE_BYTES + 1 }, 'file')).toMatch(/100 MB/);
  });
  it('picks image or file by type', () => {
    expect(kindOf({ type: 'image/png' })).toBe('image');
    expect(kindOf({ type: 'image/svg+xml' })).toBe('file');
    expect(kindOf({ type: '' })).toBe('file');
  });
  it('formats sizes and labels', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2 KB');
    expect(formatBytes(3 * 1024 * 1024)).toBe('3.0 MB');
    expect(extensionLabel('report.final.pdf')).toBe('PDF');
    expect(extensionLabel('README')).toBe('FILE');
  });
  it('resizes within bounds', () => {
    expect(resizedWidth(200, 50, 800)).toBe(250);
    expect(resizedWidth(200, -500, 800)).toBe(48);
    expect(resizedWidth(200, 900, 800)).toBe(800);
    expect(cleanAlign('center')).toBe('center');
    expect(cleanAlign('right')).toBe('left');
  });
});

describe('node attributes', () => {
  it('image keeps src, alt, width, fileId, caption and align', async () => {
    const m = await mountEditor();
    const attrs = { src: '/api/pages/p/files/f', alt: 'A cat', fileId: 'f', width: 320, caption: 'Cat', align: 'center' };
    m.editor.commands.setContent({ type: 'doc', content: [{ type: 'image', attrs }] });
    expect((m.editor.getJSON().content![0] as any).attrs).toEqual(attrs);
    // The document in Yjs carries them too
    const el = m.doc.getXmlFragment('default').get(0) as any;
    expect(el.nodeName).toBe('image');
    expect(el.getAttribute('width')).toBe(320);
    m.unmount();
  });

  it('image defaults to left and no width', async () => {
    const m = await mountEditor();
    m.editor.commands.setContent({ type: 'doc', content: [{ type: 'image', attrs: { src: '/x' } }] });
    const attrs = (m.editor.getJSON().content![0] as any).attrs;
    expect(attrs).toMatchObject({ align: 'left', width: null, caption: null, fileId: null });
    m.unmount();
  });

  it('file keeps its attributes', async () => {
    const m = await mountEditor();
    const attrs = { fileId: 'f1', url: '/api/pages/p/files/f1', name: 'Plan.pdf', size: 1234, mime: 'application/pdf' };
    await act(async () => {
      m.editor.commands.setContent({ type: 'doc', content: [{ type: 'file', attrs }] });
    });
    expect((m.editor.getJSON().content![0] as any).attrs).toEqual(attrs);
    expect(m.editor.view.dom.querySelector('.cl-file__name')?.textContent).toBe('Plan.pdf');
    expect(m.editor.view.dom.querySelector('a.cl-file__download')?.getAttribute('href')).toBe(attrs.url);
    m.unmount();
  });

  it('read-only pages show the image without editing controls', async () => {
    const m = await mountEditor({ editable: false });
    await act(async () => {
      m.editor.commands.setContent({ type: 'doc', content: [{ type: 'image', attrs: { src: '/x', caption: 'Hello' } }] });
    });
    const dom = m.editor.view.dom;
    expect(dom.querySelector('img')).not.toBeNull();
    expect(dom.querySelector('.cl-image__handle')).toBeNull();
    expect(dom.querySelector('input')).toBeNull();
    expect(dom.querySelector('figcaption')?.textContent).toBe('Hello');
    m.unmount();
  });

  it('nodeForFile maps the server answer to a node', () => {
    const base = { id: 'f', url: '/u', name: 'n', size: 3, mime: 'x/y' };
    expect(nodeForFile({ ...base, kind: 'image' }).type).toBe('image');
    expect(nodeForFile({ ...base, kind: 'file' })).toEqual({ type: 'file', attrs: { fileId: 'f', url: '/u', name: 'n', size: 3, mime: 'x/y' } });
  });
});

// ---- the upload flow with a fake XHR ----

class FakeXhr {
  static last: FakeXhr | null = null;
  upload: { onprogress: ((e: any) => void) | null } = { onprogress: null };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  status = 0;
  responseText = '';
  sent: FormData | null = null;
  url = '';
  headers: Record<string, string> = {};
  open(_m: string, url: string) {
    this.url = url;
    FakeXhr.last = this;
  }
  setRequestHeader(k: string, v: string) {
    this.headers[k] = v;
  }
  send(body: FormData) {
    this.sent = body;
  }
  finish(status: number, body: unknown) {
    this.status = status;
    this.responseText = JSON.stringify(body);
    this.onload?.();
  }
}

describe('upload flow', () => {
  let platform: FakePlatform;
  beforeEach(() => {
    platform = createFakePlatform();
    setPlatform(platform);
    vi.stubGlobal('XMLHttpRequest', FakeXhr);
    FakeXhr.last = null;
  });
  afterEach(() => vi.unstubAllGlobals());

  const png = () => new File([new Uint8Array([1, 2, 3])], 'shot.png', { type: 'image/png' });

  it('shows a local placeholder, then inserts the image', async () => {
    const m = await mountEditor();
    setEditorPageId(m.editor, 'page1');
    const done = startUpload(m.editor, png(), 1);
    await act(async () => {});
    expect(FakeXhr.last!.url).toBe('/api/pages/page1/files');
    expect(FakeXhr.last!.headers['X-Client-Id']).toBeTruthy();
    // Placeholder is drawn but the shared document has no image yet
    expect(m.editor.view.dom.querySelector('.cl-upload')).not.toBeNull();
    expect(m.doc.getXmlFragment('default').toString()).not.toContain('image');
    act(() => FakeXhr.last!.upload.onprogress!({ lengthComputable: true, loaded: 1, total: 2 }));
    expect((m.editor.view.dom.querySelector('.cl-upload__fill') as HTMLElement).style.width).toBe('50%');

    await act(async () => {
      FakeXhr.last!.finish(200, { id: 'f1', url: '/api/pages/page1/files/f1', name: 'shot.png', size: 3, mime: 'image/png', kind: 'image', width: 4, height: 2 });
      await done;
    });
    expect(m.editor.view.dom.querySelector('.cl-upload')).toBeNull();
    expect(outline(m.editor.getJSON())).toContain('image()');
    expect(m.doc.getXmlFragment('default').toString()).toContain('image');
    m.unmount();
  });

  it('removes the placeholder and shows a toast when the upload fails', async () => {
    const m = await mountEditor();
    setEditorPageId(m.editor, 'page1');
    const done = startUpload(m.editor, png(), 1);
    await act(async () => {});
    await act(async () => {
      FakeXhr.last!.finish(413, { detail: 'Image is too large' });
      expect(await done).toBe(false);
    });
    expect(m.editor.view.dom.querySelector('.cl-upload')).toBeNull();
    expect(outline(m.editor.getJSON())).not.toContain('image');
    expect(platform.toasts).toEqual([{ kind: 'error', message: 'Could not upload shot.png: Image is too large' }]);
    m.unmount();
  });

  it('refuses a file over the limit without contacting the server', async () => {
    const m = await mountEditor();
    setEditorPageId(m.editor, 'page1');
    const huge = new File([new Uint8Array(1)], 'huge.png', { type: 'image/png' });
    Object.defineProperty(huge, 'size', { value: MAX_IMAGE_BYTES + 1 });
    expect(await startUpload(m.editor, huge, 1)).toBe(false);
    expect(FakeXhr.last).toBeNull();
    expect(platform.toasts[0]?.message).toMatch(/too large/);
    m.unmount();
  });

  it('refuses when the editor has no page', async () => {
    const m = await mountEditor();
    expect(await startUpload(m.editor, png(), 1)).toBe(false);
    expect(platform.toasts[0]?.kind).toBe('error');
    m.unmount();
  });

  it('a pasted image starts an upload', async () => {
    const m = await mountEditor();
    setEditorPageId(m.editor, 'page1');
    m.editor.commands.focus();
    const event = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clipboardData', { value: { files: [png()], getData: () => '', types: ['Files'] } });
    m.editor.view.dom.dispatchEvent(event);
    await act(async () => {});
    expect(event.defaultPrevented).toBe(true);
    expect(FakeXhr.last?.url).toBe('/api/pages/page1/files');
    m.unmount();
  });
});
