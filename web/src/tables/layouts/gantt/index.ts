import { registerLayout } from '../registry';
import { GanttLayout } from './GanttLayout';
import { defaultColumns } from './model';

// A new gantt draws bars from the start-date column to the due-date column (or the first two date columns)
registerLayout(
  'gantt',
  GanttLayout,
  (schema) => {
    const columns = defaultColumns(schema);
    return columns ? { gantt: { ...columns, scale: 'week' as const } } : {};
  },
  'Gantt',
);

export { GanttLayout };
