import type { MenuItem } from '../ui';
import type { View } from '../tables/types';
import { exportViewCsv } from './download';
import { openExport } from './ExportHost';

/** The one entry of the page "..." menus: it opens the dialog with Markdown, Markdown with sub-pages and Print / PDF. */
export function pageExportItems(pageId: string): MenuItem[] {
  return [{ id: 'export', label: 'Export...', testId: 'menu-export', onSelect: () => openExport(pageId) }];
}

/** The view "..." menu entry that downloads the rows on screen as CSV. */
export function viewExportItem(view: Pick<View, 'tableRef' | 'name' | 'config'>): MenuItem {
  return { id: 'export-csv', label: 'Export CSV', testId: 'menu-export-csv', onSelect: () => void exportViewCsv(view) };
}
