import { useEffect, useState } from 'react';
import { getPlatform } from '../platform';
import { Palette } from './Palette';

/** Fired on `window` to open the palette (the search buttons of the sidebar and of the legacy top bar). */
export const OPEN_SEARCH_EVENT = 'cutline:open-search';

/** Ask the palette to open. Harmless when nobody is logged in. */
export function openSearch(): void {
  window.dispatchEvent(new CustomEvent(OPEN_SEARCH_EVENT));
}

/**
 * Always mounted (see mount.tsx): opens the palette on Ctrl+K / Cmd+K, wherever the user is in the app.
 * A key that something else already handled (`defaultPrevented`) is left alone: inside the page editor Ctrl+K
 * is the link shortcut when text is selected or the cursor is in a link, and the editor says so by
 * preventing the event before it reaches us.
 */
export function PaletteHost() {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const signedIn = () => getPlatform().user() !== null; // null for guests too
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.altKey || e.shiftKey || !(e.ctrlKey || e.metaKey)) return;
      if (e.key.toLowerCase() !== 'k' || !signedIn()) return;
      e.preventDefault();
      setOpen((o) => !o);
    };
    const onOpen = () => {
      if (signedIn()) setOpen(true);
    };
    document.addEventListener('keydown', onKey);
    window.addEventListener(OPEN_SEARCH_EVENT, onOpen);
    return () => {
      document.removeEventListener('keydown', onKey);
      window.removeEventListener(OPEN_SEARCH_EVENT, onOpen);
    };
  }, []);

  return <Palette open={open} onClose={() => setOpen(false)} />;
}
