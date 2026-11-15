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
export const createRow = (ref: string, body: CreateRowBody) => requestJson<Row>('POST', `${base(ref)}/rows`, body);

export const updateRow = (ref: string, id: string, values: Record<string, unknown>) =>
  requestJson<Row>('PATCH', `${base(ref)}/rows/${enc(id)}`, { values });

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
