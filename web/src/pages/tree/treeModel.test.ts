import { describe, expect, it } from 'vitest';
import type { PageNode } from '../../api/pageTree';
import {
  ancestorsOf,
  buildTree,
  canDrop,
  isInSubtree,
  planDrop,
  planMoveToTop,
  sortBetween,
  subtreeIds,
  visibleRows,
} from './treeModel';

const page = (id: string, parentId: string | null, sortOrder: number): PageNode => ({
  id,
  parentId,
  title: id,
  icon: null,
  sortOrder,
  kind: 'page',
});

// A(0) { A1(0) { A1a(0) }, A2(1) }   B(1)   C(2)
const pages = [
  page('C', null, 2),
  page('A1a', 'A1', 0),
  page('A', null, 0),
  page('B', null, 1),
  page('A2', 'A', 1),
  page('A1', 'A', 0),
];
const model = buildTree(pages);

describe('buildTree', () => {
  it('nests children under their parent and orders siblings by sortOrder', () => {
    expect(model.roots.map((n) => n.page.id)).toEqual(['A', 'B', 'C']);
    expect(model.byId.get('A')!.children.map((n) => n.page.id)).toEqual(['A1', 'A2']);
    expect(model.byId.get('A1')!.children.map((n) => n.page.id)).toEqual(['A1a']);
  });

  it('keeps the list order for equal sortOrder', () => {
    const m = buildTree([page('x', null, 1), page('y', null, 1), page('z', null, 1)]);
    expect(m.roots.map((n) => n.page.id)).toEqual(['x', 'y', 'z']);
  });

  it('shows a page whose parent is missing at the top level', () => {
    const m = buildTree([page('orphan', 'gone', 0), page('a', null, 1)]);
    expect(m.roots.map((n) => n.page.id)).toEqual(['orphan', 'a']);
  });

  it('survives a page that names itself as parent', () => {
    expect(buildTree([page('loop', 'loop', 0)]).roots.map((n) => n.page.id)).toEqual(['loop']);
  });
});

describe('walking', () => {
  it('lists ancestors from the top down', () => {
    expect(ancestorsOf(model, 'A1a').map((p) => p.id)).toEqual(['A', 'A1']);
    expect(ancestorsOf(model, 'A')).toEqual([]);
    expect(ancestorsOf(model, 'nope')).toEqual([]);
  });

  it('knows subtrees', () => {
    expect(subtreeIds(model, 'A')).toEqual(['A', 'A1', 'A1a', 'A2']);
    expect(isInSubtree(model, 'A', 'A1a')).toBe(true);
    expect(isInSubtree(model, 'A', 'A')).toBe(true);
    expect(isInSubtree(model, 'A1', 'A2')).toBe(false);
  });

  it('shows children of expanded pages only', () => {
    expect(visibleRows(model, new Set()).map((r) => r.node.page.id)).toEqual(['A', 'B', 'C']);
    const rows = visibleRows(model, new Set(['A', 'A1']));
    expect(rows.map((r) => `${r.node.page.id}:${r.depth}`)).toEqual(['A:0', 'A1:1', 'A1a:2', 'A2:1', 'B:0', 'C:0']);
  });
});

describe('sortBetween', () => {
  it('takes the middle, or steps outwards at the ends', () => {
    expect(sortBetween(1, 2)).toBe(1.5);
    expect(sortBetween(null, 3)).toBe(2);
    expect(sortBetween(3, undefined)).toBe(4);
    expect(sortBetween(null, null)).toBe(0);
    expect(sortBetween(0, 1)).toBe(0.5);
  });
});

describe('planDrop', () => {
  it('before the first sibling', () => {
    expect(planDrop(model, 'C', 'A', 'before')).toEqual({ parentId: null, sortOrder: -1 });
  });

  it('before a middle sibling lands between its neighbours', () => {
    expect(planDrop(model, 'C', 'B', 'before')).toEqual({ parentId: null, sortOrder: 0.5 });
  });

  it('after the last sibling', () => {
    expect(planDrop(model, 'A', 'C', 'after')).toEqual({ parentId: null, sortOrder: 3 });
  });

  it('after a middle sibling', () => {
    expect(planDrop(model, 'C', 'A', 'after')).toEqual({ parentId: null, sortOrder: 0.5 });
  });

  it('inside a page without children', () => {
    expect(planDrop(model, 'C', 'B', 'inside')).toEqual({ parentId: 'B', sortOrder: 0 });
  });

  it('inside a page with children goes to the end', () => {
    expect(planDrop(model, 'C', 'A', 'inside')).toEqual({ parentId: 'A', sortOrder: 2 });
  });

  it('into a nested level, between two siblings', () => {
    expect(planDrop(model, 'B', 'A2', 'before')).toEqual({ parentId: 'A', sortOrder: 0.5 });
  });

  it('out of a nested level to the end of another', () => {
    expect(planDrop(model, 'A1a', 'A2', 'after')).toEqual({ parentId: 'A', sortOrder: 2 });
  });

  it('after an expanded page with children becomes the first child', () => {
    expect(planDrop(model, 'C', 'A', 'after', new Set(['A']))).toEqual({ parentId: 'A', sortOrder: -1 });
    // collapsed: a sibling after it
    expect(planDrop(model, 'C', 'A', 'after', new Set())).toEqual({ parentId: null, sortOrder: 0.5 });
  });

  it('ignores the dragged page itself when counting neighbours', () => {
    // Moving B after C: neighbours are C and nothing
    expect(planDrop(model, 'B', 'C', 'after')).toEqual({ parentId: null, sortOrder: 3 });
    // Moving A2 before A1 (A2's own slot does not count)
    expect(planDrop(model, 'A2', 'A1', 'before')).toEqual({ parentId: 'A', sortOrder: -1 });
  });

  it('refuses a drop on itself', () => {
    for (const position of ['before', 'after', 'inside'] as const) {
      expect(planDrop(model, 'A', 'A', position)).toBeNull();
    }
  });

  it('refuses a drop into its own descendants', () => {
    for (const target of ['A1', 'A1a', 'A2']) {
      for (const position of ['before', 'after', 'inside'] as const) {
        expect(planDrop(model, 'A', target, position)).toBeNull();
      }
    }
    expect(canDrop(model, 'A', 'A1a')).toBe(false);
    expect(canDrop(model, 'A1', 'A2')).toBe(true);
    expect(canDrop(model, 'A1a', 'A')).toBe(true); // up is fine
  });

  it('returns null for a drop that changes nothing', () => {
    expect(planDrop(model, 'B', 'C', 'before')).toBeNull(); // already right before C
    expect(planDrop(model, 'B', 'A', 'after')).toBeNull(); // already right after A
    expect(planDrop(model, 'A2', 'A', 'inside')).toBeNull(); // already the last child
    expect(planDrop(model, 'nope', 'A', 'before')).toBeNull();
  });
});

describe('planMoveToTop', () => {
  it('appends to the top level', () => {
    expect(planMoveToTop(model, 'A1')).toEqual({ parentId: null, sortOrder: 3 });
  });

  it('does nothing for the last top-level page', () => {
    expect(planMoveToTop(model, 'C')).toBeNull();
  });
});
