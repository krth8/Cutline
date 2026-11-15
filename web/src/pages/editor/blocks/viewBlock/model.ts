/**
 * Plain logic of the view block (no React, no Tiptap, no platform): what the node stores, which view a new
 * block gets, and how pasted blocks are told apart from the originals. Used by the node (editor chunk)
 * and by the host (main bundle), so it must stay free of anything that exists once per bundle.
 */
import type { Node as PMNode } from '@tiptap/pm/model';

/** The node name in the document (PLAN.md 5.8). */
export const VIEW_BLOCK = 'viewBlock';

/** The layouts a view can have; every one gets a slash entry, registered or not. */
export const VIEW_LAYOUTS = ['table', 'board', 'calendar', 'gantt', 'list'] as const;

export const MIN_HEIGHT = 160;
export const MAX_HEIGHT = 1600;

/** What a block needs to know about its page. `space` ('me' or 'p:<id>') is asked of the server when needed. */
export interface PageContext {
  pageId: string;
  space?: string | undefined;
}

/** The attributes of the node. `copyOf` and `copyToken` only exist for the moment a pasted copy is being made. */
export interface ViewBlockAttrs {
  viewId: string | null;
  height: number | null;
  copyOf: string | null;
  copyToken: string | null;
}

export function clampHeight(value: unknown): number | null {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, Math.round(n)));
}

/** The view a page gets when a layout is inserted: the project's tasks, or "my tasks" in the personal space. */
export function newViewSpec(
  layout: string,
  space: string,
): { tableRef: string; name: string; layout: string; config: { query: Record<string, unknown> } } {
  const label = layout.charAt(0).toUpperCase() + layout.slice(1);
  if (space.startsWith('p:')) {
    return { tableRef: `tasks:${space.slice(2)}`, name: label, layout, config: { query: {} } };
  }
  return {
    tableRef: 'tasks:*',
    name: `My ${layout}`,
    layout,
    config: { query: { filter: { and: [{ column: 'assignees', op: 'in', value: ['@me'] }] } } },
  };
}

/** True when the page owns the view, i.e. the view is deleted together with its block. */
export function ownsView(view: { ownerPageId?: string | null }, pageId: string): boolean {
  return !!view.ownerPageId && view.ownerPageId === pageId;
}

/** Anything with a position map: a transaction's `mapping` or a `Mapping` of several. */
interface PositionMap {
  mapResult(pos: number, assoc?: number): { pos: number; deleted: boolean };
}

/**
 * The view blocks a change added as copies of a view that is already in the document (a paste, a duplicate,
 * a copy dropped in): blocks of `newDoc` that no block of `oldDoc` maps onto, whose view id is used by
 * another block too. When every block with that id is new, the first one keeps the id. A block that only
 * moved maps onto itself and is not reported.
 */
export function findNewDuplicates(oldDoc: PMNode, newDoc: PMNode, mapping: PositionMap): Array<{ pos: number; id: string }> {
  const kept = new Set<number>();
  oldDoc.descendants((node, pos) => {
    if (node.type.name !== VIEW_BLOCK) return;
    const mapped = mapping.mapResult(pos, 1);
    if (!mapped.deleted) kept.add(mapped.pos);
  });
  const byId = new Map<string, Array<{ pos: number; isNew: boolean }>>();
  newDoc.descendants((node, pos) => {
    const id = node.attrs.viewId;
    if (node.type.name !== VIEW_BLOCK || typeof id !== 'string') return;
    const list = byId.get(id) ?? [];
    list.push({ pos, isNew: !kept.has(pos) });
    byId.set(id, list);
  });
  const out: Array<{ pos: number; id: string }> = [];
  for (const [id, list] of byId) {
    if (list.length < 2) continue;
    const fresh = list.filter((n) => n.isNew);
    const copies = fresh.length === list.length ? fresh.slice(1) : fresh;
    for (const n of copies) out.push({ pos: n.pos, id });
  }
  return out.sort((a, b) => a.pos - b.pos);
}
