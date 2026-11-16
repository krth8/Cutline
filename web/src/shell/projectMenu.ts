/** The actions of one project (share link, cover image, members, delete), as menu items. */
import { getPlatform } from '../platform';
import type { MenuItem } from '../ui';

export function projectMenuItems(project: { id: string; name: string }): MenuItem[] {
  const platform = getPlatform();
  const tools = platform.projectTools;
  const isAdmin = platform.user()?.role === 'admin';
  const items: MenuItem[] = [];
  if (tools?.canShare()) items.push({ id: 'share', label: 'Share link...', onSelect: () => tools.share(project.id) });
  if (tools) items.push({ id: 'cover', label: 'Set cover image...', onSelect: () => tools.setCover(project.id) });
  if (tools && isAdmin) items.push({ id: 'access', label: 'Access and members...', onSelect: () => tools.openAccess() });
  if (tools?.canDelete()) {
    items.push({ type: 'separator' }, { id: 'delete', label: 'Delete project...', danger: true, onSelect: () => tools.remove(project.id, project.name) });
  }
  return items;
}
