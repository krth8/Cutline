/**
 * The command registry of the palette. A command is something the palette can run instead of opening a
 * result: it calls existing functions or APIs and does not need anything new on the server.
 *
 *   registerCommand({ id, title, keywords, run, when? })      one command; returns an unregister function
 *   registerCommandProvider(id, (ctx) => Command[])           commands that depend on the context, such as
 *                                                             one per accessible project
 *
 * `when(ctx)` hides the command when it does not apply (e.g. "Set this page as home" off a personal page).
 */
import type { Route } from '../router';

/** What a command may look at: where the user is and who they are. */
export interface CommandContext {
  route: Route;
  /** The project of the current route (null on Home and in the personal space). */
  projectId: string | null;
  user: { id: string; username: string; role: 'admin' | 'editor' | 'viewer' };
  projects: Array<{ id: string; name: string; canTasks: boolean; isOwner: boolean }>;
}

export interface Command {
  id: string;
  title: string;
  /** Extra words that find the command. */
  keywords?: string[];
  run(ctx: CommandContext): void | Promise<void>;
  when?(ctx: CommandContext): boolean;
}

const commands = new Map<string, Command>();
const providers = new Map<string, (ctx: CommandContext) => Command[]>();

export function registerCommand(command: Command): () => void {
  commands.set(command.id, command);
  return () => {
    if (commands.get(command.id) === command) commands.delete(command.id);
  };
}

export function registerCommandProvider(id: string, provider: (ctx: CommandContext) => Command[]): () => void {
  providers.set(id, provider);
  return () => {
    if (providers.get(id) === provider) providers.delete(id);
  };
}

/** The commands that apply in this context, in registration order (provider commands after plain ones). */
export function listCommands(ctx: CommandContext): Command[] {
  const all = [...commands.values()];
  for (const provider of providers.values()) {
    try {
      all.push(...provider(ctx));
    } catch (e) {
      console.error('Search: a command provider failed', e);
    }
  }
  return all.filter((c) => {
    try {
      return !c.when || c.when(ctx);
    } catch {
      return false;
    }
  });
}

/** Test helper: forget every registration. */
export function clearCommands(): void {
  commands.clear();
  providers.clear();
}
