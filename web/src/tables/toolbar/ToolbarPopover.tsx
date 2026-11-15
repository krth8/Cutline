import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Button, cx } from '../../ui';
import { useEscape, useFloatingPosition } from '../../ui/hooks';

/**
 * A toolbar button that opens a panel; `count` shows how many things are set in it.
 *
 * The panel is not a ui Popover: it holds cell editors that open popovers of their own, and a press inside
 * one of those must not close the panel. A press counts as outside unless it lands in the panel, on the
 * button, or in any other `.cl-popover` (a nested editor).
 */
export function ToolbarPopover({
  label,
  count = 0,
  testId,
  panelClassName,
  children,
}: {
  label: string;
  count?: number;
  testId: string;
  panelClassName?: string;
  children: ReactNode;
}) {
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const pos = useFloatingPosition(open, buttonRef, panelRef, 'bottom-start');

  useEscape(open, () => setOpen(false));

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Element | null;
      if (!target) return;
      if (panelRef.current?.contains(target) || buttonRef.current?.contains(target)) return;
      if (target.closest('.cl-popover')) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  return (
    <>
      <Button
        ref={buttonRef}
        size="sm"
        variant="ghost"
        className={cx('cl-toolbar__btn', count > 0 && 'is-set')}
        aria-haspopup="dialog"
        aria-expanded={open}
        data-testid={`toolbar-${testId}`}
        onClick={() => setOpen((o) => !o)}
      >
        {label}
        {count > 0 && <span className="cl-toolbar__count">{count}</span>}
      </Button>
      {open &&
        createPortal(
          <div
            ref={panelRef}
            role="dialog"
            aria-label={label}
            tabIndex={-1}
            className={cx('cl-toolbar__panel', panelClassName)}
            data-testid={`panel-${testId}`}
            style={pos ? { top: pos.top, left: pos.left } : { top: 0, left: 0, opacity: 0 }}
          >
            {children}
          </div>,
          document.body,
        )}
    </>
  );
}
