import { createContext, useContext, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { cx, useEscape } from '../ui/hooks';
import { clampWidth, usePanelWidth } from './usePanelWidth';
import './task.css';

interface PanelContextValue {
  /** Wide reading mode: the panel is centred and about 880 px wide. */
  wide: boolean;
  toggleWide(): void;
  close(): void;
}

const PanelContext = createContext<PanelContextValue>({ wide: false, toggleWide: () => {}, close: () => {} });
export const usePanel = () => useContext(PanelContext);

/** The row element on the page behind the panel (not the panel's own subtask list). */
function rowBehind(rowId: string | null): HTMLElement | null {
  if (!rowId) return null;
  const found = document.querySelectorAll<HTMLElement>('[data-row-id]');
  return [...found].find((el) => el.dataset.rowId === rowId && !el.closest('.cl-task')) ?? null;
}

export interface PanelShellProps {
  /** Accessible name of the region ("Task", "Row"). */
  label: string;
  testId: string;
  /** Attribute that carries the id of what is shown (`data-task-id`, `data-row-id`). */
  idAttr: 'data-task-id' | 'data-row-id';
  /** Id of the shown row; when the panel closes, focus goes back to that row on the page, else to where it was. */
  rowId: string;
  onClose: () => void;
  className?: string;
  children: ReactNode;
}

/**
 * The frame of the task panel and the row panel: a right-hand region over the current route that leaves the page
 * usable (no dimming), is resized by dragging its left edge (the width is remembered) and can switch to a wide
 * centred reading mode. Escape closes it; focus moves in when it opens and back to the row when it closes.
 */
export function PanelShell({ label, testId, idAttr, rowId, onClose, className, children }: PanelShellProps) {
  const { width, setWidth, remember } = usePanelWidth();
  const [wide, setWide] = useState(false);
  const [resizing, setResizing] = useState(false);
  const ref = useRef<HTMLElement>(null);
  const swallowEscape = useRef(false);
  const rowIdRef = useRef(rowId);
  rowIdRef.current = rowId;

  // Focus into the panel on open; back to the row (or whatever had focus) on close
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    ref.current?.focus({ preventScroll: true });
    return () => {
      const target = rowBehind(rowIdRef.current) ?? (opener && opener.isConnected ? opener : null);
      target?.focus({ preventScroll: true });
    };
  }, []);

  // Escape closes the panel, unless it was meant for a field or an open editor: that first Escape only leaves it.
  // useEscape keeps the order with popovers and dialogs (the innermost layer gets the key).
  useEscape(true, () => {
    if (swallowEscape.current) {
      swallowEscape.current = false;
      const active = document.activeElement as HTMLElement | null;
      if (active && active.matches('input, textarea, select, [contenteditable]')) active.blur();
      return;
    }
    onClose();
  });

  function startResize(e: ReactPointerEvent<HTMLDivElement>) {
    if (e.button !== 0) return;
    e.preventDefault();
    const handle = e.currentTarget;
    handle.setPointerCapture(e.pointerId);
    const startX = e.clientX;
    const startWidth = width;
    let last = width;
    setResizing(true);
    const move = (ev: PointerEvent) => {
      last = clampWidth(startWidth + (startX - ev.clientX));
      setWidth(last);
    };
    const up = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
      handle.removeEventListener('pointercancel', up);
      setResizing(false);
      remember(last);
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
    handle.addEventListener('pointercancel', up);
  }

  function resizeKey(e: ReactKeyboardEvent<HTMLDivElement>) {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    remember(width + (e.key === 'ArrowLeft' ? 24 : -24));
  }

  const value: PanelContextValue = { wide, toggleWide: () => setWide((w) => !w), close: onClose };

  return createPortal(
    <PanelContext.Provider value={value}>
      {wide ? <div className="cl-task__scrim" data-testid="panel-scrim" onMouseDown={() => setWide(false)} /> : null}
      <aside
        ref={ref}
        tabIndex={-1}
        className={cx('cl-task', wide && 'is-wide', resizing && 'is-resizing', className)}
        style={{ ['--cl-task-w' as string]: `${width}px` }}
        aria-label={label}
        data-testid={testId}
        {...{ [idAttr]: rowId }}
        onKeyDownCapture={(e) => {
          if (e.key !== 'Escape') return;
          const target = e.target as HTMLElement;
          swallowEscape.current = !!target.closest('.is-editing, input, textarea, select, [contenteditable]');
          setTimeout(() => (swallowEscape.current = false), 0);
        }}
      >
        {wide ? null : (
          <div
            className="cl-task__resize"
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize panel"
            aria-valuenow={width}
            tabIndex={0}
            data-testid="panel-resize"
            onPointerDown={startResize}
            onKeyDown={resizeKey}
          />
        )}
        {children}
      </aside>
    </PanelContext.Provider>,
    document.body,
  );
}

/** The panel's body while the row loads: the shape of the real thing, so nothing jumps when it arrives. */
export function PanelSkeleton({ label }: { label: string }) {
  return (
    <div className="cl-task__skeleton" aria-busy="true" aria-label={label} data-testid="panel-skeleton">
      <div className="cl-skel cl-skel--crumb" />
      <div className="cl-skel cl-skel--title" />
      <div className="cl-skel__props">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="cl-skel__prop">
            <div className="cl-skel cl-skel--label" />
            <div className="cl-skel cl-skel--value" />
          </div>
        ))}
      </div>
      <div className="cl-skel cl-skel--line" />
      <div className="cl-skel cl-skel--line cl-skel--short" />
    </div>
  );
}

/** "Not available" and "Could not load" states, with a way out. */
export function Unavailable({ message, onClose, onRetry }: { message: string; onClose: () => void; onRetry?: () => void }) {
  return (
    <div className="cl-task__state" data-testid="task-unavailable">
      <p>{message}</p>
      <div className="cl-task__statebtns">
        {onRetry ? (
          <button type="button" className="cl-task__link" onClick={onRetry}>
            Try again
          </button>
        ) : null}
        <button type="button" className="cl-task__link" onClick={onClose}>
          Close
        </button>
      </div>
    </div>
  );
}
