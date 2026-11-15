/**
 * Opening mention targets and recognising pasted Cutline links. Runs in the main bundle (it uses the router
 * and the platform).
 */
import { getPlatform } from '../../../../platform';
import { buildRoute, parseRoute } from '../../../../router';
import type { MentionAttrs, ResolvedMention } from './model';

/**
 * A pasted text that is exactly one link to a page or a task of this app, as a mention (without a label yet).
 * Only same-origin URLs that the router recognises count; `?task=<id>` wins over the route it sits on.
 */
export function parseMentionLink(text: string, origin: string = window.location.origin): Pick<MentionAttrs, 'kind' | 'id'> | null {
  const value = text.trim();
  if (!value || /\s/.test(value)) return null;
  let url: URL;
  try {
    url = new URL(value, origin);
  } catch {
    return null;
  }
  if (!/^https?:$/.test(url.protocol) || url.origin !== origin) return null;
  const route = parseRoute(url.pathname + url.search);
  if (route.kind === 'notFound') return null;
  if (route.task) return { kind: 'task', id: route.task };
  if (route.kind === 'mePage' || route.kind === 'projectPage') return { kind: 'page', id: route.pageId };
  return null;
}

/** The current location with the task panel opened on `taskId`. */
export function taskUrl(taskId: string): string {
  const route = parseRoute(window.location.pathname + window.location.search);
  if (route.kind !== 'notFound') return buildRoute({ ...route, task: taskId });
  const url = new URL(window.location.href);
  url.searchParams.set('task', taskId);
  return url.pathname + url.search;
}

/** Where a resolved chip leads (null for people and for targets that cannot be opened). */
export function hrefOf(resolved: ResolvedMention | null): string | null {
  if (!resolved?.ok || !resolved.route) return null;
  return resolved.kind === 'task' ? taskUrl(resolved.id) : resolved.route;
}

export function openHref(href: string): void {
  getPlatform().navigate(href);
}
