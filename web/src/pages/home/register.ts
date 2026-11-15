/** Plugs the Home view into the shell. Imported once at start-up (src/index.ts). */
import { registerRouteView } from '../../shell/registry';
import { HomeView } from './HomeView';

export function registerHome(): () => void {
  return registerRouteView('home', HomeView);
}

registerHome();
