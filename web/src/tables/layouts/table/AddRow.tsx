import { useEffect, useRef, useState, type KeyboardEvent } from 'react';

export interface AddRowProps {
  placeholder: string;
  /** Indent in pixels (subtask lines). */
  indent?: number;
  autoFocus?: boolean;
  /** Called once the autofocus has been used up. */
  onFocused?: () => void;
  /** Projects to choose from (tasks across projects: a new row needs one). */
  projects?: Array<{ id: string; name: string }>;
  project?: string;
  onProject?: (id: string) => void;
  testId: string;
  onSubmit(name: string): void;
}

/** A line at the end of the rows with one text field: Enter adds a row with that title and keeps the field for the next one. */
export function AddRow({ placeholder, indent = 0, autoFocus, onFocused, projects, project, onProject, testId, onSubmit }: AddRowProps) {
  const [text, setText] = useState('');
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (autoFocus) {
      input.current?.focus();
      onFocused?.();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoFocus]);

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    e.stopPropagation();
    if (e.key === 'Enter') {
      e.preventDefault();
      const name = text.trim();
      if (!name) return;
      setText('');
      onSubmit(name);
    } else if (e.key === 'Escape') {
      setText('');
      e.currentTarget.blur();
    }
  }

  return (
    <div className="cl-table__addrow" role="row" data-testid={`${testId}-row`}>
      <div className="cl-table__lead cl-table__addicon" aria-hidden="true">
        +
      </div>
      <div className="cl-table__addcell" style={indent ? { paddingLeft: indent } : undefined}>
        <input
          ref={input}
          type="text"
          className="cl-table__addinput"
          data-testid={testId}
          aria-label={placeholder}
          placeholder={placeholder}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
        />
        {projects && projects.length > 0 && (
          <select
            className="cl-table__select"
            aria-label="Project for the new row"
            data-testid="table-add-project"
            value={project ?? ''}
            onChange={(e) => onProject?.(e.target.value)}
          >
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        )}
      </div>
    </div>
  );
}
