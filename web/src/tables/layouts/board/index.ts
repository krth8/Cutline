import { registerLayout } from '../registry';
import { BoardLayout } from './BoardLayout';
import { defaultGroupBy } from './model';

// A new board splits by the status column when the table has one (the layout also copies that choice
// into the query's groupBy when the view has none, because the lanes come from the query's groups)
registerLayout('board', BoardLayout, (schema) => ({ board: { groupBy: defaultGroupBy(schema) ?? '', cardColumns: [] } }));

export { BoardLayout };
