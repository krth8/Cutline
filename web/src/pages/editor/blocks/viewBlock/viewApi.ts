/**
 * Everything the view block asks the server: the view endpoints it needs and the page's space.
 * Runs in the main bundle (the editor chunk reaches it through host.ts).
 */
import { ApiError, requestJson } from '../../../../api/http';
import { getPage } from '../../../../api/pageTree';
import { createTable, deleteTable, getSchema, getTableInfo } from '../../../../api/tables';
import { createView, deleteView, getView } from '../../../../api/views';
import { getPlatform } from '../../../../platform';
import { layoutDefaults, getLayout } from '../../../../tables/layouts';
import type { View } from '../../../../tables/types';
import { newViewSpec, ownsView, tableViewSpec, type PageContext } from './model';

export interface ViewSummary {
  id: string;
  tableRef: string;
  name: string;
  layout: View['layout'];
  ownerPageId: string | null;
  canEdit: boolean;
}

/** `GET /api/views`: the views the caller may open (only those whose rows the caller may read). */
export async function listViews(filter: { tableRef?: string; ownerPageId?: string } = {}): Promise<ViewSummary[]> {
  const q = new URLSearchParams();
  if (filter.tableRef) q.set('tableRef', filter.tableRef);
  if (filter.ownerPageId) q.set('ownerPageId', filter.ownerPageId);
  const qs = q.toString();
  const body = await requestJson<{ views: ViewSummary[] }>('GET', `/api/views${qs ? `?${qs}` : ''}`);
  return body.views;
}

/** The space of the page ('me' or 'p:<projectId>'): from the context, else from the server. */
export async function spaceOf(ctx: PageContext): Promise<string> {
  return ctx.space ?? (await getPage(ctx.pageId)).space;
}

/** Create a view of `layout` owned by the page (so it follows the page's permissions). */
export async function createViewForPage(layout: string, ctx: PageContext): Promise<View & { ownerPageId: string }> {
  const spec = newViewSpec(layout, await spaceOf(ctx));
  let config: View['config'] = spec.config as View['config'];
  // A registered layout brings the config keys it needs (a board needs its group column); others get none
  const entry = getLayout(layout);
  if (entry) {
    try {
      config = { ...config, ...layoutDefaults(entry, await getSchema(spec.tableRef), config) };
    } catch {
      /* the schema is not readable: the view is still created, the shell reports the rest */
    }
  }
  const view = await createView({ ...spec, layout: layout as View['layout'], config, ownerPageId: ctx.pageId });
  return view as View & { ownerPageId: string };
}

/** Create a table view owned by the page on an existing custom table. */
export async function createViewOnTable(tableRef: string, name: string, ctx: PageContext): Promise<View & { ownerPageId: string }> {
  const view = await createView({ ...tableViewSpec(tableRef, name), ownerPageId: ctx.pageId });
  return view as View & { ownerPageId: string };
}

/**
 * "New table": a custom table in the page's space with the title column and one text column "Notes", and a
 * table view of it owned by the page. When the view cannot be made the new table is removed again.
 */
export async function createTableViewForPage(ctx: PageContext): Promise<View & { ownerPageId: string }> {
  const table = await createTable({ name: 'Untitled table', space: await spaceOf(ctx), columns: [{ name: 'Notes', type: 'text' }] });
  try {
    return await createViewOnTable(table.ref, table.name, ctx);
  } catch (e) {
    await deleteTable(table.ref).catch(() => undefined);
    throw e;
  }
}

/**
 * The view id a pasted copy of `sourceId` gets: a view this page owns is copied (same table, layout and
 * config, new row in the database); a view picked from elsewhere is shared, so it keeps its id.
 */
export async function copyViewForPaste(sourceId: string, ctx: PageContext): Promise<string> {
  const source = (await getView(sourceId)) as View & { ownerPageId?: string | null };
  if (!ownsView(source, ctx.pageId)) return sourceId;
  const copy = await createView({
    tableRef: source.tableRef,
    name: source.name,
    layout: source.layout,
    config: source.config,
    ownerPageId: ctx.pageId,
  });
  return copy.id;
}

/**
 * Ask before a block goes away. A view the page owns is deleted with its block (after a confirm); a picked view
 * is never deleted. Resolves to whether the block should now be removed.
 */
export async function confirmAndDeleteViewOf(viewId: string | null, ctx: PageContext | null): Promise<boolean> {
  if (!viewId || !ctx) return true;
  let owned = false;
  let tableRef = '';
  try {
    const view = (await getView(viewId)) as View & { ownerPageId?: string | null };
    owned = ownsView(view, ctx.pageId);
    tableRef = view.tableRef;
  } catch {
    return true; // already gone or not readable: only the block is left to remove
  }
  if (!owned) return true;
  const ok = await getPlatform().confirm('Delete this view and remove it from the page?', {
    danger: true,
    confirmLabel: 'Delete',
  });
  if (!ok) return false;
  const dropTable = tableRef.startsWith('tbl_') ? await askToDeleteTable(tableRef) : false;
  try {
    await deleteView(viewId);
  } catch (e) {
    if (!(e instanceof ApiError && e.status === 404)) {
      getPlatform().toast('error', e instanceof Error ? e.message : 'Could not delete the view');
      return false;
    }
  }
  if (dropTable) {
    try {
      await deleteTable(tableRef);
    } catch (e) {
      getPlatform().toast('error', e instanceof Error ? e.message : 'Could not delete the table');
    }
  }
  return true;
}

/**
 * The view being deleted is the only one on a custom table: ask whether the table goes too. Keeping the
 * table is the default (Cancel, or no right to delete it), so rows are never lost by accident.
 */
async function askToDeleteTable(tableRef: string): Promise<boolean> {
  try {
    const info = await getTableInfo(tableRef);
    if (info.viewCount !== 1 || !info.canEditSchema) return false;
    const rows = `${info.rowCount} ${info.rowCount === 1 ? 'row' : 'rows'}`;
    return await getPlatform().confirm(
      `This is the only view of the table "${info.name}" (${rows}). Delete the table and its rows too? Cancel keeps the table.`,
      { danger: true, confirmLabel: 'Delete table' },
    );
  } catch {
    return false;
  }
}
