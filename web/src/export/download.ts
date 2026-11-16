import { getPlatform } from '../platform';
import type { View } from '../tables/types';

/** The address of a page's Markdown export. GET requests carry the login cookie, so a plain link works. */
export function pageExportUrl(pageId: string, opts: { subpages?: boolean } = {}): string {
  return `/api/pages/${encodeURIComponent(pageId)}/export?format=md${opts.subpages ? '&subpages=1' : ''}`;
}

/** Start a browser download of `href` (a normal navigation with the cookie; the server names the file). */
export function triggerDownload(href: string, filename?: string): void {
  const a = document.createElement('a');
  a.href = href;
  a.download = filename ?? '';
  a.rel = 'noopener';
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

export function exportPageMarkdown(pageId: string, withSubpages: boolean): void {
  triggerDownload(pageExportUrl(pageId, { subpages: withSubpages }));
}

/** The file name the server proposed in Content-Disposition (filename*= first), or a fallback. */
export function filenameFrom(disposition: string | null, fallback: string): string {
  if (!disposition) return fallback;
  const star = /filename\*=UTF-8''([^;]+)/i.exec(disposition);
  if (star?.[1]) {
    try {
      return decodeURIComponent(star[1]);
    } catch {
      /* fall through to the plain name */
    }
  }
  const plain = /filename="([^"]+)"/i.exec(disposition);
  return plain?.[1] ?? fallback;
}

/**
 * Download the view as CSV. The view on screen may hold changes that are not saved yet (they are saved
 * after a short delay), so the current query and columns are posted instead of asking for the saved view.
 */
export async function exportViewCsv(view: Pick<View, 'tableRef' | 'name' | 'config'>): Promise<void> {
  const platform = getPlatform();
  try {
    const res = await platform.fetch(`/api/tables/${encodeURIComponent(view.tableRef)}/export`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: view.config.query ?? {}, columns: view.config.columns, name: view.name }),
    });
    if (!res.ok) {
      const detail = await res.json().then((b: { detail?: string }) => b.detail, () => undefined);
      throw new Error(detail || `The export failed (${res.status})`);
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    triggerDownload(url, filenameFrom(res.headers.get('Content-Disposition'), 'export.csv'));
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  } catch (e) {
    platform.toast('error', e instanceof Error ? e.message : 'The export failed');
  }
}
