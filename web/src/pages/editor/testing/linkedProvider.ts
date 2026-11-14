import {
  Awareness,
  applyAwarenessUpdate,
  encodeAwarenessUpdate,
  removeAwarenessStates,
} from 'y-protocols/awareness';
import * as Y from 'yjs';

/** Origin of updates this module applies, so they are not relayed back. */
const RELAY = Symbol('linked-provider');

export interface LinkedPeer {
  doc: Y.Doc;
  awareness: Awareness;
  readonly online: boolean;
  /** Go offline (edits queue up locally) or come back (both sides catch up). */
  setOnline(online: boolean): void;
  destroy(): void;
}

/**
 * An in-memory stand-in for the network provider: it links any number of Y.Docs
 * (and their awareness instances) by relaying updates, with an optional delay.
 * For tests and demos; the real provider is a separate package.
 */
export class LinkedNetwork {
  private peers: Array<{ peer: LinkedPeer; online: boolean }> = [];
  private timers = new Set<ReturnType<typeof setTimeout>>();

  constructor(private delayMs = 0) {}

  setDelay(ms: number) {
    this.delayMs = ms;
  }

  /** Run `fn` now, or after the configured delay. */
  private later(fn: () => void) {
    if (this.delayMs <= 0) {
      fn();
      return;
    }
    const t = setTimeout(() => {
      this.timers.delete(t);
      fn();
    }, this.delayMs);
    this.timers.add(t);
  }

  join(doc: Y.Doc = new Y.Doc(), awareness: Awareness = new Awareness(doc)): LinkedPeer {
    const entry = { online: true } as { peer: LinkedPeer; online: boolean };
    const net = this;

    const peer: LinkedPeer = {
      doc,
      awareness,
      get online() {
        return entry.online;
      },
      setOnline(online) {
        if (entry.online === online) return;
        entry.online = online;
        if (online) net.sync(entry);
        else net.disconnectAwareness(entry);
      },
      destroy() {
        doc.off('update', onDocUpdate);
        awareness.off('update', onAwarenessUpdate);
        net.peers = net.peers.filter((p) => p !== entry);
        net.disconnectAwareness(entry);
      },
    };
    entry.peer = peer;

    const onDocUpdate = (update: Uint8Array, origin: unknown) => {
      if (origin === RELAY || !entry.online) return;
      for (const other of net.peers) {
        if (other === entry) continue;
        net.later(() => {
          if (entry.online && other.online) Y.applyUpdate(other.peer.doc, update, RELAY);
        });
      }
    };
    const onAwarenessUpdate = (
      change: { added: number[]; updated: number[]; removed: number[] },
      origin: unknown,
    ) => {
      if (origin === RELAY || !entry.online) return;
      const changed = [...change.added, ...change.updated, ...change.removed];
      const payload = encodeAwarenessUpdate(awareness, changed);
      for (const other of net.peers) {
        if (other === entry) continue;
        net.later(() => {
          if (entry.online && other.online) applyAwarenessUpdate(other.peer.awareness, payload, RELAY);
        });
      }
    };
    doc.on('update', onDocUpdate);
    awareness.on('update', onAwarenessUpdate);

    this.peers.push(entry);
    this.sync(entry);
    return peer;
  }

  /** Exchange everything the entry and each online peer are missing, plus presence. */
  private sync(entry: { peer: LinkedPeer; online: boolean }) {
    for (const other of this.peers) {
      if (other === entry) continue;
      this.later(() => {
        if (!entry.online || !other.online) return;
        const a = entry.peer;
        const b = other.peer;
        Y.applyUpdate(b.doc, Y.encodeStateAsUpdate(a.doc, Y.encodeStateVector(b.doc)), RELAY);
        Y.applyUpdate(a.doc, Y.encodeStateAsUpdate(b.doc, Y.encodeStateVector(a.doc)), RELAY);
        applyAwarenessUpdate(b.awareness, encodeAwarenessUpdate(a.awareness, [...a.awareness.getStates().keys()]), RELAY);
        applyAwarenessUpdate(a.awareness, encodeAwarenessUpdate(b.awareness, [...b.awareness.getStates().keys()]), RELAY);
      });
    }
  }

  /** Remote presence disappears when the link goes down, as it would after a socket close. */
  private disconnectAwareness(entry: { peer: LinkedPeer; online: boolean }) {
    const own = entry.peer.awareness.clientID;
    for (const other of this.peers) {
      if (other === entry) continue;
      removeAwarenessStates(other.peer.awareness, [own], RELAY);
      removeAwarenessStates(
        entry.peer.awareness,
        [...entry.peer.awareness.getStates().keys()].filter((id) => id !== own),
        RELAY,
      );
    }
  }

  /** Cancel updates that are still on their way (for cleanup in tests). */
  dispose() {
    this.timers.forEach(clearTimeout);
    this.timers.clear();
    [...this.peers].forEach((p) => p.peer.destroy());
  }
}
