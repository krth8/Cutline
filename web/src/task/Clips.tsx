import { useEffect, useState } from 'react';
import { getPlatform } from '../platform';
import { navigate } from '../router';
import { Button, Dialog, Input } from '../ui';
import { getClips, getProjectClips, linkClip, unlinkClip, type LinkedClip, type ProjectClip } from './api';
import { useTaskPart } from './useTaskPart';

const versionLabel = (n: number) => `v${String(n).padStart(2, '0')}`;

/** Picker: every clip of the project with a checkbox; confirming links the new ones and unlinks the cleared ones. */
function ClipPicker({
  projectId,
  linked,
  onClose,
  onConfirm,
}: {
  projectId: string;
  linked: LinkedClip[];
  onClose: () => void;
  onConfirm: (toLink: number[], toUnlink: number[]) => void;
}) {
  const [clips, setClips] = useState<ProjectClip[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [filter, setFilter] = useState('');
  const [selected, setSelected] = useState(() => new Set(linked.map((c) => c.id)));

  useEffect(() => {
    let cancelled = false;
    getProjectClips(projectId).then(
      (list) => !cancelled && setClips(list),
      () => !cancelled && setFailed(true),
    );
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  const shown = (clips ?? []).filter((c) => !filter || c.baseName.toLowerCase().includes(filter.toLowerCase()));
  const toggle = (id: number) =>
    setSelected((set) => {
      const next = new Set(set);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  function confirm() {
    const before = new Set(linked.map((c) => c.id));
    onConfirm(
      [...selected].filter((id) => !before.has(id)),
      [...before].filter((id) => !selected.has(id)),
    );
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title="Link clips to task"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={confirm}>
            Done
          </Button>
        </>
      }
    >
      <Input placeholder="Search clips..." aria-label="Search clips" value={filter} onChange={(e) => setFilter(e.target.value)} />
      <ul className="cl-clippicker">
        {failed ? <li className="cl-task__empty">Could not load the clips</li> : null}
        {!failed && clips === null ? <li className="cl-task__empty">Loading...</li> : null}
        {clips && clips.length === 0 ? <li className="cl-task__empty">No clips available</li> : null}
        {clips && clips.length > 0 && shown.length === 0 ? <li className="cl-task__empty">No clips match your search</li> : null}
        {shown.map((c) => (
          <li key={c.clipId}>
            <label className="cl-clippicker__item">
              <input type="checkbox" checked={selected.has(c.clipId)} onChange={() => toggle(c.clipId)} />
              {c.thumbnail ? <img className="cl-clip__thumb" src={`/thumbnail/${c.thumbnail}`} alt="" /> : <span className="cl-clip__thumb" aria-hidden="true" />}
              <span className="cl-clip__name">{c.baseName}</span>
              <span className="cl-clip__version">
                {versionLabel(c.activeVersion)} &middot; {c.versions} version{c.versions === 1 ? '' : 's'}
              </span>
            </label>
          </li>
        ))}
      </ul>
    </Dialog>
  );
}

/** Clips linked to the task: open one in the review tab, unlink it, or link more. */
export function Clips({ taskId, projectId, canEdit }: { taskId: string; projectId: string; canEdit: boolean }) {
  const platform = getPlatform();
  const { items, setItems, reload } = useTaskPart<LinkedClip>(taskId, 'clips', getClips);
  const [picking, setPicking] = useState(false);

  async function unlink(clip: LinkedClip) {
    setItems((list) => list.filter((c) => c.id !== clip.id));
    try {
      await unlinkClip(taskId, clip.id);
    } catch {
      void reload();
      platform.toast('error', 'Failed to unlink clip');
    }
  }

  async function apply(toLink: number[], toUnlink: number[]) {
    setPicking(false);
    const results = await Promise.allSettled([...toLink.map((id) => linkClip(taskId, id)), ...toUnlink.map((id) => unlinkClip(taskId, id))]);
    if (results.some((r) => r.status === 'rejected')) platform.toast('error', 'Some clips could not be updated');
    await reload();
  }

  function open(clip: LinkedClip) {
    navigate({ kind: 'review', projectId, clip: clip.baseName, v: String(clip.activeVersion) });
  }

  return (
    <section className="cl-task__section" aria-label="Linked clips" data-testid="task-clips">
      <div className="cl-task__headrow">
        <h3 className="cl-task__heading">
          Linked clips <span className="cl-task__count">({items.length})</span>
        </h3>
        {canEdit ? (
          <button type="button" className="cl-task__link" onClick={() => setPicking(true)}>
            + Link clip
          </button>
        ) : null}
      </div>
      {items.length === 0 ? <div className="cl-task__empty">No clips linked</div> : null}
      <ul className="cl-clips">
        {items.map((clip) => (
          <li key={clip.id} className="cl-clip" data-clip-id={clip.id}>
            <button type="button" className="cl-clip__open" onClick={() => open(clip)} title="Open in the review tab">
              {clip.thumbnail ? <img className="cl-clip__thumb" src={`/thumbnail/${clip.thumbnail}`} alt="" /> : <span className="cl-clip__thumb" aria-hidden="true" />}
              <span className="cl-clip__name">{clip.baseName}</span>
              <span className="cl-clip__version">{versionLabel(clip.activeVersion)}</span>
            </button>
            {canEdit ? (
              <button type="button" className="cl-task__iconbtn" aria-label={`Unlink ${clip.baseName}`} title="Unlink" onClick={() => void unlink(clip)}>
                &times;
              </button>
            ) : null}
          </li>
        ))}
      </ul>
      {picking ? <ClipPicker projectId={projectId} linked={items} onClose={() => setPicking(false)} onConfirm={(a, b) => void apply(a, b)} /> : null}
    </section>
  );
}
