import { useState, type KeyboardEvent } from 'react';
import { getPlatform } from '../platform';
import { addChecklistItem, deleteChecklistItem, getChecklist, setChecklistItem, type ChecklistItem } from './api';
import { useTaskPart } from './useTaskPart';

/** The existing checklist of a task: add, tick, delete; all shown at once and rolled back with a toast on failure. */
export function Checklist({ taskId, canEdit }: { taskId: string; canEdit: boolean }) {
  const platform = getPlatform();
  const { items, setItems } = useTaskPart<ChecklistItem>(taskId, 'checklist', getChecklist);
  const [draft, setDraft] = useState('');
  const checked = items.filter((i) => i.isChecked).length;

  async function add() {
    const text = draft.trim();
    if (!text) return;
    setDraft('');
    const temp: ChecklistItem = { id: `temp-${Date.now()}`, text, isChecked: false, pending: true };
    setItems((list) => [...list, temp]);
    try {
      const saved = await addChecklistItem(taskId, text);
      setItems((list) => list.map((i) => (i.id === temp.id ? saved : i)));
    } catch {
      setItems((list) => list.filter((i) => i.id !== temp.id));
      setDraft(text);
      platform.toast('error', 'Failed to add item');
    }
  }

  async function toggle(item: ChecklistItem, value: boolean) {
    setItems((list) => list.map((i) => (i.id === item.id ? { ...i, isChecked: value } : i)));
    try {
      await setChecklistItem(taskId, item.id, value);
    } catch {
      setItems((list) => list.map((i) => (i.id === item.id ? { ...i, isChecked: item.isChecked } : i)));
      platform.toast('error', 'Failed to update item');
    }
  }

  async function remove(item: ChecklistItem) {
    const before = items;
    setItems((list) => list.filter((i) => i.id !== item.id));
    try {
      await deleteChecklistItem(taskId, item.id);
    } catch {
      setItems(before);
      platform.toast('error', 'Failed to delete item');
    }
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') {
      e.preventDefault();
      void add();
    }
  }

  return (
    <section className="cl-task__section" aria-label="Checklist" data-testid="task-checklist">
      <h3 className="cl-task__heading">
        Checklist <span className="cl-task__count">{items.length > 0 ? `(${checked}/${items.length})` : '(0)'}</span>
      </h3>
      <ul className="cl-checklist">
        {items.map((item) => (
          <li key={item.id} className={item.isChecked ? 'cl-checklist__item is-checked' : 'cl-checklist__item'} data-item-id={item.id}>
            <input
              type="checkbox"
              checked={item.isChecked}
              disabled={!canEdit || item.pending}
              aria-label={item.text}
              onChange={(e) => void toggle(item, e.target.checked)}
            />
            <span className="cl-checklist__text">{item.text}</span>
            {canEdit && !item.pending ? (
              <button type="button" className="cl-task__iconbtn" aria-label={`Delete ${item.text}`} title="Delete" onClick={() => void remove(item)}>
                &times;
              </button>
            ) : null}
          </li>
        ))}
      </ul>
      {canEdit ? (
        <div className="cl-task__addrow">
          <input
            className="cl-task__addinput"
            placeholder="Add an item..."
            aria-label="Add a checklist item"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKeyDown}
          />
          <button type="button" className="cl-task__iconbtn" aria-label="Add item" onClick={() => void add()}>
            +
          </button>
        </div>
      ) : null}
    </section>
  );
}
