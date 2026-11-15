import { useEffect, useRef, useState } from 'react';
import type { Awareness } from 'y-protocols/awareness';
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
export function SyncStatus({ status, quiet }: { status: PageStatus; quiet?: boolean }) {
  return (
    <span className={quiet ? 'cl-sync-status cl-sync-status--quiet' : 'cl-sync-status'} data-status={status} title={LABELS[status]} role="status" aria-live="polite">
      <span className="cl-sync-status__dot" aria-hidden="true" />
      <span className="cl-sync-status__label">{LABELS[status]}</span>
    </span>
  );
}

/** Someone else who has this page open. */
export interface PagePeer {
  id: string;
  name: string;
  color: string;
}

/** What a host needs to show the sync state itself (see `CollabEditorProps.onSync`). */
export interface SyncInfo {
  status: PageStatus;
  peers: PagePeer[];
}

/** The other people on the page, one entry per person (a person may have several tabs), without yourself. */
export function peersOf(awareness: Awareness | null): PagePeer[] {
  if (!awareness) return [];
  const seen = new Map<string, PagePeer>();
  awareness.getStates().forEach((state, clientId) => {
    const u = state.user as Partial<PagePeer> | undefined;
    if (clientId === awareness.clientID || !u?.name) return;
    const id = String(u.id ?? u.name);
    if (!seen.has(id)) seen.set(id, { id, name: String(u.name), color: String(u.color ?? '') });
  });
  const mine = (awareness.getLocalState()?.user as Partial<PagePeer> | undefined)?.id;
  if (mine) seen.delete(String(mine));
  return [...seen.values()];
}

/** Keeps the list of other people on the page up to date. */
function usePeers(awareness: Awareness | null): PagePeer[] {
  const [peers, setPeers] = useState<PagePeer[]>([]);
  useEffect(() => {
    if (!awareness) {
      setPeers([]);
      return;
    }
    const update = () =>
      setPeers((old) => {
        const next = peersOf(awareness);
        return old.length === next.length && old.every((p, i) => p.id === next[i]!.id) ? old : next;
      });
    update();
    awareness.on('change', update);
    return () => awareness.off('change', update);
  }, [awareness]);
  return peers;
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
  /** Do not draw the built-in status bar; the host shows the status itself (see `onSync`). */
  hideStatusBar?: boolean;
  /** Called whenever the sync status or the people on the page change. */
  onSync?(info: SyncInfo): void;
}

/** The page editor connected to the sync server: content, remote carets and the status label. */
export function CollabEditor({ pageId, placeholder, autoFocus, readOnly, hideStatusBar, onSync }: CollabEditorProps) {
  const { doc, awareness, status, editable, ready, user } = usePage(pageId);
  const chunk = useEditorChunk();
  const peers = usePeers(awareness);
  const onSyncRef = useRef(onSync);
  onSyncRef.current = onSync;
  useEffect(() => {
    onSyncRef.current?.({ status, peers });
  }, [status, peers]);
  // Leaving the page clears the host's indicator
  useEffect(() => () => onSyncRef.current?.({ status: 'connecting', peers: [] }), [pageId]);

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
        pageId={pageId}
        {...(placeholder ? { placeholder } : {})}
        {...(autoFocus ? { autoFocus } : {})}
      />
    );
  }

  return (
    <div className="cl-collab" data-page-id={pageId}>
      {hideStatusBar ? null : (
        <div className="cl-collab__bar">
          <SyncStatus status={status} />
        </div>
      )}
      <div className="cl-collab__body">{body}</div>
    </div>
  );
}
