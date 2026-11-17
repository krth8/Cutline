/**
 * The Lounge's channels in the sidebar (shown while the Lounge tab is open, above the projects): every channel links
 * to /lounge/c/<id>, and "+" adds one. The Lounge view itself has no room list of its own any more.
 */
import { useEffect, useState, type FormEvent, type MouseEvent } from 'react';
import { requestJson } from '../api/http';
import { getPlatform } from '../platform';
import { buildRoute, navigate, type Route } from '../router';

export interface Channel {
  id: string;
  name: string;
}

export function LoungeChannels({ route }: { route: Route }) {
  const [channels, setChannels] = useState<Channel[] | null>(null);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const active = route.kind === 'lounge' ? route.channelId : undefined;

  useEffect(() => {
    let current = true;
    requestJson<{ channels: Channel[] }>('GET', '/api/chat/channels')
      .then((res) => current && setChannels(res.channels ?? []))
      .catch(() => current && setChannels([]));
    return () => {
      current = false;
    };
  }, []);

  async function add(e: FormEvent) {
    e.preventDefault();
    const text = name.trim();
    if (!text) return setAdding(false);
    try {
      const channel = await requestJson<Channel>('POST', '/api/chat/channels', { name: text });
      setChannels((list) => [...(list ?? []), channel]);
      setName('');
      setAdding(false);
      navigate({ kind: 'lounge', channelId: channel.id });
    } catch (err) {
      getPlatform().toast('error', err instanceof Error ? err.message : 'Could not create the channel');
    }
  }

  const go = (to: Route) => (e: MouseEvent<HTMLAnchorElement>) => {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    navigate(to);
  };

  return (
    <section className="cl-nav__channels" data-testid="nav-channels">
      <div className="cl-nav__heading cl-nav__heading--row">
        <span>Channels</span>
        <button type="button" className="cl-nav__headbtn" aria-label="Add channel" title="Add channel" onClick={() => setAdding(true)} data-testid="channel-add">
          +
        </button>
      </div>
      <ul className="cl-nav__projects">
        {(channels ?? []).map((c) => {
          const to: Route = { kind: 'lounge', channelId: c.id };
          return (
            <li key={c.id}>
              <a
                href={buildRoute(to)}
                onClick={go(to)}
                className={`cl-nav__item${active === c.id ? ' is-active' : ''}`}
                aria-current={active === c.id ? 'page' : undefined}
                data-testid="nav-channel"
              >
                <span className="cl-nav__hash" aria-hidden="true">
                  #
                </span>
                <span className="cl-nav__label">{c.name}</span>
              </a>
            </li>
          );
        })}
      </ul>
      {channels !== null && channels.length === 0 && !adding && <div className="cl-nav__empty">No channels yet</div>}
      {adding && (
        <form onSubmit={(e) => void add(e)} className="cl-nav__newchannel">
          <input
            autoFocus
            className="cl-nav__input"
            aria-label="Channel name"
            placeholder="Channel name"
            maxLength={80}
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                setName('');
                setAdding(false);
              }
            }}
            onBlur={() => !name.trim() && setAdding(false)}
            data-testid="channel-name"
          />
        </form>
      )}
    </section>
  );
}
