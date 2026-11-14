import { useEffect, useRef, type CSSProperties, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { cx, useEscape, useFloatingPosition, useOutsidePress, useReturnFocus, type Placement } from './hooks';
import './popover.css';

export interface PopoverProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The element the popover is attached to (usually the trigger button). */
  anchorRef: RefObject<HTMLElement | null>;
  placement?: Placement;
  /** ARIA role of the floating panel. */
  role?: 'dialog' | 'menu' | 'listbox' | 'group';
  'aria-label'?: string;
  className?: string;
  style?: CSSProperties;
  children: ReactNode;
}

/**
 * A floating panel next to an anchor. Closes on Escape or a press outside, moves
 * focus into itself when it opens (unless a child already took it) and gives it
 * back to the trigger when it closes.
 */
export function Popover({
  open,
  onOpenChange,
  anchorRef,
  placement = 'bottom-start',
  role = 'dialog',
  className,
  style,
  children,
  ...aria
}: PopoverProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const pos = useFloatingPosition(open, anchorRef, panelRef, placement);

  useEscape(open, () => onOpenChange(false));
  useOutsidePress(open, [panelRef, anchorRef], () => onOpenChange(false));
  useReturnFocus(open);

  useEffect(() => {
    const panel = panelRef.current;
    if (open && panel && !panel.contains(document.activeElement)) panel.focus();
  }, [open]);

  if (!open) return null;
  return createPortal(
    <div
      ref={panelRef}
      role={role}
      tabIndex={-1}
      aria-label={aria['aria-label']}
      className={cx('cl-popover', className)}
      style={{ ...(pos ? { top: pos.top, left: pos.left } : { top: 0, left: 0, opacity: 0 }), ...style }}
    >
      {children}
    </div>,
    document.body,
  );
}
