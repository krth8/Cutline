import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';

export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function focusableIn(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE));
}

/** While `active`, remember what had focus and give it back when `active` turns false or on unmount. */
export function useReturnFocus(active: boolean): void {
  useEffect(() => {
    if (!active) return;
    const previous = document.activeElement as HTMLElement | null;
    return () => {
      if (previous && previous.isConnected) previous.focus();
    };
  }, [active]);
}

/** Calls `onEscape` when Escape is pressed anywhere while `active` (innermost layer wins). */
const escapeStack: Array<() => void> = [];
export function useEscape(active: boolean, onEscape: () => void): void {
  const ref = useRef(onEscape);
  ref.current = onEscape;
  useEffect(() => {
    if (!active) return;
    const layer = () => ref.current();
    escapeStack.push(layer);
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || escapeStack[escapeStack.length - 1] !== layer) return;
      e.stopPropagation();
      layer();
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      const i = escapeStack.indexOf(layer);
      if (i >= 0) escapeStack.splice(i, 1);
    };
  }, [active]);
}

/** Calls `onOutside` for a pointer press outside every given element. */
export function useOutsidePress(
  active: boolean,
  refs: Array<RefObject<HTMLElement | null>>,
  onOutside: () => void,
): void {
  const cb = useRef(onOutside);
  cb.current = onOutside;
  const list = useRef(refs);
  list.current = refs;
  useEffect(() => {
    if (!active) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (list.current.some((r) => r.current?.contains(target))) return;
      cb.current();
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [active]);
}

export type Placement = 'bottom-start' | 'bottom-end' | 'top-start' | 'top-end' | 'top' | 'bottom';

export interface Position {
  top: number;
  left: number;
}

/** Fixed position for a floating element next to an anchor; flips vertically and clamps to the viewport. */
export function computePosition(anchor: DOMRect, floating: { width: number; height: number }, placement: Placement, gap = 6): Position {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  let vertical: 'top' | 'bottom' = placement.startsWith('top') ? 'top' : 'bottom';
  const fitsBelow = anchor.bottom + gap + floating.height <= vh;
  const fitsAbove = anchor.top - gap - floating.height >= 0;
  if (vertical === 'bottom' && !fitsBelow && fitsAbove) vertical = 'top';
  else if (vertical === 'top' && !fitsAbove && fitsBelow) vertical = 'bottom';
  const top = vertical === 'bottom' ? anchor.bottom + gap : anchor.top - gap - floating.height;
  let left: number;
  if (placement.endsWith('end')) left = anchor.right - floating.width;
  else if (placement === 'top' || placement === 'bottom') left = anchor.left + anchor.width / 2 - floating.width / 2;
  else left = anchor.left;
  left = Math.max(8, Math.min(left, vw - floating.width - 8));
  return { top: Math.max(8, top), left };
}

/** Measures the floating element after render and positions it relative to the anchor. */
export function useFloatingPosition(
  open: boolean,
  anchorRef: RefObject<HTMLElement | null>,
  floatingRef: RefObject<HTMLElement | null>,
  placement: Placement,
): Position | null {
  const [pos, setPos] = useState<Position | null>(null);
  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    const update = () => {
      const anchor = anchorRef.current;
      const floating = floatingRef.current;
      if (!anchor || !floating) return;
      const rect = floating.getBoundingClientRect();
      setPos(computePosition(anchor.getBoundingClientRect(), { width: rect.width, height: rect.height }, placement));
    };
    update();
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    return () => {
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
    };
  }, [open, anchorRef, floatingRef, placement]);
  return pos;
}
