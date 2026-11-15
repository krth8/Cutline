/**
 * Importing this file registers every built-in layout. Each layout work package adds one line here
 * (its own `layouts/<name>/index.ts` calls `registerLayout`).
 */
import { registerLayout } from './registry';
import { FallbackLayout } from './fallback/FallbackLayout';
import './board';

// Placeholder for the real table layout (T6 registers 'table' again and removes this line)
registerLayout('table', FallbackLayout);

export {
  registerLayout,
  getLayout,
  listLayouts,
  useLayouts,
  layoutDefaults,
  type LayoutEntry,
  type LayoutDefaults,
} from './registry';
