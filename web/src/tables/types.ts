// Table API types, copied from PLAN.md section 5.6. Everything that talks about
// tables, views and layouts imports them from here.

export type ColumnType =
  | 'text' | 'longtext' | 'number' | 'checkbox' | 'date' | 'select' | 'multiselect'
  | 'status' | 'priority' | 'person' | 'people' | 'url' | 'clip' | 'relation' | 'formula';

export interface Column {
  key: string; // 'name', 'status', 'assignees', 'dueDate', 'cf_ab12' ...
  name: string;
  type: ColumnType;
  builtin: boolean; // builtin columns cannot be deleted or retyped
  readonly?: boolean;
  options?: Array<{ value: string; label: string; color?: string }>; // select-like types
  config?: Record<string, unknown>;
}

export interface TableSchema {
  ref: string; // 'tasks:<projectId>' | 'tasks:*' | 'tbl_<id>'
  name: string;
  columns: Column[];
  titleColumn: string; // 'name' for tasks
  capabilities: { create: boolean; delete: boolean; hierarchy: boolean; editSchema: boolean };
}

export interface Row {
  id: string;
  tableRef: string; // concrete table of this row ('tasks:<projectId>')
  parentId?: string | null;
  childCount?: number;
  values: Record<string, unknown>; // by column key
  canEdit: boolean;
}

export type FilterOp =
  | 'eq' | 'neq' | 'in' | 'nin' | 'contains' | 'empty' | 'notEmpty' | 'lt' | 'lte' | 'gt' | 'gte'
  | 'before' | 'after' | 'between' | 'relative'; // relative: {unit:'day'|'week'|'month', from:-7, to:0}

export type Filter =
  | { column: string; op: FilterOp; value?: unknown }
  | { and: Filter[] }
  | { or: Filter[] };

export interface Query {
  filter?: Filter;
  sort?: Array<{ column: string; dir: 'asc' | 'desc' }>;
  groupBy?: string; // column key
  summaries?: Record<
    string,
    'count' | 'countEmpty' | 'countFilled' | 'sum' | 'avg' | 'min' | 'max' | 'percentChecked'
  >;
  parentId?: string | null; // hierarchy: null = roots only, omit = flat
  search?: string;
  limit?: number;
  offset?: number;
}

export interface QueryResult {
  rows: Row[];
  total: number;
  groups?: Array<{
    key: string | null;
    label: string;
    color?: string;
    count: number;
    summaries?: Record<string, number | null>;
  }>;
  summaries?: Record<string, number | null>;
}

export interface View {
  id: string;
  tableRef: string;
  name: string;
  layout: 'table' | 'board' | 'list' | 'calendar' | 'gantt';
  config: {
    query: Query;
    columns?: Array<{ key: string; width?: number; hidden?: boolean }>; // order = display order
    board?: { groupBy: string; cardColumns: string[] };
    calendar?: { dateColumn: string; endColumn?: string };
    gantt?: { startColumn: string; endColumn: string; scale: 'day' | 'week' | 'month' };
    list?: { secondaryColumns: string[] };
  };
}

export interface LayoutProps {
  schema: TableSchema;
  view: View;
  result: QueryResult; // from useView(viewId)
  loading: boolean;
  actions: {
    updateRow(id: string, values: Record<string, unknown>): Promise<void>; // optimistic
    createRow(
      values: Record<string, unknown>,
      opts?: { parentId?: string; projectId?: string },
    ): Promise<Row>;
    deleteRows(ids: string[]): Promise<void>;
    reorder(ids: string[], before?: string): Promise<void>;
    openRow(id: string): void; // task panel
    updateConfig(patch: Partial<View['config']>): void; // debounced save
    loadChildren(parentId: string): Promise<Row[]>;
  };
}
