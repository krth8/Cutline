import { registerLayout } from '../registry';
import { ListLayout } from './ListLayout';

registerLayout('list', ListLayout, { list: { secondaryColumns: [] } }, 'List');

export { ListLayout };
