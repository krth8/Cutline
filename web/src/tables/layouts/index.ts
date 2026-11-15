/**
 * Importing this file registers every built-in layout. Each layout work package adds one line here
 * (its own `layouts/<name>/index.ts` calls `registerLayout`).
 */
import './board';
import './calendar';
import './gantt';
import './list';
import './table';

export {
  registerLayout,
  getLayout,
  listLayouts,
  useLayouts,
  layoutDefaults,
  type LayoutEntry,
  type LayoutDefaults,
} from './registry';
