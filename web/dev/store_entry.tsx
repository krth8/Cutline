// Dev-only entry for web/dev/check_store.py: exposes StoreDemo on window so the check can mount it
// inside the real, logged-in app (real platform bridge, real server, real live events).
import { createRoot } from 'react-dom/client';
import { StoreDemo } from '../src/tables/store';

(window as unknown as Record<string, unknown>).StoreDemoMount = (el: HTMLElement, tableRef: string) => {
  createRoot(el).render(<StoreDemo tableRef={tableRef} />);
};
