/**
 * Copy and paste of cells as tab-separated text (the format spreadsheets use): writing a block of
 * cells, reading one back, and working out which values a paste changes.
 */
import type { Column } from '../../types';

/** Cells joined with tabs and rows with newlines; a cell with a tab, newline or quote is put in quotes. */
export function toTsv(matrix: readonly (readonly string[])[]): string {
  return matrix
    .map((row) => row.map((cell) => (/[\t\r\n"]/.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell)).join('\t'))
    .join('\n');
}

/** The inverse of `toTsv`. Accepts \r\n and quoted cells; one trailing newline does not make an empty row. */
export function parseTsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  let i = 0;
  const endRow = () => {
    row.push(cell);
    rows.push(row);
    row = [];
    cell = '';
  };
  while (i < text.length) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i += 2;
          continue;
        }
        quoted = false;
      } else cell += ch;
    } else if (ch === '"' && cell === '') {
      quoted = true;
    } else if (ch === '\t') {
      row.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      endRow();
    } else cell += ch;
    i++;
  }
  if (cell !== '' || row.length > 0) endRow();
  return rows;
}

export interface PasteUpdate {
  rowId: string;
  values: Record<string, unknown>;
}

export interface PasteInput {
  matrix: readonly (readonly string[])[];
  /** Row ids in display order. */
  order: readonly string[];
  /** Where the paste starts: the focused cell. */
  start: { rowId: string; col: number };
  columns: readonly Column[];
  /** Rows ticked in the first column. */
  selected: ReadonlySet<string>;
  canEditRow(id: string): boolean;
  canEditColumn(column: Column): boolean;
  /** `{ value }` for valid text, null for text the column cannot take. */
  parse(column: Column, text: string): { value: unknown } | null;
}

/**
 * The cell values a paste sets. A block is laid out from the focused cell down and to the right and
 * is cut off at the last row and column. One value pasted while several rows are ticked (and the
 * focused row is one of them) goes to all of them in that column. Cells that cannot be edited or
 * parsed are counted in `skipped`.
 */
export function planPaste(input: PasteInput): { updates: PasteUpdate[]; skipped: number } {
  const { matrix, order, start, columns } = input;
  const startRow = order.indexOf(start.rowId);
  if (startRow < 0 || matrix.length === 0) return { updates: [], skipped: 0 };
  const byRow = new Map<string, Record<string, unknown>>();
  let skipped = 0;
  const put = (rowId: string, column: Column, text: string) => {
    const parsed = input.canEditRow(rowId) && input.canEditColumn(column) ? input.parse(column, text) : null;
    if (!parsed) {
      skipped++;
      return;
    }
    byRow.set(rowId, { ...(byRow.get(rowId) ?? {}), [column.key]: parsed.value });
  };

  const single = matrix.length === 1 && matrix[0]!.length === 1;
  if (single && input.selected.size > 1 && input.selected.has(start.rowId)) {
    const column = columns[start.col];
    if (column) for (const id of order) if (input.selected.has(id)) put(id, column, matrix[0]![0]!);
  } else {
    matrix.forEach((cells, r) => {
      const rowId = order[startRow + r];
      if (rowId === undefined) return;
      cells.forEach((text, c) => {
        const column = columns[start.col + c];
        if (column) put(rowId, column, text);
      });
    });
  }
  return { updates: [...byRow].map(([rowId, values]) => ({ rowId, values })), skipped };
}
