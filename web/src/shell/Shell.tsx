import { useEffect, type ComponentType } from 'react';
import { getPlatform } from '../platform';
import { routeProjectId, useRoute, type Route } from '../router';
import { ActivityPanel } from './ActivityPanel';
import { tabOf } from './ProjectTabs';
import { useRouteView } from './registry';
import './shell.css';

function projectName(projectId: string): string {
  return getPlatform().projects().find((p) => p.id === projectId)?.name ?? 'Unknown project';
}

function Placeholder({ title, detail }: { title: string; detail?: string }) {
  return (
    <div className="cl-main__placeholder" data-testid="cl-placeholder">
      <h1 className="cl-main__title">{title}</h1>
      {detail ? <p className="cl-main__detail">{detail}</p> : null}
    </div>
  );
}

function placeholderFor(route: Route): { title: string; detail?: string } {
  switch (route.kind) {
    case 'home':
      return { title: 'Home', detail: 'Your pinned page or project list will show here.' };
    case 'me':
      return { title: 'Personal space', detail: 'Your private pages will show here.' };
    case 'mePage':
      return { title: 'Personal page', detail: route.pageId };
    case 'projectPages':
      return { title: `${projectName(route.projectId)}: Pages`, detail: 'The page tree of this project will show here.' };
    case 'projectPage':
      return { title: `${projectName(route.projectId)}: Page`, detail: route.pageId };
    case 'projectTasks':
      return { title: `${projectName(route.projectId)}: Tasks`, detail: 'Loading the tasks...' };
    case 'projectView':
    case 'meView':
      return { title: 'View', detail: route.viewId };
    case 'review':
      return { title: `${projectName(route.projectId)}: Review`, detail: 'Opening the review...' };
    case 'lounge':
      return { title: 'Lounge', detail: 'Opening the Lounge...' };
    case 'projects':
      return { title: 'Projects' };
    case 'notFound':
      return { title: 'Not found', detail: route.path };
  }
}

function MainView({ route }: { route: Route }) {
  const View = useRouteView(route.kind) as ComponentType<{ route: Route }> | undefined;
  if (View) return <View route={route} />;
  const { title, detail } = placeholderFor(route);
  return <Placeholder title={title} {...(detail ? { detail } : {})} />;
}

/** The routed content area. The sidebar is mounted separately (NavApp), so it also stays on legacy screens. */
export function Shell() {
  const route = useRoute();
  const user = getPlatform().user();
  // The Home tab has the activity panel on its right; the grid of projects and pages outside the tabs do not
  const hasPanel = !!user && tabOf(route) === 'main';
  useEffect(() => {
    const layout = document.getElementById('clLayout');
    if (layout) layout.dataset.homePanel = hasPanel ? '1' : '0';
  }, [hasPanel]);
  // How much room a page has for wide blocks: the content area without its padding (editor.css, --cl-avail)
  const userId = user?.id;
  useEffect(() => {
    const main = document.getElementById('cl-main');
    if (!main || typeof ResizeObserver === 'undefined') return;
    const measure = () => {
      const style = getComputedStyle(main);
      const room = main.clientWidth - parseFloat(style.paddingLeft || '0') - parseFloat(style.paddingRight || '0');
      main.style.setProperty('--cl-avail', `${Math.max(0, Math.floor(room))}px`);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(main);
    return () => observer.disconnect();
  }, [userId]);
  if (!user) {
    return (
      <div className="cl-shell" data-testid="cl-shell">
        <main className="cl-main">
          <Placeholder title="Not signed in" detail="Sign in to use Pages." />
        </main>
      </div>
    );
  }
  return (
    <div className="cl-shell" data-testid="cl-shell">
      <main className="cl-main" id="cl-main" tabIndex={-1}>
        <MainView route={route} />
      </main>
      {hasPanel ? <ActivityPanel projectId={routeProjectId(route)} /> : null}
    </div>
  );
}
