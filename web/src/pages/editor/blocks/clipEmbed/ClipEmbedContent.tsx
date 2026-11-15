import { useState, type MouseEvent } from 'react';
import { getPlatform } from '../../../../platform';
import { Button } from '../../../../ui';
import { ClipPicker } from './ClipPicker';
import { takeFreshClipBlock } from './freshInsert';
import { frameLabel, hasClip, reviewLink, thumbnailSrc, versionLabel, type ClipEmbedAttrs, type ClipSummary } from './model';
import { useClipInfo } from './useClipInfo';
import './clipEmbed.css';

export interface ClipEmbedContentProps {
  attrs: ClipEmbedAttrs;
  /** The editor accepts changes: the block can be given another clip or removed. */
  editable: boolean;
  /** The page the block is on (the picker lists that page's project first). */
  pageId: string | null;
  setAttrs(attrs: Partial<ClipEmbedAttrs>): void;
  removeBlock(): void;
}

/** The inside of a clip block: a card for the clip, or the state that stands in for it. */
export function ClipEmbedContent({ attrs, editable, pageId, setAttrs, removeBlock }: ClipEmbedContentProps) {
  const named = hasClip(attrs);
  const info = useClipInfo(named ? attrs.projectId : null, named ? attrs.baseName : null, attrs.version);
  // A block this browser has just inserted asks for its clip at once
  const [picking, setPicking] = useState(() => !named && editable && takeFreshClipBlock());

  const state = !named ? 'empty' : info.state;
  let body;
  if (!named) {
    body = (
      <div className="cl-clipembed__state" data-testid="clip-embed-empty">
        <p>{editable ? 'No clip chosen yet.' : 'No clip.'}</p>
        {editable && (
          <Button size="sm" onClick={() => setPicking(true)} data-testid="clip-embed-pick">
            Pick a clip
          </Button>
        )}
      </div>
    );
  } else if (info.state === 'loading') {
    body = (
      <div className="cl-clipembed__state" data-testid="clip-embed-loading">
        <p>Loading the clip...</p>
      </div>
    );
  } else if (info.state === 'denied') {
    // Says nothing about the clip: not its name, not its project
    body = (
      <div className="cl-clipembed__state" data-testid="clip-embed-denied">
        <p>You don&apos;t have access to this clip.</p>
      </div>
    );
  } else if (info.state === 'gone') {
    body = (
      <div className="cl-clipembed__state" data-testid="clip-embed-gone">
        <p>This clip was deleted.</p>
        {editable && (
          <Button size="sm" onClick={removeBlock} data-testid="clip-embed-remove-gone">
            Remove block
          </Button>
        )}
      </div>
    );
  } else if (info.state === 'error') {
    body = (
      <div className="cl-clipembed__state" data-testid="clip-embed-error">
        <p>Could not load this clip.</p>
        <Button size="sm" onClick={info.retry}>
          Try again
        </Button>
      </div>
    );
  } else {
    body = (
      <ClipCard
        clip={info.clip}
        attrs={attrs}
        editable={editable}
        onChange={() => setPicking(true)}
        onRemove={removeBlock}
      />
    );
  }

  return (
    <div
      className="cl-clipembed"
      data-testid="clip-embed"
      data-state={state}
      data-project-id={attrs.projectId ?? ''}
      data-clip={attrs.baseName ?? ''}
    >
      {body}
      {editable && (
        <ClipPicker
          open={picking}
          pageId={pageId}
          onClose={() => setPicking(false)}
          onPick={(c) => {
            setPicking(false);
            // A new choice starts without the version of the old one
            setAttrs({ projectId: c.projectId, baseName: c.baseName, frame: c.frame, version: null });
          }}
        />
      )}
    </div>
  );
}

function ClipCard({
  clip,
  attrs,
  editable,
  onChange,
  onRemove,
}: {
  clip: ClipSummary;
  attrs: ClipEmbedAttrs;
  editable: boolean;
  onChange(): void;
  onRemove(): void;
}) {
  const href = reviewLink(attrs);
  const open = (e: MouseEvent<HTMLAnchorElement>) => {
    // Let the browser handle new-tab clicks; a plain click stays in the app
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    getPlatform().navigate(href);
  };
  const frame = frameLabel(attrs.frame);
  return (
    <div className="cl-clipembed__card">
      <a className="cl-clipembed__link" href={href} onClick={open} data-testid="clip-embed-open" title="Open in review">
        <span className="cl-clipembed__thumb">
          {clip.thumbnail ? <img src={thumbnailSrc(clip.thumbnail)} alt="" data-testid="clip-embed-thumb" /> : <span aria-hidden="true">▶</span>}
        </span>
        <span className="cl-clipembed__info">
          <span className="cl-clipembed__name" data-testid="clip-embed-name">
            {clip.baseName}
          </span>
          <span className="cl-clipembed__meta">
            <span data-testid="clip-embed-version">{versionLabel(clip)}</span>
            {frame && <span data-testid="clip-embed-frame">{frame}</span>}
            <span data-testid="clip-embed-comments">
              {clip.commentCount} {clip.commentCount === 1 ? 'comment' : 'comments'}
            </span>
          </span>
          {clip.status ? (
            <span className="cl-clipembed__status" data-testid="clip-embed-status" style={{ ['--cl-status' as string]: clip.status.color }}>
              {clip.status.name}
            </span>
          ) : (
            <span className="cl-clipembed__status cl-clipembed__status--none" data-testid="clip-embed-status">
              No status
            </span>
          )}
        </span>
      </a>
      {editable && (
        <span className="cl-clipembed__actions">
          <Button size="sm" variant="ghost" onClick={onChange} data-testid="clip-embed-change">
            Change
          </Button>
          <Button size="sm" variant="ghost" onClick={onRemove} data-testid="clip-embed-remove">
            Remove
          </Button>
        </span>
      )}
    </div>
  );
}
