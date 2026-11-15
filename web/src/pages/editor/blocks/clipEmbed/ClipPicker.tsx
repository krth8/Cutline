import { useEffect, useState } from 'react';
import { Button, Dialog } from '../../../../ui';
import { loadPickerProjects, type PickerProject } from './clipApi';
import { cleanCount, thumbnailSrc, versionLabel, type ClipSummary } from './model';

export interface PickedClip {
  projectId: string;
  baseName: string;
  frame: number | null;
}

/** Does a clip or its project match what was typed in the search box? */
export function matchesSearch(project: Pick<PickerProject, 'name'>, clip: Pick<ClipSummary, 'baseName'>, search: string): boolean {
  const q = search.trim().toLowerCase();
  if (!q) return true;
  return clip.baseName.toLowerCase().includes(q) || project.name.toLowerCase().includes(q);
}

/**
 * A dialog listing the clips the user may review: the page's project first, then the others, with thumbnails
 * and a search box. An optional frame number makes the card open the review at that frame.
 */
export function ClipPicker({
  open,
  pageId,
  onClose,
  onPick,
}: {
  open: boolean;
  pageId: string | null;
  onClose(): void;
  onPick(clip: PickedClip): void;
}) {
  const [projects, setProjects] = useState<PickerProject[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [search, setSearch] = useState('');
  const [frame, setFrame] = useState('');

  useEffect(() => {
    if (!open) return undefined;
    let cancelled = false;
    setProjects(null);
    setFailed(false);
    setSearch('');
    setFrame('');
    loadPickerProjects(pageId).then(
      (p) => !cancelled && setProjects(p),
      () => !cancelled && setFailed(true),
    );
    return () => {
      cancelled = true;
    };
  }, [open, pageId]);

  const groups = (projects ?? [])
    .map((p) => ({ project: p, clips: p.clips.filter((c) => matchesSearch(p, c, search)) }))
    .filter((g) => g.clips.length > 0);
  const frameNumber = cleanCount(frame.trim());
  const frameInvalid = frame.trim() !== '' && frameNumber === null;

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Pick a clip"
      className="cl-clippicker"
      footer={
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
      }
    >
      <div className="cl-clippicker__fields">
        <input
          className="cl-clippicker__search"
          type="search"
          placeholder="Search clips"
          aria-label="Search clips"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <input
          className="cl-clippicker__frame"
          type="text"
          inputMode="numeric"
          placeholder="Frame"
          aria-label="Open at frame (optional)"
          aria-invalid={frameInvalid || undefined}
          value={frame}
          onChange={(e) => setFrame(e.target.value)}
        />
      </div>
      {failed ? (
        <p className="cl-clippicker__state">Could not load the clips.</p>
      ) : !projects ? (
        <p className="cl-clippicker__state">Loading...</p>
      ) : groups.length === 0 ? (
        <p className="cl-clippicker__state">{projects.length ? 'No clip matches.' : 'There are no clips you can review yet.'}</p>
      ) : (
        <div className="cl-clippicker__groups" data-testid="clip-picker-list">
          {groups.map(({ project, clips }) => (
            <section key={project.id} className="cl-clippicker__group" data-project-id={project.id}>
              <h4 className="cl-clippicker__project">{project.name}</h4>
              <ul className="cl-clippicker__list">
                {clips.map((c) => (
                  <li key={c.baseName}>
                    <button
                      type="button"
                      className="cl-clippicker__item"
                      data-clip={c.baseName}
                      disabled={frameInvalid}
                      onClick={() => onPick({ projectId: project.id, baseName: c.baseName, frame: frameNumber })}
                    >
                      <span className="cl-clippicker__thumb">
                        {c.thumbnail ? <img src={thumbnailSrc(c.thumbnail)} alt="" loading="lazy" /> : <span aria-hidden="true">▶</span>}
                      </span>
                      <span className="cl-clippicker__name">{c.baseName}</span>
                      <span className="cl-clippicker__meta">{versionLabel(c)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
    </Dialog>
  );
}
