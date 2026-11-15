// Entry of the view side of the tables: the shell, the layout registry and the REST view source.
import './layouts';
import { setViewSource } from './store';
import { createRestViewSource } from './restViewSource';

export { ViewShell } from './ViewShell';
export { DevView } from './DevView';
export { createRestViewSource } from './restViewSource';
export { registerLayout, getLayout, listLayouts, type LayoutEntry, type LayoutDefaults } from './layouts';
export { orderedColumns, visibleColumns } from './viewColumns';

/** Make views load from and save to /api/views. Called once at bundle start-up. */
export function installViewSource(): void {
  setViewSource(createRestViewSource());
}
