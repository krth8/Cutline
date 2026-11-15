/**
 * Typed client for the view endpoints of PLAN.md 5.6. The server side is WP T4; nothing in the
 * store calls this yet (the view source in tables/store/viewSource.ts will wrap it).
 */
import type { View } from '../tables/types';
import { requestJson } from './http';

export interface CreateViewBody {
  tableRef: string;
  name: string;
  layout: View['layout'];
  config: View['config'];
  ownerPageId?: string;
}
export type UpdateViewBody = Partial<Pick<View, 'name' | 'layout'>> & { config?: Partial<View['config']> };

export const getView = (id: string) => requestJson<View>('GET', `/api/views/${encodeURIComponent(id)}`);
export const createView = (body: CreateViewBody) => requestJson<View>('POST', '/api/views', body);
export const updateView = (id: string, patch: UpdateViewBody) =>
  requestJson<View>('PATCH', `/api/views/${encodeURIComponent(id)}`, patch);
export const deleteView = (id: string) => requestJson<unknown>('DELETE', `/api/views/${encodeURIComponent(id)}`);
