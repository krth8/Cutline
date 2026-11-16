import { createRoot, type Root } from 'react-dom/client';
import { registerBuiltinCommands } from './builtins';
import { registerTemplateCommands, TemplatesHost } from '../pages/templates';
import { PaletteHost } from './PaletteHost';

let root: Root | null = null;

/**
 * Mount the palette in a small root of its own on the page, so Ctrl+K works on every legacy tab as well
 * (Review, Projects, Lounge), where the Pages shell is not mounted. Calling it again does nothing.
 */
export function mountSearch(): void {
  if (root) return;
  registerBuiltinCommands();
  registerTemplateCommands();
  const host = document.createElement('div');
  host.id = 'cl-search-root';
  document.body.appendChild(host);
  root = createRoot(host);
  root.render(
    <>
      <PaletteHost />
      <TemplatesHost />
    </>,
  );
}
