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

/**
 * A view as the layouts expect it: `config.query` always an object. A view made through the API without a
 * query (scripts, old data) would otherwise crash every layout that reads `config.query.groupBy`.
 */
export function withQuery(view: View): View {
  const config = (view.config ?? {}) as View['config'];
  if (config.query && typeof config.query === 'object') return view;
  return { ...view, config: { ...config, query: {} } };
}

export const getView = async (id: string) => withQuery(await requestJson<View>('GET', `/api/views/${encodeURIComponent(id)}`));
export const createView = async (body: CreateViewBody) => withQuery(await requestJson<View>('POST', '/api/views', body));
export const updateView = async (id: string, patch: UpdateViewBody) =>
  withQuery(await requestJson<View>('PATCH', `/api/views/${encodeURIComponent(id)}`, patch));
export const deleteView = (id: string) => requestJson<unknown>('DELETE', `/api/views/${encodeURIComponent(id)}`);
