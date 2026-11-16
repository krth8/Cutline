import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { ProjectSelect, useFocusWithin, type AddProject } from '../../addProject';

export interface AddRowProps {
  placeholder: string;
  /** Indent in pixels (subtask lines). */
  indent?: number;
  autoFocus?: boolean;
  /** Called once the autofocus has been used up. */
  onFocused?: () => void;
  /** Project choice (tasks across projects: a new row needs one); the picker shows once the row has focus. */
  add?: AddProject;
  testId: string;
  onSubmit(name: string): void;
}

/** A line at the end of the rows with one text field: Enter adds a row with that title and keeps the field for the next one. */
export function AddRow({ placeholder, indent = 0, autoFocus, onFocused, add, testId, onSubmit }: AddRowProps) {
  const [text, setText] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const focus = useFocusWithin();
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
    <div className="cl-table__addrow" role="row" data-testid={`${testId}-row`} {...focus.bind}>
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
        {add && focus.active && <ProjectSelect add={add} className="cl-table__select" testId="table-add-project" />}
      </div>
    </div>
  );
}
