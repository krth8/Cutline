/**
 * The right panel of the Home tab: what happened. "For me" is what other people did that concerns the user
 * (assigned, answered, tagged) across their projects; "This project" is everything in the open project.
 * It is the same container, at the same width, as the comments of Review and the people of Lounge; the
 * header button (static/js/features/panel.js) turns it on and off.
 */
import { useCallback, useEffect, useRef, useState, type MouseEvent } from 'react';
import { requestJson } from '../api/http';
import { getPlatform } from '../platform';
import { cx } from '../ui';
import './activityPanel.css';

export interface ActivityEvent {
  id: string;
  projectId: string;
  projectName?: string | null;
  actorId: string | null;
  actorName: string | null;
  actorImage?: string | null;
  kind: string;
  title: string;
  detail: { from?: string | null; to?: string | string[] | null; text?: string; reply?: boolean; drawing?: boolean };
  link: string | null;
  createdAt: string;
}

type Scope = 'me' | 'project';

const COLORS = ['#6d5df0', '#c2587a', '#2f8f83', '#b0792b', '#4a7fc4', '#8a5fc4'];

function colorOf(key: string): string {
  let sum = 0;
  for (let i = 0; i < key.length; i++) sum = (sum * 31 + key.charCodeAt(i)) >>> 0;
  return COLORS[sum % COLORS.length]!;
}

function shortDate(value: string): string {
  const d = new Date(`${value}T00:00:00`);
  return Number.isNaN(d.getTime()) ? value : d.toLocaleDateString([], { day: 'numeric', month: 'short' });
}

function ago(iso: string, now: number): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const minutes = Math.max(0, Math.round((now - then) / 60000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return new Date(iso).toLocaleDateString([], { day: 'numeric', month: 'short' });
}

/** "Today", "Yesterday" or "Earlier": the heading an event goes under. */
export function dayGroup(iso: string, now: Date): string {
  const d = new Date(iso);
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  if (d.getTime() >= start) return 'Today';
  if (d.getTime() >= start - 86400000) return 'Yesterday';
  return 'Earlier';
}

function Sentence({ event, myName }: { event: ActivityEvent; myName: string | null }) {
  const who = <b>{event.actorName ?? 'Someone'}</b>;
  const what = <b>{event.title}</b>;
  const d = event.detail;
  switch (event.kind) {
    case 'task.created':
      return <>{who} created {what}</>;
    case 'task.status':
      return <>{who} changed {what}</>;
    case 'task.assigned': {
      const names = (Array.isArray(d.to) ? d.to : []).map((n) => (n === myName ? 'you' : n));
      return <>{who} assigned {names.join(', ') || 'someone'} to {what}</>;
    }
    case 'task.due':
      return <>{who} moved the due date of {what}</>;
    case 'task.renamed':
      return <>{who} renamed {d.from ? <>{d.from} to </> : null}{what}</>;
    case 'page.created':
      return <>{who} created the page {what}</>;
    case 'comment.added':
      return <>{who} {d.reply ? 'replied on' : 'commented on'} {what}</>;
    default:
      return <>{who} changed {what}</>;
  }
}

function Change({ event }: { event: ActivityEvent }) {
  const d = event.detail;
  if (event.kind === 'task.status' && (d.from || d.to)) {
    return (
      <div className="cl-activity__diff">
        <span className="cl-activity__pill">{d.from ?? 'No status'}</span>
        <span aria-hidden="true">&rarr;</span>
        <span className="cl-activity__pill is-new">{typeof d.to === 'string' ? d.to : 'No status'}</span>
      </div>
    );
  }
  if (event.kind === 'task.due') {
    return (
      <div className="cl-activity__diff">
        <span className="cl-activity__pill">{d.from ? shortDate(d.from) : 'No date'}</span>
        <span aria-hidden="true">&rarr;</span>
        <span className="cl-activity__pill is-new">{typeof d.to === 'string' ? shortDate(d.to) : 'No date'}</span>
      </div>
    );
  }
  if (event.kind === 'comment.added' && (d.text || d.drawing)) {
    return <div className="cl-activity__quote">{d.text || 'A drawing'}</div>;
  }
  return null;
}

function Row({ event, now, myName, showProject }: { event: ActivityEvent; now: number; myName: string | null; showProject: boolean }) {
  const name = event.actorName ?? '?';
  const onClick = (e: MouseEvent<HTMLAnchorElement>) => {
    if (!event.link || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    getPlatform().navigate(event.link);
  };
  const body = (
    <>
      {event.actorImage ? (
        <img className="cl-activity__avatar" src={event.actorImage} alt="" />
      ) : (
        <span className="cl-activity__avatar" style={{ background: colorOf(event.actorId ?? name) }} aria-hidden="true">
          {name.slice(0, 2).toUpperCase()}
        </span>
      )}
      <span className="cl-activity__body">
        <span className="cl-activity__text">
          <Sentence event={event} myName={myName} />
        </span>
        <Change event={event} />
        <span className="cl-activity__meta">
          {showProject && event.projectName ? `${event.projectName} · ` : ''}
          {ago(event.createdAt, now)}
        </span>
      </span>
    </>
  );
  return (
    <li data-testid="activity-event" data-kind={event.kind}>
      {event.link ? (
        <a className="cl-activity__row" href={event.link} onClick={onClick}>
          {body}
        </a>
      ) : (
        <div className="cl-activity__row">{body}</div>
      )}
    </li>
  );
}

export function ActivityPanel({ projectId }: { projectId: string | null }) {
  const platform = getPlatform();
  const [scope, setScope] = useState<Scope>('me');
  const [events, setEvents] = useState<ActivityEvent[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const effective: Scope = scope === 'project' && projectId ? 'project' : 'me';
  const request = useRef(0);

  const load = useCallback(async () => {
    const mine = ++request.current;
    try {
      const query = effective === 'project' ? `scope=project&projectId=${encodeURIComponent(projectId!)}` : 'scope=me';
      const { events: list } = await requestJson<{ events: ActivityEvent[] }>('GET', `/api/activity?${query}`);
      if (mine !== request.current) return;
      setEvents(list);
      setFailed(false);
      setNow(Date.now());
    } catch {
      if (mine === request.current) setFailed(true);
    }
  }, [effective, projectId]);

  useEffect(() => {
    setEvents(null);
    void load();
  }, [load]);

  // Hear about every project the user has, not only the one that is open
  const watched = platform
    .projects()
    .map((p) => p.id)
    .sort()
    .join(',');
  useEffect(() => {
    platform.live.watch('activity', watched ? { projects: watched.split(',') } : null);
    return () => platform.live.watch('activity', null);
  }, [platform, watched]);

  // Something happened in one of them: fetch again, once for a burst of changes
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const soon = () => {
      clearTimeout(timer);
      timer = setTimeout(() => void load(), 600);
    };
    // The events that already tell people about these changes; the list itself comes from the server
    const offs = ['task_created', 'task_updated', 'comment_added', 'page_changed', 'resync'].map((type) => platform.live.on(type, soon));
    const tick = setInterval(() => setNow(Date.now()), 60000);
    return () => {
      offs.forEach((off) => off());
      clearTimeout(timer);
      clearInterval(tick);
    };
  }, [platform, load]);

  const myName = platform.user()?.username ?? null;
  const groups: Array<[string, ActivityEvent[]]> = [];
  for (const event of events ?? []) {
    const label = dayGroup(event.createdAt, new Date(now));
    const last = groups[groups.length - 1];
    if (last && last[0] === label) last[1].push(event);
    else groups.push([label, [event]]);
  }

  return (
    <aside className="cl-panel" aria-label="Activity" data-testid="activity-panel">
      <div className="cl-panel__head">
        <span className="cl-panel__title">Activity</span>
      </div>
      <div className="cl-panel__tabs" role="tablist" aria-label="Which activity">
        <button type="button" role="tab" aria-selected={effective === 'me'} className={cx('cl-panel__tab', effective === 'me' && 'is-active')} onClick={() => setScope('me')}>
          For me
        </button>
        {projectId ? (
          <button type="button" role="tab" aria-selected={effective === 'project'} className={cx('cl-panel__tab', effective === 'project' && 'is-active')} onClick={() => setScope('project')}>
            This project
          </button>
        ) : null}
      </div>
      <div className="cl-panel__body">
        {events === null ? (
          <p className="cl-panel__empty" role="status">
            {failed ? 'Could not load the activity.' : 'Loading...'}
          </p>
        ) : events.length === 0 ? (
          <p className="cl-panel__empty">
            {effective === 'me' ? 'Nothing for you yet. When someone assigns you a task, answers you or tags you, it shows here.' : 'Nothing has happened in this project yet.'}
          </p>
        ) : (
          groups.map(([label, list]) => (
            <section key={label}>
              <h3 className="cl-panel__when">{label}</h3>
              <ul className="cl-activity">
                {list.map((event) => (
                  <Row key={event.id} event={event} now={now} myName={myName} showProject={effective === 'me'} />
                ))}
              </ul>
            </section>
          ))
        )}
      </div>
    </aside>
  );
}
