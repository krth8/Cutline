import { registerLayout } from '../registry';
import { TableLayout } from './TableLayout';

registerLayout('table', TableLayout, {}, 'Table');

export { TableLayout };
export { readTableConfig, type TableConfig } from './grid';
