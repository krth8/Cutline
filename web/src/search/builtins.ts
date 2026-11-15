/** The commands that ship with the palette. Each one calls an existing function or API. */
import { createPage } from '../api/pageTree';
import { createRow } from '../api/tables';
import { setHomePage } from '../pages/home/homeStore';
import { getPlatform } from '../platform';
import { buildRoute, navigate } from '../router';
import { cycleTheme, THEME_LABELS } from '../theme';
import { registerCommand, registerCommandProvider, type Command } from './commands';
import { openTaskById } from './navigate';

function message(e: unknown): string {
  return e instanceof Error ? e.message : 'Something went wrong';
}

/** Flip the "old task list" switch of this browser and reload at the matching address. */
function toggleOldTaskList(projectId: string | null): void {
  try {
    localStorage.setItem('legacyTasks', localStorage.getItem('legacyTasks') === '1' ? '0' : '1');
  } catch {
    /* storage unavailable: the switch cannot be remembered */
  }
  window.location.href = projectId ? buildRoute({ kind: 'projectTasks', projectId }) : '/';
}

/** One Review, Tasks and Pages command per accessible project. */
const projectCommands = (ctx: { projects: Array<{ id: string; name: string; canTasks: boolean }> }): Command[] =>
  ctx.projects.flatMap((p) => {
    const list: Command[] = [
      {
        id: `go-review:${p.id}`,
        title: `Go to ${p.name}: Review`,
        keywords: ['review', 'project'],
        run: () => navigate({ kind: 'review', projectId: p.id }),
      },
    ];
    if (p.canTasks) {
      list.push({
        id: `go-tasks:${p.id}`,
        title: `Go to ${p.name}: Tasks`,
        keywords: ['tasks', 'project'],
        run: () => navigate({ kind: 'projectTasks', projectId: p.id }),
      });
    }
    list.push({
      id: `go-pages:${p.id}`,
      title: `Go to ${p.name}: Pages`,
      keywords: ['pages', 'project'],
      run: () => navigate({ kind: 'projectPages', projectId: p.id }),
    });
    return list;
  });

/** Register the built-in commands. Registering twice only replaces them (ids are stable). */
export function registerBuiltinCommands(): void {
  registerCommand({
    id: 'new-page',
    title: 'New page',
    keywords: ['create', 'add', 'document'],
    async run(ctx) {
      // A project's pages when the user may write there, otherwise the personal space
      const project = ctx.projects.find((p) => p.id === ctx.projectId);
      const space = project?.canTasks ? (`p:${project.id}` as const) : 'me';
      try {
        const page = await createPage(space, {});
        navigate(
          space === 'me' || !project
            ? { kind: 'mePage', pageId: page.id }
            : { kind: 'projectPage', projectId: project.id, pageId: page.id },
        );
      } catch (e) {
        getPlatform().toast('error', `Could not create the page: ${message(e)}`);
      }
    },
  });

  registerCommand({
    id: 'new-task',
    title: 'New task',
    keywords: ['create', 'add', 'todo'],
    when: (ctx) => ctx.projects.some((p) => p.id === ctx.projectId && p.canTasks),
    async run(ctx) {
      const projectId = ctx.projectId;
      if (!projectId) return;
      try {
        const row = await createRow(`tasks:${projectId}`, { values: { name: 'New task' }, projectId });
        openTaskById(row.id, projectId);
      } catch (e) {
        getPlatform().toast('error', `Could not create the task: ${message(e)}`);
      }
    },
  });

  registerCommand({ id: 'go-home', title: 'Go to Home', keywords: ['dashboard', 'start'], run: () => navigate({ kind: 'home' }) });
  registerCommand({
    id: 'go-me',
    title: 'Go to Personal space',
    keywords: ['me', 'private', 'my pages'],
    run: () => navigate({ kind: 'me' }),
  });
  registerCommandProvider('projects', projectCommands);

  registerCommand({
    id: 'set-home',
    title: 'Set this page as home',
    keywords: ['home', 'pin', 'dashboard'],
    when: (ctx) => ctx.route.kind === 'mePage',
    async run(ctx) {
      if (ctx.route.kind === 'mePage') await setHomePage(ctx.route.pageId);
    },
  });

  registerCommand({
    id: 'toggle-old-tasks',
    title: 'Toggle old/new task list',
    keywords: ['legacy', 'tasks', 'switch'],
    run: (ctx) => toggleOldTaskList(ctx.projectId),
  });

  registerCommand({
    id: 'switch-theme',
    title: 'Switch theme',
    keywords: ['dark', 'light', 'appearance', 'system', 'colors'],
    run() {
      const next = cycleTheme();
      getPlatform().toast('success', `Theme: ${THEME_LABELS[next]}`);
    },
  });

  registerCommand({
    id: 'log-out',
    title: 'Log out',
    keywords: ['sign out', 'logout'],
    async run() {
      const platform = getPlatform();
      if (!platform.logout) {
        platform.toast('error', 'Logging out is not available here');
        return;
      }
      await platform.logout();
    },
  });
}
