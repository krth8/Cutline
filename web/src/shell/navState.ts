/** What the sidebar remembers in this browser: which projects are open and whether the whole sidebar is collapsed. */
import { useCallback, useEffect, useState } from 'react';

const COLLAPSED_KEY = 'cl-sidebar-collapsed';
const projectsKey = (userId: string) => `cl-nav-projects:${userId}`;

export function readCollapsed(): boolean {
  try {
    return localStorage.getItem(COLLAPSED_KEY) === '1';
  } catch {
    return false;
  }
}

export function writeCollapsed(value: boolean): void {
  try {
    localStorage.setItem(COLLAPSED_KEY, value ? '1' : '0');
  } catch {
    /* storage unavailable: the state just is not remembered */
  }
}

/** The ids of the projects the user left open, or null when nothing was stored yet. */
function readOpenProjects(userId: string): Set<string> | null {
  try {
    const raw = localStorage.getItem(projectsKey(userId));
    if (raw === null) return null;
    const list = JSON.parse(raw) as unknown;
    return new Set(Array.isArray(list) ? list.filter((x): x is string => typeof x === 'string') : []);
  } catch {
    return null;
  }
}

function writeOpenProjects(userId: string, ids: Set<string>): void {
  try {
    localStorage.setItem(projectsKey(userId), JSON.stringify([...ids]));
  } catch {
    /* storage unavailable: the state just is not remembered */
  }
}

export interface OpenProjects {
  isOpen(projectId: string): boolean;
  set(projectId: string, open: boolean): void;
}

/**
 * The expanded projects of the sidebar, remembered per user. With nothing stored yet only the project of
 * the current route (`currentId`) is open. Following the route into a project opens it.
 */
export function useOpenProjects(userId: string, currentId: string | null): OpenProjects {
  const [state, setState] = useState(() => ({
    userId,
    ids: readOpenProjects(userId) ?? new Set<string>(currentId ? [currentId] : []),
  }));
  let current = state;
  if (state.userId !== userId) {
    current = { userId, ids: readOpenProjects(userId) ?? new Set<string>(currentId ? [currentId] : []) };
    setState(current);
  }

  const set = useCallback((projectId: string, open: boolean) => {
    setState((s) => {
      if (s.ids.has(projectId) === open) return s;
      const ids = new Set(s.ids);
      if (open) ids.add(projectId);
      else ids.delete(projectId);
      writeOpenProjects(s.userId, ids);
      return { userId: s.userId, ids };
    });
  }, []);

  // Following a link, back/forward or a new project into a project opens it
  useEffect(() => {
    if (currentId) set(currentId, true);
  }, [currentId, set]);

  return { isOpen: (id) => current.ids.has(id), set };
}
