import { useEffect, useState, type FormEvent } from 'react';
import { listTables } from '../../../api/tables';
import { getPlatform } from '../../../platform';
import { Button, Dialog, Input } from '../../../ui';
import { relationConfig } from '../../cells/relation';
import type { Column, ColumnType } from '../../types';

/** The types a custom column can have (the server's CUSTOM_TYPES), with their labels. */
export const CUSTOM_COLUMN_TYPES: ReadonlyArray<{ type: ColumnType; label: string }> = [
  { type: 'text', label: 'Text' },
  { type: 'longtext', label: 'Long text' },
  { type: 'number', label: 'Number' },
  { type: 'checkbox', label: 'Checkbox' },
  { type: 'date', label: 'Date' },
  { type: 'select', label: 'Select' },
  { type: 'multiselect', label: 'Multi-select' },
  { type: 'url', label: 'URL' },
  { type: 'person', label: 'Person' },
  { type: 'people', label: 'People' },
  { type: 'relation', label: 'Relation' },
  { type: 'image', label: 'Image' },
];

/** Currencies a number column can show its values in ('' is a plain number). */
export const CURRENCIES: ReadonlyArray<{ code: string; label: string }> = [
  { code: '', label: 'Plain number' },
  { code: 'NOK', label: 'Norwegian krone (NOK)' },
  { code: 'SEK', label: 'Swedish krona (SEK)' },
  { code: 'DKK', label: 'Danish krone (DKK)' },
  { code: 'EUR', label: 'Euro (EUR)' },
  { code: 'USD', label: 'US dollar (USD)' },
  { code: 'GBP', label: 'British pound (GBP)' },
];

export const isSelectType = (type: ColumnType) => type === 'select' || type === 'multiselect';

/** What the form hands back: a name, a type and (for select types) the option labels, one per line. */
export interface ColumnFormValue {
  name: string;
  type: ColumnType;
  options: string[];
  /** Relation columns: the target table and the switches. */
  relation?: { target: string; multiple: boolean; twoWay: boolean };
  /** Number columns: the currency code, '' for a plain number. */
  currency?: string;
}

export interface TargetChoice {
  ref: string;
  label: string;
}

/**
 * The tables a relation column of a table in `space` ('me' or 'p:<projectId>') may point at: the tables of
 * the space and, in a project, its tasks; in the personal space the tasks of every project the user has task access to.
 */
export async function loadTargets(space: string): Promise<TargetChoice[]> {
  const tables = (await listTables(space)).map((t) => ({ ref: t.ref, label: t.name }));
  const projects = getPlatform().projects();
  if (space.startsWith('p:')) {
    const id = space.slice(2);
    return [{ ref: `tasks:${id}`, label: 'Tasks' }, ...tables];
  }
  return [...tables, ...projects.filter((p) => p.canTasks).map((p) => ({ ref: `tasks:${p.id}`, label: `Tasks of ${p.name}` }))];
}

export type ColumnFormMode = 'add' | 'rename' | 'type';

const TITLES: Record<ColumnFormMode, string> = { add: 'Add column', rename: 'Rename column', type: 'Change column type' };

/**
 * A dialog for the three column forms: add (name + type + options), rename (name) and change type (type +
 * options). `column` is the column being changed. Options are typed one per line.
 */
export function ColumnForm({
  mode,
  column,
  space,
  onSubmit,
  onClose,
}: {
  mode: ColumnFormMode;
  column?: Column;
  /** The space of the table ('me' or 'p:<projectId>'); decides which tables a relation can point at. */
  space?: string | null;
  onSubmit(value: ColumnFormValue): Promise<void>;
  onClose(): void;
}) {
  const [name, setName] = useState(column?.name ?? '');
  const [type, setType] = useState<ColumnType>(column && column.type !== 'status' ? column.type : 'text');
  const [options, setOptions] = useState((column?.options ?? []).map((o) => o.label).join('\n'));
  const [busy, setBusy] = useState(false);
  const existing = column?.type === 'relation' ? relationConfig(column) : null;
  const [target, setTarget] = useState(existing?.target ?? '');
  const [multiple, setMultiple] = useState(existing?.multiple ?? true);
  const [twoWay, setTwoWay] = useState(existing?.twoWay ?? false);
  const [targets, setTargets] = useState<TargetChoice[] | null>(null);
  const [currency, setCurrency] = useState(typeof column?.config?.currency === 'string' ? column.config.currency : '');
  const isRelation = type === 'relation';
  useEffect(() => {
    if (!isRelation || !space || targets) return;
    let current = true;
    loadTargets(space)
      .then((list) => current && setTargets(list))
      .catch(() => current && setTargets([]));
    return () => {
      current = false;
    };
  }, [isRelation, space, targets]);
  const showType = mode !== 'rename';
  const showOptions = showType && isSelectType(type);
  const valid = (mode === 'type' || name.trim() !== '') && (!isRelation || mode === 'rename' || target !== '');

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!valid || busy) return;
    setBusy(true);
    try {
      await onSubmit({
        name: name.trim(),
        type,
        options: options
          .split('\n')
          .map((l) => l.trim())
          .filter(Boolean),
        ...(isRelation && mode !== 'rename' ? { relation: { target, multiple, twoWay } } : {}),
        ...(type === 'number' && mode !== 'rename' ? { currency } : {}),
      });
      onClose();
    } catch {
      setBusy(false); // the caller has shown the error; the form stays open
    }
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title={TITLES[mode]}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" form="cl-column-form" disabled={!valid} loading={busy} data-testid="column-form-submit">
            {mode === 'add' ? 'Add' : 'Save'}
          </Button>
        </>
      }
    >
      <form id="cl-column-form" className="cl-colform" onSubmit={(e) => void submit(e)}>
        {mode !== 'type' && (
          <label className="cl-colform__field">
            Name
            <Input value={name} onChange={(e) => setName(e.target.value)} data-testid="column-form-name" maxLength={80} />
          </label>
        )}
        {showType && (
          <label className="cl-colform__field">
            Type
            <select
              className="cl-table__select"
              value={type}
              onChange={(e) => setType(e.target.value as ColumnType)}
              data-testid="column-form-type"
            >
              {CUSTOM_COLUMN_TYPES.map((t) => (
                <option key={t.type} value={t.type}>
                  {t.label}
                </option>
              ))}
            </select>
          </label>
        )}
        {showType && type === 'number' && (
          <label className="cl-colform__field">
            Format
            <select className="cl-table__select" value={currency} onChange={(e) => setCurrency(e.target.value)} data-testid="column-form-currency">
              {CURRENCIES.map((c) => (
                <option key={c.code} value={c.code}>
                  {c.label}
                </option>
              ))}
            </select>
          </label>
        )}
        {showType && isRelation && (
          <>
            <label className="cl-colform__field">
              Linked table
              <select
                className="cl-table__select"
                value={target}
                onChange={(e) => setTarget(e.target.value)}
                data-testid="column-form-target"
              >
                <option value="">{targets === null ? 'Loading...' : 'Choose a table...'}</option>
                {(targets ?? []).map((t) => (
                  <option key={t.ref} value={t.ref}>
                    {t.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="cl-colform__check">
              <input type="checkbox" checked={multiple} onChange={(e) => setMultiple(e.target.checked)} data-testid="column-form-multiple" />
              Allow linking several rows
            </label>
            <label className="cl-colform__check">
              <input type="checkbox" checked={twoWay} onChange={(e) => setTwoWay(e.target.checked)} data-testid="column-form-twoway" />
              Show on the other table
            </label>
            {column?.type === 'relation' && target !== existing?.target && (
              <p className="cl-colform__note">Changing the linked table clears the existing links.</p>
            )}
          </>
        )}
        {showOptions && (
          <label className="cl-colform__field">
            Options (one per line)
            <textarea
              className="cl-colform__options"
              rows={4}
              value={options}
              onChange={(e) => setOptions(e.target.value)}
              data-testid="column-form-options"
            />
          </label>
        )}
      </form>
    </Dialog>
  );
}
