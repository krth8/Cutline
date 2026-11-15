import {
  applyAwarenessUpdate,
  encodeAwarenessUpdate,
  removeAwarenessStates,
  type Awareness,
} from 'y-protocols/awareness';
import * as Y from 'yjs';
import { getPlatform } from '../../platform';
import {
  AWARENESS,
  CLOSE_ACCESS_REMOVED,
  CLOSE_BAD_DATA,
  CLOSE_SESSION_ENDED,
  MAX_FRAME_BYTES,
  STATE_VECTOR,
  SYNC_STATE,
  UPDATE,
  frame,
} from './protocol';

export type PageStatus = 'connecting' | 'synced' | 'saving' | 'offline' | 'readonly' | 'gone' | 'error';

/** Timings in milliseconds; tests shorten them or run on fake timers. */
export interface PageProviderTiming {
  /** First reconnect delay; it doubles per failed attempt. */
  backoffBase: number;
  backoffMax: number;
  /** Outgoing awareness: at most one frame per interval (the first one goes out at once). */
  awarenessThrottle: number;
  /** A ping goes out this long after a burst of local updates, to learn they are stored. */
  ackDelay: number;
  pingInterval: number;
  /** No frame for this long means the connection is dead. */
  deadAfter: number;
}

export const DEFAULT_TIMING: PageProviderTiming = {
  backoffBase: 500,
  backoffMax: 15_000,
  awarenessThrottle: 100,
  ackDelay: 250,
  pingInterval: 25_000,
  deadAfter: 60_000,
};

export interface PageProviderOptions {
  pageId: string;
  doc: Y.Doc;
  awareness: Awareness;
  timing?: Partial<PageProviderTiming>;
  /** Random source for the backoff jitter (tests). */
  random?: () => number;
}

/**
 * Connects a Y.Doc and an Awareness to the page sync server (PLAN.md 5.7).
 *
 * - On connect the server sends its full state (type 0). We apply it and send back what it lacks as
 *   one update (type 1). From then on local updates stream as type 1 and remote ones are applied.
 * - Edits made while offline are ordinary Yjs updates in the doc; the diff after the next type 0
 *   carries them. There is no queue.
 * - "Saving" means local updates were sent and no pong has come back since. The server handles one
 *   frame at a time and stores an update before it reads the next frame, so the pong to a ping that
 *   was sent after an update proves the update is stored.
 */
export class PageProvider {
  readonly pageId: string;
  readonly doc: Y.Doc;
  readonly awareness: Awareness;

  private timing: PageProviderTiming;
  private random: () => number;

  private _status: PageStatus = 'connecting';
  private _error: Error | null = null;
  private _readonly = false;
  private listeners = new Set<(status: PageStatus) => void>();

  private ws: WebSocket | null = null;
  private generation = 0; // identifies the current connection attempt
  private synced = false; // type 0 applied and our diff sent on the current connection
  private everSynced = false;
  private destroyed = false;
  private terminal = false;
  private attempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private fromScratch = false; // after a 1007: resend the whole state once
  private badDataStrikes = 0;

  private updateCount = 0; // local updates sent on this and earlier connections
  private savedCount = 0; // updates known to be stored
  private pings: number[] = []; // updateCount at the time each unanswered ping was sent
  private ackTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private lastReceived = 0;

  private awarenessPending = new Set<number>();
  private awarenessTimer: ReturnType<typeof setTimeout> | null = null;
  private awarenessLastSent = -Infinity;

  private syncWaiters: Array<{ resolve(): void; reject(error: Error): void }> = [];

  constructor(options: PageProviderOptions) {
    this.pageId = options.pageId;
    this.doc = options.doc;
    this.awareness = options.awareness;
    this.timing = { ...DEFAULT_TIMING, ...options.timing };
    this.random = options.random ?? Math.random;

    this.doc.on('update', this.onDocUpdate);
    this.awareness.on('update', this.onAwarenessUpdate);
    if (typeof window !== 'undefined') {
      window.addEventListener('offline', this.onBrowserOffline);
      window.addEventListener('online', this.onBrowserOnline);
    }
    this.connect();
  }

  // ---- public state ----

  get status(): PageStatus {
    return this._status;
  }

  /** True once the server said this reader may not edit. It stays true for the life of the provider. */
  get readonly(): boolean {
    return this._readonly;
  }

  /** Why the status is 'error' (or 'gone'). */
  get error(): Error | null {
    return this._error;
  }

  /** Call `cb` on every change of `status`. Returns the unsubscribe function. */
  onStatus(cb: (status: PageStatus) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  /** Resolves when the first sync is done; rejects if the provider ends (gone, error, destroyed) before. */
  whenSynced(): Promise<void> {
    if (this.everSynced) return Promise.resolve();
    if (this.terminal || this.destroyed) return Promise.reject(this._error ?? new Error('The page is not available'));
    return new Promise((resolve, reject) => this.syncWaiters.push({ resolve, reject }));
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.doc.off('update', this.onDocUpdate);
    this.awareness.off('update', this.onAwarenessUpdate);
    if (typeof window !== 'undefined') {
      window.removeEventListener('offline', this.onBrowserOffline);
      window.removeEventListener('online', this.onBrowserOnline);
    }
    // Tell the others we are gone before the socket closes
    removeAwarenessStates(this.awareness, [this.doc.clientID], 'local');
    this.awarenessPending.add(this.doc.clientID);
    this.flushAwareness(true);
    this.clearTimers();
    this.generation++;
    const ws = this.ws;
    this.ws = null;
    this.synced = false;
    if (ws) {
      detach(ws);
      try {
        ws.close(1000);
      } catch {
        // already closed
      }
    }
    this.listeners.clear();
    this.rejectWaiters(new Error('The provider was destroyed'));
  }

  // ---- status ----

  private computeStatus(): PageStatus {
    if (this.terminal) return this._status; // 'gone' or 'error', set where it happened
    if (!this.synced) return this.everSynced ? 'offline' : 'connecting';
    if (this._readonly) return 'readonly';
    return this.updateCount > this.savedCount ? 'saving' : 'synced';
  }

  private refreshStatus(): void {
    this.setStatus(this.computeStatus());
  }

  private setStatus(status: PageStatus): void {
    if (status === this._status) return;
    this._status = status;
    for (const cb of [...this.listeners]) {
      try {
        cb(status);
      } catch (e) {
        console.error('PageProvider: a status listener failed', e);
      }
    }
  }

  private rejectWaiters(error: Error): void {
    const waiters = this.syncWaiters;
    this.syncWaiters = [];
    for (const w of waiters) w.reject(error);
  }

  private stopForGood(status: 'gone' | 'error', error: Error): void {
    this.terminal = true;
    this._error = error;
    this.synced = false;
    this.clearTimers();
    this.setStatus(status);
    this.rejectWaiters(error);
  }

  // ---- connecting ----

  private connect(): void {
    if (this.destroyed || this.terminal) return;
    this.reconnectTimer = null;
    const generation = ++this.generation;
    this.refreshStatus();
    getPlatform()
      .openSocket(`/ws/pages/${encodeURIComponent(this.pageId)}`)
      .then(
        (ws) => {
          if (this.destroyed || generation !== this.generation) {
            detach(ws);
            try {
              ws.close(1000);
            } catch {
              // ignore
            }
            return;
          }
          this.attach(ws, generation);
        },
        (error) => {
          // No ticket (offline, server down, login ended): try again later
          if (this.destroyed || generation !== this.generation) return;
          console.warn('PageProvider: could not open the socket', error);
          this.scheduleReconnect();
        },
      );
  }

  private attach(ws: WebSocket, generation: number): void {
    this.ws = ws;
    ws.binaryType = 'arraybuffer';
    this.lastReceived = Date.now();
    ws.onmessage = (event) => {
      if (generation === this.generation) this.onMessage(event.data);
    };
    ws.onclose = (event) => {
      if (generation === this.generation) this.onClosed(event.code);
    };
    ws.onerror = () => {
      // A close event follows; it does the work
    };
    ws.onopen = () => {
      if (generation !== this.generation) return;
      this.lastReceived = Date.now();
      this.startKeepalive();
    };
    // The platform may hand over a socket that is already open
    if (ws.readyState === 1) ws.onopen?.(new Event('open'));
  }

  private scheduleReconnect(): void {
    if (this.destroyed || this.terminal || this.reconnectTimer) return;
    const { backoffBase, backoffMax } = this.timing;
    const delay = Math.min(backoffBase * 2 ** this.attempt, backoffMax) * (0.75 + this.random() * 0.5);
    this.attempt++;
    this.refreshStatus();
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  private onClosed(code: number): void {
    this.closeConnection();
    if (code === CLOSE_SESSION_ENDED) {
      // The platform shows the login again; there is nothing to retry until the user logs in
      this.stopForGood('error', new Error('Your session has ended'));
      return;
    }
    if (code === CLOSE_ACCESS_REMOVED) {
      this.stopForGood('gone', new Error('The page is not available'));
      return;
    }
    if (code === CLOSE_BAD_DATA) {
      this.badDataStrikes++;
      console.error(`PageProvider: the server refused our data (close ${code}), attempt ${this.badDataStrikes}`);
      if (this.badDataStrikes > 1) {
        this.stopForGood('error', new Error('The server could not accept this document'));
        return;
      }
      this.fromScratch = true;
    }
    this.scheduleReconnect();
  }

  /** The socket is over (closed or declared dead): forget its state and drop the others' carets. */
  private closeConnection(): void {
    const ws = this.ws;
    this.ws = null;
    this.generation++;
    this.synced = false;
    this.pings = [];
    if (this.ackTimer) clearTimeout(this.ackTimer);
    this.ackTimer = null;
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
    if (this.awarenessTimer) clearTimeout(this.awarenessTimer);
    this.awarenessTimer = null;
    this.awarenessPending.clear();
    if (ws) {
      detach(ws);
      try {
        ws.close();
      } catch {
        // already closed
      }
    }
    const others = [...this.awareness.getStates().keys()].filter((id) => id !== this.doc.clientID);
    if (others.length) removeAwarenessStates(this.awareness, others, this);
    this.refreshStatus();
  }

  private clearTimers(): void {
    for (const t of [this.reconnectTimer, this.ackTimer, this.awarenessTimer]) if (t) clearTimeout(t);
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.reconnectTimer = this.ackTimer = this.awarenessTimer = null;
    this.pingTimer = null;
  }

  private readonly onBrowserOffline = (): void => {
    // The browser may keep a dead socket open for a long time: treat it as closed now
    if (this.ws) {
      this.closeConnection();
      this.scheduleReconnect();
    }
  };

  private readonly onBrowserOnline = (): void => {
    if (this.destroyed || this.terminal) return;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
      this.attempt = 0;
      this.connect();
    }
  };

  // ---- keepalive ----

  private startKeepalive(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    const generation = this.generation;
    this.pingTimer = setInterval(() => {
      if (generation !== this.generation) return;
      if (Date.now() - this.lastReceived > this.timing.deadAfter) {
        console.warn('PageProvider: no frame from the server, treating the connection as dead');
        this.closeConnection();
        this.scheduleReconnect();
        return;
      }
      this.sendPing();
    }, this.timing.pingInterval);
  }

  private sendPing(): void {
    if (!this.isOpen()) return;
    this.pings.push(this.updateCount);
    this.ws!.send(JSON.stringify({ type: 'ping' }));
  }

  private onPong(): void {
    const covered = this.pings.shift();
    if (covered === undefined) return;
    if (covered > this.savedCount) this.savedCount = covered;
    this.badDataStrikes = 0; // the server took what we sent
    this.refreshStatus();
  }

  // ---- incoming ----

  private onMessage(data: unknown): void {
    this.lastReceived = Date.now();
    if (typeof data === 'string') {
      this.onControl(data);
      return;
    }
    const bytes = new Uint8Array(data as ArrayBuffer);
    if (bytes.length === 0) return;
    const type = bytes[0];
    const payload = bytes.subarray(1);
    try {
      if (type === SYNC_STATE) this.onSyncState(payload);
      else if (type === UPDATE) Y.applyUpdate(this.doc, payload, this);
      else if (type === AWARENESS) applyAwarenessUpdate(this.awareness, payload, this);
    } catch (e) {
      console.error(`PageProvider: could not use a frame of type ${type}`, e);
    }
  }

  private onControl(text: string): void {
    let message: { type?: unknown };
    try {
      message = JSON.parse(text);
    } catch {
      return;
    }
    if (message.type === 'pong') this.onPong();
    else if (message.type === 'readonly') {
      this._readonly = true;
      this.refreshStatus();
    }
  }

  private onSyncState(serverState: Uint8Array): void {
    const hadState = this.doc.store.clients.size > 0;
    Y.applyUpdate(this.doc, serverState, this);

    // What the server lacks: everything we have beyond the state it just sent
    const diff = this.fromScratch
      ? Y.encodeStateAsUpdate(this.doc)
      : Y.encodeStateAsUpdate(this.doc, Y.encodeStateVectorFromUpdate(serverState));
    this.fromScratch = false;

    // An update with nothing in it is two bytes; skip those
    if (diff.length > 2) this.sendUpdate(diff);
    // A client that already had state asks for the difference as well. The type 0 above already
    // contained it, so the answer is nearly empty; it costs a few bytes and keeps both sides honest.
    if (hadState && this.isOpen()) this.ws!.send(frame(STATE_VECTOR, Y.encodeStateVector(this.doc)));

    this.synced = true;
    this.attempt = 0;
    if (this.updateCount > this.savedCount) this.sendPing();
    this.refreshStatus();

    // Show ourselves to the others
    if (this.awareness.getLocalState() !== null) {
      this.awarenessPending.add(this.doc.clientID);
      this.flushAwareness(true);
    }

    if (!this.everSynced) {
      this.everSynced = true;
      const waiters = this.syncWaiters;
      this.syncWaiters = [];
      for (const w of waiters) w.resolve();
    }
  }

  // ---- outgoing ----

  private isOpen(): boolean {
    return this.ws !== null && this.ws.readyState === 1;
  }

  private sendUpdate(update: Uint8Array): void {
    if (this._readonly || !this.isOpen()) return;
    const out = frame(UPDATE, update);
    if (out.length > MAX_FRAME_BYTES) {
      console.error(`PageProvider: an update of ${out.length} bytes is over the server limit and was not sent`);
      return;
    }
    this.ws!.send(out);
    this.updateCount++;
  }

  private readonly onDocUpdate = (update: Uint8Array, origin: unknown): void => {
    if (origin === this) return; // came from the network
    // Before the first type 0 and while offline the edit stays in the doc; the sync diff carries it
    if (!this.synced) return;
    this.sendUpdate(update);
    this.refreshStatus();
    if (this.updateCount > this.savedCount && !this.ackTimer) {
      this.ackTimer = setTimeout(() => {
        this.ackTimer = null;
        this.sendPing();
      }, this.timing.ackDelay);
    }
  };

  private readonly onAwarenessUpdate = (
    change: { added: number[]; updated: number[]; removed: number[] },
    origin: unknown,
  ): void => {
    if (origin === this) return;
    const own = this.doc.clientID;
    if (![...change.added, ...change.updated, ...change.removed].includes(own)) return;
    this.awarenessPending.add(own);
    if (!this.synced || this.destroyed) return;
    const wait = this.awarenessLastSent + this.timing.awarenessThrottle - Date.now();
    if (wait <= 0) this.flushAwareness(false);
    else if (!this.awarenessTimer) {
      this.awarenessTimer = setTimeout(() => {
        this.awarenessTimer = null;
        this.flushAwareness(false);
      }, wait);
    }
  };

  private flushAwareness(force: boolean): void {
    if (this.awarenessTimer) {
      clearTimeout(this.awarenessTimer);
      this.awarenessTimer = null;
    }
    if (!this.awarenessPending.size || !this.isOpen() || (!this.synced && !force)) return;
    const ids = [...this.awarenessPending];
    this.awarenessPending.clear();
    this.awarenessLastSent = Date.now();
    this.ws!.send(frame(AWARENESS, encodeAwarenessUpdate(this.awareness, ids)));
  }
}

function detach(ws: WebSocket): void {
  ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
}
