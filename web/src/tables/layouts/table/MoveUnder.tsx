import { useState } from 'react';
import { Button, Dialog } from '../../../ui';
import type { Row } from '../../types';

/**
 * "Move under...": pick another row (or the top level) as the parent of one row. The choices are the rows
 * the table has loaded; the server refuses a row's own descendants and rows of another project.
 */
export function MoveUnder({
  row,
  candidates,
  titleKey,
  onMove,
  onClose,
}: {
  row: Row;
  candidates: readonly Row[];
  titleKey: string;
  onMove(parentId: string | null): Promise<void>;
  onClose(): void;
}) {
  const options = candidates.filter((c) => c.id !== row.id && c.tableRef === row.tableRef);
  const [target, setTarget] = useState<string>(row.parentId ?? '');
  const [busy, setBusy] = useState(false);

  async function move() {
    setBusy(true);
    try {
      await onMove(target || null);
      onClose();
    } catch {
      setBusy(false); // the store has shown the error
    }
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title="Move under"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={busy} onClick={() => void move()} data-testid="move-under-submit">
            Move
          </Button>
        </>
      }
    >
      <label className="cl-colform__field">
        New parent
        <select className="cl-table__select" value={target} onChange={(e) => setTarget(e.target.value)} data-testid="move-under-select">
          <option value="">(top level)</option>
          {options.map((c) => (
            <option key={c.id} value={c.id}>
              {String(c.values[titleKey] ?? 'Untitled')}
            </option>
          ))}
        </select>
      </label>
    </Dialog>
  );
}
