import { useEffect, useState } from 'react';
import { getPlatform } from '../platform';
import { Button, Dialog } from '../ui';
import { exportPageMarkdown } from './download';
import { printPage } from './print';
import './exportDialog.css';

export const OPEN_EXPORT_EVENT = 'cutline:open-export';

/** Open the "Export page" dialog (the one "Export..." entry of the page menus). */
export function openExport(pageId: string): void {
  window.dispatchEvent(new CustomEvent(OPEN_EXPORT_EVENT, { detail: { pageId } }));
}

/** Always mounted next to the palette: the choices for exporting one page. */
export function ExportHost() {
  const [pageId, setPageId] = useState<string | null>(null);

  useEffect(() => {
    const onOpen = (e: Event) => {
      if (getPlatform().user() === null) return;
      setPageId((e as CustomEvent<{ pageId: string }>).detail.pageId);
    };
    window.addEventListener(OPEN_EXPORT_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_EXPORT_EVENT, onOpen);
  }, []);

  if (!pageId) return null;
  const close = () => setPageId(null);
  const choose = (run: () => void) => {
    close();
    // After the dialog is gone, so it is not part of what gets printed
    setTimeout(run, 0);
  };
  return (
    <Dialog open onClose={close} title="Export page" footer={<Button onClick={close}>Cancel</Button>}>
      <div className="cl-export" data-testid="export-dialog">
        <button type="button" className="cl-export__choice" data-testid="export-md" onClick={() => choose(() => exportPageMarkdown(pageId, false))}>
          <strong>Markdown</strong>
          <span>This page as a .md file, or a .zip when it has images or files.</span>
        </button>
        <button type="button" className="cl-export__choice" data-testid="export-md-tree" onClick={() => choose(() => exportPageMarkdown(pageId, true))}>
          <strong>Markdown with sub-pages</strong>
          <span>A .zip with this page and every page under it.</span>
        </button>
        <button type="button" className="cl-export__choice" data-testid="export-print" onClick={() => choose(() => void printPage())}>
          <strong>Print / Save as PDF</strong>
          <span>Opens the browser&apos;s print dialog for the page on screen.</span>
        </button>
      </div>
    </Dialog>
  );
}
