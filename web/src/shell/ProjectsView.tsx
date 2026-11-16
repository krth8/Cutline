/** The Projects grid: every project as a card with its cover. Choosing one opens its Review. */
import { useEffect, useState } from 'react';
import { getPlatform } from '../platform';
import { buildRoute, navigate, type Route } from '../router';
import './projectsView.css';

export function ProjectsView() {
  const platform = getPlatform();
  const [, setVersion] = useState(0);
  // The list is refreshed by the legacy page after create / delete / access changes
  useEffect(() => platform.onProjectsChanged?.(() => setVersion((v) => v + 1)), [platform]);
  const projects = platform.projects();
  const tools = platform.projectTools;
  const canCreate = !!tools?.canCreate();

  return (
    <div className="cl-projects" data-testid="projects-grid">
      <h1 className="cl-projects__title">Projects</h1>
      {projects.length === 0 && !canCreate ? <p className="cl-projects__empty">You have no projects yet. Ask an admin to give you access to one.</p> : null}
      <ul className="cl-projects__grid">
        {projects.map((p) => {
          const to: Route = { kind: 'review', projectId: p.id };
          return (
            <li key={p.id}>
              <a
                href={buildRoute(to)}
                className="cl-projects__card"
                data-testid="project-card"
                data-project-id={p.id}
                onClick={(e) => {
                  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
                  e.preventDefault();
                  navigate(to);
                }}
              >
                <span className="cl-projects__cover" style={p.coverImage ? { backgroundImage: `url("${encodeURI(p.coverImage)}")` } : undefined}>
                  {p.coverImage ? null : <span aria-hidden="true">{p.name.trim().charAt(0).toUpperCase() || '?'}</span>}
                </span>
                <span className="cl-projects__name">{p.name}</span>
                <span className="cl-projects__meta">
                  {typeof p.clipCount === 'number' ? `${p.clipCount} ${p.clipCount === 1 ? 'clip' : 'clips'}` : ' '}
                </span>
              </a>
            </li>
          );
        })}
        {canCreate ? (
          <li>
            <button type="button" className="cl-projects__card cl-projects__card--new" data-testid="projects-new" onClick={() => tools?.create()}>
              <span className="cl-projects__cover">
                <span aria-hidden="true">+</span>
              </span>
              <span className="cl-projects__name">New project</span>
              <span className="cl-projects__meta">&nbsp;</span>
            </button>
          </li>
        ) : null}
      </ul>
    </div>
  );
}
