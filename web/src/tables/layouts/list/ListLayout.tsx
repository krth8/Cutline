import { useEffect, useRef, useState, type KeyboardEvent, type RefObject } from 'react';
import { CellHost } from '../../cells';
import { projectsForCreate } from '../../store';
import type { LayoutProps, Row } from '../../types';
import { cx } from '../../../ui';
import { doneModel, hasValue, rowInGroup, secondaryColumns } from './listHelpers';
import './list.css';

/** Containers narrower than this (px) put the secondary values on a second line under the title. */
export const NARROW_WIDTH = 420;

/** True while the element is narrower than NARROW_WIDTH (measured with a ResizeObserver). */
function useNarrow(ref: RefObject<HTMLElement | null>): boolean {
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const measure = (width: number) => setNarrow(width > 0 && width < NARROW_WIDTH);
    measure(el.getBoundingClientRect().width);
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width;
      if (w !== undefined) measure(w);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return narrow;
}

/**
 * Compact list: a done checkbox, the title and a few secondary values per row. Groups become headings,
 * a quick-add row sits at the bottom. Arrow keys move between rows, Space toggles, Enter opens, F2 renames.
 */
export function ListLayout({ schema, view, result, loading, actions }: LayoutProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const narrow = useNarrow(rootRef);
  const done = doneModel(schema);
  const secondary = secondaryColumns(schema, view.config);
  const titleKey = schema.titleColumn;
  const titleColumn = schema.columns.find((c) => c.key === titleKey);
  const groupBy = view.config.query.groupBy ?? '';

  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [newTitle, setNewTitle] = useState('');
  const [projectId, setProjectId] = useState('');
  const projects = schema.ref === 'tasks:*' ? projectsForCreate() : [];
  const chosenProject = projects.find((p) => p.id === projectId) ?? projects[0];
  const canCreate = schema.capabilities.create;

  function toggle(row: Row) {
    if (!done || !row.canEdit) return;
    const next = done.isDone(row) ? done.openValue : done.doneValue;
    actions.updateRow(row.id, { [done.column.key]: next }).catch(() => {
      /* the store has already shown the error */
    });
  }

  function startEdit(row: Row) {
    if (!row.canEdit || titleColumn?.readonly) return;
    setDraft(String(row.values[titleKey] ?? ''));
    setEditingId(row.id);
  }

  function finishEdit(row: Row, save: boolean) {
    setEditingId(null);
    const text = draft.trim();
    if (save && text && text !== row.values[titleKey]) {
      actions.updateRow(row.id, { [titleKey]: text }).catch(() => {});
    }
    // Keep keyboard focus on the row after the input goes away
    requestAnimationFrame(() => rootRef.current?.querySelector<HTMLElement>(`[data-row-id="${row.id}"]`)?.focus());
  }

  function rowKeyDown(e: KeyboardEvent<HTMLElement>, row: Row) {
    if (e.target !== e.currentTarget) return;
    if (e.key === ' ') {
      e.preventDefault();
      toggle(row);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      actions.openRow(row.id);
    } else if (e.key === 'F2') {
      e.preventDefault();
      startEdit(row);
    }
  }

  function listKeyDown(e: KeyboardEvent<HTMLElement>) {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const target = e.target as HTMLElement;
    if (target.tagName === 'INPUT' && target.getAttribute('type') !== 'checkbox') return;
    if (target.tagName === 'SELECT') return;
    if (target.closest('.cl-cellhost') && !target.classList.contains('cl-cellhost')) return;
    const rows = [...(rootRef.current?.querySelectorAll<HTMLElement>('[data-row-id]') ?? [])];
    const current = rows.indexOf(target.closest<HTMLElement>('[data-row-id]') as HTMLElement);
    const next = rows[current + (e.key === 'ArrowDown' ? 1 : -1)];
    e.preventDefault();
    if (next) next.focus();
  }

  function addRow() {
    const title = newTitle.trim();
    if (!title) return;
    if (schema.ref === 'tasks:*' && !chosenProject) return;
    setNewTitle('');
    actions
      .createRow({ [titleKey]: title }, schema.ref === 'tasks:*' && chosenProject ? { projectId: chosenProject.id } : undefined)
      .catch(() => {});
  }

  const sections = result.groups
    ? result.groups.map((g) => ({
        key: g.key ?? '(none)',
        label: g.label as string | null,
        count: g.count,
        color: g.color,
        rows: result.rows.filter((r) => rowInGroup(r.values[groupBy], g.key)),
      }))
    : [{ key: 'all', label: null as string | null, count: 0, color: undefined as string | undefined, rows: result.rows }];

  function renderRow(row: Row) {
    const isDone = done?.isDone(row) ?? false;
    const editing = editingId === row.id;
    const title = String(row.values[titleKey] ?? '');
    return (
      <li
        key={row.id}
        className={cx('cl-list__row', isDone && 'is-done')}
        data-row-id={row.id}
        data-done={isDone}
        tabIndex={0}
        onKeyDown={(e) => rowKeyDown(e, row)}
      >
        <input
          type="checkbox"
          className="cl-list__check"
          aria-label={isDone ? `Mark "${title}" as not done` : `Mark "${title}" as done`}
          checked={isDone}
          disabled={!done || !row.canEdit}
          onChange={() => toggle(row)}
          data-testid="list-check"
        />
        {editing ? (
          <input
            className="cl-list__edit"
            aria-label="Title"
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => editingId === row.id && finishEdit(row, true)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                finishEdit(row, true);
              } else if (e.key === 'Escape') {
                e.preventDefault();
                finishEdit(row, false);
              }
            }}
          />
        ) : (
          <span
            className="cl-list__title"
            data-testid="list-title"
            title={title}
            onClick={() => actions.openRow(row.id)}
            onDoubleClick={() => startEdit(row)}
          >
            {title || 'Untitled'}
          </span>
        )}
        <span className="cl-list__secondary">
          {secondary.map((c) =>
            hasValue(c, row.values[c.key]) ? (
              <span key={c.key} className="cl-list__value" data-column={c.key}>
                <CellHost
                  column={c}
                  value={row.values[c.key]}
                  row={row}
                  compact
                  onChange={(value) => {
                    actions.updateRow(row.id, { [c.key]: value }).catch(() => {});
                  }}
                />
              </span>
            ) : null,
          )}
        </span>
      </li>
    );
  }

  return (
    <div
      ref={rootRef}
      className={cx('cl-list', narrow && 'is-narrow')}
      data-testid="list-layout"
      data-narrow={narrow || undefined}
      aria-busy={loading || undefined}
      onKeyDown={listKeyDown}
    >
      {sections.map((section) => (
        <section key={section.key} className="cl-list__section">
          {section.label !== null && (
            <h3 className="cl-list__group" data-testid="list-group">
              {section.color && <span className="cl-list__dot" style={{ background: section.color }} />}
              <span className="cl-list__group-label">{section.label}</span>
              <span className="cl-list__group-count">{section.count}</span>
            </h3>
          )}
          <ul className="cl-list__rows" role="list">
            {section.rows.map(renderRow)}
          </ul>
        </section>
      ))}
      {result.rows.length === 0 && !loading && <p className="cl-list__empty">No rows.</p>}
      {canCreate && (
        <form
          className="cl-list__add"
          onSubmit={(e) => {
            e.preventDefault();
            addRow();
          }}
        >
          <span className="cl-list__plus" aria-hidden="true">
            +
          </span>
          <input
            className="cl-list__new"
            aria-label="New"
            placeholder="New"
            data-testid="list-new"
            value={newTitle}
            onChange={(e) => setNewTitle(e.target.value)}
          />
          {projects.length > 0 && (
            <select
              className="cl-list__project"
              aria-label="Project"
              value={chosenProject?.id ?? ''}
              onChange={(e) => setProjectId(e.target.value)}
            >
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          )}
        </form>
      )}
    </div>
  );
}
