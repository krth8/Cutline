/** Where the palette sends the user for an item or a task, given where they are. */
import { getPlatform } from '../platform';
import { buildRoute, parseRoute, withTaskParam } from '../router';
import type { SearchItem } from './api';

/** True while the Pages shell is on screen. Only then does `?task=` open the task panel on the current route. */
export function shellIsMounted(): boolean {
  return document.querySelector('.cl-shell') !== null;
}

/** The address that shows a task in its panel: over the current route when the shell is there, else over the
 *  project's Tasks view. */
export function taskAddress(taskId: string, projectId: string | null): string {
  const here = window.location.pathname + window.location.search;
  const route = parseRoute(here);
  if (shellIsMounted() && route.kind !== 'review' && route.kind !== 'notFound') return withTaskParam(here, taskId);
  return buildRoute({ kind: 'projectTasks', projectId: projectId ?? '', task: taskId });
}

/** Open a search result. */
export function openItem(item: SearchItem): void {
  const platform = getPlatform();
  if (item.type === 'task') platform.navigate(taskAddress(item.id, item.projectId ?? null));
  else platform.navigate(item.route);
}

/** Open a task by id (from a command). */
export function openTaskById(taskId: string, projectId: string): void {
  getPlatform().navigate(taskAddress(taskId, projectId));
}
