/**
 * The project choice of a quick-add in a `tasks:*` view (tasks across projects: a new task needs a project).
 * One implementation for the table, list, board, calendar and gantt quick-adds and the toolbar's "New":
 *   - `useAddProject` lists the projects the user can add tasks to and remembers the choice per view;
 *   - `ProjectSelect` is the small picker, drawn only when there is something to choose;
 *   - `useFocusWithin` tells a quick-add row whether the user has started adding (the picker is shown only then).
 */
import { useCallback, useState, type FocusEvent } from 'react';
import { cx } from '../ui';
import { projectsForCreate } from './store';

const KEY = 'cl-add-project:';

function remembered(viewId: string): string {
  try {
    return localStorage.getItem(KEY + viewId) ?? '';
  } catch {
    return '';
  }
}

export interface AddProject {
  /** Projects a new row can go to; empty unless the view is `tasks:*`. */
  projects: Array<{ id: string; name: string }>;
  /** The chosen project (the remembered one, else the first); empty when the view needs no choice. */
  projectId: string;
  setProjectId(id: string): void;
}

export function useAddProject(viewId: string, tableRef: string): AddProject {
  const [chosen, setChosen] = useState(() => remembered(viewId));
  const projects = tableRef === 'tasks:*' ? projectsForCreate() : EMPTY;
  const projectId = projects.find((p) => p.id === chosen)?.id ?? projects[0]?.id ?? '';
  const setProjectId = useCallback(
    (id: string) => {
      setChosen(id);
      try {
        localStorage.setItem(KEY + viewId, id);
      } catch {
        /* the choice is only a convenience */
      }
    },
    [viewId],
  );
  return { projects, projectId, setProjectId };
}

const EMPTY: Array<{ id: string; name: string }> = [];

/** The picker; nothing is drawn when there is no choice to make (fewer than two projects). */
export function ProjectSelect({
  add,
  className,
  testId,
}: {
  add: AddProject;
  className?: string | undefined;
  testId?: string | undefined;
}) {
  if (add.projects.length < 2) return null;
  return (
    <select
      className={cx('cl-addproject', className)}
      aria-label="Project for the new row"
      data-testid={testId ?? 'add-project'}
      value={add.projectId}
      onChange={(e) => add.setProjectId(e.target.value)}
    >
      {add.projects.map((p) => (
        <option key={p.id} value={p.id}>
          {p.name}
        </option>
      ))}
    </select>
  );
}

/** True while focus is inside the element the returned props are put on (input, picker and all). */
export function useFocusWithin() {
  const [active, setActive] = useState(false);
  return {
    active,
    bind: {
      onFocus: () => setActive(true),
      onBlur: (e: FocusEvent<HTMLElement>) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setActive(false);
      },
    },
  };
}
