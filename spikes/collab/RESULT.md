# F6 result: collaborative editor spike

## Verdict: GO with listed changes

D2 (Tiptap + Yjs) and D3 (pycrdt holds the Yjs state on the server) work end to end.
All of (a)-(g) pass from a real run. The changes to PLAN.md 5.7 are small (see "Changes to 5.7");
none of them is a blocker. The fallback (dumb relay, clients extract text) is not needed.

## Versions (exact)

| Package | Version |
|---|---|
| Python | 3.12.10 |
| Node | v26.13.0 |
| pycrdt | 0.14.13 |
| fastapi / starlette | 0.109.0 / 0.35.1 |
| uvicorn / websockets | 0.27.0 / 12.0 |
| @tiptap/core, starter-kit, extension-collaboration, extension-collaboration-caret, @tiptap/pm | 3.34.0 |
| @tiptap/y-tiptap | 3.3.0 |
| yjs | 13.6.33 |
| y-protocols | 1.0.7 |
| esbuild | 0.28.2 (bundle 517 kB minified, unsplit) |
| Playwright (Python) / Chromium headless | 1.49.1 |

Note: Tiptap 3 is current. `@tiptap/extension-collaboration-cursor` no longer exists; it is
`@tiptap/extension-collaboration-caret`. Both use `@tiptap/y-tiptap` (a fork of y-prosemirror) as peer,
not `y-prosemirror`. Install `yjs` and `y-protocols` yourself; they are peers, not bundled.

## check.py output (actual run, exit code 0)

```
PASS  (b) A -> B  'Hello world'
PASS  (a) concurrent typing, same paragraph  A='AAAAAAAAAAHello worldBBBBBBBBBB' B='AAAAAAAAAAHello worldBBBBBBBBBB'
PASS  (g) remote caret element present  B sees ['Alice']
PASS  (extra) Carol caret seen, then removed after she closes  B sees ['Alice']
PASS  (e) server plain text  'AAAAAAAAAAHello worldBBBBBBBBBB'
PASS  (c) server restart: content kept, editing continues  (A, B and server all = '...BBBBBBBBBB after-restart')
PASS  (d) offline edits converge  A=B='OFFLINE-A AAAAAAAAAAHello worldBBBBBBBBBB after-restart ONLINE-B'
PASS  (f) after snapshot (+server restart) fresh client gets full doc  before={'update_rows': 60, 'update_bytes': 1122, 'snapshot_bytes': 0} snap={'rows_merged': 60, 'bytes': 633} after={'update_rows': 0, 'update_bytes': 0, 'snapshot_bytes': 633}
PASS  (e2) server plain text after snapshot reload  'OFFLINE-A AAAAAAAAAAHello worldBBBBBBBBBB after-restart ONLINE-B'

9/9 passed
```

| Item | Result |
|---|---|
| (a) both type in the same paragraph at once, both texts survive on both sides | PASS |
| (b) text typed in A appears in B | PASS |
| (c) server killed and restarted: content kept, editing continues after auto-reconnect | PASS |
| (d) one client offline (socket closed + context offline), both edit, converge with both edits | PASS |
| (e) server plain-text endpoint returns the text (also after snapshot + restart) | PASS |
| (f) after snapshot (and server restart, so the doc comes only from the snapshot blob) a fresh client gets the full doc | PASS |
| (g) the other user's caret element (`.collaboration-carets__caret` / `__label` with the name) is in the DOM | PASS |
| extra: caret disappears in other clients when a socket closes (server-side cleanup) | PASS |

Limits of the test: one machine, localhost (no latency), headless Chromium only, two to four clients,
a single paragraph; no rich-text node types beyond StarterKit were exercised in check.py.

## Measurements (`python measure.py`, localhost)

Frames are WebSocket binary payloads including the leading type byte.

| Item | Bytes |
|---|---|
| single keystroke, type-1 update | 19 (first keystroke that creates the paragraph: 50) |
| paste of one 100-word paragraph (534 chars), type-1 update | 581 (about chars + 47) |
| awareness frame (type 2), sent on every selection change, i.e. also with every keystroke | 578 |

The awareness frame is 30x bigger than a keystroke update. Throttle outgoing awareness (see pitfalls).

Stored state, about 5,000 words (random words, 50 paragraphs of 100 words):

| Document | Rows in `page_updates` | Update bytes | After snapshot (1 blob) | Server load (in-process `Doc` rebuild) |
|---|---|---|---|---|
| pasted/set in one go | 2 | 30,012 | 30,010 | 0.3 ms before and after |
| typed one word per update (5,050 updates, a realistic worst case; real per-keystroke would be ~5x more rows) | 5,050 | 129,150 | 76,594 | 10.7 ms before snapshot, 1.6 ms after |

So: raw text is ~28 kB; a snapshot is 1.1x to 2.7x the text size depending on edit history; replaying
5,000 stored rows costs ~11 ms. Load time is not a concern. The case for the 200-rows / 30 s snapshot rule
is storage size (~40% smaller) and row count, not speed. Python process start and SQLite file open are not
included in the load figures.

## Changes to 5.7

1. **Type `0` and type `3` overlap; the client diff needs the server's state.** The server answering a
   state vector with a diff gives the client what it lacks, but nothing tells the client what the server
   lacks (the server's state vector is never sent). With type `0` the client can compute it:
   `Y.encodeStateAsUpdate(doc, Y.encodeStateVectorFromUpdate(syncStateUpdate))`. That is what the spike does
   (and it works), so type `3` was exercised but is not needed. Proposed replacement for the table rows
   `0` and `3` and the paragraph after it:

   > | `0` sync-state | server to client, once on connect | the server's full merged Yjs update. The client applies it, then sends its own diff against it as a type `1` frame (`Y.encodeStateAsUpdate(doc, Y.encodeStateVectorFromUpdate(payload))`). |
   > | `3` state-vector | client to server, optional | client's state vector; the server answers with a type `1` diff. Not needed when type `0` is used; keep it for a later large-document mode where the server skips the type `0` full state and waits for a `3`. |

   If large documents matter later, make type `0` conditional (server sends its state *vector* instead of
   the full update, with type `0` meaning "server state vector"; client replies with a diff). For 5,000
   words (30-77 kB) the full state on connect is fine.

2. **Awareness cleanup must be specified.** "Relayed, never stored" is not enough: when a socket closes
   the other clients keep showing its caret until the y-protocols 30 s timeout. Add:

   > The server remembers, per socket, the awareness client ids and last clock it saw in type `2` frames
   > (the payload is varuint count, then per entry varuint clientID, varuint clock, varstring JSON state).
   > When the socket closes it relays a type `2` frame with `{clientID, clock + 1, state "null"}` for each
   > of them. Clients, on socket close, remove all remote awareness states locally
   > (`removeAwarenessStates`) and re-send their own state after reconnect.

3. **Fragment name.** Add: "The editor content lives in the Y.XmlFragment named `default` (Tiptap's
   default). The server reads that name. Do not configure another."

4. **Snapshot text extraction.** Add a sentence that `pages.text` is extracted by walking
   the fragment (`XmlElement` children, `XmlText.diff()` runs), and that rows are inserted by the server
   only after `apply_update` succeeds (malformed frames are dropped, not stored).

5. Optional: tell the client to throttle outgoing awareness (about 100 ms) and to send a type `2`
   heartbeat about every 15 s (y-protocols expires states not renewed in 30 s; the stock `Awareness`
   already renews, so the provider just has to keep the `Awareness` object alive).

## Pitfalls for P2 (server), P3 (editor), P4 (provider)

Editor (P3):
- Tiptap 3 StarterKit includes the history extension as **`undoRedo`** (it was `history` in Tiptap 2).
  It must be disabled with Yjs: `StarterKit.configure({ undoRedo: false })`. The Collaboration extension
  provides Yjs-aware undo/redo itself (`editor.commands.undo()`, Mod-z).
- The Collaboration extension stores content in `Y.XmlFragment` named **`default`**. Configurable with
  `Collaboration.configure({ document, field: '...' })`, but the server has to read the same name.
- Collaboration (3.x) takes `document: Y.Doc`, not a provider. `CollaborationCaret.configure({ provider, user })`
  needs an object with an `awareness` property (a y-protocols `Awareness`). The user is `{name, color}`.
  It renders `.collaboration-carets__caret` with a child `.collaboration-carets__label`; style them in CSS
  (the extension ships no CSS).
- Do not call `setContent` on a synced editor to load content (it is a normal edit that replaces the shared content for everyone). Initial content / the legacy import is written once, by the claimed importer only,
  and only into an empty fragment.

Provider (P4):
- Updates the provider applies from the server must carry an origin (`Y.applyUpdate(doc, u, ORIGIN)`) and
  the `doc.on('update')` handler must skip that origin, or every received update is echoed back to the server.
- On `onclose` remove remote awareness states; on `onopen` send state-vector (if used), our diff and our
  awareness. Reconnect with exponential backoff plus jitter (the spike: 250 ms doubling to 5 s, +-25 %); the
  reconnect after a server restart worked without intervention.
- A fresh ticket per attempt (`url` as a function) is required once tickets are one-time (they are, per the plan).
- Offline edits are just local Yjs updates; the diff sent after reconnect carries them. No queue needed.
- `new WebSocket` messages arrive as ArrayBuffer only with `binaryType = 'arraybuffer'`.
- Update frames: a received update with missing dependencies stays "pending" inside Yjs until the missing
  part arrives; this was not hit in tests but means "synced" must mean "type 0 applied and our diff sent".

Server (P2):
- pycrdt API used (all verified in 0.14.13):
  `doc = Doc()`; `doc.apply_update(bytes)` (raises `ValueError` for undecodable input);
  full state `doc.get_update()`; diff for a client `doc.get_update(client_state_vector)`;
  `doc.get_state()` is the state vector; `pycrdt.merge_updates(*updates)` merges blobs without a Doc;
  `doc.get("default", type=XmlFragment)` for the editor content; `doc.observe(cb)` gives events with
  `.update` (one event per transaction). The server does not need observers: the bytes received from a
  socket are exactly what must be stored and relayed. Use observers only for server-originated edits.
- `str(XmlText)` returns the text **with formatting as XML tags** (`<bold>he</bold>llo`). For plain text use
  `"".join(run for run, attrs in xml_text.diff() if isinstance(run, str))`. Embedded (non-str) runs, like
  inline atoms, show up as non-str items in `diff()`; the spike skips them (P2 should map `taskChip`,
  `pageLink`, `mention` nodes by reading their attributes).
- Threading: pycrdt 0.14.13 did not panic when a `Doc` was read from another thread in a quick test, but
  `Doc` is not documented as thread-safe. Do all Doc access on the event-loop thread (as the spike does).
  Applying/merging for a 5,000-word page takes under 20 ms, so it does not need `run_in_executor`; for
  snapshot merging of very large logs use `merge_updates` (works on bytes, so it is safe in a worker thread).
  Note: blocking SQLite writes on the event loop are the larger risk (the spike commits per update; P2 should
  use the existing DB layer and think about batching).
- Do not trust frames: wrap `apply_update` in try/except and drop the frame, and store only after the apply
  succeeded (the spike does). Check `readonly` before applying.
- Awareness: parse only to learn client ids for cleanup (see 5.7 change 2). Clients may legitimately send
  several client ids over one socket (reconnects reuse the Awareness object; the id stays the same, but
  several tabs have their own sockets).
- Duplicates: after every reconnect the client sends a diff that may be redundant. `apply_update` is
  idempotent, but the spike still appends the row. P2 can skip storing when `doc.get_state()` did not change.
- Snapshot: merge `pages.ydoc` (old) + all rows with id <= last merged id, write, delete those rows in one
  transaction. Rows arriving during the snapshot have higher ids and survive. A snapshot (`doc.get_update()` of
  the live doc) is equivalent and also drops deleted content bookkeeping better; either is fine, `merge_updates`
  is used in the spike. Deleted text keeps tombstones: the typed-per-word document is 76 kB for 28 kB of text.
- On startup, rebuild lazily per page when the first socket arrives (as the spike does), not for all pages.
- Awareness frames are about 580 bytes each; relaying them costs more bandwidth than the document edits.

## Not done / not verified

- No auth, tickets, read-only sockets, guest sessions: out of scope for the spike.
- Only Chromium, only localhost, no latency or packet-loss simulation, two to four clients.
- Rich-text node types (lists, task lists, custom nodes) and images were not exercised, only paragraphs.
- Load figures exclude Python process start-up. Memory per Doc was not measured.
- Undo/redo behaviour with two users was not tested (Collaboration extension's undo is Yjs UndoManager based).

## Fallback evaluation (not needed)

If pycrdt had failed: server stores opaque updates (same `page_updates` table, same relay), and clients
send extracted plain text with each snapshot trigger. It would work but loses server-side search, export and
reference extraction without a client being online; with pycrdt working this is unnecessary.

## How to rerun

```
cd spikes/collab
python -m pip install -r requirements.txt
npm install && npm run build
python check.py      # asserts (a)-(g)
python measure.py    # prints the sizes above
python server.py 8765   # manual use: http://127.0.0.1:8765/?page=p1&name=Alice
```
