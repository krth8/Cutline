// Dev-only entry for web/dev/check_cells.py: renders CellsDemo on a bare page.
import { createRoot } from 'react-dom/client';
import { CellsDemo } from '../src/tables/cells';

const params = new URLSearchParams(location.search);
const theme = params.get('theme');
if (theme) document.documentElement.setAttribute('data-theme', theme);

createRoot(document.getElementById('root')!).render(
  <div style={{ padding: 24, maxWidth: 900 }}>
    <CellsDemo />
    <button id="after-demo" style={{ marginTop: 16 }}>
      after
    </button>
  </div>,
);
