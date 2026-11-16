import { useEffect, useRef, useState, type ReactNode } from 'react';
import { getPlatform } from '../platform';
import { Menu, Tooltip, cx, type MenuItem } from '../ui';
import type { Row } from '../tables/types';
import type { DoneModel } from '../tables/layouts/list/listHelpers';
import { usePanel } from './PanelShell';

const svg = { width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true } as const;

export const LinkIcon = () => (
  <svg {...svg}>
    <path d="M6.5 9.5a3 3 0 0 0 4.2 0l2-2a3 3 0 0 0-4.2-4.2l-.8.8" />
    <path d="M9.5 6.5a3 3 0 0 0-4.2 0l-2 2a3 3 0 0 0 4.2 4.2l.8-.8" />
  </svg>
);
export const ExpandIcon = () => (
  <svg {...svg}>
    <path d="M9.5 2.5h4v4M6.5 13.5h-4v-4M13.5 2.5 9 7M2.5 13.5 7 9" />
  </svg>
);
export const CollapseIcon = () => (
  <svg {...svg}>
    <path d="M13.5 6.5h-4v-4M2.5 9.5h4v4M9.5 6.5 14 2M6.5 9.5 2 14" />
  </svg>
);
export const MoreIcon = () => (
  <svg {...svg} fill="currentColor" stroke="none">
    <circle cx="3.5" cy="8" r="1.3" />
    <circle cx="8" cy="8" r="1.3" />
    <circle cx="12.5" cy="8" r="1.3" />
  </svg>
);
export const CloseIcon = () => (
  <svg {...svg}>
    <path d="M3.5 3.5l9 9M12.5 3.5l-9 9" />
  </svg>
);
export const CheckIcon = () => (
  <svg {...svg} strokeWidth={2}>
    <path d="M3.5 8.5l3 3 6-7" />
  </svg>
);

/** A quiet icon button with a tooltip; `label` is also its accessible name. */
export function IconButton({ label, onClick, children, pressed, danger, buttonRef }: {
  label: string;
  onClick: () => void;
  children: ReactNode;
  pressed?: boolean;
  danger?: boolean;
  buttonRef?: React.Ref<HTMLButtonElement>;
}) {
  return (
    <Tooltip content={label}>
      <button
        ref={buttonRef}
        type="button"
        className={cx('cl-task__iconbtn', danger && 'cl-task__danger')}
        aria-label={label}
        aria-pressed={pressed}
        onClick={onClick}
      >
        {children}
      </button>
    </Tooltip>
  );
}

/** The editable title of a row (shared by the task panel and the row panel). */
export function Title({ row, canEdit, onSave, label = 'Task name' }: { row: Row; canEdit: boolean; onSave: (name: string) => void; label?: string }) {
  const name = String(row.values.name ?? '');
  const [draft, setDraft] = useState(name);
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) setDraft(name);
  }, [name]);
  function finish() {
    focused.current = false;
    const text = draft.trim();
    if (!text) setDraft(name);
    else if (text !== name) onSave(text);
  }
  return (
    <input
      className="cl-task__title"
      aria-label={label}
      placeholder={label}
      value={draft}
      readOnly={!canEdit}
      onFocus={() => (focused.current = true)}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={finish}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        else if (e.key === 'Escape') {
          setDraft(name);
          focused.current = false;
          (e.target as HTMLInputElement).blur();
        }
      }}
    />
  );
}

/** The round done control at the title's left: sets the status to its done option, or back to the first open one. */
export function DoneToggle({ model, row, onChange }: { model: DoneModel; row: Row; onChange: (key: string, value: unknown) => void }) {
  const done = model.isDone(row);
  const canEdit = row.canEdit;
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={done}
      aria-label={done ? 'Mark as not done' : 'Mark as done'}
      className={cx('cl-task__done', done && 'is-done')}
      disabled={!canEdit}
      data-testid="task-done"
      onClick={() => onChange(model.column.key, done ? model.openValue : model.doneValue)}
    >
      {done ? <CheckIcon /> : null}
    </button>
  );
}

export interface PanelHeaderProps {
  /** Small muted trail above the title (project, parent task). */
  crumbs: ReactNode;
  title: ReactNode;
  done?: ReactNode;
  /** The sync indicator, shown quietly beside the actions. */
  status?: ReactNode;
  /** Entries of the "more" menu (History, Delete, ...). */
  menu: MenuItem[];
  closeLabel: string;
}

/** Breadcrumb and a quiet row of icon buttons on top, the large title (with the done control) below. */
export function PanelHeader({ crumbs, title, done, status, menu, closeLabel }: PanelHeaderProps) {
  const { wide, toggleWide, close } = usePanel();
  const moreRef = useRef<HTMLButtonElement>(null);
  const [menuOpen, setMenuOpen] = useState(false);

  function copyLink() {
    const platform = getPlatform();
    const url = window.location.href;
    const clipboard = typeof navigator !== 'undefined' ? navigator.clipboard : undefined;
    if (!clipboard) {
      platform.toast('error', 'Could not copy the link');
      return;
    }
    clipboard.writeText(url).then(
      () => platform.toast('success', 'Link copied'),
      () => platform.toast('error', 'Could not copy the link'),
    );
  }

  return (
    <header className="cl-task__header">
      <div className="cl-task__bar">
        <div className="cl-task__crumbs">{crumbs}</div>
        {status ? <div className="cl-task__status">{status}</div> : null}
        <div className="cl-task__actions">
          <IconButton label="Copy link" onClick={copyLink}>
            <LinkIcon />
          </IconButton>
          <IconButton label={wide ? 'Narrow view' : 'Wide view'} pressed={wide} onClick={toggleWide}>
            {wide ? <CollapseIcon /> : <ExpandIcon />}
          </IconButton>
          {menu.length > 0 ? (
            <>
              <IconButton label="More actions" buttonRef={moreRef} onClick={() => setMenuOpen((o) => !o)}>
                <MoreIcon />
              </IconButton>
              <Menu open={menuOpen} onOpenChange={setMenuOpen} anchorRef={moreRef} items={menu} placement="bottom-end" aria-label="More actions" />
            </>
          ) : null}
          <IconButton label={closeLabel} onClick={close}>
            <CloseIcon />
          </IconButton>
        </div>
      </div>
      <div className="cl-task__titlerow">
        {done}
        {title}
      </div>
    </header>
  );
}
