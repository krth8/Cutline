// Hand-written provider for the Cutline page protocol (PLAN.md 5.7).
// Frames: [type byte][payload]. 0 sync-state (server->client), 1 update (both),
// 2 awareness (both), 3 state-vector (client->server).
import * as Y from 'yjs'
import { Awareness, encodeAwarenessUpdate, applyAwarenessUpdate, removeAwarenessStates } from 'y-protocols/awareness'

const ORIGIN = 'remote'

function frame(type, payload) {
  const out = new Uint8Array(payload.length + 1)
  out[0] = type
  out.set(payload, 1)
  return out
}

export class PageProvider {
  constructor(url, doc) {
    this.url = url // string or () => string (fresh ticket per attempt)
    this.doc = doc
    this.awareness = new Awareness(doc)
    this.status = 'connecting'
    this.synced = false
    this.attempt = 0
    this.closed = false
    this.listeners = {}
    this._onDocUpdate = (update, origin) => {
      if (origin !== ORIGIN && this._open()) this.ws.send(frame(1, update))
    }
    this._onAwareness = ({ added, updated, removed }, origin) => {
      if (origin === ORIGIN || !this._open()) return
      this.ws.send(frame(2, encodeAwarenessUpdate(this.awareness, added.concat(updated, removed))))
    }
    doc.on('update', this._onDocUpdate)
    this.awareness.on('update', this._onAwareness)
    this.connect()
  }
  on(ev, fn) { (this.listeners[ev] ||= []).push(fn) }
  _emit(ev, v) { (this.listeners[ev] || []).forEach((f) => f(v)) }
  _open() { return this.ws && this.ws.readyState === WebSocket.OPEN }
  _setStatus(s) { this.status = s; this._emit('status', s) }

  connect() {
    if (this.closed) return
    this._setStatus('connecting')
    const ws = (this.ws = new WebSocket(typeof this.url === 'function' ? this.url() : this.url))
    ws.binaryType = 'arraybuffer'
    ws.onopen = () => {
      this.attempt = 0
      this._setStatus('connected')
      // Ask for what we miss; the server answers with a type-1 diff. Then push ours.
      ws.send(frame(3, Y.encodeStateVector(this.doc)))
      if (this.awareness.getLocalState() !== null)
        ws.send(frame(2, encodeAwarenessUpdate(this.awareness, [this.doc.clientID])))
    }
    ws.onmessage = (ev) => {
      if (typeof ev.data === 'string') return // JSON control (ping/readonly): ignored in the spike
      const data = new Uint8Array(ev.data)
      const payload = data.subarray(1)
      if (data[0] === 0 || data[0] === 1) {
        Y.applyUpdate(this.doc, payload, ORIGIN)
        if (data[0] === 0) {
          // Server state received; send everything the server may lack (our diff against its state).
          this.ws.send(frame(1, Y.encodeStateAsUpdate(this.doc, Y.encodeStateVectorFromUpdate(payload))))
          if (!this.synced) { this.synced = true; this._emit('synced', true) }
        }
      } else if (data[0] === 2) {
        applyAwarenessUpdate(this.awareness, payload, ORIGIN)
      }
    }
    ws.onclose = () => {
      if (this.ws !== ws) return
      // Drop remote carets; keep our own state for the next connection.
      const others = [...this.awareness.getStates().keys()].filter((c) => c !== this.doc.clientID)
      removeAwarenessStates(this.awareness, others, ORIGIN)
      this.synced = false
      this._setStatus('disconnected')
      if (this.closed) return
      const delay = Math.min(250 * 2 ** this.attempt++, 5000) * (0.75 + Math.random() * 0.5)
      this.timer = setTimeout(() => this.connect(), delay)
    }
    ws.onerror = () => {}
  }
  destroy() {
    this.closed = true
    clearTimeout(this.timer)
    this.doc.off('update', this._onDocUpdate)
    removeAwarenessStates(this.awareness, [this.doc.clientID], 'local')
    this.awareness.destroy()
    if (this.ws) this.ws.close()
  }
}
