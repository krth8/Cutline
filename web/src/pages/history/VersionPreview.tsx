import { useEffect, useMemo, useState } from 'react';
import * as Y from 'yjs';
import { stateBytes } from '../../api/history';
import { loadEditor, type EditorChunk } from '../sync/loadEditor';

const PREVIEW_USER = { id: 'history-preview', name: 'Preview', color: '#888888' };

/**
 * A read-only rendering of one version: the editor mounted on a throwaway Y.Doc built from the
 * stored state. No provider and no awareness, so nothing is sent anywhere and nobody sees a caret.
 */
export function VersionPreview({ state }: { state: string }) {
  const [chunk, setChunk] = useState<EditorChunk | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let cancelled = false;
    loadEditor().then(
      (c) => !cancelled && setChunk(c),
      () => !cancelled && setFailed(true),
    );
    return () => {
      cancelled = true;
    };
  }, []);

  const doc = useMemo(() => {
    const d = new Y.Doc();
    Y.applyUpdate(d, stateBytes(state));
    return d;
  }, [state]);
  useEffect(() => () => doc.destroy(), [doc]);

  if (failed) return <p className="cl-history__message">The preview could not be loaded.</p>;
  if (!chunk) return <p className="cl-history__message">Loading...</p>;
  const Editor = chunk.Editor;
  return (
    <div className="cl-history__preview" data-testid="history-preview">
      <Editor key={state} doc={doc} user={PREVIEW_USER} editable={false} />
    </div>
  );
}
