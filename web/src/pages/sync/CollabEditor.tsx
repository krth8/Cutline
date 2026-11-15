import { useEffect, useState } from 'react';
import { loadEditor, type EditorChunk } from './loadEditor';
import type { PageStatus } from './PageProvider';
import { usePage } from './usePage';
import './sync.css';

const LABELS: Record<PageStatus, string> = {
  connecting: 'Connecting...',
  synced: 'Saved',
  saving: 'Saving...',
  offline: 'Offline, changes will sync',
  readonly: 'Read only',
  gone: 'Not available',
  error: 'Could not sync',
};

/** The small "Saved / Saving... / Offline" label. */
export function SyncStatus({ status }: { status: PageStatus }) {
  return (
    <span className="cl-sync-status" data-status={status} role="status" aria-live="polite">
      <span className="cl-sync-status__dot" aria-hidden="true" />
      {LABELS[status]}
    </span>
  );
}

/** The editor chunk, loaded on first use (it brings Tiptap, which the main bundle does not carry). */
function useEditorChunk(): EditorChunk | null {
  const [chunk, setChunk] = useState<EditorChunk | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let cancelled = false;
    loadEditor().then(
      (c) => !cancelled && setChunk(c),
      (e) => {
        console.error('Could not load the editor', e);
        if (!cancelled) setFailed(true);
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);
  if (failed) throw new Error('The editor could not be loaded');
  return chunk;
}

export interface CollabEditorProps {
  pageId: string;
  placeholder?: string;
  autoFocus?: boolean;
  /** Show the page without letting anyone type, even when the server allows editing (an archived page). */
  readOnly?: boolean;
}

/** The page editor connected to the sync server: content, remote carets and the status label. */
export function CollabEditor({ pageId, placeholder, autoFocus, readOnly }: CollabEditorProps) {
  const { doc, awareness, status, editable, ready, user } = usePage(pageId);
  const chunk = useEditorChunk();

  let body;
  if (status === 'gone') body = <p className="cl-collab__message">This page is not available.</p>;
  else if (status === 'error' && !ready) body = <p className="cl-collab__message">The page could not be loaded.</p>;
  else if (!ready || !chunk || !doc) body = <p className="cl-collab__message">Loading...</p>;
  else {
    const Editor = chunk.Editor;
    body = (
      <Editor
        key={pageId}
        doc={doc}
        awareness={awareness ?? undefined}
        user={user}
        editable={editable && !readOnly}
        {...(placeholder ? { placeholder } : {})}
        {...(autoFocus ? { autoFocus } : {})}
      />
    );
  }

  return (
    <div className="cl-collab" data-page-id={pageId}>
      <div className="cl-collab__bar">
        <SyncStatus status={status} />
      </div>
      <div className="cl-collab__body">{body}</div>
    </div>
  );
}
