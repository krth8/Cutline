export { useTableSchema, useViewQuery, useView, useRow, toLayoutProps, type ViewQueryData, type RowState } from './hooks';
export {
  createMemoryViewSource,
  getViewSource,
  setViewSource,
  type MemoryViewSource,
  type ViewDescriptor,
  type ViewPatch,
  type ViewSource,
} from './viewSource';
export { projectsForCreate, updateRow, deleteRows } from './mutations';
export { STORE_CONFIG, type QueryState, type SchemaState } from './registry';
export { StoreDemo } from './StoreDemo';

import { resetMutations } from './mutations';
import { resetTableStores } from './registry';

/** Drop all caches, timers and subscriptions (tests). */
export function resetStores(): void {
  resetTableStores();
  resetMutations();
}
