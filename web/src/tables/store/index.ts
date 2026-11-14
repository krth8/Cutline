export { useTableSchema, useViewQuery, useView, toLayoutProps, type ViewQueryData } from './hooks';
export {
  createMemoryViewSource,
  getViewSource,
  setViewSource,
  type MemoryViewSource,
  type ViewDescriptor,
  type ViewPatch,
  type ViewSource,
} from './viewSource';
export { STORE_CONFIG, type QueryState, type SchemaState } from './registry';
export { StoreDemo } from './StoreDemo';

import { resetMutations } from './mutations';
import { resetTableStores } from './registry';

/** Drop all caches, timers and subscriptions (tests). */
export function resetStores(): void {
  resetTableStores();
  resetMutations();
}
