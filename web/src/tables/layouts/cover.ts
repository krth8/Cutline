/**
 * The picture on top of a card (board and gallery). The rule: an image column with a picture wins; a row without
 * one shows the frame of its linked clip. `choice` narrows it: 'none' shows no pictures, a column key uses only
 * that column (an image column, or a clip column for clip frames).
 */
import { imageUrl } from '../cells/image';
import type { Column, Row } from '../types';

export type CoverChoice = 'auto' | 'none' | string;

function clipFrame(value: unknown): string | null {
  const v = value as { thumbnail?: unknown } | null | undefined;
  return v && typeof v.thumbnail === 'string' && v.thumbnail ? `/thumbnail/${encodeURIComponent(v.thumbnail)}` : null;
}

function fromColumn(row: Row, column: Column): string | null {
  if (column.type === 'image') return imageUrl(row.values[column.key]);
  if (column.type === 'clip') return clipFrame(row.values[column.key]);
  return null;
}

export function coverOf(row: Row, columns: Column[], choice: CoverChoice = 'auto'): string | null {
  if (choice === 'none') return null;
  if (choice !== 'auto') {
    const column = columns.find((c) => c.key === choice);
    return column ? fromColumn(row, column) : null;
  }
  for (const type of ['image', 'clip'] as const) {
    for (const c of columns) {
      if (c.type !== type) continue;
      const url = fromColumn(row, c);
      if (url) return url;
    }
  }
  return null;
}

/** The columns a cover can come from. */
export const coverColumnsOf = (columns: Column[]): Column[] => columns.filter((c) => c.type === 'image' || c.type === 'clip');
