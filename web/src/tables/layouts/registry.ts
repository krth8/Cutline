/**
 * The layout registry: which React component draws a view of a given `layout` name.
 *
 *   registerLayout('board', BoardLayout, { board: { groupBy: 'status', cardColumns: [] } })
 *
 * `defaults` is the part of `View['config']` the layout needs; the view shell merges it into a view's
 * config (keys that are missing only) when the user switches the view to this layout. It may also be a
 * function of the table schema, for defaults that depend on the columns.
 * Registering a name again replaces the earlier registration (a layout package replaces the fallback).
 */
import { useSyncExternalStore, type ComponentType } from 'react';
import type { LayoutProps, TableSchema, View } from '../types';

export type LayoutDefaults = Partial<View['config']> | ((schema: TableSchema) => Partial<View['config']>);

export interface LayoutEntry {
  name: string;
  /** Shown in the layout switcher. Defaults to the capitalised name. */
  label: string;
  component: ComponentType<LayoutProps>;
  defaults: LayoutDefaults;
}

const layouts = new Map<string, LayoutEntry>();
let version = 0;
const listeners = new Set<() => void>();

function changed(): void {
  version += 1;
  for (const fn of [...listeners]) fn();
}

/** Register (or replace) the component for a layout name. Returns an unregister function. */
export function registerLayout(
  name: string,
  component: ComponentType<LayoutProps>,
  defaults: LayoutDefaults = {},
  label?: string,
): () => void {
  const entry: LayoutEntry = { name, label: label ?? name.charAt(0).toUpperCase() + name.slice(1), component, defaults };
  layouts.set(name, entry);
  changed();
  return () => {
    if (layouts.get(name) === entry) {
      layouts.delete(name);
      changed();
    }
  };
}

export function getLayout(name: string): LayoutEntry | undefined {
  return layouts.get(name);
}

/** Registered layouts in registration order. */
export function listLayouts(): LayoutEntry[] {
  return [...layouts.values()];
}

/** The config keys a layout wants that a view does not have yet. */
export function layoutDefaults(entry: LayoutEntry, schema: TableSchema, config: View['config']): Partial<View['config']> {
  const defaults = typeof entry.defaults === 'function' ? entry.defaults(schema) : entry.defaults;
  const missing: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(defaults)) {
    if ((config as Record<string, unknown>)[key] === undefined) missing[key] = value;
  }
  return missing as Partial<View['config']>;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Re-renders when layouts are registered or replaced. */
export function useLayouts(): LayoutEntry[] {
  useSyncExternalStore(subscribe, () => version);
  return listLayouts();
}

/** Test helper: forget every registration. */
export function clearLayouts(): void {
  layouts.clear();
  changed();
}
