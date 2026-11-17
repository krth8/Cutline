import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { getPlatform } from '../platform';
import { Avatar } from '../ui';
import { addComment, deleteComment, editComment, getComments, type TaskComment } from './api';
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
  edit(comment: TaskComment, text: string): Promise<boolean>;
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

  async function edit(comment: TaskComment, text: string): Promise<boolean> {
    const clean = text.trim();
    if (!clean || clean === comment.text) return true;
    setItems((list) => list.map((c) => (c.id === comment.id ? { ...c, text: clean, pending: true } : c)));
    try {
      const saved = await editComment(taskId, comment.id, clean);
      setItems((list) => list.map((c) => (c.id === comment.id ? saved : c)));
      return true;
    } catch {
      setItems((list) => list.map((c) => (c.id === comment.id ? comment : c)));
      platform.toast('error', 'Could not save the comment');
      return false;
    }
  }

  return { items, loading, submit, remove, edit };
}

/** The activity stream: comments with avatar, name and time. Collapsed to its heading while there are none. */
export function Activity({ state }: { state: CommentsState }) {
  const me = getPlatform().user();
  const { items, remove, edit } = state;
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
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
                {c.updatedAt ? <span className="cl-comment__edited">(edited)</span> : null}
                {!c.pending && me && c.userId === me.id && editing !== c.id ? (
                  <button
                    type="button"
                    className="cl-task__iconbtn cl-comment__edit"
                    aria-label="Edit comment"
                    title="Edit"
                    onClick={() => {
                      setEditing(c.id);
                      setDraft(c.text);
                    }}
                  >
                    &#9998;
                  </button>
                ) : null}
                {!c.pending && me && (c.userId === me.id || me.role === 'admin') ? (
                  <button type="button" className="cl-task__iconbtn cl-comment__delete" aria-label="Delete comment" title="Delete" onClick={() => void remove(c)}>
                    &times;
                  </button>
                ) : null}
              </div>
              {editing === c.id ? (
                <textarea
                  className="cl-composer__input cl-comment__editor"
                  aria-label="Edit comment"
                  autoFocus
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Escape') setEditing(null);
                    else if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                      e.preventDefault();
                      setEditing(null);
                      void edit(c, draft);
                    }
                  }}
                  onBlur={() => {
                    setEditing(null);
                    void edit(c, draft);
                  }}
                />
              ) : (
                <div className="cl-comment__text">{withMentions(c.text)}</div>
              )}
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
export function Composer({ state, projectId }: { state: CommentsState; projectId?: string }) {
  const me = getPlatform().user();
  const [draft, setDraft] = useState('');
  const input = useRef<HTMLTextAreaElement>(null);
  const members = useMembers(projectId);
  const [caret, setCaret] = useState(0);
  const [active, setActive] = useState(0);
  const query = mentionQuery(draft, caret);
  const choices = query === null ? [] : members.filter((m) => m.id !== me?.id && m.username.toLowerCase().startsWith(query.toLowerCase())).slice(0, 6);

  function pick(username: string) {
    if (query === null) return;
    const start = caret - query.length - 1;
    const next = `${draft.slice(0, start)}@${username} ${draft.slice(caret)}`;
    setDraft(next);
    const at = start + username.length + 2;
    setCaret(at);
    requestAnimationFrame(() => {
      input.current?.focus();
      input.current?.setSelectionRange(at, at);
    });
  }

  async function send() {
    const text = draft;
    if (!text.trim()) return;
    setDraft('');
    if (!(await state.submit(text))) setDraft((current) => current || text);
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (choices.length > 0) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        setActive((i) => (i + (e.key === 'ArrowDown' ? 1 : choices.length - 1)) % choices.length);
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        pick(choices[Math.min(active, choices.length - 1)]!.username);
        return;
      }
      if (e.key === 'Escape') {
        setCaret(-1);
        return;
      }
    }
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
        ref={input}
        className="cl-composer__input"
        rows={1}
        placeholder="Write a comment... (@ to mention)"
        aria-label="Add a comment"
        value={draft}
        onChange={(e) => {
          setDraft(e.target.value);
          setCaret(e.target.selectionStart ?? e.target.value.length);
          setActive(0);
        }}
        onSelect={(e) => setCaret(e.currentTarget.selectionStart ?? 0)}
        onKeyDown={onKeyDown}
      />
      {choices.length > 0 ? (
        <ul className="cl-composer__mentions" role="listbox" aria-label="People to mention" data-testid="comment-mentions">
          {choices.map((m, i) => (
            <li
              key={m.id}
              role="option"
              aria-selected={i === active}
              className={i === active ? 'is-active' : undefined}
              onMouseDown={(e) => {
                e.preventDefault();
                pick(m.username);
              }}
            >
              <Avatar name={m.username} src={m.profileImage ?? undefined} size={20} />
              {m.username}
            </li>
          ))}
        </ul>
      ) : null}
      <button type="button" className="cl-composer__send" aria-label="Post comment" title="Post comment (Enter)" disabled={!draft.trim()} onClick={() => void send()}>
        Send
      </button>
    </div>
  );
}

/** The text after an @ right before the caret ("@an" -> "an"), or null when the caret is not in a mention. */
export function mentionQuery(text: string, caret: number): string | null {
  if (caret < 0) return null;
  const m = /(?:^|\s)@([\w.\-]{0,40})$/.exec(text.slice(0, caret));
  return m ? m[1]! : null;
}

/** The members of the project, for @ suggestions (empty until loaded or without a project). */
function useMembers(projectId: string | undefined) {
  const [members, setMembers] = useState<Array<{ id: string; username: string; profileImage?: string }>>([]);
  useEffect(() => {
    if (!projectId) return;
    let current = true;
    getPlatform()
      .members(projectId)
      .then((list) => current && setMembers(list))
      .catch(() => undefined);
    return () => {
      current = false;
    };
  }, [projectId]);
  return members;
}

/** Comment text with @names set apart. */
export function withMentions(text: string): ReactNode[] {
  const parts: ReactNode[] = [];
  const re = /(^|[^\w@])@([\w.\-]{1,80})/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const at = m.index + m[1]!.length;
    if (at > last) parts.push(text.slice(last, at));
    parts.push(
      <span key={at} className="cl-comment__mention">
        @{m[2]}
      </span>,
    );
    last = at + m[2]!.length + 1;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}
