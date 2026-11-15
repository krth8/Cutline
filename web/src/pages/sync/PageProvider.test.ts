import { Awareness, encodeAwarenessUpdate } from 'y-protocols/awareness';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { setPlatform } from '../../platform';
import { PageProvider, type PageStatus } from './PageProvider';
import {
  decodeAwareness,
  flush,
  installServer,
  typeInto,
  xmlText,
  type FakeServerOptions,
  type Harness,
} from './testing/fakeServer';

const providers: PageProvider[] = [];

function start(h: Harness, doc = new Y.Doc(), extra: Partial<ConstructorParameters<typeof PageProvider>[0]> = {}) {
  const awareness = new Awareness(doc);
  const provider = new PageProvider({ pageId: 'pg1', doc, awareness, random: () => 0.5, ...extra });
  providers.push(provider);
  return { doc, awareness, provider };
}

function statuses(provider: PageProvider): PageStatus[] {
  const seen: PageStatus[] = [];
  provider.onStatus((s) => seen.push(s));
  return seen;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  providers.splice(0).forEach((p) => p.destroy());
  vi.useRealTimers();
  setPlatform(null);
});

async function settle(ms = 0) {
  await vi.advanceTimersByTimeAsync(ms);
  await flush();
}

describe('sync', () => {
  it('applies the server state, sends what the server lacks as one update, and reports synced', async () => {
    const h = installServer({ holdPongs: true });
    typeInto(h.server.doc, 'from server');
    const doc = new Y.Doc();
    typeInto(doc, 'local');
    const { provider } = start(h, doc);
    expect(provider.status).toBe('connecting');
    await settle();
    await provider.whenSynced();
    expect(h.server.paths).toEqual(['/ws/pages/pg1']);
    expect(provider.status).toBe('saving'); // our update is out, the pong has not come yet
    expect(xmlText(doc)).toContain('from server');
    expect(h.server.text()).toContain('local');
    expect(h.server.frames(1)).toHaveLength(1);
    h.server.releasePongs();
    await settle();
    expect(provider.status).toBe('synced');
  });

  it('sends nothing when the server already has everything', async () => {
    const h = installServer();
    typeInto(h.server.doc, 'same');
    const doc = new Y.Doc();
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(h.server.doc));
    const { provider } = start(h, doc);
    await settle();
    expect(provider.status).toBe('synced');
    expect(h.server.frames(1)).toHaveLength(0);
  });

  it('streams local updates and applies remote ones without echoing them back', async () => {
    const h = installServer();
    const { doc, provider } = start(h);
    await settle();
    expect(provider.status).toBe('synced');

    typeInto(doc, 'hello');
    expect(h.server.frames(1)).toHaveLength(1);
    await settle();
    expect(h.server.text()).toBe('hello');

    h.server.editAsOther((other) => typeInto(other, ' world'));
    await settle();
    expect(xmlText(doc)).toBe('hello world');
    // Still one update from us: the remote one was not sent back
    expect(h.server.frames(1)).toHaveLength(1);
  });

  it('does not send edits made before the first sync as separate frames', async () => {
    const h = installServer();
    const { doc } = start(h);
    typeInto(doc, 'early');
    await settle();
    expect(h.server.frames(1)).toHaveLength(1);
    expect(h.server.text()).toBe('early');
  });

  it('whenSynced resolves once and later calls resolve at once', async () => {
    const h = installServer();
    const { provider } = start(h);
    let done = false;
    provider.whenSynced().then(() => (done = true));
    expect(done).toBe(false);
    await settle();
    expect(done).toBe(true);
    await expect(provider.whenSynced()).resolves.toBeUndefined();
  });

  it('whenSynced rejects when the page is gone before the first sync', async () => {
    const h = installServer({ closeOnOpen: 4403 });
    const { provider } = start(h);
    const caught = provider.whenSynced().catch((e: Error) => e.message);
    await settle();
    expect(await caught).toMatch(/not available/);
    expect(provider.status).toBe('gone');
  });
});

describe('saving', () => {
  it('shows saving until a pong comes back for a ping sent after the update', async () => {
    const h = installServer({ holdPongs: true });
    const { doc, provider } = start(h);
    await settle();
    const seen = statuses(provider);
    typeInto(doc, 'a');
    expect(provider.status).toBe('saving');
    await settle(300); // ack delay: the ping goes out
    expect(h.server.texts().filter((t) => t.includes('ping')).length).toBeGreaterThan(0);
    expect(provider.status).toBe('saving');
    h.server.releasePongs();
    await settle();
    expect(provider.status).toBe('synced');
    expect(seen).toEqual(['saving', 'synced']);
  });

  it('an old pong does not cover a newer update', async () => {
    const h = installServer({ holdPongs: true });
    const { doc, provider } = start(h);
    await settle();
    typeInto(doc, 'a');
    await settle(300); // ping 1 (covers 'a')
    typeInto(doc, 'b');
    h.server.releasePongs(); // answers ping 1 only
    await settle();
    expect(provider.status).toBe('saving');
    await settle(300); // ping 2
    h.server.releasePongs();
    await settle();
    expect(provider.status).toBe('synced');
  });
});

describe('offline and reconnect', () => {
  it('keeps edits made offline and sends them on reconnect, taking remote changes too', async () => {
    const h = installServer();
    const { doc, provider } = start(h);
    await settle();
    typeInto(doc, 'one');
    await settle(300);
    h.server.options.holdPongs = true;
    const seen = statuses(provider);

    h.server.closeAll(1006);
    await settle();
    expect(provider.status).toBe('offline');
    typeInto(doc, ' offline');
    h.server.editAsOther((other) => {
      const p = other.getXmlFragment('default').get(0) as Y.XmlElement;
      p.insert(0, [new Y.XmlText('S:')]);
    });
    expect(h.server.text()).not.toContain('offline');

    await settle(1000); // first backoff 500 ms
    expect(provider.status).toBe('saving');
    await settle(300);
    h.server.releasePongs();
    await settle();
    expect(provider.status).toBe('synced');
    expect(h.server.text()).toBe(xmlText(doc));
    expect(xmlText(doc)).toContain('offline');
    expect(xmlText(doc)).toContain('S:');
    expect(seen).toContain('offline');
  });

  it('sends its state vector (type 3) when it reconnects with state', async () => {
    const h = installServer();
    const { doc } = start(h);
    await settle();
    typeInto(doc, 'x');
    await settle(300);
    expect(h.server.frames(3)).toHaveLength(0); // a fresh doc does not ask
    h.server.closeAll(1006);
    await settle(1000);
    const vectors = h.server.frames(3);
    expect(vectors).toHaveLength(1);
    expect(Array.from(vectors[0]!.payload)).toEqual(Array.from(Y.encodeStateVector(doc)));
  });

  it('backs off exponentially with jitter and a cap, and resets after a sync', async () => {
    const h = installServer();
    h.server.failOpens = 100;
    const times: number[] = [];
    const origin = Date.now();
    const platform = (await import('../../platform')).getPlatform();
    const open = platform.openSocket;
    platform.openSocket = (path) => {
      times.push(Date.now() - origin);
      return open(path);
    };
    const { provider } = start(h, new Y.Doc(), { timing: { backoffBase: 500, backoffMax: 4000 } });
    await settle(60_000);
    // random() = 0.5 gives factor 1.0: 0, 500, 1000, 2000, 4000, 4000 ...
    const gaps = times.slice(1, 7).map((t, i) => t - times[i]!);
    expect(gaps.slice(0, 5)).toEqual([500, 1000, 2000, 4000, 4000]);
    expect(provider.status).toBe('connecting');

    h.server.failOpens = 0;
    await settle(5000);
    expect(provider.status).toBe('synced');
    h.server.closeAll(1006);
    await settle();
    const before = times.length;
    await settle(499);
    expect(times.length).toBe(before);
    await settle(1);
    expect(times.length).toBe(before + 1); // back to the first delay
  });

  it('jitter stays within 25 percent', async () => {
    const h = installServer();
    h.server.failOpens = 1;
    let r = 0;
    const times: number[] = [];
    const platform = (await import('../../platform')).getPlatform();
    const open = platform.openSocket;
    platform.openSocket = (p) => {
      times.push(Date.now());
      return open(p);
    };
    start(h, new Y.Doc(), { random: () => r });
    await settle();
    await settle(374);
    expect(times).toHaveLength(1);
    await settle(1);
    expect(times).toHaveLength(2); // 500 * 0.75 = 375
    expect(r).toBe(0);
  });

  it('treats 60 seconds of silence as a dead connection and reconnects', async () => {
    const h = installServer({ silent: true });
    const { provider } = start(h);
    await settle();
    expect(provider.status).toBe('synced');
    const first = h.server.last;
    await settle(25_000 * 2); // pings at 25 s and 50 s get no answer
    expect(provider.status).toBe('synced');
    await settle(25_000); // 75 s: the check sees more than 60 s of silence
    expect(provider.status).toBe('offline');
    expect(first.closedByClient).not.toBeNull();
    await settle(2000);
    expect(h.server.everOpened.length).toBeGreaterThan(1);
  });

  it('pings every 25 seconds', async () => {
    const h = installServer();
    start(h);
    await settle();
    await settle(25_000);
    expect(h.server.texts()).toHaveLength(1);
    await settle(25_000);
    expect(h.server.texts()).toHaveLength(2);
  });

  it('reconnects when a new socket cannot be opened (no ticket)', async () => {
    const h = installServer();
    h.server.failOpens = 2;
    const { provider } = start(h);
    await settle(10_000);
    expect(provider.status).toBe('synced');
    expect(h.server.paths).toHaveLength(3);
  });

  it('the browser offline event ends the connection at once and online reconnects at once', async () => {
    const h = installServer();
    const { provider } = start(h);
    await settle();
    window.dispatchEvent(new Event('offline'));
    expect(provider.status).toBe('offline');
    h.server.failOpens = 1;
    await settle(1);
    window.dispatchEvent(new Event('online'));
    await settle(1);
    window.dispatchEvent(new Event('online'));
    await settle(2000);
    expect(provider.status).toBe('synced');
  });
});

describe('awareness', () => {
  it('sends the local state at once, then throttles to one frame per 100 ms with a trailing frame', async () => {
    const h = installServer();
    const { awareness } = start(h);
    awareness.setLocalStateField('user', { name: 'Ada', color: '#fff' });
    await settle();
    const initial = h.server.frames(2).length;
    expect(initial).toBe(1); // sent on sync

    await settle(200);
    awareness.setLocalStateField('cursor', 1); // first after quiet time: immediate
    expect(h.server.frames(2)).toHaveLength(initial + 1);
    awareness.setLocalStateField('cursor', 2);
    awareness.setLocalStateField('cursor', 3);
    awareness.setLocalStateField('cursor', 4);
    expect(h.server.frames(2)).toHaveLength(initial + 1);
    await settle(100);
    expect(h.server.frames(2)).toHaveLength(initial + 2);
    const last = h.server.frames(2).slice(-1)[0]!;
    const state = [...decodeAwareness(last.payload).values()][0] as { cursor: number };
    expect(state.cursor).toBe(4);
    await settle(500);
    expect(h.server.frames(2)).toHaveLength(initial + 2);
  });

  it('shows remote awareness and removes it when the socket closes', async () => {
    const h = installServer();
    const { awareness } = start(h);
    await settle();
    const remote = new Awareness(new Y.Doc());
    remote.setLocalState({ user: { name: 'Grace' } });
    h.server.sendAwareness(encodeAwarenessUpdate(remote, [remote.clientID]));
    await settle();
    expect(awareness.getStates().get(remote.clientID)).toEqual({ user: { name: 'Grace' } });

    h.server.closeAll(1006);
    await settle();
    expect(awareness.getStates().has(remote.clientID)).toBe(false);
    remote.destroy();
  });

  it('removes the local state and tells the server when destroyed', async () => {
    const h = installServer();
    const { awareness, doc, provider } = start(h);
    awareness.setLocalStateField('user', { name: 'Ada' });
    await settle();
    const before = h.server.frames(2).length;
    provider.destroy();
    expect(awareness.getLocalState() ?? null).toBeNull();
    const frames = h.server.frames(2);
    expect(frames).toHaveLength(before + 1);
    expect(decodeAwareness(frames.slice(-1)[0]!.payload).get(doc.clientID)).toBeNull();
    expect(h.server.last.closedByClient).toBe(1000);
  });

  it('sends its state again after a reconnect', async () => {
    const h = installServer();
    const { awareness } = start(h);
    awareness.setLocalStateField('user', { name: 'Ada' });
    await settle();
    h.server.closeAll(1006);
    await settle(1000);
    expect(h.server.last.sent.some((f) => typeof f !== 'string' && f[0] === 2)).toBe(true);
  });
});

describe('read only', () => {
  it('switches to read only and sends no updates', async () => {
    const h = installServer({ readonly: true });
    typeInto(h.server.doc, 'stored');
    const { doc, provider } = start(h);
    await settle();
    expect(provider.readonly).toBe(true);
    expect(provider.status).toBe('readonly');
    expect(xmlText(doc)).toBe('stored');
    typeInto(doc, '!');
    await settle(1000);
    expect(h.server.frames(1)).toHaveLength(0);
    expect(provider.status).toBe('readonly');
  });

  it('a readonly frame in the middle of a session also switches it', async () => {
    const h = installServer();
    const { provider } = start(h);
    await settle();
    h.server.last.deliver(JSON.stringify({ type: 'readonly' }));
    expect(provider.status).toBe('readonly');
  });
});

describe('close codes', () => {
  it('4401 stops for good', async () => {
    const h = installServer();
    const { provider } = start(h);
    await settle();
    h.server.closeAll(4401);
    await settle(120_000);
    expect(provider.status).toBe('error');
    expect(provider.error?.message).toMatch(/session/);
    expect(h.server.paths).toHaveLength(1);
  });

  it('4403 stops for good and reports gone', async () => {
    const h = installServer();
    const { provider } = start(h);
    await settle();
    h.server.closeAll(4403);
    await settle(120_000);
    expect(provider.status).toBe('gone');
    expect(h.server.paths).toHaveLength(1);
  });

  it('1007 resyncs from scratch once, then gives up', async () => {
    const warn = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const h = installServer();
    const { doc, provider } = start(h);
    await settle();
    typeInto(doc, 'content');
    await settle(300);
    const updatesBefore = h.server.frames(1).length;

    h.server.closeAll(1007);
    await settle(1000);
    // Second connection: no type 3, the whole state goes out as one update
    expect(provider.status).not.toBe('error');
    expect(h.server.paths).toHaveLength(2);
    expect(h.server.frames(1).length).toBe(updatesBefore + 1);
    const whole = h.server.frames(1).slice(-1)[0]!;
    const probe = new Y.Doc();
    Y.applyUpdate(probe, whole.payload);
    expect(xmlText(probe)).toBe('content');

    h.server.options.closeOnOpen = 1007;
    h.server.closeAll(1007);
    await settle(60_000);
    expect(provider.status).toBe('error');
    expect(provider.error?.message).toMatch(/could not accept/);
    expect(h.server.paths).toHaveLength(3);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('a pong after the retry makes the next 1007 count as a first one again', async () => {
    const warn = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const h = installServer();
    const { doc, provider } = start(h);
    await settle();
    h.server.closeAll(1007);
    await settle(1000);
    typeInto(doc, 'ok');
    await settle(300); // pong
    h.server.closeAll(1007);
    await settle(1000);
    expect(provider.status).not.toBe('error');
    warn.mockRestore();
  });
});

describe('destroy', () => {
  it('stops listening to the doc and closes the socket', async () => {
    const h = installServer();
    const { doc, provider } = start(h);
    await settle();
    provider.destroy();
    typeInto(doc, 'after');
    expect(h.server.frames(1)).toHaveLength(0);
    await settle(100_000);
    expect(h.server.paths).toHaveLength(1);
  });

  it('destroying while the socket is still opening closes it when it arrives', async () => {
    const h = installServer();
    const { provider } = start(h);
    provider.destroy();
    await settle();
    expect(h.server.everOpened[0]?.closedByClient).toBe(1000);
  });
});

describe('options', () => {
  it('keeps the fragment name in step with the editor', async () => {
    const { FRAGMENT_NAME: editor } = await import('../editor/buildExtensions');
    const { FRAGMENT_NAME } = await import('./protocol');
    expect(FRAGMENT_NAME).toBe(editor);
  });

  it('accepts timing overrides', async () => {
    const h = installServer({ holdPongs: true } as FakeServerOptions);
    const { doc } = start(h, new Y.Doc(), { timing: { ackDelay: 10 } });
    await settle();
    typeInto(doc, 'x');
    await settle(10);
    expect(h.server.texts()).toHaveLength(1);
  });
});
