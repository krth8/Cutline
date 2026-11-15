/**
 * An in-memory page sync server for tests: the same behaviour as api/routes/pagesync.py as far as the
 * client can tell (type 0 on connect, type 1 applied and relayed, type 3 answered with a diff, awareness
 * relayed, ping answered with pong, readonly sockets ignored, close codes).
 */
import * as decoding from 'lib0/decoding';
import * as Y from 'yjs';
import { setPlatform } from '../../../platform';
import { createFakePlatform, type FakePlatform } from '../../../testing/fakePlatform';

export class FakeSocket {
  readyState = 0;
  binaryType = 'blob';
  onopen: ((ev: Event) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onclose: ((ev: CloseEvent) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  /** Frames the client sent, as the server saw them. */
  sent: Array<Uint8Array | string> = [];
  closedByClient: number | null = null;

  constructor(readonly server: FakeServer) {}

  send(data: Uint8Array | string) {
    if (this.readyState !== 1) throw new Error('FakeSocket.send: not open');
    this.sent.push(typeof data === 'string' ? data : new Uint8Array(data));
    queueMicrotask(() => this.server.receive(this, data));
  }

  close(code = 1000) {
    if (this.readyState === 3) return;
    this.closedByClient = code;
    this.readyState = 3;
    this.server.remove(this);
    // A real close handshake would call onclose; the provider detaches its handlers first
    this.onclose?.({ code } as CloseEvent);
  }

  // ---- server side ----
  deliver(data: Uint8Array | string) {
    if (this.readyState !== 1) return;
    let payload: string | ArrayBuffer;
    if (typeof data === 'string') payload = data;
    else {
      payload = new ArrayBuffer(data.length);
      new Uint8Array(payload).set(data);
    }
    this.onmessage?.({ data: payload } as MessageEvent);
  }

  serverClose(code: number) {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.server.remove(this);
    this.onclose?.({ code } as CloseEvent);
  }
}

export interface FakeServerOptions {
  readonly?: boolean;
  /** Do not answer pings (a half-dead connection). */
  silent?: boolean;
  /** Close every new socket with this code instead of syncing. */
  closeOnOpen?: number;
  /** Hold pongs back until `releasePongs()` (to observe the "saving" state). */
  holdPongs?: boolean;
}

export class FakeServer {
  doc = new Y.Doc();
  sockets: FakeSocket[] = [];
  everOpened: FakeSocket[] = [];
  paths: string[] = [];
  options: FakeServerOptions;
  /** Next openSocket calls fail with this error (one entry per call). */
  failOpens = 0;
  private heldPongs: FakeSocket[] = [];
  /** Updates the server applied (type 1 frames from clients), in order. */
  applied: Uint8Array[] = [];

  constructor(options: FakeServerOptions = {}) {
    this.options = options;
  }

  open(path: string): Promise<WebSocket> {
    this.paths.push(path);
    if (this.failOpens > 0) {
      this.failOpens--;
      return Promise.reject(new Error('no ticket'));
    }
    const socket = new FakeSocket(this);
    this.everOpened.push(socket);
    // A real socket opens in a later task: the client has attached its handlers by then
    afterTicks(() => {
      if (socket.readyState !== 0) return;
      socket.readyState = 1;
      this.sockets.push(socket);
      socket.onopen?.(new Event('open'));
      if (this.options.closeOnOpen) {
        socket.serverClose(this.options.closeOnOpen);
        return;
      }
      socket.deliver(frame0(Y.encodeStateAsUpdate(this.doc)));
      if (this.options.readonly) socket.deliver(JSON.stringify({ type: 'readonly' }));
    });
    return Promise.resolve(socket as unknown as WebSocket);
  }

  remove(socket: FakeSocket) {
    this.sockets = this.sockets.filter((s) => s !== socket);
  }

  receive(from: FakeSocket, data: Uint8Array | string) {
    if (from.readyState !== 1) return;
    if (typeof data === 'string') {
      if (JSON.parse(data).type === 'ping' && !this.options.silent) {
        if (this.options.holdPongs) this.heldPongs.push(from);
        else from.deliver(JSON.stringify({ type: 'pong' }));
      }
      return;
    }
    const type = data[0];
    const payload = data.subarray(1);
    if (type === 1) {
      if (this.options.readonly) return;
      Y.applyUpdate(this.doc, payload, 'client');
      this.applied.push(payload);
      this.relay(from, data);
    } else if (type === 3) {
      from.deliver(prefixed(1, Y.encodeStateAsUpdate(this.doc, payload)));
    } else if (type === 2) {
      this.relay(from, data);
    }
  }

  private relay(from: FakeSocket, data: Uint8Array) {
    for (const s of this.sockets) if (s !== from) s.deliver(data);
  }

  /** Send a frame from the server to every connected client (as if another client had edited). */
  broadcastUpdate(update: Uint8Array) {
    Y.applyUpdate(this.doc, update, 'other');
    for (const s of this.sockets) s.deliver(prefixed(1, update));
  }

  /** An edit by another person, applied to the server doc and relayed. */
  editAsOther(fn: (doc: Y.Doc) => void) {
    const other = new Y.Doc();
    Y.applyUpdate(other, Y.encodeStateAsUpdate(this.doc));
    let captured: Uint8Array | null = null;
    other.on('update', (u: Uint8Array) => {
      captured = u;
    });
    fn(other);
    if (captured) this.broadcastUpdate(captured);
  }

  sendAwareness(payload: Uint8Array) {
    for (const s of this.sockets) s.deliver(prefixed(2, payload));
  }

  releasePongs() {
    const held = this.heldPongs;
    this.heldPongs = [];
    for (const s of held) s.deliver(JSON.stringify({ type: 'pong' }));
  }

  closeAll(code: number) {
    for (const s of [...this.sockets]) s.serverClose(code);
  }

  get last(): FakeSocket {
    return this.everOpened[this.everOpened.length - 1]!;
  }

  /** Binary frames the client sent over all sockets, as [type, payload]. */
  frames(type?: number): Array<{ type: number; payload: Uint8Array }> {
    return this.everOpened
      .flatMap((s) => s.sent)
      .filter((d): d is Uint8Array => typeof d !== 'string')
      .map((d) => ({ type: d[0]!, payload: d.subarray(1) }))
      .filter((f) => type === undefined || f.type === type);
  }

  /** Text frames the client sent. */
  texts(): string[] {
    return this.everOpened.flatMap((s) => s.sent).filter((d): d is string => typeof d === 'string');
  }

  /** The text of the document as the server holds it. */
  text(): string {
    return xmlText(this.doc);
  }
}

function afterTicks(fn: () => void, ticks = 4) {
  if (ticks <= 0) fn();
  else queueMicrotask(() => afterTicks(fn, ticks - 1));
}

function frame0(payload: Uint8Array) {
  return prefixed(0, payload);
}

function prefixed(type: number, payload: Uint8Array) {
  const out = new Uint8Array(payload.length + 1);
  out[0] = type;
  out.set(payload, 1);
  return out;
}

/** Plain text of the "default" fragment (paragraph texts joined with newlines). */
export function xmlText(doc: Y.Doc): string {
  return doc
    .getXmlFragment('default')
    .toArray()
    .map((n) => (n instanceof Y.XmlElement ? n.toString().replace(/<[^>]+>/g, '') : ''))
    .join('\n');
}

/** Append a paragraph with `text` (or add `text` to the end of the last paragraph). */
export function typeInto(doc: Y.Doc, text: string) {
  const fragment = doc.getXmlFragment('default');
  doc.transact(() => {
    let paragraph = fragment.get(fragment.length - 1) as Y.XmlElement | undefined;
    if (!paragraph) {
      paragraph = new Y.XmlElement('paragraph');
      fragment.insert(0, [paragraph]);
    }
    let node = paragraph.get(paragraph.length - 1) as Y.XmlText | undefined;
    if (!node) {
      node = new Y.XmlText();
      paragraph.insert(0, [node]);
    }
    node.insert(node.length, text);
  });
}

/** The awareness entries of a frame payload: client id to state (null for a removal). */
export function decodeAwareness(payload: Uint8Array): Map<number, unknown> {
  const decoder = decoding.createDecoder(payload);
  const out = new Map<number, unknown>();
  const count = decoding.readVarUint(decoder);
  for (let i = 0; i < count; i++) {
    const clientId = decoding.readVarUint(decoder);
    decoding.readVarUint(decoder); // clock
    out.set(clientId, JSON.parse(decoding.readVarString(decoder)));
  }
  return out;
}

export interface Harness {
  server: FakeServer;
  platform: FakePlatform;
}

/** Install a fake platform whose sockets go to a fresh FakeServer. */
export function installServer(options: FakeServerOptions = {}): Harness {
  const server = new FakeServer(options);
  const platform = createFakePlatform();
  platform.openSocket = (path) => server.open(path);
  setPlatform(platform);
  return { server, platform };
}

/** Let queued microtasks (socket opens, deliveries) run. */
export async function flush(times = 5) {
  for (let i = 0; i < times; i++) await Promise.resolve();
}
