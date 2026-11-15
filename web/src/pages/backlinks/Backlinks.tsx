/**
 * "Mentioned in N pages": a collapsed list of the pages that mention a task, page, clip or person.
 * Shows nothing while there are none. Use it at the bottom of the page view and in the task panel:
 * `<Backlinks kind="task" id={task.id} />`.
 */
import { useEffect, useState, type MouseEvent } from 'react';
import { getPlatform } from '../../platform';
import { cx } from '../../ui';
import { getBacklinks, type Backlink, type BacklinkKind } from './api';
import './backlinks.css';

export interface BacklinksProps {
  kind: BacklinkKind;
  id: string;
  /** Start expanded (default: collapsed). */
  defaultOpen?: boolean;
  className?: string;
}

export function Backlinks({ kind, id, defaultOpen = false, className }: BacklinksProps) {
  const [pages, setPages] = useState<Backlink[]>([]);
  const [open, setOpen] = useState(defaultOpen);

  useEffect(() => {
    let live = true;
    const load = () => {
      getBacklinks(kind, id).then(
        (found) => live && setPages(found),
        () => live && setPages([]),
      );
    };
    setPages([]);
    load();
    // After a reconnect the list may be out of date
    const off = getPlatform().live.on('resync', load);
    return () => {
      live = false;
      off();
    };
  }, [kind, id]);

  if (pages.length === 0) return null;
  const go = (route: string) => (e: MouseEvent<HTMLAnchorElement>) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    getPlatform().navigate(route);
  };
  return (
    <section className={cx('cl-backlinks', className)} data-testid="backlinks" aria-label="Mentioned in">
      <button type="button" className="cl-backlinks__toggle" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <span className="cl-backlinks__caret" aria-hidden="true">
          {open ? '▾' : '▸'}
        </span>
        Mentioned in {pages.length} {pages.length === 1 ? 'page' : 'pages'}
      </button>
      {open ? (
        <ul className="cl-backlinks__list">
          {pages.map((p) => (
            <li key={p.id}>
              <a className="cl-backlinks__link" href={p.route} onClick={go(p.route)} data-page-id={p.id}>
                <span aria-hidden="true">{p.icon || '\u{1F4C4}'}</span> {p.title || 'Untitled'}
              </a>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
