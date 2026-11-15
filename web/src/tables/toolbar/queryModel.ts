/**
 * What the toolbar knows about queries: which operators a column type offers, how a filter tree is
 * edited (immutably, by path), and which summary functions fit a column. The server stays the authority;
 * the operator lists mirror api/tables/query.py (OPS_BY_TYPE).
 */
import type { Column, ColumnType, Filter, FilterOp, Query } from '../types';

export type Leaf = { column: string; op: FilterOp; value?: unknown };
export type Group = { and: Filter[] } | { or: Filter[] };

export const MAX_FILTER_DEPTH = 3;

export const OP_LABELS: Record<FilterOp, string> = {
  eq: 'is',
  neq: 'is not',
  in: 'is any of',
  nin: 'is none of',
  contains: 'contains',
  empty: 'is empty',
  notEmpty: 'is not empty',
  lt: '<',
  lte: '≤',
  gt: '>',
  gte: '≥',
  before: 'is before',
  after: 'is after',
  between: 'is between',
  relative: 'is within',
  done: 'is done',
  notDone: 'is not done',
};

const EMPTY_OPS: FilterOp[] = ['empty', 'notEmpty'];

/** Operators the filter builder offers per column type (a subset of what the server accepts). */
export function opsFor(type: ColumnType): FilterOp[] {
  switch (type) {
    case 'text':
    case 'longtext':
    case 'url':
      return ['contains', 'eq', 'neq', ...EMPTY_OPS];
    case 'number':
      return ['eq', 'neq', 'lt', 'lte', 'gt', 'gte', 'between', ...EMPTY_OPS];
    case 'checkbox':
      return ['eq'];
    case 'date':
      return ['eq', 'neq', 'before', 'after', 'between', 'relative', ...EMPTY_OPS];
    case 'status':
      return ['eq', 'neq', 'in', 'nin', 'done', 'notDone', ...EMPTY_OPS];
    case 'select':
    case 'priority':
    case 'person':
      return ['eq', 'neq', 'in', 'nin', ...EMPTY_OPS];
    case 'multiselect':
    case 'people':
      return ['contains', 'in', ...EMPTY_OPS];
    case 'relation':
      return ['contains', ...EMPTY_OPS];
    case 'formula':
      return ['contains', 'eq', 'neq', ...EMPTY_OPS];
    default:
      return EMPTY_OPS;
  }
}

export const hasValue = (op: FilterOp) => op !== 'empty' && op !== 'notEmpty' && op !== 'done' && op !== 'notDone';

export const isLeaf = (f: Filter): f is Leaf => 'column' in f;
export const isAnd = (f: Filter): f is { and: Filter[] } => 'and' in f;
export const childrenOf = (g: Group): Filter[] => ('and' in g ? g.and : g.or);
export const withChildren = (g: Group, children: Filter[]): Group => ('and' in g ? { and: children } : { or: children });

/** The value a new condition on this operator starts with. */
export function defaultValue(column: Column, op: FilterOp): unknown {
  switch (op) {
    case 'empty':
    case 'notEmpty':
    case 'done':
    case 'notDone':
      return undefined;
    case 'in':
    case 'nin':
      return [];
    case 'between':
      return [null, null];
    case 'relative':
      return { unit: 'day', from: -7, to: 0 };
    case 'eq':
    case 'neq':
      return column.type === 'checkbox' ? true : null;
    default:
      return null;
  }
}

export function makeLeaf(column: Column, op?: FilterOp): Leaf {
  const o = op ?? opsFor(column.type)[0]!;
  const value = defaultValue(column, o);
  return value === undefined ? { column: column.key, op: o } : { column: column.key, op: o, value };
}

/** The filter as a group the builder can edit: nothing becomes an empty "all of", a lone condition is wrapped. */
export function toRootGroup(filter: Filter | undefined): Group {
  if (!filter) return { and: [] };
  return isLeaf(filter) ? { and: [filter] } : filter;
}

/** Drops empty groups and unwraps trivial ones; `undefined` when nothing is left. */
export function simplify(filter: Filter | undefined): Filter | undefined {
  if (!filter || isLeaf(filter)) return filter;
  const kids = childrenOf(filter)
    .map(simplify)
    .filter((f): f is Filter => f !== undefined);
  if (kids.length === 0) return undefined;
  return withChildren(filter, kids);
}

/** True for a condition the server would accept as written (no half-filled value). */
export function isComplete(leaf: Leaf): boolean {
  if (!hasValue(leaf.op)) return true;
  const v = leaf.value;
  if (leaf.op === 'between') return Array.isArray(v) && v.length === 2 && v.every((x) => x !== null && x !== undefined && x !== '');
  if (leaf.op === 'in' || leaf.op === 'nin') return Array.isArray(v) && v.length > 0;
  if (leaf.op === 'relative') return !!v && typeof v === 'object';
  if (leaf.op === 'eq' || leaf.op === 'neq') return v !== null && v !== undefined && v !== '';
  return v !== null && v !== undefined && v !== '';
}

/** Only the complete conditions of a filter, so a half-edited row never reaches the server. */
export function completeOnly(filter: Filter | undefined): Filter | undefined {
  if (!filter) return filter;
  if (isLeaf(filter)) return isComplete(filter) ? filter : undefined;
  const kids = childrenOf(filter)
    .map(completeOnly)
    .filter((f): f is Filter => f !== undefined);
  return kids.length ? withChildren(filter, kids) : undefined;
}

/** Number of conditions in a filter (all levels). */
export function countConditions(filter: Filter | undefined): number {
  if (!filter) return 0;
  if (isLeaf(filter)) return 1;
  return childrenOf(filter).reduce((n, f) => n + countConditions(f), 0);
}

// ---- editing a filter tree by path (indexes of the children from the root group) ----

export function getAt(root: Group, path: number[]): Filter {
  let node: Filter = root;
  for (const i of path) node = childrenOf(node as Group)[i]!;
  return node;
}

/** Replace the node at `path` (or remove it when `next` is null). The root can only be replaced. */
export function setAt(root: Group, path: number[], next: Filter | null): Group {
  if (path.length === 0) return (next ?? { and: [] }) as Group;
  const [head, ...rest] = path as [number, ...number[]];
  const kids = childrenOf(root);
  const copy = [...kids];
  if (rest.length === 0) {
    if (next === null) copy.splice(head, 1);
    else copy[head] = next;
  } else {
    copy[head] = setAt(copy[head] as Group, rest, next);
  }
  return withChildren(root, copy);
}

export function appendAt(root: Group, path: number[], node: Filter): Group {
  const group = getAt(root, path) as Group;
  return setAt(root, path, withChildren(group, [...childrenOf(group), node]));
}

// ---- sort, group, summaries ----

export const GROUPABLE: ReadonlySet<ColumnType> = new Set<ColumnType>([
  'select', 'status', 'priority', 'person', 'people', 'multiselect', 'checkbox', 'date', 'number', 'text', 'relation',
]);

export const SORTABLE_EXCLUDED: ReadonlySet<ColumnType> = new Set<ColumnType>();

type SummaryFn = NonNullable<Query['summaries']>[string];

export const SUMMARY_LABELS: Record<SummaryFn, string> = {
  count: 'Count',
  countEmpty: 'Empty',
  countFilled: 'Filled',
  sum: 'Sum',
  avg: 'Average',
  min: 'Min',
  max: 'Max',
  percentChecked: 'Percent checked',
};

export function summariesFor(type: ColumnType): SummaryFn[] {
  const base: SummaryFn[] = ['count', 'countEmpty', 'countFilled'];
  switch (type) {
    case 'number':
      return [...base, 'sum', 'avg', 'min', 'max'];
    case 'date':
      return [...base, 'min', 'max'];
    case 'checkbox':
      return ['percentChecked', ...base];
    default:
      return base;
  }
}
