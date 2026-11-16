import { useState, type ReactNode } from 'react';
import { cx } from '../ui';

export interface SectionProps {
  title: string;
  /** Number of items. 0 collapses the section to its heading line. */
  count: number;
  testId?: string;
  /** Text of the add action ("Add subtask"); without `onAdd` there is no action. */
  addLabel?: string;
  onAdd?: () => void;
  /** Keep the content shown although there are no items yet (an add row is open). */
  forceOpen?: boolean;
  /** The count as shown next to the title when it is not a plain number ("1/3"). */
  countText?: string;
  children: ReactNode;
}

/**
 * A quiet heading with a count and an add action on the heading line. With no items it is just that line;
 * with items the heading folds the list away and back.
 */
export function Section({ title, count, testId, addLabel, onAdd, forceOpen, countText, children }: SectionProps) {
  const [folded, setFolded] = useState(false);
  const hasContent = count > 0 || !!forceOpen;
  const open = hasContent && !folded;
  return (
    <section className={cx('cl-sec', open && 'is-open')} aria-label={title} data-testid={testId}>
      <div className="cl-sec__head">
        {count > 0 ? (
          <button type="button" className="cl-sec__toggle" aria-expanded={open} onClick={() => setFolded((f) => !f)}>
            <span className="cl-sec__caret" aria-hidden="true">
              {open ? '▾' : '▸'}
            </span>
            <h3 className="cl-sec__title">{title}</h3>
            <span className="cl-sec__count">{countText ?? count}</span>
          </button>
        ) : (
          <div className="cl-sec__toggle is-static">
            <h3 className="cl-sec__title">{title}</h3>
          </div>
        )}
        {onAdd ? (
          <button
            type="button"
            className="cl-sec__add"
            aria-label={addLabel ?? `Add to ${title}`}
            title={addLabel ?? `Add to ${title}`}
            onClick={() => {
              setFolded(false);
              onAdd();
            }}
          >
            {'＋'}
          </button>
        ) : null}
      </div>
      {open ? <div className="cl-sec__body">{children}</div> : null}
    </section>
  );
}
