/**
 * The look of a mention in the text: an icon and the current name of the target, a link when the reader may
 * open it. Runs in the main bundle (the node in the editor chunk renders it through host.ts).
 */
import { useEffect, useState, type MouseEvent } from 'react';
import { cx } from '../../../../ui';
import { hrefOf, openHref } from './link';
import { defaultLabel, kindIcon, type MentionKind, type ResolvedMention } from './model';
import { cachedMention, resolveMention } from './resolve';
import './mention.css';

export interface MentionChipProps {
  kind: MentionKind;
  id: string;
  /** The name stored in the document: shown until the target is resolved and when it cannot be. */
  label: string;
}

function useResolved(kind: MentionKind, id: string): ResolvedMention | null {
  const [resolved, setResolved] = useState<ResolvedMention | null>(() => cachedMention(kind, id));
  useEffect(() => {
    let live = true;
    setResolved(cachedMention(kind, id));
    void resolveMention(kind, id).then((value) => {
      if (live && value) setResolved(value);
    });
    return () => {
      live = false;
    };
  }, [kind, id]);
  return resolved;
}

export function MentionChip({ kind, id, label }: MentionChipProps) {
  const resolved = useResolved(kind, id);
  const denied = resolved !== null && !resolved.ok;
  const name = (resolved?.ok ? resolved.title : null) || label || defaultLabel(kind);
  const href = hrefOf(resolved);
  const state = denied ? 'denied' : resolved ? 'ready' : 'loading';
  const className = cx('cl-mention', `cl-mention--${kind}`, denied && 'is-denied', href && 'is-link');
  const body = (
    <>
      <span className="cl-mention__icon" aria-hidden="true">
        {kindIcon(kind, resolved?.ok ? resolved.icon : null)}
      </span>
      <span className="cl-mention__label">{name}</span>
      {denied ? <span className="cl-mention__note">No access</span> : null}
    </>
  );
  const common = { 'data-testid': 'mention-chip', 'data-kind': kind, 'data-id': id, 'data-state': state };

  if (href) {
    const onClick = (e: MouseEvent<HTMLAnchorElement>) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      e.preventDefault();
      openHref(href);
    };
    return (
      <a {...common} className={className} href={href} onClick={onClick}>
        {body}
      </a>
    );
  }
  const title = denied ? 'No access' : kind === 'person' ? 'Person' : undefined;
  return (
    <span {...common} className={className} title={title}>
      {body}
    </span>
  );
}
