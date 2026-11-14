import type { ReactNode } from 'react';
import { Avatar, cx } from '../../ui';
import type { Column } from '../types';
import type { CellDisplayProps } from './types';
import {
  asArray,
  avatarFor,
  describeDate,
  findOption,
  formatNumber,
  isISODate,
  readableTextColor,
  type Option,
} from './util';
import './cells.css';

export function Empty() {
  return (
    <span className="cl-cell__empty" aria-label="Empty">
      <span aria-hidden="true">&ndash;</span>
    </span>
  );
}

function Shell({ column, compact, children, align }: { column: Column; compact?: boolean | undefined; children: ReactNode; align?: 'end' }) {
  return (
    <div className={cx('cl-cell', `cl-cell--${column.type}`, compact && 'cl-cell--compact', align === 'end' && 'cl-cell--end')}>
      {children}
    </div>
  );
}

export function TextDisplay({ column, value, compact }: CellDisplayProps) {
  const text = typeof value === 'string' ? value : '';
  return (
    <Shell column={column} compact={compact}>
      {text ? (
        <span className="cl-cell__text" title={text}>
          {text}
        </span>
      ) : (
        <Empty />
      )}
    </Shell>
  );
}

export function LongTextDisplay({ column, value, compact }: CellDisplayProps) {
  const text = typeof value === 'string' ? value : '';
  return (
    <Shell column={column} compact={compact}>
      {text ? (
        <span className={cx('cl-cell__text', 'cl-cell__text--clamp')} title={text}>
          {text}
        </span>
      ) : (
        <Empty />
      )}
    </Shell>
  );
}

export function NumberDisplay({ column, value, compact }: CellDisplayProps) {
  const n = typeof value === 'number' && Number.isFinite(value) ? value : null;
  return (
    <Shell column={column} compact={compact} align="end">
      {n === null ? <Empty /> : <span className="cl-cell__text cl-cell__num">{formatNumber(n, column)}</span>}
    </Shell>
  );
}

/** Only web and mail links become clickable; "example.com" is treated as https. */
export function safeHref(value: string): string | null {
  const v = value.trim();
  if (!v) return null;
  if (/^(https?:|mailto:)/i.test(v)) return v;
  if (/^[a-z][a-z0-9+.-]*:/i.test(v)) return null;
  return `https://${v}`;
}

export function UrlDisplay({ column, value, compact }: CellDisplayProps) {
  const text = typeof value === 'string' ? value.trim() : '';
  const href = text ? safeHref(text) : null;
  return (
    <Shell column={column} compact={compact}>
      {!text ? (
        <Empty />
      ) : href ? (
        <a
          className="cl-cell__link"
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          title={text}
          onClick={(e) => e.stopPropagation()}
        >
          {text.replace(/^https?:\/\//i, '').replace(/\/$/, '')}
        </a>
      ) : (
        <span className="cl-cell__text" title={text}>
          {text}
        </span>
      )}
    </Shell>
  );
}

export function CheckboxDisplay({ column, value, compact, onToggle }: CellDisplayProps) {
  const checked = value === true;
  return (
    <Shell column={column} compact={compact}>
      <input
        type="checkbox"
        className="cl-cell__checkbox"
        checked={checked}
        disabled={!onToggle}
        aria-label={column.name}
        tabIndex={onToggle ? 0 : -1}
        onChange={(e) => onToggle?.(e.target.checked)}
        onClick={(e) => e.stopPropagation()}
      />
    </Shell>
  );
}

// ---- date -------------------------------------------------------------------------

export function showsOverdue(column: Column): boolean {
  const flag = column.config?.overdue;
  return typeof flag === 'boolean' ? flag : !column.readonly;
}

export function DateDisplay({ column, value, compact }: CellDisplayProps) {
  if (!isISODate(value)) {
    return (
      <Shell column={column} compact={compact}>
        <Empty />
      </Shell>
    );
  }
  const info = describeDate(value);
  const overdue = info.kind === 'overdue' && showsOverdue(column);
  return (
    <Shell column={column} compact={compact}>
      <span
        className={cx('cl-cell__text', 'cl-cell__date', overdue && 'is-overdue', info.kind === 'today' && 'is-today')}
        title={overdue ? `${value} (overdue)` : value}
        data-kind={overdue ? 'overdue' : info.kind}
      >
        {info.text}
      </span>
    </Shell>
  );
}

// ---- select-like ------------------------------------------------------------------

export function Pill({ option, fallback }: { option?: Option | undefined; fallback?: string }) {
  const label = option?.label ?? fallback ?? '';
  const text = option?.color ? readableTextColor(option.color) : null;
  if (option?.color && text) {
    return (
      <span className="cl-pill" style={{ background: option.color, color: text }} title={label}>
        <span className="cl-pill__label">{label}</span>
      </span>
    );
  }
  return (
    <span className="cl-pill cl-pill--neutral" title={label}>
      {option?.color && <span className="cl-pill__dot" style={{ background: option.color }} aria-hidden="true" />}
      <span className="cl-pill__label">{label}</span>
    </span>
  );
}

export function SelectDisplay({ column, value, compact }: CellDisplayProps) {
  const v = typeof value === 'string' && value ? value : null;
  return (
    <Shell column={column} compact={compact}>
      {v === null ? <Empty /> : <Pill option={findOption(column, v)} fallback={v} />}
    </Shell>
  );
}

export function MultiSelectDisplay({ column, value, compact }: CellDisplayProps) {
  const values = asArray(value);
  return (
    <Shell column={column} compact={compact}>
      {values.length === 0 ? (
        <Empty />
      ) : (
        <span className="cl-cell__pills">
          {values.map((v) => (
            <Pill key={v} option={findOption(column, v)} fallback={v} />
          ))}
        </span>
      )}
    </Shell>
  );
}

// ---- people -----------------------------------------------------------------------

function personName(column: Column, id: string): string {
  return findOption(column, id)?.label ?? 'Unknown user';
}

export function PersonDisplay({ column, value, compact }: CellDisplayProps) {
  const id = typeof value === 'string' && value ? value : null;
  const size = compact ? 18 : 22;
  return (
    <Shell column={column} compact={compact}>
      {id === null ? (
        <Empty />
      ) : (
        <span className="cl-cell__person" title={personName(column, id)}>
          <Avatar name={personName(column, id)} src={avatarFor(column, id)} size={size} />
          {!compact && <span className="cl-cell__text">{personName(column, id)}</span>}
        </span>
      )}
    </Shell>
  );
}

export function PeopleDisplay({ column, value, compact }: CellDisplayProps) {
  const ids = asArray(value);
  const max = typeof column.config?.maxAvatars === 'number' ? column.config.maxAvatars : compact ? 3 : 4;
  const shown = ids.slice(0, max);
  const extra = ids.length - shown.length;
  const size = compact ? 18 : 22;
  return (
    <Shell column={column} compact={compact}>
      {ids.length === 0 ? (
        <Empty />
      ) : (
        <span className="cl-cell__people" title={ids.map((id) => personName(column, id)).join(', ')}>
          {shown.map((id) => (
            <Avatar key={id} name={personName(column, id)} src={avatarFor(column, id)} size={size} className="cl-cell__stacked" />
          ))}
          {extra > 0 && (
            <span className="cl-cell__more" style={{ height: size, minWidth: size }} aria-label={`${extra} more`}>
              +{extra}
            </span>
          )}
          {!compact && ids.length === 1 && <span className="cl-cell__text">{personName(column, ids[0]!)}</span>}
        </span>
      )}
    </Shell>
  );
}

// ---- clip / relation / formula ----------------------------------------------------

export interface ClipValue {
  baseName: string;
  version?: number;
}

export function asClip(value: unknown): ClipValue | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Partial<ClipValue>;
  if (typeof v.baseName !== 'string' || !v.baseName) return null;
  return typeof v.version === 'number' ? { baseName: v.baseName, version: v.version } : { baseName: v.baseName };
}

export function ClipDisplay({ column, value, compact }: CellDisplayProps) {
  const clip = asClip(value);
  return (
    <Shell column={column} compact={compact}>
      {!clip ? (
        <Empty />
      ) : (
        <span className="cl-cell__clip" title={clip.version ? `${clip.baseName} v${clip.version}` : clip.baseName}>
          <span className="cl-cell__text">{clip.baseName}</span>
          {clip.version !== undefined && <span className="cl-cell__badge">v{clip.version}</span>}
        </span>
      )}
    </Shell>
  );
}

export function RelationDisplay({ column, value, compact }: CellDisplayProps) {
  const ids = asArray(value);
  return (
    <Shell column={column} compact={compact}>
      {ids.length === 0 ? <Empty /> : <span className="cl-cell__badge">{ids.length === 1 ? '1 linked row' : `${ids.length} linked rows`}</span>}
    </Shell>
  );
}

export function FormulaDisplay({ column, value, compact }: CellDisplayProps) {
  const isNum = typeof value === 'number' && Number.isFinite(value);
  const text = isNum ? formatNumber(value as number, column) : typeof value === 'boolean' ? (value ? '✓' : '✗') : typeof value === 'string' ? value : '';
  return (
    <Shell column={column} compact={compact} {...(isNum ? { align: 'end' as const } : {})}>
      {text ? (
        <span className="cl-cell__text cl-cell__formula" title={text}>
          {text}
        </span>
      ) : (
        <Empty />
      )}
    </Shell>
  );
}
