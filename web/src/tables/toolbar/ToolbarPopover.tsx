import { useEffect, useRef, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { cx } from '../../ui';
import { useEscape, useFloatingPosition } from '../../ui/hooks';

/**
 * The floating panel of a view option (filter, sort, group, columns, summaries), attached to `anchorRef`
 * (the button or chip that opened it, or the "..." button when it was chosen from the menu).
 *
 * The panel is not a ui Popover: it holds cell editors that open popovers of their own, and a press inside
 * one of those must not close the panel. A press counts as outside unless it lands in the panel, on the
 * anchor, or in any other `.cl-popover` (a nested editor).
 */
export function ToolbarPanel({
  open,
  label,
  testId,
  anchorRef,
  onClose,
  wide,
  children,
}: {
  open: boolean;
  label: string;
  testId: string;
  anchorRef: RefObject<HTMLElement | null>;
  onClose: () => void;
  wide?: boolean;
  children: ReactNode;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const pos = useFloatingPosition(open, anchorRef, panelRef, 'bottom-start');

  useEscape(open, onClose);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Element | null;
      if (!target) return;
      if (panelRef.current?.contains(target) || anchorRef.current?.contains(target)) return;
      if (target.closest('.cl-popover')) return;
      onClose();
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open, anchorRef, onClose]);

  if (!open) return null;
  return createPortal(
    <div
      ref={panelRef}
      role="dialog"
      aria-label={label}
      tabIndex={-1}
      className={cx('cl-viewbar__panel', wide && 'cl-viewbar__panel--wide')}
      data-testid={`panel-${testId}`}
      style={pos ? { top: pos.top, left: pos.left } : { top: 0, left: 0, opacity: 0 }}
    >
      {children}
    </div>,
    document.body,
  );
}
