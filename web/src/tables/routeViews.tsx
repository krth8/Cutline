/**
 * The full-page routes of views, plugged into the shell:
 *   /p/<projectId>/view/<viewId> and /me/view/<viewId>   one view, full page
 *   /p/<projectId>/tasks                                 the project's Tasks view (the Tasks tab)
 */
import { useEffect, useState } from 'react';
import { getPlatform } from '../platform';
import { listPages } from '../api/pageTree';
import { requestJson } from '../api/http';
import { createView } from '../api/views';
import { navigate } from '../router';
import { registerRouteView, type RouteViewProps } from '../shell/registry';
import { ViewShell } from './ViewShell';
import './toolbar/toolbar.css';

/** One view, full page, inside the shell. */
export function ViewPage({ viewId }: { viewId: string }) {
  return (
    <div className="cl-viewpage" data-testid="view-page">
      <ViewShell viewId={viewId} />
    </div>
  );
}

const ALL_TASKS = 'All tasks';

type TasksState =
  | { status: 'loading' }
  | { status: 'ready'; viewId: string; pageId: string }
  | { status: 'denied' }
  | { status: 'missing' }
  | { status: 'error'; message: string };

/** The project's "All tasks" view. It is owned by the dashboard page (older projects: by their Tasks page). */
async function findTasksView(projectId: string): Promise<{ viewId: string; pageId: string } | null> {
  const pages = await listPages(`p:${projectId}`);
  const page = pages.find((p) => p.system === 'dashboard') ?? pages.find((p) => p.system === 'tasks');
  if (!page) return null;
  const { views } = await requestJson<{ views: Array<{ id: string; name?: string; layout?: string }> }>('GET', `/api/views?ownerPageId=${encodeURIComponent(page.id)}`);
  // On the dashboard it is the one called "All tasks"; on an old Tasks page the oldest (the list is newest first)
  const first = views.find((v) => v.name === ALL_TASKS) ?? (page.system === 'tasks' ? views[views.length - 1] : undefined);
  if (first) return { viewId: first.id, pageId: page.id };
  // The block was removed from the page and took its view along: make a plain nested table again
  const made = await createView({
    tableRef: `tasks:${projectId}`,
    name: ALL_TASKS,
    layout: 'table',
    config: { query: { parentId: null } },
    ownerPageId: page.id,
  });
  return { viewId: made.id, pageId: page.id };
}

/** The Tasks tab: the project's Tasks view full page, with a link to the Tasks page it lives on. */
export function TasksTab({ projectId }: { projectId: string }) {
  const project = getPlatform()
    .projects()
    .find((p) => p.id === projectId);
  const allowed = !!project && project.canTasks;
  const [state, setState] = useState<TasksState>({ status: 'loading' });

  useEffect(() => {
    if (!allowed) return;
    let cancelled = false;
    setState({ status: 'loading' });
    findTasksView(projectId).then(
      (found) => {
        if (!cancelled) setState(found ? { status: 'ready', ...found } : { status: 'missing' });
      },
      (e: unknown) => {
        if (cancelled) return;
        const status = (e as { status?: number })?.status;
        setState(status === 403 ? { status: 'denied' } : { status: 'error', message: e instanceof Error ? e.message : 'Could not load the tasks' });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [projectId, allowed]);

  if (!allowed || state.status === 'denied') {
    return (
      <div className="cl-viewpage" data-testid="tasks-denied">
        <p className="cl-viewshell__state">You do not have access to the tasks of this project.</p>
      </div>
    );
  }
  if (state.status === 'loading') return <div className="cl-viewpage"><p className="cl-viewshell__state">Loading...</p></div>;
  if (state.status !== 'ready') {
    return (
      <div className="cl-viewpage" data-testid="tasks-error">
        <p className="cl-viewshell__state cl-viewshell__state--error" role="alert">
          {state.status === 'missing' ? 'This project has no dashboard yet.' : state.message}
        </p>
      </div>
    );
  }
  return (
    <div className="cl-viewpage" data-testid="tasks-tab">
      <ViewShell
        viewId={state.viewId}
        menuItems={[
          {
            id: 'open-page',
            label: 'Open the dashboard',
            testId: 'tasks-open-page',
            onSelect: () => navigate({ kind: 'projectPages', projectId }),
          },
        ]}
      />
    </div>
  );
}

export function registerViewRoutes(): () => void {
  const offs = [
    registerRouteView('projectView', ({ route }: RouteViewProps<'projectView'>) => <ViewPage key={route.viewId} viewId={route.viewId} />),
    registerRouteView('meView', ({ route }: RouteViewProps<'meView'>) => <ViewPage key={route.viewId} viewId={route.viewId} />),
    registerRouteView('projectTasks', ({ route }: RouteViewProps<'projectTasks'>) => <TasksTab key={route.projectId} projectId={route.projectId} />),
  ];
  return () => offs.forEach((off) => off());
}

registerViewRoutes();
