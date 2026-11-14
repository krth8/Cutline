import { cloneElement, useEffect, useId, useRef, useState, type ReactElement, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useFloatingPosition } from './hooks';
import './tooltip.css';

export interface TooltipProps {
  content: ReactNode;
  /** Delay before showing on hover, in ms (focus shows it immediately). */
  delay?: number;
  placement?: 'top' | 'bottom';
  /** The one element the tooltip describes; it must accept ref, event handlers and aria-describedby. */
  children: ReactElement<any>;
}

export function Tooltip({ content, delay = 400, placement = 'top', children }: TooltipProps) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLElement | null>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const pos = useFloatingPosition(open, anchorRef, tipRef, placement);

  useEffect(() => () => clearTimeout(timer.current), []);

  // Escape hides the tip without moving focus
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  const show = (wait: number) => {
    clearTimeout(timer.current);
    if (wait <= 0) setOpen(true);
    else timer.current = setTimeout(() => setOpen(true), wait);
  };
  const hide = () => {
    clearTimeout(timer.current);
    setOpen(false);
  };

  const child = children;
  const trigger = cloneElement(child, {
    ref: (el: HTMLElement | null) => {
      anchorRef.current = el;
      const original = (child as any).ref;
      if (typeof original === 'function') original(el);
      else if (original) original.current = el;
    },
    'aria-describedby': open ? id : child.props['aria-describedby'],
    onMouseEnter: (e: unknown) => {
      child.props.onMouseEnter?.(e);
      show(delay);
    },
    onMouseLeave: (e: unknown) => {
      child.props.onMouseLeave?.(e);
      hide();
    },
    onFocus: (e: unknown) => {
      child.props.onFocus?.(e);
      show(0);
    },
    onBlur: (e: unknown) => {
      child.props.onBlur?.(e);
      hide();
    },
  });

  return (
    <>
      {trigger}
      {open &&
        createPortal(
          <div
            ref={tipRef}
            id={id}
            role="tooltip"
            className="cl-tooltip"
            style={pos ? { top: pos.top, left: pos.left } : { top: 0, left: 0, opacity: 0 }}
          >
            {content}
          </div>,
          document.body,
        )}
    </>
  );
}
