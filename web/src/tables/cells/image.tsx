/**
 * Image columns: a cell holds one uploaded image. The value is the path the server gave back on upload
 * (`tasks.<projectId>/img_<hex>.png`, see api/routes/table_images.py); the picture is served from
 * `/api/table-images/<value>` to everyone who can read the table it was uploaded to.
 */
import { useRef, useState, type ClipboardEvent, type DragEvent } from 'react';
import { Button, Popover, cx } from '../../ui';
import { getPlatform } from '../../platform';
import type { Column } from '../types';
import type { CellDisplayProps, CellEditorProps } from './types';
import { useSettle } from './editors';
import { useAnchorRef } from './pickers';
import './cells.css';

const VALUE = /^(?:tasks\.[A-Za-z0-9_-]+|tbl_[A-Za-z0-9_-]+)\/img_[0-9a-f]{16}\.(?:jpg|png|gif|webp)$/;
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

export const asImage = (v: unknown): string | null => (typeof v === 'string' && VALUE.test(v) ? v : null);

/** The address of a cell's image, or null for an empty cell. */
export function imageUrl(v: unknown): string | null {
  const value = asImage(v);
  return value ? `/api/table-images/${value}` : null;
}

/** The table an image column uploads to (the server puts it in the column's config). */
export const uploadRefOf = (column: Column): string | null =>
  typeof column.config?.uploadRef === 'string' ? column.config.uploadRef : null;

interface LegacyWindow {
  applyRequestHeaders?: (xhr: XMLHttpRequest) => void;
  CLIENT_ID?: string;
}

/** Upload an image for a cell of `ref`; resolves with the value to store. Errors carry a message fit for a toast. */
export function uploadTableImage(ref: string, file: File): Promise<string> {
  if (!file.type.startsWith('image/')) return Promise.reject(new Error(`${file.name || 'That file'} is not an image`));
  if (file.size > MAX_IMAGE_BYTES) return Promise.reject(new Error(`${file.name || 'The image'} is too large (limit 20 MB)`));
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/api/tables/${encodeURIComponent(ref)}/images`);
    const legacy = window as unknown as LegacyWindow;
    if (legacy.applyRequestHeaders) legacy.applyRequestHeaders(xhr);
    else xhr.setRequestHeader('X-Client-Id', legacy.CLIENT_ID ?? 'web');
    xhr.onerror = () => reject(new Error('Could not upload the image: network error'));
    xhr.onload = () => {
      let body: { value?: unknown; detail?: unknown } | null = null;
      try {
        body = JSON.parse(xhr.responseText);
      } catch {
        body = null;
      }
      if (xhr.status >= 200 && xhr.status < 300 && typeof body?.value === 'string') resolve(body.value);
      else reject(new Error(`Could not upload the image: ${typeof body?.detail === 'string' ? body.detail : `HTTP ${xhr.status}`}`));
    };
    const form = new FormData();
    form.append('file', file, file.name || 'image');
    xhr.send(form);
  });
}

export function ImageDisplay({ column, value, compact }: CellDisplayProps) {
  const url = imageUrl(value);
  const [failed, setFailed] = useState<string | null>(null);
  return (
    <div className={cx('cl-cell', `cl-cell--${column.type}`, compact && 'cl-cell--compact')}>
      {url && failed !== url ? (
        <img className="cl-cell__image" src={url} alt="" loading="lazy" draggable={false} onError={() => setFailed(url)} data-testid="cell-image" />
      ) : url ? (
        <span className="cl-cell__muted">Image missing</span>
      ) : (
        <span className="cl-cell__empty" aria-label="Empty">
          <span aria-hidden="true">&ndash;</span>
        </span>
      )}
    </div>
  );
}

/** A small panel: the current image, Upload / Replace, Remove. A dropped or pasted image uploads too. */
export function ImageEditor({ column, value, row, onCommit, onCancel, anchor }: CellEditorProps) {
  const { selfRef, anchorRef } = useAnchorRef(anchor);
  const { commit, cancel } = useSettle(onCommit, onCancel);
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const url = imageUrl(value);
  const ref = uploadRefOf(column);

  async function take(file: File | undefined) {
    if (!file || !ref || busy) return;
    setBusy(true);
    try {
      commit(await uploadTableImage(ref, file));
    } catch (e) {
      getPlatform().toast('error', e instanceof Error ? e.message : 'Could not upload the image');
      setBusy(false);
    }
  }

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    void take(e.dataTransfer.files[0]);
  };
  const onPaste = (e: ClipboardEvent) => {
    const file = [...e.clipboardData.files].find((f) => f.type.startsWith('image/'));
    if (file) {
      e.preventDefault();
      void take(file);
    }
  };

  return (
    <>
      <span ref={selfRef} className="cl-cell__anchor">
        <ImageDisplay column={column} value={value} {...(row ? { row } : {})} />
      </span>
      <Popover open onOpenChange={(o) => !o && !busy && cancel()} anchorRef={anchorRef} aria-label={column.name} className="cl-imgedit">
        <div className="cl-imgedit__body" onDragOver={(e) => e.preventDefault()} onDrop={onDrop} onPaste={onPaste} tabIndex={-1} data-testid="image-editor">
          {url ? <img className="cl-imgedit__preview" src={url} alt="" /> : <div className="cl-imgedit__drop">Drop or paste an image</div>}
          {!ref && <p className="cl-imgedit__note">Images can only be added in the table the column belongs to.</p>}
          <div className="cl-imgedit__actions">
            <Button variant="primary" size="sm" disabled={!ref} loading={busy} onClick={() => input.current?.click()} data-testid="image-upload">
              {url ? 'Replace' : 'Upload image'}
            </Button>
            {url && (
              <Button variant="ghost" size="sm" disabled={busy} onClick={() => commit(null)} data-testid="image-remove">
                Remove
              </Button>
            )}
          </div>
          <input
            ref={input}
            type="file"
            accept="image/jpeg,image/png,image/gif,image/webp"
            hidden
            data-testid="image-file"
            onChange={(e) => void take(e.target.files?.[0])}
          />
        </div>
      </Popover>
    </>
  );
}
