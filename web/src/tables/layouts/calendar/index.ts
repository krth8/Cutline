import type { View } from '../../types';
import { registerLayout } from '../registry';
import { CalendarLayout } from './CalendarLayout';
import { defaultDateColumn } from './model';

// A new calendar sits on the table's first (editable) date column, in month mode
registerLayout(
  'calendar',
  CalendarLayout,
  (schema) => ({ calendar: { dateColumn: defaultDateColumn(schema)?.key ?? '', mode: 'month' } as NonNullable<View['config']['calendar']> }),
  'Calendar',
);

export { CalendarLayout };
