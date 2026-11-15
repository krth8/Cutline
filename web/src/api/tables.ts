/** Typed client for the table endpoints of PLAN.md 5.6. */
import type { Column, Query, QueryResult, Row, TableSchema } from '../tables/types';
import { requestJson } from './http';

// Refs contain ':' and '*'; encodeURIComponent turns ':' into %3A (the server decodes it) and keeps '*'.
const base = (ref: string) => `/api/tables/${encodeURIComponent(ref)}`;
const enc = encodeURIComponent;

export const getSchema = (ref: string) => requestJson<TableSchema>('GET', `${base(ref)}/schema`);

export const query = (ref: string, q: Query) => requestJson<QueryResult>('POST', `${base(ref)}/query`, q);

export interface CreateRowBody {
  values: Record<string, unknown>;
  parentId?: string | null;
  /** Required for `tasks:*`. */
  projectId?: string;
}
/** One row by id (404 when it does not exist or may not be read). `tasks:*` finds a task in any project. */
export const getRow = (ref: string, id: string) => requestJson<Row>('GET', `${base(ref)}/rows/${enc(id)}`);

export const createRow = (ref: string, body: CreateRowBody) => requestJson<Row>('POST', `${base(ref)}/rows`, body);

export const updateRow = (ref: string, id: string, values: Record<string, unknown>) =>
  requestJson<Row>('PATCH', `${base(ref)}/rows/${enc(id)}`, { values });

/** Move a row under another parent (a row id) or to the top level (null). The server refuses cycles and other projects. */
export const moveRow = (ref: string, id: string, parentId: string | null) =>
  requestJson<Row>('PATCH', `${base(ref)}/rows/${enc(id)}`, { parentId });

export const deleteRow = (ref: string, id: string) =>
  requestJson<{ success: boolean }>('DELETE', `${base(ref)}/rows/${enc(id)}`);

export const reorderRows = (ref: string, ids: string[], before?: string) =>
  requestJson<{ success: boolean }>('POST', `${base(ref)}/rows/reorder`, before ? { ids, before } : { ids });

export const createColumn = (ref: string, column: Partial<Column> & Pick<Column, 'name' | 'type'>) =>
  requestJson<Column>('POST', `${base(ref)}/columns`, column);

export const updateColumn = (ref: string, key: string, patch: Partial<Column>) =>
  requestJson<Column>('PATCH', `${base(ref)}/columns/${enc(key)}`, patch);

export const deleteColumn = (ref: string, key: string) =>
  requestJson<unknown>('DELETE', `${base(ref)}/columns/${enc(key)}`);

// ---- Trash (PLAN.md H3): deleted rows wait here until restored or deleted for good ----

export interface TrashItem {
  id: string;
  name: string;
  /** Concrete table of the row ('tasks:<projectId>'). */
  tableRef: string;
  projectId?: string;
  projectName?: string | null;
  deletedAt: string;
  deletedBy: string | null;
  deletedByName: string | null;
  parentId: string | null;
  parentName: string | null;
  /** Subtasks deleted together with this row (they come back with it). */
  subtaskCount: number;
}

export const listTrash = async (ref: string) => (await requestJson<{ items: TrashItem[] }>('GET', `${base(ref)}/trash`)).items;

/** Bring rows back. Returns the ids restored (subtasks that came back with their parent are included). */
export const restoreRows = async (ref: string, ids: string[]) =>
  (await requestJson<{ restored: string[] }>('POST', `${base(ref)}/rows/restore`, { ids })).restored;

/** Delete one row in the trash for good. */
export const purgeRow = (ref: string, id: string) => requestJson<{ success: boolean }>('DELETE', `${base(ref)}/trash/${enc(id)}`);

/** Delete everything in the trash of a table for good (project owner or admin). */
export const emptyTrash = (ref: string) => requestJson<{ removed: number }>('DELETE', `${base(ref)}/trash`);

// ---- Custom tables (`tbl_<id>`) ----

/** What the server says about a custom table. `space` is 'me' or 'p:<projectId>'. */
export interface CustomTable {
  id: string;
  ref: string;
  name: string;
  space: string;
  spaceType: 'project' | 'personal';
  projectId: string | null;
  canEdit: boolean;
  canEditSchema: boolean;
}

export type CustomTableInfo = CustomTable & { rowCount: number; viewCount: number };

/** The custom tables of a space ('me' or 'p:<projectId>') the caller may read. */
export const listTables = (space: string) =>
  requestJson<{ tables: CustomTable[] }>('GET', `/api/tables?space=${enc(space)}`).then((r) => r.tables);

/** Create a table in a space; `columns` are extra starter columns after the title column. */
export const createTable = (body: {
  name: string;
  space: string;
  columns?: Array<{ name: string; type: Column['type']; options?: Array<{ label: string }> }>;
}) => requestJson<CustomTable>('POST', '/api/tables', body);

export const getTableInfo = (ref: string) => requestJson<CustomTableInfo>('GET', base(ref));

export const renameTable = (ref: string, name: string) => requestJson<CustomTable>('PATCH', base(ref), { name });

/** Delete the table with its rows, columns and views. */
export const deleteTable = (ref: string) => requestJson<{ success: boolean; deletedViews: number }>('DELETE', base(ref));
