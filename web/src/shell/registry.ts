/**
 * Extension points of the shell, so later work packages (the page tree in P5,
 * page and table views) plug in without editing the shell files:
 *
 *   registerSidebarSection(id, Component)   a tree shown under "Personal space"
 *                                           and under every expanded project
 *   registerRouteView(kind, Component)      the main-area component for a route kind
 *
 * Both return an unregister function. Registrations may happen before or after
 * the shell is mounted; the shell re-renders when the registry changes.
 */
import { useSyncExternalStore, type ComponentType } from 'react';
import type { Route, RouteKind } from '../router';

/** The space a sidebar section belongs to: the personal space or one project. */
export type Space = { kind: 'personal' } | { kind: 'project'; projectId: string };

export interface SidebarSectionProps {
  space: Space;
  /** The current route, to highlight the open page. */
  route: Route;
}

export interface RouteViewProps<K extends RouteKind = RouteKind> {
  route: Extract<Route, { kind: K }>;
}

const sidebarSections = new Map<string, ComponentType<SidebarSectionProps>>();
const routeViews = new Map<RouteKind, ComponentType<RouteViewProps<any>>>();

let version = 0;
const listeners = new Set<() => void>();

function changed(): void {
  version += 1;
  for (const fn of [...listeners]) fn();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Add (or replace, by `id`) a section rendered for every space in the sidebar. */
export function registerSidebarSection(id: string, component: ComponentType<SidebarSectionProps>): () => void {
  sidebarSections.set(id, component);
  changed();
  return () => {
    if (sidebarSections.get(id) === component) {
      sidebarSections.delete(id);
      changed();
    }
  };
}

/** Set the main-area component for routes of this kind (replaces an earlier one). */
export function registerRouteView<K extends RouteKind>(kind: K, component: ComponentType<RouteViewProps<K>>): () => void {
  routeViews.set(kind, component);
  changed();
  return () => {
    if (routeViews.get(kind) === component) {
      routeViews.delete(kind);
      changed();
    }
  };
}

/** The registered sidebar sections in registration order (re-renders on change). */
export function useSidebarSections(): Array<[string, ComponentType<SidebarSectionProps>]> {
  useSyncExternalStore(subscribe, () => version);
  return [...sidebarSections.entries()];
}

/** The registered main-area component for a route kind, if any (re-renders on change). */
export function useRouteView<K extends RouteKind>(kind: K): ComponentType<RouteViewProps<K>> | undefined {
  useSyncExternalStore(subscribe, () => version);
  return routeViews.get(kind);
}

/** Test helper: forget every registration. */
export function clearRegistry(): void {
  sidebarSections.clear();
  routeViews.clear();
  changed();
}
