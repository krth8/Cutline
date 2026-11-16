import { useCallback, useState } from 'react';

export const DEFAULT_WIDTH = 540;
export const MIN_WIDTH = 380;
export const MAX_WIDTH = 900;
const KEY = 'cutline.taskPanel.width';

/** Keeps the width inside the limits and leaves some of the page visible on small screens. */
export function clampWidth(width: number, viewport = window.innerWidth): number {
  const max = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, viewport - 240));
  return Math.round(Math.min(max, Math.max(MIN_WIDTH, width)));
}

function readStored(): number {
  try {
    const n = Number(window.localStorage.getItem(KEY));
    return Number.isFinite(n) && n > 0 ? clampWidth(n) : DEFAULT_WIDTH;
  } catch {
    return DEFAULT_WIDTH;
  }
}

/** The panel width: remembered per browser (localStorage may be unavailable, then it is only kept for this session). */
export function usePanelWidth(): { width: number; setWidth: (w: number) => void; remember: (w: number) => void } {
  const [width, setWidthState] = useState(readStored);
  const setWidth = useCallback((w: number) => setWidthState(clampWidth(w)), []);
  const remember = useCallback((w: number) => {
    const clamped = clampWidth(w);
    setWidthState(clamped);
    try {
      window.localStorage.setItem(KEY, String(clamped));
    } catch {
      /* storage is blocked or full: the width still applies for this session */
    }
  }, []);
  return { width, setWidth, remember };
}
