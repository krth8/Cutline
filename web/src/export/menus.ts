import type { MenuItem } from '../ui';
import type { View } from '../tables/types';
import { exportPageMarkdown, exportViewCsv } from './download';
import { printPage } from './print';

/** Menu entries of the page "..." menu: Markdown, Markdown with sub-pages, Print / PDF (the browser prints it). */
export function pageExportItems(pageId: string): MenuItem[] {
  return [
    { id: 'export-md', label: 'Export as Markdown', testId: 'menu-export-md', onSelect: () => exportPageMarkdown(pageId, false) },
    { id: 'export-md-tree', label: 'Export as Markdown with sub-pages', testId: 'menu-export-md-tree', onSelect: () => exportPageMarkdown(pageId, true) },
    { id: 'export-print', label: 'Print / Save as PDF', testId: 'menu-export-print', onSelect: () => void printPage() },
  ];
}

/** The view "..." menu entry that downloads the rows on screen as CSV. */
export function viewExportItem(view: Pick<View, 'tableRef' | 'name' | 'config'>): MenuItem {
  return { id: 'export-csv', label: 'Export CSV', testId: 'menu-export-csv', onSelect: () => void exportViewCsv(view) };
}
