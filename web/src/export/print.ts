import { getPlatform } from '../platform';
import './print.css';

/** Class on <html> while a page is being printed; the print stylesheet only acts under it. */
export const PRINT_CLASS = 'cl-print-page';
export const PRINT_ROW_CAP = 500;

/** Parse CSV text (RFC 4180: quotes, doubled quotes, CRLF) into rows of cells. A leading BOM is dropped. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += ch;
  }
  if (cell !== '' || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

/** A static table for the rows of a view (header first); at most `PRINT_ROW_CAP` body rows, with a note. */
export function buildPrintTable(rows: string[][]): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'cl-print-table';
  const table = document.createElement('table');
  const [header = [], ...body] = rows;
  const head = table.createTHead().insertRow();
  for (const text of header) {
    const th = document.createElement('th');
    th.textContent = text;
    head.appendChild(th);
  }
  const tbody = table.createTBody();
  for (const cells of body.slice(0, PRINT_ROW_CAP)) {
    const tr = tbody.insertRow();
    for (const text of cells) tr.insertCell().textContent = text;
  }
  wrap.appendChild(table);
  if (body.length > PRINT_ROW_CAP) {
    const note = document.createElement('p');
    note.textContent = `Showing the first ${PRINT_ROW_CAP} of ${body.length} rows.`;
    wrap.appendChild(note);
  }
  return wrap;
}

async function fetchRows(viewId: string): Promise<string[][] | null> {
  try {
    const res = await getPlatform().fetch(`/api/views/${encodeURIComponent(viewId)}/export?format=csv`);
    return res.ok ? parseCsv(await res.text()) : null;
  } catch {
    return null;
  }
}

function imagesLoaded(root: ParentNode, timeoutMs = 3000): Promise<void> {
  const pending = Array.from(root.querySelectorAll('img')).filter((img) => !img.complete);
  if (!pending.length) return Promise.resolve();
  const all = Promise.all(
    pending.map((img) => new Promise<void>((done) => {
      img.addEventListener('load', () => done(), { once: true });
      img.addEventListener('error', () => done(), { once: true });
    })),
  ).then(() => undefined);
  return Promise.race([all, new Promise<void>((done) => setTimeout(done, timeoutMs))]);
}

/**
 * Put the page in its printable state: a light theme, every view block replaced by a static table of its rows
 * (the table layout only renders the rows in view), images loaded. Returns the function that undoes it all.
 * Without a page on screen nothing changes and the undo does nothing.
 */
export async function preparePrint(): Promise<() => void> {
  const html = document.documentElement;
  const page = document.querySelector<HTMLElement>('.cl-page');
  if (!page || html.classList.contains(PRINT_CLASS)) return () => {};
  const theme = html.getAttribute('data-theme');
  const title = document.title;
  const added: HTMLElement[] = [];
  html.classList.add(PRINT_CLASS);
  html.setAttribute('data-theme', 'light');
  const heading = page.querySelector<HTMLElement>('.cl-page__title');
  const name = (heading instanceof HTMLInputElement || heading instanceof HTMLTextAreaElement ? heading.value : heading?.textContent) ?? '';
  if (name.trim()) document.title = name.trim();

  const shells = Array.from(page.querySelectorAll<HTMLElement>('.cl-viewshell[data-view-id]'));
  await Promise.all(
    shells.map(async (shell) => {
      const rows = await fetchRows(shell.dataset.viewId!);
      if (!rows) return;
      const table = buildPrintTable(rows);
      shell.after(table);
      added.push(table);
    }),
  );
  await imagesLoaded(page);
  return () => {
    for (const el of added) el.remove();
    html.classList.remove(PRINT_CLASS);
    if (theme === null) html.removeAttribute('data-theme');
    else html.setAttribute('data-theme', theme);
    document.title = title;
  };
}

/** "Print / Save as PDF": the browser prints the page (there is no server-side PDF). */
export async function printPage(): Promise<void> {
  if (!document.querySelector('.cl-page')) {
    getPlatform().toast('error', 'Open a page to print it');
    return;
  }
  const restore = await preparePrint();
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    window.removeEventListener('afterprint', finish);
    restore();
  };
  window.addEventListener('afterprint', finish);
  window.print();
  // Some browsers return from print() before the dialog is gone; afterprint then restores. Others never fire it.
  setTimeout(finish, 60_000);
}

/** Ctrl+P and the browser's own Print menu: prepare synchronously (static tables are only built by `printPage`). */
export function installBeforePrint(): () => void {
  const html = document.documentElement;
  let theme: string | null = null;
  let on = false;
  const before = () => {
    if (html.classList.contains(PRINT_CLASS) || !document.querySelector('.cl-page')) return;
    on = true;
    theme = html.getAttribute('data-theme');
    html.classList.add(PRINT_CLASS);
    html.setAttribute('data-theme', 'light');
  };
  const after = () => {
    if (!on) return;
    on = false;
    html.classList.remove(PRINT_CLASS);
    if (theme === null) html.removeAttribute('data-theme');
    else html.setAttribute('data-theme', theme);
  };
  window.addEventListener('beforeprint', before);
  window.addEventListener('afterprint', after);
  return () => {
    window.removeEventListener('beforeprint', before);
    window.removeEventListener('afterprint', after);
  };
}
