// Value helpers for relation columns (PLAN 5.6, WP C3). A relation value is a list of linked rows,
// `{ id, label }` as the server resolved them for this reader. Writes may send plain ids or the same objects.
import type { Column } from '../types';

export interface RelationLink {
  id: string;
  label: string;
}

/** The linked rows of a cell value; anything that is not `{id, label}` or an id is ignored. */
export function asLinks(value: unknown): RelationLink[] {
  if (!Array.isArray(value)) return [];
  const out: RelationLink[] = [];
  for (const item of value) {
    if (typeof item === 'string' && item) out.push({ id: item, label: item });
    else if (item && typeof item === 'object' && typeof (item as { id?: unknown }).id === 'string') {
      const { id, label } = item as { id: string; label?: unknown };
      out.push({ id, label: typeof label === 'string' ? label : id });
    }
  }
  return out;
}

export interface RelationConfig {
  /** `tasks:<projectId>` or `tbl_<id>`. */
  target: string | null;
  multiple: boolean;
  twoWay: boolean;
  /** The target table was deleted: the column is empty and shows "Table deleted". */
  targetDeleted: boolean;
  targetName: string | null;
  /** A mirror column ("show on the other table"): read-only. */
  mirror: boolean;
}

export function relationConfig(column: Column): RelationConfig {
  const c = column.config ?? {};
  return {
    target: typeof c.target === 'string' ? c.target : null,
    multiple: c.multiple !== false,
    twoWay: c.twoWay === true,
    targetDeleted: c.targetDeleted === true,
    targetName: typeof c.targetName === 'string' ? c.targetName : null,
    mirror: typeof c.mirrorOf === 'object' && c.mirrorOf !== null,
  };
}

export const linksToText = (value: unknown): string =>
  asLinks(value)
    .map((l) => l.label)
    .join(', ');
