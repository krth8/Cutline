/** The actions of one project (all tasks, share link, cover image, members, delete), as menu items. */
import { getPlatform } from '../platform';
import { navigate } from '../router';
import type { MenuItem } from '../ui';

export function projectMenuItems(project: { id: string; name: string; canTasks?: boolean }): MenuItem[] {
  const platform = getPlatform();
  const tools = platform.projectTools;
  const isAdmin = platform.user()?.role === 'admin';
  const items: MenuItem[] = [];
  // Every task of the project in one table, full page (there is no fixed Tasks page to find them on)
  if (project.canTasks !== false) {
    items.push({ id: 'all-tasks', label: 'All tasks', onSelect: () => navigate({ kind: 'projectTasks', projectId: project.id }) });
    if (tools) items.push({ type: 'separator' });
  }
  if (tools?.canShare()) items.push({ id: 'share', label: 'Share link...', onSelect: () => tools.share(project.id) });
  if (tools) items.push({ id: 'cover', label: 'Set cover image...', onSelect: () => tools.setCover(project.id) });
  if (tools && isAdmin) items.push({ id: 'access', label: 'Access and members...', onSelect: () => tools.openAccess() });
  if (tools?.canDelete()) {
    items.push({ type: 'separator' }, { id: 'delete', label: 'Delete project...', danger: true, onSelect: () => tools.remove(project.id, project.name) });
  }
  return items;
}
