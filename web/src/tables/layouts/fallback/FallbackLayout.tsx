import { CellHost } from '../../cells';
import type { LayoutProps } from '../../types';
import { visibleColumns } from '../../viewColumns';
import './fallback.css';

function rowInGroup(value: unknown, key: string | null): boolean {
  const atoms = Array.isArray(value) ? value : value === null || value === undefined || value === '' ? [] : [value];
  if (key === null) return atoms.length === 0;
  if (typeof value === 'boolean') return String(value) === key;
  return atoms.some((a) => String(a) === key);
}

/**
 * Placeholder layout: read-only rows as a plain table (groups as headings). It exists so the view shell
 * can be used before the real layouts are written. T6 replaces it by registering 'table' again.
 */
export function FallbackLayout({ schema, view, result, loading }: LayoutProps) {
  const columns = visibleColumns(schema, view.config);
  const groupBy = view.config.query.groupBy ?? '';
  const sections = result.groups
    ? result.groups.map((g) => ({
        key: g.key ?? '(none)',
        label: `${g.label} (${g.count})`,
        rows: result.rows.filter((r) => rowInGroup(r.values[groupBy], g.key)),
      }))
    : [{ key: 'all', label: null as string | null, rows: result.rows }];

  return (
    <div className="cl-fallback" data-testid="fallback-layout" aria-busy={loading || undefined}>
      <table className="cl-fallback__table">
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c.key}>{c.name}</th>
            ))}
          </tr>
        </thead>
        {sections.map((section) => (
          <tbody key={section.key}>
            {section.label !== null && (
              <tr className="cl-fallback__group" data-testid="fallback-group">
                <th colSpan={Math.max(1, columns.length)}>{section.label}</th>
              </tr>
            )}
            {section.rows.map((row) => (
              <tr key={row.id} data-row-id={row.id}>
                {columns.map((c) => (
                  <td key={c.key}>
                    <CellHost column={c} value={row.values[c.key]} row={row} readOnly />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        ))}
      </table>
      {result.rows.length === 0 && !loading && <p className="cl-fallback__empty">No rows.</p>}
    </div>
  );
}
