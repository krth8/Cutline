import { useMemo } from 'react';
import { CellHost } from '../cells';
import type { Query } from '../types';
import { useViewQuery } from './hooks';

/**
 * Lists the rows of a table with inline rename, new row and delete. A smoke test of the store
 * and a seed for /dev/ui; real layouts take the same data from useView.
 */
export function StoreDemo({ tableRef, projectId, query }: { tableRef: string; projectId?: string; query?: Query }) {
  const descriptor = useMemo(
    () => ({ id: 'store-demo', tableRef, layout: 'table' as const, config: { query: query ?? {} } }),
    [tableRef, query],
  );
  const { schema, result, loading, refreshing, error, actions } = useViewQuery(descriptor);
  const titleKey = schema?.titleColumn ?? 'name';
  const titleColumn = schema?.columns.find((c) => c.key === titleKey);

  return (
    <div data-testid="store-demo" data-refreshing={refreshing ? 'true' : 'false'}>
      {error && <div role="alert">{error.message}</div>}
      {loading && <div>Loading...</div>}
      <ul style={{ listStyle: 'none', padding: 0 }}>
        {result?.rows.map((row) => (
          <li key={row.id} data-row-id={row.id} style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            {titleColumn && (
              <CellHost
                column={titleColumn}
                value={row.values[titleKey]}
                row={row}
                onChange={(v) => void actions.updateRow(row.id, { [titleKey]: v })}
              />
            )}
            <button type="button" aria-label="Delete" onClick={() => void actions.deleteRows([row.id])}>
              x
            </button>
          </li>
        ))}
      </ul>
      <button
        type="button"
        data-testid="store-demo-add"
        onClick={() => void actions.createRow({ [titleKey]: 'New row' }, projectId ? { projectId } : undefined).catch(() => {})}
      >
        Add row
      </button>
      <span data-testid="store-demo-total"> {result?.total ?? 0} rows</span>
    </div>
  );
}
