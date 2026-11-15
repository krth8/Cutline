import { useState, type FormEvent } from 'react';
import { Button, Dialog, Input } from '../../../ui';
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
];

export const isSelectType = (type: ColumnType) => type === 'select' || type === 'multiselect';

/** What the form hands back: a name, a type and (for select types) the option labels, one per line. */
export interface ColumnFormValue {
  name: string;
  type: ColumnType;
  options: string[];
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
  onSubmit,
  onClose,
}: {
  mode: ColumnFormMode;
  column?: Column;
  onSubmit(value: ColumnFormValue): Promise<void>;
  onClose(): void;
}) {
  const [name, setName] = useState(column?.name ?? '');
  const [type, setType] = useState<ColumnType>(column && column.type !== 'status' ? column.type : 'text');
  const [options, setOptions] = useState((column?.options ?? []).map((o) => o.label).join('\n'));
  const [busy, setBusy] = useState(false);
  const showType = mode !== 'rename';
  const showOptions = showType && isSelectType(type);
  const valid = mode === 'type' || name.trim() !== '';

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
