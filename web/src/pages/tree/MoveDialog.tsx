import { useEffect, useMemo, useState } from 'react';
import { getMovePreview, type MovePreview, type PageInfo, type SpaceKey } from '../../api/pageTree';
import { getPlatform } from '../../platform';
import { Button, Dialog } from '../../ui';
import { moveWarning } from './moveWarning';
import { spaceName } from './space';
import { getPageStore } from './pageStore';
import { subtreeIds } from './treeModel';
import './tree.css';

/** Spaces the user may create pages in, other than `from`: the personal space and projects with task access. */
export function moveDestinations(from: SpaceKey): Array<{ key: SpaceKey; name: string }> {
  const platform = getPlatform();
  const user = platform.user();
  const list: Array<{ key: SpaceKey; name: string }> = [];
  if (from !== 'me') list.push({ key: 'me', name: spaceName('me') });
  if (user && user.role !== 'viewer') {
    for (const p of platform.projects()) {
      if (p.canTasks && `p:${p.id}` !== from) list.push({ key: `p:${p.id}`, name: p.name });
    }
  }
  return list;
}

export interface MoveDialogProps {
  open: boolean;
  onClose: () => void;
  /** The space the page is in now. */
  from: SpaceKey;
  pageId: string;
  title: string;
  /** Pre-selected destination (a page dropped on another space's tree). */
  initialDestination?: SpaceKey;
  /** Called after the server moved the page. */
  /** `movedIds`: the page and its sub-pages, as they were in the tree before the move. */
  onMoved?: (info: PageInfo, destination: SpaceKey, movedIds: string[]) => void;
}

/** "Move to...": pick a space, read who gains and loses access, confirm. */
export function MoveDialog({ open, onClose, from, pageId, title, initialDestination, onMoved }: MoveDialogProps) {
  const destinations = useMemo(() => (open ? moveDestinations(from) : []), [open, from]);
  const [destination, setDestination] = useState<SpaceKey | null>(null);
  const [preview, setPreview] = useState<MovePreview | 'loading' | 'error' | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    const wanted = initialDestination && destinations.some((d) => d.key === initialDestination) ? initialDestination : null;
    setDestination(wanted ?? (destinations.length === 1 ? destinations[0]!.key : null));
    setBusy(false);
  }, [open, initialDestination, destinations]);

  useEffect(() => {
    setPreview(null);
    if (!open || !destination) return;
    let stale = false;
    setPreview('loading');
    getMovePreview(pageId, destination).then(
      (p) => !stale && setPreview(p),
      () => !stale && setPreview('error'),
    );
    return () => {
      stale = true;
    };
  }, [open, destination, pageId]);

  const lines =
    destination && preview && typeof preview === 'object'
      ? moveWarning({
          preview,
          destinationName: spaceName(destination),
          sourceName: spaceName(from),
          destinationIsPersonal: destination === 'me',
          sourceIsPersonal: from === 'me',
        })
      : [];

  async function confirm() {
    if (!destination || busy) return;
    setBusy(true);
    const store = getPageStore(from);
    const known = subtreeIds(store.snapshot().model, pageId);
    const movedIds = known.length ? known : [pageId];
    const info = await store.moveToSpace(pageId, destination);
    setBusy(false);
    if (info) {
      onClose();
      onMoved?.(info, destination, movedIds);
    }
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={`Move "${title || 'Untitled'}"`}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!destination || typeof preview !== 'object' || preview === null || busy} onClick={() => void confirm()}>
            Move page
          </Button>
        </>
      }
    >
      <div className="cl-move">
        {destinations.length === 0 ? (
          <p className="cl-move__note">There is no other space you can move this page to.</p>
        ) : (
          <fieldset className="cl-move__choices">
            <legend className="cl-move__legend">Move to</legend>
            {destinations.map((d) => (
              <label key={d.key} className="cl-move__choice">
                <input type="radio" name="cl-move-destination" checked={destination === d.key} onChange={() => setDestination(d.key)} />
                <span>{d.name}</span>
              </label>
            ))}
          </fieldset>
        )}
        {preview === 'loading' ? <p className="cl-move__note">Checking who can see it...</p> : null}
        {preview === 'error' ? (
          <p className="cl-move__note" role="alert">
            Could not check the access change. You cannot move the page to this space.
          </p>
        ) : null}
        {lines.length ? (
          <div className="cl-move__warning" role="status" data-testid="move-warning">
            {lines.map((line) => (
              <p key={line}>{line}</p>
            ))}
          </div>
        ) : null}
      </div>
    </Dialog>
  );
}
