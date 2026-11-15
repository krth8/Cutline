import { useEffect, useState, type KeyboardEvent } from 'react';
import { getPlatform } from '../platform';
import { Avatar } from '../ui';
import { addComment, deleteComment, getComments, type TaskComment } from './api';
import { useTaskPart } from './useTaskPart';

/** "just now", "5m ago", "3h ago", "2d ago", then a short date (as the old comments showed it). */
export function timeAgo(value: string, now: Date = new Date()): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const diff = now.getTime() - date.getTime();
  const minutes = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  if (hours < 24) return `${hours}h ago`;
  if (days < 7) return `${days}d ago`;
  return date.toLocaleDateString('nb-NO', { day: 'numeric', month: 'short' });
}

/**
 * Comments of a task: newest at the bottom, added with Enter (Shift+Enter is a line break), shown at once
 * and rolled back with a toast when the server refuses. You can delete your own; admins can delete any.
 * Comments of other users arrive live.
 */
export function Comments({ taskId, onCount }: { taskId: string; onCount?: (n: number) => void }) {
  const platform = getPlatform();
  const me = platform.user();
  const { items, setItems, loading } = useTaskPart<TaskComment>(taskId, 'comments', getComments);
  const [draft, setDraft] = useState('');
  useEffect(() => onCount?.(items.length), [items.length, onCount]);

  async function submit() {
    const text = draft.trim();
    if (!text || !me) return;
    setDraft('');
    const temp: TaskComment = {
      id: `temp-${Date.now()}`,
      userId: me.id,
      userName: me.username,
      userProfileImage: me.profileImage ?? null,
      text,
      createdAt: new Date().toISOString(),
      pending: true,
    };
    setItems((list) => [...list, temp]);
    try {
      const saved = await addComment(taskId, text);
      setItems((list) => list.map((c) => (c.id === temp.id ? saved : c)));
    } catch {
      setItems((list) => list.filter((c) => c.id !== temp.id));
      setDraft(text);
      platform.toast('error', 'Failed to add comment');
    }
  }

  async function remove(comment: TaskComment) {
    if (!(await platform.confirm('Delete this comment?', { danger: true, confirmLabel: 'Delete' }))) return;
    setItems((list) => list.map((c) => (c.id === comment.id ? { ...c, pending: true } : c)));
    try {
      await deleteComment(taskId, comment.id);
      setItems((list) => list.filter((c) => c.id !== comment.id));
    } catch {
      setItems((list) => list.map((c) => (c.id === comment.id ? { ...c, pending: false } : c)));
      platform.toast('error', 'Failed to delete comment');
    }
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void submit();
    }
  }

  return (
    <section className="cl-task__section" aria-label="Comments" data-testid="task-comments">
      <h3 className="cl-task__heading">
        Comments <span className="cl-task__count">({items.length})</span>
      </h3>
      <ul className="cl-comments">
        {items.length === 0 && !loading ? <li className="cl-task__empty">No comments yet</li> : null}
        {items.map((c) => (
          <li key={c.id} className={c.pending ? 'cl-comment is-pending' : 'cl-comment'} data-comment-id={c.id}>
            <Avatar name={c.userName} src={c.userProfileImage ?? undefined} size={26} />
            <div className="cl-comment__main">
              <div className="cl-comment__head">
                <span className="cl-comment__author">{c.userName}</span>
                <span className="cl-comment__time">{timeAgo(c.createdAt)}</span>
                {!c.pending && me && (c.userId === me.id || me.role === 'admin') ? (
                  <button type="button" className="cl-task__iconbtn" aria-label="Delete comment" title="Delete" onClick={() => void remove(c)}>
                    &times;
                  </button>
                ) : null}
              </div>
              <div className="cl-comment__text">{c.text}</div>
            </div>
          </li>
        ))}
      </ul>
      <div className="cl-comment__form">
        <textarea
          className="cl-comment__input"
          rows={1}
          placeholder="Add a comment..."
          aria-label="Add a comment"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKeyDown}
        />
        <button type="button" className="cl-task__iconbtn cl-comment__send" aria-label="Post comment" title="Post comment" onClick={() => void submit()}>
          &rarr;
        </button>
      </div>
    </section>
  );
}
