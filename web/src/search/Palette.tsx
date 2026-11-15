import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { getPlatform } from '../platform';
import { routeProjectId, useRoute } from '../router';
import { cx } from '../ui';
import { useEscape, useReturnFocus } from '../ui/hooks';
import { searchAll, type SearchGroup, type SearchItem, type SearchResult, type SearchType } from './api';
import { listCommands, type Command, type CommandContext } from './commands';
import { openItem } from './navigate';
import { loadRecent, rememberOpened, type Recent } from './recent';
import { fold, highlightParts, queryWords } from './text';
import './search.css';

export const DEBOUNCE_MS = 150;
const COMMANDS_UNDER_RESULTS = 3;
const COMMANDS_WHEN_EMPTY = 5;

const GROUP_TITLES: Record<SearchType, string> = { page: 'Pages', task: 'Tasks', comment: 'Comments', clip: 'Clips' };

type Entry =
  | { key: string; kind: 'item'; item: SearchItem }
  | { key: string; kind: 'command'; command: Command }
  | { key: string; kind: 'query'; query: string };

interface Section {
  id: string;
  heading: string;
  entries: Entry[];
}

/** The commands whose title or keywords contain every word of `text`. */
export function matchCommands(commands: Command[], text: string): Command[] {
  const words = queryWords(text);
  if (words.length === 0) return commands;
  return commands.filter((c) => {
    const haystack = fold([c.title, ...(c.keywords ?? [])].join(' '));
    return words.every((w) => haystack.includes(w));
  });
}

function Icon({ type }: { type: SearchType | 'command' | 'recent' }) {
  const paths: Record<string, ReactNode> = {
    page: <path d="M6 3h8l4 4v14H6z M14 3v4h4 M9 12h6 M9 16h6" />,
    task: <path d="M4 5h16v14H4z M8 12l3 3 5-6" />,
    comment: <path d="M4 5h16v11H9l-5 4z" />,
    clip: <path d="M4 5h16v14H4z M4 9h16 M4 15h16 M8 5v14 M16 5v14" />,
    command: <path d="M5 8l5 4-5 4 M12 17h7" />,
    recent: <path d="M12 7v5l3 2 M4 12a8 8 0 1 0 2.5-5.8 M4 4v4h4" />,
  };
  return (
    <svg className="cl-search__icon" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {paths[type]}
    </svg>
  );
}

/** `text` with the parts that match the query in <mark>. */
export function Highlight({ text, words }: { text: string; words: string[] }) {
  return (
    <>
      {highlightParts(text, words).map((part, i) => (part.match ? <mark key={i}>{part.text}</mark> : <span key={i}>{part.text}</span>))}
    </>
  );
}

export function shortcutLabel(): string {
  return /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent) ? '⌘K' : 'Ctrl+K';
}

export interface PaletteProps {
  open: boolean;
  onClose: () => void;
}

/** The command palette: one box that searches pages, tasks, comments and clips, and runs commands after ">". */
export function Palette({ open, onClose }: PaletteProps) {
  if (!open) return null;
  return <PaletteBody onClose={onClose} />;
}

function PaletteBody({ onClose }: { onClose: () => void }) {
  const platform = getPlatform();
  const user = platform.user();
  const route = useRoute();
  const projectId = routeProjectId(route);
  const projects = platform.projects();
  const projectName = projectId ? projects.find((p) => p.id === projectId)?.name ?? null : null;

  const [query, setQuery] = useState('');
  const [scoped, setScoped] = useState(true);
  const [result, setResult] = useState<SearchResult | null>(null);
  const [status, setStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [active, setActive] = useState(0);
  const [recent] = useState<Recent>(() => (user ? loadRecent(user.id) : { items: [], queries: [] }));
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const seq = useRef(0);

  useEscape(true, onClose);
  useReturnFocus(true);
  useEffect(() => input.current?.focus(), []);

  const commandMode = query.startsWith('>');
  const text = commandMode ? query.slice(1).trim() : query.trim();
  const words = useMemo(() => queryWords(text), [text]);
  const useScope = scoped && !!projectId;

  // Debounced search; an answer that arrives after a newer request was sent is dropped
  useEffect(() => {
    if (commandMode || words.length === 0) {
      setResult(null);
      setStatus('idle');
      return;
    }
    setStatus('loading');
    const mine = ++seq.current;
    const timer = setTimeout(() => {
      searchAll(text, { project: useScope ? projectId : null }).then(
        (r) => {
          if (seq.current !== mine) return;
          setResult(r);
          setStatus('ready');
        },
        () => {
          if (seq.current !== mine) return;
          setStatus('error');
        },
      );
    }, DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      seq.current++;
    };
  }, [text, commandMode, words.length, useScope, projectId]);

  const ctx = useMemo<CommandContext | null>(
    () => (user ? { route, projectId, user, projects } : null),
    // projects() is a fresh array each call: the route and the user decide what applies
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [route, projectId, user?.id],
  );

  const sections = useMemo<Section[]>(() => {
    const out: Section[] = [];
    const commands = ctx ? listCommands(ctx) : [];
    const asEntries = (list: Command[]): Entry[] => list.map((c) => ({ key: `c:${c.id}`, kind: 'command', command: c }));
    if (commandMode) {
      out.push({ id: 'commands', heading: 'Commands', entries: asEntries(matchCommands(commands, text)) });
    } else if (words.length === 0) {
      if (recent.items.length) {
        out.push({ id: 'recent', heading: 'Recent', entries: recent.items.map((item) => ({ key: `r:${item.type}:${item.id}`, kind: 'item', item })) });
      }
      if (recent.queries.length) {
        out.push({ id: 'queries', heading: 'Recent searches', entries: recent.queries.map((q) => ({ key: `q:${q}`, kind: 'query', query: q })) });
      }
      out.push({ id: 'commands', heading: 'Commands', entries: asEntries(commands.slice(0, COMMANDS_WHEN_EMPTY)) });
    } else {
      for (const group of result?.groups ?? ([] as SearchGroup[])) {
        out.push({
          id: group.type,
          heading: GROUP_TITLES[group.type],
          entries: group.items.map((item) => ({ key: `i:${item.type}:${item.id}`, kind: 'item', item })),
        });
      }
      const matching = matchCommands(commands, text).slice(0, COMMANDS_UNDER_RESULTS);
      if (matching.length) out.push({ id: 'commands', heading: 'Commands', entries: asEntries(matching) });
    }
    return out.filter((s) => s.entries.length > 0);
  }, [ctx, commandMode, text, words.length, result, recent]);

  const entries = useMemo(() => sections.flatMap((s) => s.entries), [sections]);

  useEffect(() => setActive(0), [query, result, useScope]);
  useEffect(() => {
    list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView?.({ block: 'nearest' });
  }, [active, entries]);

  function choose(entry: Entry | undefined) {
    if (!entry) return;
    if (entry.kind === 'query') {
      setQuery(entry.query);
      input.current?.focus();
      return;
    }
    if (entry.kind === 'item') {
      if (user) rememberOpened(user.id, entry.item, query);
      onClose();
      openItem(entry.item);
      return;
    }
    onClose();
    if (!ctx) return;
    const done = (e: unknown) => platform.toast('error', e instanceof Error ? e.message : 'The command failed');
    try {
      Promise.resolve(entry.command.run(ctx)).catch(done);
    } catch (e) {
      done(e);
    }
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.nativeEvent.isComposing) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (entries.length === 0) return;
      const step = e.key === 'ArrowDown' ? 1 : -1;
      setActive((a) => (a + step + entries.length) % entries.length);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      // The list still belongs to the previous text while a new search is on its way
      if (status !== 'loading') choose(entries[active]);
    } else if (e.key === 'Tab') {
      e.preventDefault();
    }
  }

  const activeId = entries[active] ? `cl-search-opt-${active}` : undefined;
  let index = -1;
  const empty = status === 'ready' && entries.length === 0;

  return createPortal(
    <div
      className="cl-search__backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="cl-search" role="dialog" aria-modal="true" aria-label="Search and commands" data-testid="search-palette">
        <div className="cl-search__bar">
          <input
            ref={input}
            className="cl-search__input"
            data-testid="search-input"
            type="text"
            role="combobox"
            aria-expanded="true"
            aria-controls="cl-search-list"
            aria-activedescendant={activeId}
            aria-autocomplete="list"
            placeholder="Search pages, tasks, comments and clips, or type > for commands"
            autoComplete="off"
            spellCheck={false}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
          />
          {projectName && !commandMode ? (
            <button
              type="button"
              className={cx('cl-search__scope', !scoped && 'is-off')}
              data-testid="search-scope"
              aria-pressed={scoped}
              title={scoped ? 'Searching this project only. Click to search everywhere' : 'Searching everywhere. Click to search this project only'}
              onClick={() => {
                setScoped((s) => !s);
                input.current?.focus();
              }}
            >
              In {projectName}
              {scoped ? <span aria-hidden="true"> &times;</span> : null}
            </button>
          ) : null}
        </div>
        <div className="cl-search__list" id="cl-search-list" role="listbox" ref={list} data-testid="search-list">
          {sections.map((section) => (
            <div key={section.id} role="group" aria-label={section.heading} data-group={section.id}>
              <div className="cl-search__heading">{section.heading}</div>
              {section.entries.map((entry) => {
                index += 1;
                const i = index;
                return (
                  <div
                    key={entry.key}
                    id={`cl-search-opt-${i}`}
                    role="option"
                    aria-selected={i === active}
                    className={cx('cl-search__row', i === active && 'is-active')}
                    data-testid="search-result"
                    data-type={entry.kind === 'item' ? entry.item.type : entry.kind}
                    onMouseMove={() => i !== active && setActive(i)}
                    onClick={() => choose(entry)}
                  >
                    <EntryView entry={entry} words={words} showProject={!useScope} />
                  </div>
                );
              })}
            </div>
          ))}
          {status === 'loading' && entries.length === 0 ? <div className="cl-search__note">Searching...</div> : null}
          {status === 'error' ? <div className="cl-search__note" role="alert">Search failed. Try again.</div> : null}
          {empty ? <div className="cl-search__note">No results for &quot;{text}&quot;</div> : null}
        </div>
        <div className="cl-search__footer" aria-hidden="true">
          <span>&uarr;&darr; to move</span>
          <span>Enter to open</span>
          <span>Esc to close</span>
          <span>&gt; for commands</span>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function EntryView({ entry, words, showProject }: { entry: Entry; words: string[]; showProject: boolean }) {
  if (entry.kind === 'command') {
    return (
      <>
        <Icon type="command" />
        <span className="cl-search__text">
          <span className="cl-search__title">
            <Highlight text={entry.command.title} words={words} />
          </span>
        </span>
      </>
    );
  }
  if (entry.kind === 'query') {
    return (
      <>
        <Icon type="recent" />
        <span className="cl-search__text">
          <span className="cl-search__title">{entry.query}</span>
        </span>
      </>
    );
  }
  const { item } = entry;
  const where = item.projectName ?? (item.type === 'page' ? 'Personal' : null);
  return (
    <>
      <Icon type={item.type} />
      <span className="cl-search__text">
        <span className="cl-search__title">
          {item.type === 'page' && item.icon ? <span className="cl-search__emoji">{item.icon} </span> : null}
          <Highlight text={item.title} words={words} />
        </span>
        {item.snippet ? (
          <span className="cl-search__snippet">
            <Highlight text={item.snippet} words={words} />
          </span>
        ) : null}
      </span>
      {where && (showProject || item.type === 'page') ? <span className="cl-search__where">{where}</span> : null}
    </>
  );
}
