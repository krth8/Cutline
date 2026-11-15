import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { getPlatform } from '../platform';

export interface TaskPart<T> {
  items: T[];
  /** Local (optimistic) changes go through this; the next reload replaces them with the server's list. */
  setItems: Dispatch<SetStateAction<T[]>>;
  loading: boolean;
  /** Fetch again now. */
  reload(): Promise<void>;
}

/**
 * A list that belongs to a task (comments, checklist, linked clips). It loads on mount and loads again when
 * another user changes that part: the server sends `task_<part>_changed` with the task id to the other tabs.
 */
export function useTaskPart<T>(taskId: string, part: 'comments' | 'checklist' | 'clips', load: (taskId: string) => Promise<T[]>): TaskPart<T> {
  const [items, setItems] = useState<T[]>([]);
  const [loading, setLoading] = useState(true);
  const loadRef = useRef(load);
  loadRef.current = load;
  const current = useRef(taskId);
  current.current = taskId;

  const reload = useCallback(async () => {
    const id = current.current;
    try {
      const list = await loadRef.current(id);
      if (current.current === id) setItems(list);
    } catch (e) {
      console.error(`Could not load the ${part} of the task`, e);
    } finally {
      if (current.current === id) setLoading(false);
    }
  }, [part]);

  useEffect(() => {
    setItems([]);
    setLoading(true);
    void reload();
    return getPlatform().live.on(`task_${part}_changed`, (msg) => {
      if (msg?.taskId === current.current) void reload();
    });
  }, [taskId, part, reload]);

  return { items, setItems, loading, reload };
}
