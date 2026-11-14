// Dev-only entry (not part of pages.js): renders the two-editor demo for web/dev/check_editor.py.
import { createRoot } from 'react-dom/client';
import { EditorDemo } from '../src/pages/editor/testing/EditorDemo';

(window as unknown as { __demoReady: boolean }).__demoReady = false;
createRoot(document.getElementById('root')!).render(<EditorDemo />);
(window as unknown as { __demoReady: boolean }).__demoReady = true;
