/**
 * Uploading files into a page: limits checked in the browser, the upload itself (XHR, for progress)
 * and the page id each editor belongs to.
 */
import type { Editor } from '@tiptap/core';

export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
export const MAX_FILE_BYTES = 100 * 1024 * 1024;
/** Raster types that are shown inline as an image block; anything else (SVG, PDF ...) becomes a file block. */
export const INLINE_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];

/** What the server answers to an upload (api/routes/page_files.py). */
export interface PageFile {
  id: string;
  url: string;
  name: string;
  size: number;
  mime: string;
  kind: 'image' | 'file';
  width?: number;
  height?: number;
}

export type UploadKind = 'image' | 'file';

/** Image block for inline raster images, file block for the rest. */
export function kindOf(file: { type: string }): UploadKind {
  return INLINE_IMAGE_TYPES.includes(file.type) ? 'image' : 'file';
}

/** A message when the file is over the limit for its kind, else null. */
export function checkFileSize(file: { size: number; name: string }, kind: UploadKind): string | null {
  const max = kind === 'image' ? MAX_IMAGE_BYTES : MAX_FILE_BYTES;
  if (file.size <= max) return null;
  return `${file.name || 'The file'} is too large (limit ${formatBytes(max)})`;
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

// ---- which page an editor belongs to ----

const pageIds = new WeakMap<Editor, string>();

export function setEditorPageId(editor: Editor, pageId: string | undefined): void {
  if (pageId) pageIds.set(editor, pageId);
  else pageIds.delete(editor);
}

export function getEditorPageId(editor: Editor): string | undefined {
  return pageIds.get(editor);
}

// ---- the upload ----

interface LegacyWindow {
  applyRequestHeaders?: (xhr: XMLHttpRequest) => void;
  CLIENT_ID?: string;
}

/** POST the file to the page; the server decides from the content whether it is an image. `onProgress` gets 0..1. Rejects with an Error whose message is fit for a toast. */
export function uploadPageFile(
  pageId: string,
  file: File,
  onProgress?: (fraction: number) => void,
): Promise<PageFile> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/api/pages/${encodeURIComponent(pageId)}/files`);
    const legacy = window as unknown as LegacyWindow;
    if (legacy.applyRequestHeaders) legacy.applyRequestHeaders(xhr);
    else xhr.setRequestHeader('X-Client-Id', legacy.CLIENT_ID ?? 'web');
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && event.total > 0) onProgress?.(event.loaded / event.total);
    };
    xhr.onerror = () => reject(new Error(`Could not upload ${file.name}: network error`));
    xhr.onload = () => {
      let body: any = null;
      try {
        body = JSON.parse(xhr.responseText);
      } catch {
        body = null;
      }
      if (xhr.status >= 200 && xhr.status < 300 && body && typeof body.url === 'string') {
        resolve(body as PageFile);
        return;
      }
      const detail = typeof body?.detail === 'string' ? body.detail : `HTTP ${xhr.status}`;
      reject(new Error(`Could not upload ${file.name}: ${detail}`));
    };
    const form = new FormData();
    form.append('file', file, file.name || 'file');
    xhr.send(form);
  });
}
