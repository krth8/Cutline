import { useEffect, useRef, useState } from 'react';
import { Button, Input } from '../../ui';
import { CellHost } from '../cells';
import type { Column, Filter, FilterOp, TableSchema } from '../types';
import {
  MAX_FILTER_DEPTH,
  OP_LABELS,
  appendAt,
  childrenOf,
  completeOnly,
  hasValue,
  isLeaf,
  makeLeaf,
  opsFor,
  setAt,
  simplify,
  toRootGroup,
  defaultValue,
  type Group,
  type Leaf,
} from './queryModel';

const SCALAR_OPS = new Set<FilterOp>(['eq', 'neq', 'contains', 'lt', 'lte', 'gt', 'gte', 'before', 'after']);
const ME = { value: '@me', label: 'Me' };

/** The column the value editor edits for an operator: same type, or the multi/single variant the operator needs. */
function valueColumn(column: Column, op: FilterOp): Column {
  let type = column.type;
  if (type === 'formula' || type === 'relation' || type === 'clip' || type === 'url' || type === 'longtext') type = 'text';
  if (op === 'in' || op === 'nin') type = type === 'person' ? 'people' : 'multiselect';
  else if (op === 'contains' && (type === 'multiselect' || type === 'people')) type = type === 'people' ? 'person' : 'select';
  const options = column.type === 'person' || column.type === 'people' ? [ME, ...(column.options ?? [])] : column.options;
  return { ...column, type, readonly: false, builtin: false, ...(options ? { options } : {}) };
}

function ValueEditor({ column, leaf, onChange }: { column: Column; leaf: Leaf; onChange: (value: unknown) => void }) {
  if (!hasValue(leaf.op)) return null;
  const vc = valueColumn(column, leaf.op);

  if (leaf.op === 'relative') {
    const spec = (leaf.value ?? { unit: 'day', from: -7, to: 0 }) as { unit: string; from: number; to: number };
    const set = (patch: object) => onChange({ ...spec, ...patch });
    const num = (key: 'from' | 'to') => (
      <Input
        type="number"
        className="cl-filter__num"
        aria-label={key === 'from' ? 'From' : 'To'}
        value={String(spec[key])}
        onChange={(e) => set({ [key]: e.target.value === '' ? 0 : Number(e.target.value) })}
      />
    );
    return (
      <span className="cl-filter__value cl-filter__relative">
        {num('from')}
        <span>to</span>
        {num('to')}
        <select
          className="cl-filter__select"
          aria-label="Unit"
          value={spec.unit}
          onChange={(e) => set({ unit: e.target.value })}
        >
          <option value="day">days</option>
          <option value="week">weeks</option>
          <option value="month">months</option>
        </select>
        <span>from today</span>
      </span>
    );
  }

  if (leaf.op === 'between') {
    const pair = Array.isArray(leaf.value) ? [...leaf.value] : [null, null];
    const cell = (i: 0 | 1) => (
      <span className="cl-filter__cell" data-testid={`filter-value-${i}`}>
        <CellHost column={vc} value={pair[i] ?? null} onChange={(v) => onChange(i === 0 ? [v, pair[1] ?? null] : [pair[0] ?? null, v])} />
      </span>
    );
    return (
      <span className="cl-filter__value">
        {cell(0)}
        <span>and</span>
        {cell(1)}
      </span>
    );
  }

  const empty = leaf.op === 'in' || leaf.op === 'nin' ? [] : null;
  return (
    <span className="cl-filter__value cl-filter__cell" data-testid="filter-value">
      {vc.type === 'text' || vc.type === 'number' ? (
        <TextValue column={vc} value={leaf.value} onChange={onChange} />
      ) : (
        <CellHost column={vc} value={leaf.value ?? empty} onChange={onChange} />
      )}
    </span>
  );
}

/** Text and number conditions apply while typing (the cell editors only commit on Enter or blur). */
function TextValue({ column, value, onChange }: { column: Column; value: unknown; onChange: (v: unknown) => void }) {
  const number = column.type === 'number';
  return (
    <Input
      type={number ? 'number' : 'text'}
      className="cl-filter__input"
      aria-label="Value"
      placeholder="Value"
      value={value === null || value === undefined ? '' : String(value)}
      onChange={(e) => {
        const text = e.target.value;
        onChange(text === '' ? null : number ? Number(text) : text);
      }}
    />
  );
}

function LeafRow({
  leaf,
  schema,
  onChange,
  onRemove,
}: {
  leaf: Leaf;
  schema: TableSchema;
  onChange: (leaf: Leaf) => void;
  onRemove: () => void;
}) {
  const column = schema.columns.find((c) => c.key === leaf.column);
  const ops = column ? opsFor(column.type) : [];
  return (
    <div className="cl-filter__row" data-testid="filter-row">
      <select
        className="cl-filter__select"
        aria-label="Column"
        value={leaf.column}
        onChange={(e) => {
          const next = schema.columns.find((c) => c.key === e.target.value);
          if (next) onChange(makeLeaf(next));
        }}
      >
        {!column && <option value={leaf.column}>{leaf.column}</option>}
        {schema.columns.map((c) => (
          <option key={c.key} value={c.key}>
            {c.name}
          </option>
        ))}
      </select>
      <select
        className="cl-filter__select"
        aria-label="Operator"
        value={leaf.op}
        onChange={(e) => {
          if (!column) return;
          const op = e.target.value as FilterOp;
          // Switching between single-value operators keeps what was typed
          const keep = SCALAR_OPS.has(op) && SCALAR_OPS.has(leaf.op) && leaf.value !== undefined;
          const value = keep ? leaf.value : defaultValue(column, op);
          onChange(value === undefined ? { column: leaf.column, op } : { column: leaf.column, op, value });
        }}
      >
        {!ops.includes(leaf.op) && <option value={leaf.op}>{OP_LABELS[leaf.op]}</option>}
        {ops.map((op) => (
          <option key={op} value={op}>
            {OP_LABELS[op]}
          </option>
        ))}
      </select>
      {column && <ValueEditor column={column} leaf={leaf} onChange={(value) => onChange({ ...leaf, value })} />}
      <button type="button" className="cl-filter__remove" aria-label="Remove condition" onClick={onRemove}>
        {'×'}
      </button>
    </div>
  );
}

function GroupView({
  group,
  path,
  schema,
  root,
  update,
}: {
  group: Group;
  path: number[];
  schema: TableSchema;
  root: Group;
  update: (next: Group) => void;
}) {
  const mode = 'and' in group ? 'and' : 'or';
  const kids = childrenOf(group);
  const first = schema.columns[0];
  return (
    <div className="cl-filter__group" data-testid="filter-group" data-depth={path.length}>
      {kids.length > 1 && (
        <div className="cl-filter__mode">
          Match
          <select
            className="cl-filter__select"
            aria-label="Match"
            value={mode}
            onChange={(e) => update(setAt(root, path, e.target.value === 'or' ? { or: kids } : { and: kids }))}
          >
            <option value="and">all</option>
            <option value="or">any</option>
          </select>
          of these
        </div>
      )}
      {kids.map((kid, i) =>
        isLeaf(kid) ? (
          <LeafRow
            key={i}
            leaf={kid}
            schema={schema}
            onChange={(leaf) => update(setAt(root, [...path, i], leaf))}
            onRemove={() => update(setAt(root, [...path, i], null))}
          />
        ) : (
          <div key={i} className="cl-filter__nested">
            <GroupView group={kid} path={[...path, i]} schema={schema} root={root} update={update} />
            <button
              type="button"
              className="cl-filter__remove"
              aria-label="Remove group"
              onClick={() => update(setAt(root, [...path, i], null))}
            >
              {'×'}
            </button>
          </div>
        ),
      )}
      <div className="cl-filter__add">
        <Button
          size="sm"
          variant="ghost"
          disabled={!first}
          onClick={() => first && update(appendAt(root, path, makeLeaf(first)))}
        >
          + Add filter
        </Button>
        {path.length + 1 < MAX_FILTER_DEPTH && (
          <Button
            size="sm"
            variant="ghost"
            disabled={!first}
            onClick={() => first && update(appendAt(root, path, { or: [makeLeaf(first)] } as Filter))}
          >
            + Add group
          </Button>
        )}
      </div>
    </div>
  );
}

/**
 * Edits a nested and/or filter. The conditions being edited live in local state; only complete ones
 * are passed to `onChange` (so a half-filled row never becomes a query).
 */
export function FilterBuilder({
  schema,
  filter,
  onChange,
}: {
  schema: TableSchema;
  filter: Filter | undefined;
  onChange: (filter: Filter | undefined) => void;
}) {
  const [draft, setDraft] = useState<Group>(() => toRootGroup(filter));
  const pushed = useRef(JSON.stringify(filter ?? null));

  // A filter changed from outside (another user, another tab): show it
  useEffect(() => {
    const incoming = JSON.stringify(filter ?? null);
    if (incoming !== pushed.current) {
      pushed.current = incoming;
      setDraft(toRootGroup(filter));
    }
  }, [filter]);

  function update(next: Group) {
    setDraft(next);
    const out = completeOnly(simplify(next));
    const text = JSON.stringify(out ?? null);
    if (text !== pushed.current) {
      pushed.current = text;
      onChange(out);
    }
  }

  return (
    <div className="cl-filter" data-testid="filter-builder">
      {childrenOf(draft).length === 0 && <p className="cl-filter__none">No filters. Every row is shown.</p>}
      <GroupView group={draft} path={[]} schema={schema} root={draft} update={update} />
    </div>
  );
}
