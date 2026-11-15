/**
 * Plugs the page tree into the shell: the sidebar section and the route views for
 * the personal space, the project pages and single pages. Imported once at start-up.
 */
import { registerRouteView, registerSidebarSection } from '../../shell/registry';
import { PageView } from '../PageView';
import { PageTree } from './PageTree';
import { SpaceOverview } from './SpaceOverview';

export function registerPageTree(): () => void {
  const offs = [
    registerSidebarSection('page-tree', PageTree),
    registerRouteView('me', SpaceOverview),
    registerRouteView('projectPages', SpaceOverview),
    registerRouteView('mePage', PageView),
    registerRouteView('projectPage', PageView),
  ];
  return () => offs.forEach((off) => off());
}

registerPageTree();
