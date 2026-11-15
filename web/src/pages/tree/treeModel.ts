/**
 * Pure helpers for the page tree: build the tree from the flat list, walk it,
 * and plan a drag and drop (which parent and which fractional sortOrder).
 */
import type { PageNode } from '../../api/pageTree';

export interface TreeNode {
  page: PageNode;
  children: TreeNode[];
}

export interface PageTreeModel {
  roots: TreeNode[];
  byId: Map<string, TreeNode>;
}

/**
 * Build the tree from the flat list. Siblings are ordered by sortOrder (ties keep
 * the order of the list). A page whose parent is not in the list is shown at the top.
 */
export function buildTree(pages: PageNode[]): PageTreeModel {
  const byId = new Map<string, TreeNode>();
  for (const page of pages) byId.set(page.id, { page, children: [] });
  const roots: TreeNode[] = [];
  for (const page of pages) {
    const node = byId.get(page.id)!;
    const parent = page.parentId && page.parentId !== page.id ? byId.get(page.parentId) : undefined;
    (parent ? parent.children : roots).push(node);
  }
  const byOrder = (a: TreeNode, b: TreeNode) => a.page.sortOrder - b.page.sortOrder;
  roots.sort(byOrder); // Array.prototype.sort is stable
  for (const node of byId.values()) node.children.sort(byOrder);
  return { roots, byId };
}

/** The pages from the top-level ancestor down to the parent of `id` (empty for a top-level page or an unknown id). */
export function ancestorsOf(model: PageTreeModel, id: string): PageNode[] {
  const chain: PageNode[] = [];
  const seen = new Set<string>([id]);
  let node = model.byId.get(id);
  while (node && node.page.parentId) {
    const parent = model.byId.get(node.page.parentId);
    if (!parent || seen.has(parent.page.id)) break;
    seen.add(parent.page.id);
    chain.unshift(parent.page);
    node = parent;
  }
  return chain;
}

/** True when `id` is `ancestorId` itself or lies below it. */
export function isInSubtree(model: PageTreeModel, ancestorId: string, id: string): boolean {
  return id === ancestorId || ancestorsOf(model, id).some((p) => p.id === ancestorId);
}

/** Every id in the subtree of `id`, including `id`. */
export function subtreeIds(model: PageTreeModel, id: string): string[] {
  const out: string[] = [];
  const walk = (node: TreeNode) => {
    out.push(node.page.id);
    node.children.forEach(walk);
  };
  const start = model.byId.get(id);
  if (start) walk(start);
  return out;
}

export interface VisibleRow {
  node: TreeNode;
  depth: number;
}

/** The rows shown in the sidebar: a node's children follow it when it is expanded. */
export function visibleRows(model: PageTreeModel, expanded: ReadonlySet<string>): VisibleRow[] {
  const rows: VisibleRow[] = [];
  const walk = (nodes: TreeNode[], depth: number) => {
    for (const node of nodes) {
      rows.push({ node, depth });
      if (node.children.length && expanded.has(node.page.id)) walk(node.children, depth + 1);
    }
  };
  walk(model.roots, 0);
  return rows;
}

/** A sortOrder strictly between two neighbours (either may be missing at the ends of a list). */
export function sortBetween(before: number | null | undefined, after: number | null | undefined): number {
  const hasBefore = typeof before === 'number';
  const hasAfter = typeof after === 'number';
  if (hasBefore && hasAfter) return (before + after) / 2;
  if (hasAfter) return after - 1;
  if (hasBefore) return before + 1;
  return 0;
}

export type DropPosition = 'before' | 'after' | 'inside';

export interface DropPlan {
  parentId: string | null;
  sortOrder: number;
}

/** Dropping a page onto itself or into its own subtree is refused. */
export function canDrop(model: PageTreeModel, draggedId: string, targetId: string): boolean {
  if (!model.byId.has(draggedId) || !model.byId.has(targetId)) return false;
  return !isInSubtree(model, draggedId, targetId);
}

function childrenOf(model: PageTreeModel, parentId: string | null, without: string): TreeNode[] {
  const list = parentId === null ? model.roots : (model.byId.get(parentId)?.children ?? []);
  return list.filter((n) => n.page.id !== without);
}

/**
 * Where a dragged page ends up when dropped before / after / inside the target:
 * the new parent and a sortOrder between its new neighbours. Returns null when the
 * drop is refused (self or own subtree) or would change nothing.
 *
 * `expanded`: dropping "after" an expanded page that has children inserts at the
 * start of its children (that is where the indicator is drawn).
 */
export function planDrop(
  model: PageTreeModel,
  draggedId: string,
  targetId: string,
  position: DropPosition,
  expanded: ReadonlySet<string> = new Set(),
): DropPlan | null {
  if (!canDrop(model, draggedId, targetId)) return null;
  const dragged = model.byId.get(draggedId)!;
  const target = model.byId.get(targetId)!;

  let plan: DropPlan;
  if (position === 'inside') {
    const siblings = childrenOf(model, targetId, draggedId);
    const last = siblings[siblings.length - 1];
    plan = { parentId: targetId, sortOrder: sortBetween(last?.page.sortOrder, null) };
  } else if (position === 'after' && expanded.has(targetId) && childrenOf(model, targetId, draggedId).length) {
    const first = childrenOf(model, targetId, draggedId)[0]!;
    plan = { parentId: targetId, sortOrder: sortBetween(null, first.page.sortOrder) };
  } else {
    const parentId = target.page.parentId && model.byId.has(target.page.parentId) ? target.page.parentId : null;
    const siblings = childrenOf(model, parentId, draggedId);
    const index = siblings.findIndex((n) => n.page.id === targetId);
    const at = position === 'before' ? index : index + 1;
    plan = {
      parentId,
      sortOrder: sortBetween(siblings[at - 1]?.page.sortOrder, siblings[at]?.page.sortOrder),
    };
  }
  return isNoop(model, dragged, plan) ? null : plan;
}

/** Move to the end of the top level ("Move to top level", dropping below the tree). Null if already last there. */
export function planMoveToTop(model: PageTreeModel, pageId: string): DropPlan | null {
  const node = model.byId.get(pageId);
  if (!node) return null;
  const roots = childrenOf(model, null, pageId);
  const plan = { parentId: null, sortOrder: sortBetween(roots[roots.length - 1]?.page.sortOrder, null) };
  return isNoop(model, node, plan) ? null : plan;
}

/** Same parent and the same place among the siblings as now. */
function isNoop(model: PageTreeModel, dragged: TreeNode, plan: DropPlan): boolean {
  const currentParent = dragged.page.parentId && model.byId.has(dragged.page.parentId) ? dragged.page.parentId : null;
  if (currentParent !== plan.parentId) return false;
  const siblings = childrenOf(model, plan.parentId, dragged.page.id);
  const slotOf = (order: number) => siblings.filter((n) => n.page.sortOrder < order).length;
  return slotOf(plan.sortOrder) === slotOf(dragged.page.sortOrder);
}
