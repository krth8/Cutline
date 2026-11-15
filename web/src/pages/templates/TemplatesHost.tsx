import { useEffect, useState } from 'react';
import { getPlatform } from '../../platform';
import { registerCommand } from '../../search/commands';
import { OPEN_TEMPLATES_EVENT, openTemplates, type OpenTemplatesDetail } from './actions';
import { TemplateDialog } from './TemplateDialog';

/** The space a command should create pages in: the open project when the user may write there, else the personal space. */
function targetSpace(ctx: { projectId: string | null; projects: Array<{ id: string; canTasks: boolean }> }) {
  const project = ctx.projects.find((p) => p.id === ctx.projectId);
  return project?.canTasks ? (`p:${project.id}` as const) : ('me' as const);
}

/** Palette commands that open the dialog. Registering twice only replaces them. */
export function registerTemplateCommands(): void {
  registerCommand({
    id: 'new-from-template',
    title: 'New from template...',
    keywords: ['create', 'page', 'template', 'meeting notes', 'shot list'],
    run: (ctx) => openTemplates({ space: targetSpace(ctx) }),
  });
  registerCommand({
    id: 'manage-templates',
    title: 'Manage templates...',
    keywords: ['delete', 'template'],
    run: (ctx) => openTemplates({ space: targetSpace(ctx), manage: true }),
  });
}

/** Always mounted next to the palette: opens the template dialog when something fires OPEN_TEMPLATES_EVENT. */
export function TemplatesHost() {
  const [state, setState] = useState<OpenTemplatesDetail | null>(null);

  useEffect(() => {
    const onOpen = (e: Event) => {
      if (getPlatform().user() === null) return;
      setState((e as CustomEvent<OpenTemplatesDetail>).detail);
    };
    window.addEventListener(OPEN_TEMPLATES_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_TEMPLATES_EVENT, onOpen);
  }, []);

  if (!state) return null;
  return (
    <TemplateDialog
      open
      onClose={() => setState(null)}
      space={state.space}
      {...(state.parentId ? { parentId: state.parentId } : {})}
      {...(state.manage ? { manage: true } : {})}
    />
  );
}
