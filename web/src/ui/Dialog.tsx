import { useEffect, useId, useRef, type KeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { cx, focusableIn, useEscape, useReturnFocus } from './hooks';
import './dialog.css';

export interface DialogProps {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  /** Buttons row at the bottom. */
  footer?: ReactNode;
  /** Close when the backdrop is pressed (default true). */
  dismissOnBackdrop?: boolean;
  className?: string;
}

/** A modal dialog: traps Tab, closes on Escape or backdrop press, restores focus on close. */
export function Dialog({ open, onClose, title, children, footer, dismissOnBackdrop = true, className }: DialogProps) {
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement>(null);

  useEscape(open, onClose);
  useReturnFocus(open);

  useEffect(() => {
    const panel = panelRef.current;
    if (!open || !panel) return;
    // Prefer the first field in the body over the close button
    const target = panel.querySelector<HTMLElement>('.cl-dialog__body input, .cl-dialog__body textarea, .cl-dialog__body select, .cl-dialog__body button');
    (target ?? focusableIn(panel)[0] ?? panel).focus();
  }, [open]);

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key !== 'Tab' || !panelRef.current) return;
    const items = focusableIn(panelRef.current);
    if (!items.length) {
      e.preventDefault();
      return;
    }
    const first = items[0]!;
    const last = items[items.length - 1]!;
    const active = document.activeElement;
    if (e.shiftKey && (active === first || active === panelRef.current)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
  }

  if (!open) return null;
  return createPortal(
    <div
      className="cl-dialog__backdrop"
      onMouseDown={(e) => {
        if (dismissOnBackdrop && e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className={cx('cl-dialog', className)}
        onKeyDown={onKeyDown}
      >
        <div className="cl-dialog__header">
          <h2 id={titleId} className="cl-dialog__title">
            {title}
          </h2>
          <button type="button" className="cl-dialog__close" aria-label="Close" onClick={onClose}>
            &times;
          </button>
        </div>
        <div className="cl-dialog__body">{children}</div>
        {footer && <div className="cl-dialog__footer">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}
