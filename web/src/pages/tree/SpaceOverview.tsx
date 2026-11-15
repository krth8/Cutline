import { useState, type MouseEvent, type ReactNode } from 'react';
import type { SpaceKey } from '../../api/pageTree';
import { buildRoute, navigate, type Route } from '../../router';
import { Button } from '../../ui';
import { ArchivedDialog } from './ArchivedList';
import { DocIcon } from './PageTree';
import { canEditSpace, createAndOpen, pageRoute, spaceName, usePageStore } from './space';
import '../PageView.css';

export type OverviewRoute = Extract<Route, { kind: 'me' | 'projectPages' }>;

function Card({ to, children }: { to: Route; children: ReactNode }) {
  const onClick = (e: MouseEvent<HTMLAnchorElement>) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    navigate(to);
  };
  return (
    <a href={buildRoute(to)} onClick={onClick} className="cl-overview__card">
      {children}
    </a>
  );
}

function countDescendants(node: { children: Array<{ children: unknown[] }> }): number {
  return node.children.reduce((n, c) => n + 1 + countDescendants(c as never), 0);
}

/** Route view for `me` and `projectPages`: the top-level pages of the space as cards. */
export function SpaceOverview({ route }: { route: OverviewRoute }) {
  const key: SpaceKey = route.kind === 'me' ? 'me' : `p:${route.projectId}`;
  const { snap } = usePageStore(key);
  const [archivedOpen, setArchivedOpen] = useState(false);
  const canEdit = canEditSpace(key);
  const roots = snap.model.roots;

  return (
    <section className="cl-overview" data-testid="space-overview">
      <div className="cl-overview__head">
        <h1 className="cl-overview__title">{spaceName(key)}</h1>
        <Button variant="ghost" size="sm" onClick={() => setArchivedOpen(true)}>
          Archived
        </Button>
        {canEdit ? (
          <Button variant="primary" onClick={() => void createAndOpen(key)}>
            New page
          </Button>
        ) : null}
      </div>
      {snap.status !== 'ready' && roots.length === 0 ? (
        <p className="cl-overview__empty" role="status">
          {snap.status === 'error' ? 'Could not load pages.' : 'Loading pages...'}
        </p>
      ) : roots.length === 0 ? (
        <div className="cl-overview__empty">
          <div>No pages yet.</div>
          {canEdit ? (
            <Button variant="primary" onClick={() => void createAndOpen(key)}>
              Create the first page
            </Button>
          ) : null}
        </div>
      ) : (
        <ul className="cl-overview__grid" aria-label="Pages">
          {roots.map((node) => {
            const subpages = countDescendants(node);
            return (
              <li key={node.page.id}>
                <Card to={pageRoute(key, node.page.id)}>
                  <span className="cl-overview__card-icon" aria-hidden="true">
                    {node.page.icon ?? <DocIcon />}
                  </span>
                  <span className="cl-overview__card-title">{node.page.title || 'Untitled'}</span>
                  <span className="cl-overview__card-meta">
                    {subpages === 0 ? 'No sub-pages' : subpages === 1 ? '1 sub-page' : `${subpages} sub-pages`}
                  </span>
                </Card>
              </li>
            );
          })}
        </ul>
      )}
      <ArchivedDialog space={key} open={archivedOpen} onClose={() => setArchivedOpen(false)} />
    </section>
  );
}
