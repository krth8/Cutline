/**
 * Upload placeholders. While a file uploads, a widget shows its name and progress at the place where it
 * will go. The placeholder lives in this plugin's state only, never in the shared document, so other
 * people never see a half-finished block. When the upload succeeds the real node is inserted; when it
 * fails the placeholder disappears and a toast says why.
 */
import { Extension, type Editor } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import {
  absolutePositionToRelativePosition,
  relativePositionToAbsolutePosition,
  ySyncPluginKey,
} from '@tiptap/y-tiptap';
import { getPlatform } from '../../../platform';
import {
  checkFileSize,
  formatBytes,
  getEditorPageId,
  kindOf,
  uploadPageFile,
  type PageFile,
} from './pageFiles';

export interface UploadItem {
  id: string;
  /** Position in the editor document (kept up to date through every transaction). */
  pos: number;
  /** The same place as a Yjs relative position: survives remote changes that replace the whole document. */
  rel: unknown;
  name: string;
  size: number;
  /** 0..1 */
  progress: number;
}

export type UploadAction =
  | { type: 'add'; item: UploadItem }
  | { type: 'progress'; id: string; progress: number }
  | { type: 'remove'; id: string };

/** The list of running uploads after an action. */
export function reduceUploads(items: readonly UploadItem[], action: UploadAction): UploadItem[] {
  switch (action.type) {
    case 'add':
      return [...items.filter((i) => i.id !== action.item.id), action.item];
    case 'progress':
      return items.map((i) => (i.id === action.id ? { ...i, progress: Math.max(0, Math.min(1, action.progress)) } : i));
    case 'remove':
      return items.filter((i) => i.id !== action.id);
  }
}

/** Move every placeholder through a document change. */
export function mapUploads(items: readonly UploadItem[], map: (pos: number) => number): UploadItem[] {
  return items.map((i) => ({ ...i, pos: map(i.pos) }));
}

export const uploadsKey = new PluginKey<UploadItem[]>('clPageUploads');

function placeholderElement(item: UploadItem): HTMLElement {
  const el = document.createElement('div');
  el.className = 'cl-upload';
  el.contentEditable = 'false';
  el.setAttribute('role', 'progressbar');
  el.setAttribute('aria-label', `Uploading ${item.name}`);
  el.setAttribute('aria-valuenow', String(Math.round(item.progress * 100)));
  const label = document.createElement('span');
  label.className = 'cl-upload__name';
  label.textContent = `${item.name} (${formatBytes(item.size)})`;
  const bar = document.createElement('span');
  bar.className = 'cl-upload__bar';
  const fill = document.createElement('span');
  fill.className = 'cl-upload__fill';
  fill.style.width = `${Math.round(item.progress * 100)}%`;
  bar.appendChild(fill);
  el.append(label, bar);
  return el;
}

/** Current position of a placeholder: from the Yjs relative position when the collaboration binding is there. */
function resolvePos(editor: Editor | null, item: UploadItem): number {
  try {
    const sync = editor ? ySyncPluginKey.getState(editor.state) : null;
    if (sync?.binding && item.rel) {
      const abs = relativePositionToAbsolutePosition(sync.doc, sync.type, item.rel as any, sync.binding.mapping);
      if (abs != null && abs <= editor!.state.doc.content.size) return abs;
    }
  } catch {
    // fall through to the mapped position
  }
  return Math.min(item.pos, editor ? editor.state.doc.content.size : item.pos);
}

/** The plugin that holds and draws the placeholders, plus the paste and drop handlers that start uploads. */
export const PageFileUploads = Extension.create({
  name: 'pageFileUploads',

  addProseMirrorPlugins() {
    const editor = this.editor;
    return [
      new Plugin<UploadItem[]>({
        key: uploadsKey,
        state: {
          init: () => [],
          apply(tr, items) {
            const action = tr.getMeta(uploadsKey) as UploadAction | undefined;
            let next = items;
            if (tr.docChanged && next.length) next = mapUploads(next, (p) => tr.mapping.map(p));
            return action ? reduceUploads(next, action) : next;
          },
        },
        props: {
          decorations(state) {
            const items = uploadsKey.getState(state) ?? [];
            if (!items.length) return DecorationSet.empty;
            return DecorationSet.create(
              state.doc,
              items.map((item) =>
                Decoration.widget(resolvePos(editor, item), () => placeholderElement(item), {
                  key: `${item.id}:${Math.round(item.progress * 100)}`,
                  side: 1,
                }),
              ),
            );
          },
          handlePaste(view, event) {
            if (!view.editable) return false;
            const files = Array.from(event.clipboardData?.files ?? []);
            // Text on the clipboard wins (copying from Word brings a picture of the text along)
            if (!files.length || event.clipboardData?.getData('text/plain')?.trim()) return false;
            event.preventDefault();
            const at = view.state.selection.from;
            for (const file of files) void startUpload(editor, file, at);
            return true;
          },
          handleDrop(view, event, _slice, moved) {
            if (!view.editable || moved) return false;
            const files = Array.from(event.dataTransfer?.files ?? []);
            if (!files.length) return false;
            event.preventDefault();
            const at = view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos ?? view.state.selection.from;
            for (const file of files) void startUpload(editor, file, at);
            return true;
          },
        },
      }),
    ];
  },
});

function dispatchAction(editor: Editor, action: UploadAction) {
  if (editor.isDestroyed) return;
  editor.view.dispatch(editor.state.tr.setMeta(uploadsKey, action).setMeta('addToHistory', false));
}

/** The node JSON for an uploaded file. */
export function nodeForFile(file: PageFile): { type: string; attrs: Record<string, unknown> } {
  if (file.kind === 'image') {
    return { type: 'image', attrs: { src: file.url, alt: '', fileId: file.id, width: null, caption: null, align: 'left' } };
  }
  return { type: 'file', attrs: { fileId: file.id, url: file.url, name: file.name, size: file.size, mime: file.mime } };
}

/** Put the uploaded node where the placeholder was and remove the placeholder, in one step. */
function insertFinished(editor: Editor, item: UploadItem, file: PageFile) {
  const { state } = editor;
  const node = state.schema.nodeFromJSON(nodeForFile(file));
  const pos = Math.max(0, Math.min(resolvePos(editor, item), state.doc.content.size));
  const $pos = state.doc.resolve(pos);
  const tr = state.tr;
  if ($pos.parent.isTextblock && $pos.parent.content.size === 0) {
    // An empty paragraph (the slash menu's) is replaced by the block
    tr.replaceWith($pos.before(), $pos.after(), node);
  } else {
    tr.insert($pos.parent.isTextblock ? (pos === $pos.start() ? $pos.before() : $pos.after()) : pos, node);
  }
  tr.setMeta(uploadsKey, { type: 'remove', id: item.id } satisfies UploadAction);
  editor.view.dispatch(tr);
}

let counter = 0;

/**
 * Upload `file` and insert it at `pos` once it is stored. Shows a local placeholder meanwhile.
 * Resolves true when the block was inserted.
 */
export async function startUpload(editor: Editor, file: File, pos: number): Promise<boolean> {
  const platform = getPlatform();
  const pageId = getEditorPageId(editor);
  if (!pageId) {
    platform.toast('error', 'Files cannot be added to this page');
    return false;
  }
  const tooLarge = checkFileSize(file, kindOf(file));
  if (tooLarge) {
    platform.toast('error', tooLarge);
    return false;
  }

  const id = `upload-${Date.now()}-${++counter}`;
  let rel: unknown = null;
  try {
    const sync = ySyncPluginKey.getState(editor.state);
    if (sync?.binding) rel = absolutePositionToRelativePosition(pos, sync.type, sync.binding.mapping);
  } catch {
    rel = null;
  }
  const item: UploadItem = { id, pos, rel, name: file.name || 'file', size: file.size, progress: 0 };
  dispatchAction(editor, { type: 'add', item });
  try {
    const stored = await uploadPageFile(pageId, file, (progress) => dispatchAction(editor, { type: 'progress', id, progress }));
    if (editor.isDestroyed) return false;
    const current = uploadsKey.getState(editor.state)?.find((i) => i.id === id) ?? item;
    insertFinished(editor, current, stored);
    return true;
  } catch (error) {
    dispatchAction(editor, { type: 'remove', id });
    platform.toast('error', error instanceof Error ? error.message : 'Upload failed');
    return false;
  }
}

/** Open the browser's file picker; resolves with the chosen files (none when cancelled). */
export function pickFiles(accept: string): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    if (accept) input.accept = accept;
    input.onchange = () => resolve(Array.from(input.files ?? []));
    input.addEventListener('cancel', () => resolve([]));
    input.click();
  });
}
