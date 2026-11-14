import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { cx } from './hooks';
import './datepicker.css';

export interface DatePickerProps {
  /** Selected day as "YYYY-MM-DD", or null. */
  value: string | null;
  onChange: (value: string | null) => void;
  /** 0 = Sunday, 1 = Monday (default). */
  weekStartsOn?: 0 | 1;
  /** Show a "Clear" button (default true). */
  clearable?: boolean;
  /** Show a "Today" button (default true). */
  showToday?: boolean;
  className?: string;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const pad = (n: number) => String(n).padStart(2, '0');
export const toISODate = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

export function parseISODate(value: string | null): Date | null {
  const m = value ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(value) : null;
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return toISODate(d) === value ? d : null;
}

const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const addMonths = (d: Date, n: number) => {
  // Clamp the day so Jan 31 + 1 month is Feb 28, not March 3
  const target = new Date(d.getFullYear(), d.getMonth() + n, 1);
  const last = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
  return new Date(target.getFullYear(), target.getMonth(), Math.min(d.getDate(), last));
};

/** An inline month calendar. Wrap it in a Popover to use it as a field. */
export function DatePicker({ value, onChange, weekStartsOn = 1, clearable = true, showToday = true, className }: DatePickerProps) {
  const selected = parseISODate(value);
  const [focused, setFocused] = useState<Date>(() => selected ?? new Date());
  const gridRef = useRef<HTMLDivElement>(null);
  const moveFocus = useRef(false);

  // Follow the value when it changes from outside
  useEffect(() => {
    const d = parseISODate(value);
    if (d) setFocused(d);
  }, [value]);

  useEffect(() => {
    if (!moveFocus.current) return;
    moveFocus.current = false;
    gridRef.current?.querySelector<HTMLElement>('[tabindex="0"]')?.focus();
  }, [focused]);

  const year = focused.getFullYear();
  const month = focused.getMonth();
  const first = new Date(year, month, 1);
  const offset = (first.getDay() - weekStartsOn + 7) % 7;
  const cells = Array.from({ length: 42 }, (_, i) => addDays(first, i - offset));
  const weekdays = Array.from({ length: 7 }, (_, i) => DAYS[(i + weekStartsOn) % 7]!);
  const todayISO = toISODate(new Date());
  const selectedISO = selected ? toISODate(selected) : null;
  const focusedISO = toISODate(focused);

  function go(next: Date, keyboard = false) {
    moveFocus.current = keyboard;
    setFocused(next);
  }

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    const weekday = (focused.getDay() - weekStartsOn + 7) % 7;
    const moves: Record<string, Date> = {
      ArrowLeft: addDays(focused, -1),
      ArrowRight: addDays(focused, 1),
      ArrowUp: addDays(focused, -7),
      ArrowDown: addDays(focused, 7),
      PageUp: addMonths(focused, -1),
      PageDown: addMonths(focused, 1),
      Home: addDays(focused, -weekday),
      End: addDays(focused, 6 - weekday),
    };
    const next = moves[e.key];
    if (next) {
      e.preventDefault();
      go(next, true);
    }
  }

  return (
    <div className={cx('cl-datepicker', className)}>
      <div className="cl-datepicker__header">
        <button type="button" className="cl-datepicker__nav" aria-label="Previous month" onClick={() => go(addMonths(focused, -1))}>
          &lsaquo;
        </button>
        <div className="cl-datepicker__title" aria-live="polite">
          {MONTHS[month]} {year}
        </div>
        <button type="button" className="cl-datepicker__nav" aria-label="Next month" onClick={() => go(addMonths(focused, 1))}>
          &rsaquo;
        </button>
      </div>
      <div ref={gridRef} role="grid" aria-label={`${MONTHS[month]} ${year}`} onKeyDown={onKeyDown}>
        <div role="row" className="cl-datepicker__row">
          {weekdays.map((d) => (
            <div key={d} role="columnheader" className="cl-datepicker__weekday">
              {d}
            </div>
          ))}
        </div>
        {Array.from({ length: 6 }, (_, w) => (
          <div role="row" className="cl-datepicker__row" key={w}>
            {cells.slice(w * 7, w * 7 + 7).map((d) => {
              const iso = toISODate(d);
              return (
                <div role="gridcell" key={iso} aria-selected={iso === selectedISO}>
                  <button
                    type="button"
                    tabIndex={iso === focusedISO ? 0 : -1}
                    aria-label={`${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`}
                    aria-current={iso === todayISO ? 'date' : undefined}
                    className={cx(
                      'cl-datepicker__day',
                      d.getMonth() !== month && 'is-outside',
                      iso === todayISO && 'is-today',
                      iso === selectedISO && 'is-selected',
                    )}
                    onClick={() => onChange(iso)}
                  >
                    {d.getDate()}
                  </button>
                </div>
              );
            })}
          </div>
        ))}
      </div>
      {(showToday || clearable) && (
        <div className="cl-datepicker__footer">
          {showToday && (
            <button type="button" className="cl-datepicker__link" onClick={() => onChange(todayISO)}>
              Today
            </button>
          )}
          {clearable && (
            <button type="button" className="cl-datepicker__link" disabled={!value} onClick={() => onChange(null)}>
              Clear
            </button>
          )}
        </div>
      )}
    </div>
  );
}
