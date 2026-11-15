import { useCallback, useState } from 'react';
import type { SpaceKey } from '../../api/pageTree';

const keyOf = (space: SpaceKey) => `cl-pages-expanded:${space}`;

function read(space: SpaceKey): Set<string> {
  try {
    const raw = localStorage.getItem(keyOf(space));
    const list = raw ? (JSON.parse(raw) as unknown) : [];
    return new Set(Array.isArray(list) ? list.filter((x): x is string => typeof x === 'string') : []);
  } catch {
    return new Set();
  }
}

function write(space: SpaceKey, ids: Set<string>): void {
  try {
    localStorage.setItem(keyOf(space), JSON.stringify([...ids]));
  } catch {
    /* storage unavailable: the state just is not remembered */
  }
}

export interface Expanded {
  ids: ReadonlySet<string>;
  toggle(id: string): void;
  set(id: string, open: boolean): void;
  open(ids: string[]): void;
}

/** The ids of the expanded pages of a space, remembered in localStorage. */
export function useExpanded(space: SpaceKey): Expanded {
  const [state, setState] = useState(() => ({ space, ids: read(space) }));
  // The same component can be reused for another space: read that space's list
  let current = state;
  if (state.space !== space) {
    current = { space, ids: read(space) };
    setState(current);
  }

  const update = useCallback(
    (fn: (ids: Set<string>) => Set<string> | null) => {
      setState((s) => {
        const next = fn(new Set(s.ids));
        if (!next) return s;
        write(s.space, next);
        return { space: s.space, ids: next };
      });
    },
    [],
  );

  return {
    ids: current.ids,
    toggle: (id) =>
      update((ids) => {
        if (!ids.delete(id)) ids.add(id);
        return ids;
      }),
    set: (id, open) =>
      update((ids) => {
        if (ids.has(id) === open) return null;
        if (open) ids.add(id);
        else ids.delete(id);
        return ids;
      }),
    open: (list) =>
      update((ids) => {
        const before = ids.size;
        list.forEach((id) => ids.add(id));
        return ids.size === before ? null : ids;
      }),
  };
}
