import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { getPlatform } from '../platform';
import { Avatar } from '../ui';
import { addComment, deleteComment, getComments, type TaskComment } from './api';
import { relativeTime } from './format';
import { Section } from './Section';
import { useTaskPart } from './useTaskPart';

/** Kept for callers of the old name. */
export const timeAgo = relativeTime;

export interface CommentsState {
  items: TaskComment[];
  loading: boolean;
  submit(text: string): Promise<boolean>;
  remove(comment: TaskComment): Promise<void>;
}

/**
 * The comments of a task: newest at the bottom, shown at once and rolled back with a toast when the server
 * refuses. You can delete your own; admins can delete any. Comments of other users arrive live.
 */
export function useComments(taskId: string): CommentsState {
  const platform = getPlatform();
  const me = platform.user();
  const { items, setItems, loading } = useTaskPart<TaskComment>(taskId, 'comments', getComments);

  async function submit(text: string): Promise<boolean> {
    const clean = text.trim();
    if (!clean || !me) return false;
    const temp: TaskComment = {
      id: `temp-${Date.now()}`,
      userId: me.id,
      userName: me.username,
      userProfileImage: me.profileImage ?? null,
      text: clean,
      createdAt: new Date().toISOString(),
      pending: true,
    };
    setItems((list) => [...list, temp]);
    try {
      const saved = await addComment(taskId, clean);
      setItems((list) => list.map((c) => (c.id === temp.id ? saved : c)));
      return true;
    } catch {
      setItems((list) => list.filter((c) => c.id !== temp.id));
      platform.toast('error', 'Failed to add comment');
      return false;
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

  return { items, loading, submit, remove };
}

/** The activity stream: comments with avatar, name and time. Collapsed to its heading while there are none. */
export function Activity({ state }: { state: CommentsState }) {
  const me = getPlatform().user();
  const { items, remove } = state;
  const bottom = useRef<HTMLDivElement>(null);
  const last = items[items.length - 1]?.id;
  // A new comment at the end scrolls into view
  useEffect(() => {
    if (last) bottom.current?.scrollIntoView?.({ block: 'nearest' });
  }, [last]);

  return (
    <Section title="Activity" count={items.length} testId="task-comments">
      <ul className="cl-comments">
        {items.map((c) => (
          <li key={c.id} className={c.pending ? 'cl-comment is-pending' : 'cl-comment'} data-comment-id={c.id}>
            <Avatar name={c.userName} src={c.userProfileImage ?? undefined} size={24} />
            <div className="cl-comment__main">
              <div className="cl-comment__head">
                <span className="cl-comment__author">{c.userName}</span>
                <span className="cl-comment__time" title={c.createdAt}>
                  {relativeTime(c.createdAt)}
                </span>
                {!c.pending && me && (c.userId === me.id || me.role === 'admin') ? (
                  <button type="button" className="cl-task__iconbtn cl-comment__delete" aria-label="Delete comment" title="Delete" onClick={() => void remove(c)}>
                    &times;
                  </button>
                ) : null}
              </div>
              <div className="cl-comment__text">{c.text}</div>
            </div>
          </li>
        ))}
      </ul>
      <div ref={bottom} />
    </Section>
  );
}

/**
 * The comment box, pinned to the bottom of the panel. Enter sends, Shift+Enter is a line break (as before),
 * Ctrl/Cmd+Enter sends too. A failed send puts the text back.
 */
export function Composer({ state }: { state: CommentsState }) {
  const me = getPlatform().user();
  const [draft, setDraft] = useState('');

  async function send() {
    const text = draft;
    if (!text.trim()) return;
    setDraft('');
    if (!(await state.submit(text))) setDraft((current) => current || text);
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key !== 'Enter' || e.nativeEvent.isComposing) return;
    if (!e.shiftKey || e.ctrlKey || e.metaKey) {
      e.preventDefault();
      void send();
    }
  }

  return (
    <div className="cl-composer" data-testid="task-composer">
      {me ? <Avatar name={me.username} src={me.profileImage ?? undefined} size={24} /> : null}
      <textarea
        className="cl-composer__input"
        rows={1}
        placeholder="Write a comment..."
        aria-label="Add a comment"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={onKeyDown}
      />
      <button type="button" className="cl-composer__send" aria-label="Post comment" title="Post comment (Enter)" disabled={!draft.trim()} onClick={() => void send()}>
        Send
      </button>
    </div>
  );
}
