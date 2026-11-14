# Cutline: Pages plan

Tasks and Docs merge into one surface, **Pages**, built the Coda way: a page is
a document, and tasks, tables and views are blocks placed in it. Tasks stay
real data (rows in a table); a page only *shows* them through views (table,
board, calendar, gantt, list). Review stays its own product area.

This document is the source of truth for that work. It is written so that
independent agents can each take one work package (WP) and finish it without
talking to each other. Read sections 1 to 5 before starting any WP.

Status of every WP is tracked in section 9. Update it in the same commit that
finishes the WP.

---

## 1. Where we are today

| Area | State | Key files |
|---|---|---|
| Backend | FastAPI, one process, SQLite (PostgreSQL optional). Projects and tasks are held in memory and loaded at startup. | `server.py`, `api/`, `database/` |
| Auth | Server-side sessions, HttpOnly cookie + `X-Client-Id` (CSRF), idle timeout, one-time WebSocket tickets, guest sessions. | `api/auth.py`, `api/sessions.py`, `static/js/core/auth.js`, `static/js/core/api.js` |
| Live updates | One socket per tab (`/ws/live`); server pushes project events; no echo to the originating tab. | `api/events.py`, `api/routes/live.py`, `static/js/core/live.js` |
| Tasks | Table `tasks` (+ `task_assignees`, `task_clips`, `task_checklist_items`, `task_comments`, `task_sections`). `custom_fields` JSON column exists and is unused. Edits are written back every 30 s. | `api/routes/tasks.py`, `database/tasks.py`, `static/js/modules/projects/*` (about 4,300 lines), `static/js/core/PropertyRegistry.js`, `static/js/core/TaskUpdater.js` |
| Docs | `documents` + `doc_folders`. HTML content, `contenteditable` + `document.execCommand`, per-block merge with a version number. | `api/routes/documents.py`, `database/documents.py`, `static/js/modules/docs/*` |
| Frontend | No build step. Plain `<script>` tags, globals, `static/js/app.js` is 4,900 lines, one 13,800-line CSS file with CSS variables for theming. | `static/index.html`, `static/css/main.css` |
| Tests | `pytest` (72 tests: auth, access, comments, live, media, rooms). Browser checks exist only as throwaway scripts outside the repo. | `tests/` |

Things that constrain the design:

- Statuses are global (`clip_statuses`), shared by clips and tasks, with presets.
- Project access is `can_review`, `can_tasks`, `is_owner` per user per project, plus a global role (`admin`, `editor`, `viewer`).
- Share-link guests see one project's review only. They never see tasks or docs.
- UI strings are mixed English and Norwegian (`clips.js`). New UI is English.

---

## 2. Target

### Product shape

```
Home                      a page from your personal space, pinned as landing page
Personal space            pages only you can see
  My dashboard
  Notes ...
Projects
  <Project>
    Review                unchanged (player, clips, comments, sessions)
    Pages                 page tree; replaces the Tasks and Docs tabs
      Tasks               created for every project: one view of all its tasks
      Brief, Script ...
Lounge                    unchanged
```

- A **page** is rich text plus blocks. Markdown shortcuts and a `/` menu.
- A **table** is data: columns (typed) and rows. Every project has one built-in
  table, its tasks. Later, users can create their own tables.
- A **view** is a saved way of looking at a table: layout (table, board, list,
  calendar, gantt), filters, sorts, grouping, visible columns, summaries.
  One table can have any number of views; the same row edited in one view
  changes everywhere at once.
- A **view block** places a view in a page. A dashboard is a page whose view
  blocks read across projects ("my open tasks everywhere").
- A **task** opens in a side panel. Its body is itself a page (same editor).

### Explicitly not in scope

- Review (player, drawing, timecode comments, sessions) is not rebuilt.
  Clips can be *shown* on pages; they are not edited there.
- No Coda-style formula language before Phase 4, and then a small one.
- No offline-first, no native apps, no public page publishing (see section 8).

---

## 3. Architecture decisions

Each decision is final for this plan. Changing one means updating this file
first.

**D1. New UI is a bundled TypeScript + React app, mounted inside the existing page.**
The legacy code stays as it is (script tags, globals). New code lives in
`web/`, is built with esbuild into `static/dist/`, and exposes
`window.CutlinePages.mount(element, route)`. Reasons: Tiptap, Yjs and view
layouts need npm packages and components; types make contracts between
parallel WPs checkable; nothing existing has to be rewritten to get started.
The bundle is not committed: it is built in a Docker stage and by
`npm run build` locally.

**D2. Editor is Tiptap (ProseMirror) with Yjs for collaboration.**
Character-level merging, cursors and undo come from Yjs. The per-block merge
in `docMerge.js` is deleted together with the old Docs module.

**D3. The server understands the documents: `pycrdt` holds the Yjs state.**
The server applies updates, stores them, and can read page content (search
text, references, export). The wire protocol is our own thin one (section
5.4) over the existing ticketed WebSocket, not `y-websocket`.
WP F6 is a spike that proves D2 + D3 end to end before anything depends on it.

**D4. One table API, several sources.**
Views never talk to "tasks" directly. They talk to a table reference:

- `tasks:<projectId>`: the tasks of one project
- `tasks:*`: tasks of every project the caller can access (dashboards)
- `tbl_<id>`: a user-created table (Phase 4)

The server implements a `TableSource` per kind. Tasks keep their SQL tables;
custom columns are stored in `tasks.custom_fields`. This is what lets every
view layout be built once and work for tasks now and custom tables later.

**D5. The server is the authority on queries.**
Filtering, sorting, grouping and summaries run on the server
(`POST /api/tables/{ref}/query`). The client edits optimistically and, when a
live event says the table changed, re-runs the query (debounced). No filter
logic is duplicated in the browser.

**D6. Views are rows in the database, not content of the page.**
The Yjs document holds only `{ type: "viewBlock", viewId }`. Config changes
go through the REST API and are pushed over `/ws/live`. This keeps
permissions enforceable and lets the same view be reused.

**D7. Pages belong to a space: a project, or a person.**
`pages.space_type` is `project` or `personal`. Permissions follow the space
(section 5.5). A view block is always filtered by what the *reader* may see,
whatever page it sits on.

**D8. Everything is written to the database when it happens.**
The 30-second write-back for tasks and clip status is removed (WP F2) before
tables are built on top of tasks.

**D9. Schema changes are numbered migration files.**
`database/migrations/NNN_<name>.py`, applied in order at startup, recorded in
`schema_migrations`. No WP edits `database/engine.py` after F1.

**D10. New styles live next to their component and use the existing CSS variables.**
No WP edits `static/css/main.css`. Component CSS is imported by the bundle
and prefixed `cl-`.

---

## 4. Rules for every work package

1. **Start clean.** `git fetch`, be up to date with `origin/main`, work on a
   branch `wp/<ID>-<slug>` (use a worktree when running in parallel).
2. **Stay in your files.** Each WP lists the paths it owns. Do not edit other
   paths except the *shared touchpoints* listed for that WP. If you need a
   change elsewhere, write it in the WP's "Notes" in section 9 and stop.
3. **Code to the contracts in section 5.** If a contract is wrong or missing
   something, propose the change in section 9; do not invent a variant.
4. **Tests are part of the WP.** Backend: `pytest`. Frontend logic: `vitest`.
   User-visible behaviour: one Playwright test in `tests/e2e/` (after F3).
   A WP is done when its acceptance list passes and the whole suite is green.
5. **No drive-by refactors** of legacy code. Legacy files are changed only by
   the WPs that say so.
6. **English** in UI text, code and comments. Comments say what the code does
   and why, not how it came to be.
7. **Commit messages** describe the behaviour change. Push the branch and
   open a PR; do not push to `main`. Commits that touch `.github/workflows/`
   cannot be pushed from the owner's machine (missing token scope): put the
   file content in the PR description instead.
8. **Report honestly.** If an acceptance item is not met, say which and why.

Agent prompt template:

```
You are implementing work package <ID> from PLAN.md in this repository.
Read PLAN.md sections 1-5 and the entry for <ID> in section 7. Follow the
rules in section 4. Own only the listed paths. When finished: all acceptance
items pass, the full test suite is green, section 9 is updated, the branch is
pushed and a PR is open. Report what you built, what you verified and how,
and anything you could not do.
```

---

## 5. Contracts

### 5.1 Repository layout (new)

```
web/
  package.json            esbuild, typescript, react, vitest, tiptap, yjs
  src/
    index.ts              window.CutlinePages
    platform.ts           typed bridge to the legacy page (5.2)
    router.ts             routes (5.3)
    api/                  typed REST clients, one file per resource
    pages/                editor, blocks, page tree
    tables/               RowStore, useView, ViewShell, cells/, layouts/
    task/                 task panel
    ui/                   shared primitives (Popover, Menu, DatePicker, Avatar ...)
static/dist/              build output (git-ignored)
database/migrations/      NNN_<name>.py
api/tables/               TableSource implementations and the query engine
api/routes/pages.py, tables.py, views.py
tests/e2e/                Playwright (Python) + harness
```

### 5.2 Platform bridge (`web/src/platform.ts`)

The only way new code touches the legacy page. F4 implements it by wrapping
existing globals; nothing else reads `window.*`.

```ts
export interface Platform {
  user(): { id: string; username: string; role: 'admin'|'editor'|'viewer'; profileImage?: string } | null;
  fetch(path: string, init?: RequestInit): Promise<Response>;   // adds auth, CSRF, idle headers; handles 401
  openSocket(path: string): Promise<WebSocket>;                 // one-time ticket
  live: {
    on(type: string, handler: (msg: any) => void): () => void;  // returns unsubscribe
    watch(slot: string, target: { projects?: string[]; allTasks?: boolean } | null): void;
  };
  toast(kind: 'info'|'success'|'error', message: string): void;
  confirm(message: string, opts?: { danger?: boolean; confirmLabel?: string }): Promise<boolean>;
  navigate(route: string): void;
  projects(): Array<{ id: string; name: string; canTasks: boolean; isOwner: boolean }>;
  statuses(): Array<{ id: string; name: string; color: string }>;
  members(projectId: string): Promise<Array<{ id: string; username: string; profileImage?: string }>>;
}
```

### 5.3 Routes

Served by the server as `index.html`; parsed by `web/src/router.ts`.

| URL | Shows |
|---|---|
| `/` | Home: the user's pinned page, else the project list |
| `/me` , `/me/page/<pageId>` | Personal space |
| `/p/<projectId>/pages` , `/p/<projectId>/page/<pageId>` | Project pages |
| `/p/<projectId>/review` (+ `?clip=&v=&session=`) | Review (legacy view) |
| `...?task=<taskId>` on any route | Task panel open over the current route |

Existing `/?project=<id>` links keep working and redirect to `/p/<id>/review`.

### 5.4 Data model

New tables (created by the WP named in brackets):

```
pages                                                        [P1]
  id TEXT PK, kind TEXT ('page' | 'task'),
  space_type TEXT ('project' | 'personal'),
  project_id TEXT NULL -> projects, owner_id TEXT NULL -> users,
  parent_id TEXT NULL -> pages, task_id TEXT NULL -> tasks (kind='task', unique),
  title TEXT, icon TEXT NULL, sort_order REAL,
  ydoc BLOB NULL            -- merged Yjs state (snapshot)
  text TEXT NULL            -- plain text, derived, for search
  legacy_html TEXT NULL     -- content waiting to be imported (5.7)
  created_by, created_at, updated_at, archived_at NULL

page_updates                                                 [P2]
  id INTEGER PK AUTOINCREMENT, page_id -> pages, update BLOB, created_at
  -- appended on every change; folded into pages.ydoc and deleted by the snapshot job

page_refs                                                    [S5]
  page_id -> pages, ref_type TEXT ('task'|'page'|'clip'|'user'|'view'), ref_id TEXT
  -- derived from the document at snapshot time; powers backlinks

views                                                        [T4]
  id TEXT PK, table_ref TEXT, name TEXT,
  owner_page_id TEXT NULL -> pages (deleted with the page),
  layout TEXT, config TEXT (JSON, 5.6), created_by, created_at, updated_at

table_columns                                                [T2]
  id TEXT PK, table_ref TEXT, key TEXT, name TEXT, type TEXT,
  config TEXT (JSON), sort_order REAL, UNIQUE(table_ref, key)
  -- custom columns. For tasks, table_ref is 'tasks:<projectId>'

tasks: + start_date TEXT NULL                                [T9]
task_dependencies (task_id, depends_on_id, PK both)          [T9, optional part]

custom_tables, custom_rows                                   [C1]
```

`documents`, `doc_folders` are dropped by P8 after migration.
`task_checklist_items` stays until a later decision (section 8).

### 5.5 Permissions

| Action | Rule |
|---|---|
| Read a project page | any access to the project (not guests) |
| Edit a project page, its views | `can_tasks` on the project and role is not `viewer` (same as `can_edit_tasks` today) |
| Read or edit a personal page | the owner only |
| Read rows through any view | rows of projects where the caller has `can_tasks`; others are silently left out |
| Edit a row | `can_edit_tasks` on the row's project |
| Table schema (add column) | project owner or admin |

One helper per rule in `api/auth.py` (`can_read_page`, `can_edit_page`, ...),
used by REST and WebSocket alike. Every rule gets a test in `tests/`.

### 5.6 Table API

```ts
type ColumnType = 'text'|'longtext'|'number'|'checkbox'|'date'|'select'|'multiselect'
                | 'status'|'priority'|'person'|'people'|'url'|'clip'|'relation'|'formula';

interface Column {
  key: string;                 // 'name', 'status', 'assignees', 'dueDate', 'cf_ab12' ...
  name: string;
  type: ColumnType;
  builtin: boolean;            // builtin columns cannot be deleted or retyped
  readonly?: boolean;
  options?: Array<{ value: string; label: string; color?: string }>;  // select-like types
  config?: Record<string, unknown>;
}

interface TableSchema {
  ref: string;                 // 'tasks:<projectId>' | 'tasks:*' | 'tbl_<id>'
  name: string;
  columns: Column[];
  titleColumn: string;         // 'name' for tasks
  capabilities: { create: boolean; delete: boolean; hierarchy: boolean; editSchema: boolean };
}

interface Row {
  id: string;
  tableRef: string;            // concrete table of this row ('tasks:<projectId>')
  parentId?: string | null;
  childCount?: number;
  values: Record<string, unknown>;   // by column key
  canEdit: boolean;
}

type FilterOp = 'eq'|'neq'|'in'|'nin'|'contains'|'empty'|'notEmpty'|'lt'|'lte'|'gt'|'gte'
              | 'before'|'after'|'between'|'relative';   // relative: {unit:'day'|'week'|'month', from:-7, to:0}
type Filter =
  | { column: string; op: FilterOp; value?: unknown }
  | { and: Filter[] } | { or: Filter[] };

interface Query {
  filter?: Filter;
  sort?: Array<{ column: string; dir: 'asc'|'desc' }>;
  groupBy?: string;                                   // column key
  summaries?: Record<string, 'count'|'countEmpty'|'countFilled'|'sum'|'avg'|'min'|'max'|'percentChecked'>;
  parentId?: string | null;                           // hierarchy: null = roots only, omit = flat
  search?: string;
  limit?: number; offset?: number;
}

interface QueryResult {
  rows: Row[];
  total: number;
  groups?: Array<{ key: string | null; label: string; color?: string; count: number;
                   summaries?: Record<string, number | null> }>;
  summaries?: Record<string, number | null>;
}
```

The special value `"@me"` in a `person`/`people` filter means the caller.

Endpoints:

```
GET    /api/tables/{ref}/schema                 -> TableSchema
POST   /api/tables/{ref}/query        Query     -> QueryResult
POST   /api/tables/{ref}/rows         {values, parentId?, projectId? (required for tasks:*)} -> Row
PATCH  /api/tables/{ref}/rows/{id}    {values}  -> Row
DELETE /api/tables/{ref}/rows/{id}
POST   /api/tables/{ref}/rows/reorder {ids, before?: id}
POST   /api/tables/{ref}/columns      Column    -> Column         (custom columns)
PATCH  /api/tables/{ref}/columns/{key}
DELETE /api/tables/{ref}/columns/{key}

GET    /api/views/{id}                          -> View
POST   /api/views                     {tableRef, name, layout, config, ownerPageId?}
PATCH  /api/views/{id}
DELETE /api/views/{id}
```

```ts
interface View {
  id: string; tableRef: string; name: string;
  layout: 'table'|'board'|'list'|'calendar'|'gantt';
  config: {
    query: Query;
    columns?: Array<{ key: string; width?: number; hidden?: boolean }>;   // order = display order
    board?:    { groupBy: string; cardColumns: string[] };
    calendar?: { dateColumn: string; endColumn?: string };
    gantt?:    { startColumn: string; endColumn: string; scale: 'day'|'week'|'month' };
    list?:     { secondaryColumns: string[] };
  };
}
```

Live events (pushed on `/ws/live`, never echoed to the originating tab):

```
{ type: 'rows_changed',  tableRef, ids: string[], change: 'created'|'updated'|'deleted'|'reordered', project }
{ type: 'schema_changed', tableRef, project }
{ type: 'view_changed',  viewId, project? }
{ type: 'page_changed',  pageId, change: 'created'|'renamed'|'moved'|'archived'|'deleted', project? }
```

The existing `task_*` events keep being sent until T13 removes the old task UI.

Client side, every layout receives the same props and nothing else:

```ts
interface LayoutProps {
  schema: TableSchema;
  view: View;
  result: QueryResult;                       // from useView(viewId)
  loading: boolean;
  actions: {
    updateRow(id: string, values: Record<string, unknown>): Promise<void>;   // optimistic
    createRow(values: Record<string, unknown>, opts?: { parentId?: string; projectId?: string }): Promise<Row>;
    deleteRows(ids: string[]): Promise<void>;
    reorder(ids: string[], before?: string): Promise<void>;
    openRow(id: string): void;                                              // task panel
    updateConfig(patch: Partial<View['config']>): void;                     // debounced save
    loadChildren(parentId: string): Promise<Row[]>;
  };
}
```

### 5.7 Page API and sync protocol

```
GET    /api/spaces/{space}/pages          -> tree: [{id, parentId, title, icon, sortOrder, kind}]
       space = 'me' | 'p:<projectId>'
POST   /api/spaces/{space}/pages          {title?, parentId?, template?} -> page
GET    /api/pages/{id}                    -> {id, title, icon, space, parentId, canEdit, needsImport, legacyHtml?}
PATCH  /api/pages/{id}                    {title?, icon?, parentId?, sortOrder?, archived?}
DELETE /api/pages/{id}                    (archived pages only)
POST   /api/pages/{id}/claim-import       -> {granted: boolean}   (exactly one caller gets true)
POST   /api/pages/{id}/files              multipart -> {url}      (images, attachments)
GET    /api/tasks/{taskId}/page           -> page (created on first call)
```

WebSocket `/ws/pages/{pageId}?ticket=...`. Binary frames; first byte is the
message type:

| Byte | Direction | Payload |
|---|---|---|
| `0` sync-state | server to client on connect | full merged Yjs update |
| `1` update | both ways | a Yjs update. Server applies it with pycrdt, appends to `page_updates`, relays to the other sockets |
| `2` awareness | both ways | opaque awareness update, relayed, never stored |
| `3` state-vector | client to server after connect | client's state vector; server answers with a type `1` diff, client sends its own diff |

Text frames are JSON control messages: `{type:'ping'}` / `{type:'pong'}`,
`{type:'readonly'}` (sent once on connect when the reader may not edit;
updates from that socket are dropped).

Snapshot job: when a page has had no update for 30 s, or has more than 200
pending rows in `page_updates`, merge them into `pages.ydoc`, refresh
`pages.text` and `page_refs`, delete the merged rows. Also runs at shutdown.

Legacy import: a page with `legacy_html` and an empty document reports
`needsImport`. The first editor to get `granted: true` from `claim-import`
parses the HTML with Tiptap and writes the result into the Yjs document.
Everyone else waits for the content to arrive over sync.

### 5.8 Document schema (Tiptap nodes)

Base: `paragraph`, `heading` (1 to 3), `bulletList`, `orderedList`,
`taskList`/`taskItem`, `blockquote`, `codeBlock`, `horizontalRule`,
`image`, `hardBreak`; marks `bold`, `italic`, `underline`, `strike`, `code`,
`link`, `highlight`.

Custom nodes (attrs only; rendered by React node views):

| Node | Attrs | WP |
|---|---|---|
| `callout` | `tone` | P3 |
| `viewBlock` | `viewId` | T12 |
| `taskChip` (inline) | `taskId` | S5 |
| `pageLink` (inline) | `pageId` | S5 |
| `mention` (inline) | `userId` | S5 |
| `clipEmbed` | `projectId, baseName, version?, frame?` | S6 |
| `summary` | `viewId, column?, fn` | S3 |

A node whose target is gone or not visible to the reader renders a neutral
"Not available" placeholder. It never throws and never deletes itself.

---

## 6. Phases and how to parallelise

```
Phase 0  Foundations        F1  F2  F3  F4 -> F5      F6 (spike, gate for Phase 1)
Phase 1  Pages              P1 -> P2 -> P4            P3 (needs F4)   P5 (needs P1,F5)
                            P6 (needs P1,P3)   P7 (needs P1-P4)   P8 (needs P7 in production)
Phase 2  Tables and views   T1 -> T2, T3 -> T4 -> T6 T7 T8 T9 T10 (parallel)
                            T5 (needs F4; parallel with T1)   T11 (needs T5, P3, P4)
                            T12 (needs T4, P3)   T13 (needs T6, T11, T12)
Phase 3  Personal space     S1 (needs P5)   S2 (needs T1,T3)   S3 (needs T4,T12)
                            S4 (needs S1,S2,S3)   S5 (needs P2,P3)   S6 (needs P3)
Phase 4  Custom tables      C1 -> C2 -> C3, C4, C5
Phase 5  Hardening          H1 ... H10, independent of each other
```

Suggested waves (each line can run in parallel):

1. F1, F2, F3, F4, F6
2. F5, P1, P3, T1, T5
3. P2, P5, T2, T3
4. P4, P6, T4, S5
5. P7, T6, T7, T8, T9, T10, T11, T12, S1, S2, S6
6. T13, S3
7. S4, P8, then Phase 4 and Phase 5 as wanted

Phase 1 and Phase 2 do not depend on each other until T11/T12, so two streams
can run side by side from wave 2. Contract-defining WPs (F4, P1, T1, T4) are
reviewed against section 5 before the WPs that depend on them start.

---

## 7. Work packages

Size: S is up to about a day of focused work, M a few days, L a week.

### Phase 0: Foundations

**F1. Migration runner** (S)
Owns: `database/migrations/`, `database/migrate.py`. Touchpoint: one call in `database/utils.py`.
Build: numbered Python migration files with `up(conn)`, applied in order at startup inside a transaction each, recorded in `schema_migrations`. Works on SQLite and PostgreSQL through `database.engine.execute`. Migration `001` is empty and marks the current schema as the baseline.
Accept: fresh database and existing database both start; a failing migration rolls back and stops startup with a clear message; applied migrations are not run twice (test).

**F2. Tasks and clip status are saved when they change** (M)
Owns: `api/routes/tasks.py`, `database/tasks.py`, `cache/manager.py`, the clip status endpoint in `server.py`, `tests/test_tasks.py`.
Build: every task mutation and clip status change writes to the database before the response is sent; remove the dirty tracking for tasks and clips (keep `persist_now` callers working or remove them). Add API tests for the whole task surface: CRUD, subtasks, assignees, reorder, checklist, clip links, access rules, live events.
Accept: killing the server right after a 200 response loses nothing (test by re-reading from the database, not memory); `pytest` covers each task endpoint and each permission rule.

**F3. Browser tests in the repository** (S)
Owns: `tests/e2e/`. Touchpoints: `requirements-dev.txt`, `pytest.ini`.
Build: a `server` fixture that starts Cutline on a free port with a throwaway database and folders (as `tests/conftest.py` does for the API); helpers to create users, projects, share links, and to log a page in; mark the tests `e2e` so `pytest -m "not e2e"` stays fast. Port three flows as real tests: login + idle logout + cross-tab logout; two users and a guest seeing each other's comments and clips; two users editing one document. Provide the CI workflow file content in the PR description.
Accept: `pytest -m e2e` passes three times in a row locally, headless.

**F4. Web bundle and platform bridge** (M) *(contract-defining)*
Owns: `web/` (toolchain, `index.ts`, `platform.ts`, `ui/` primitives), `.gitignore`, `Dockerfile`, `start.bat`, `install.bat`. Touchpoints: one `<script>` and one `<link>` in `static/index.html`; `api/assets.py` if stamping needs it.
Build: esbuild + TypeScript (strict) + React 18 + vitest; `npm run build`, `npm run watch`, `npm test`, `npm run typecheck`. Docker builds the bundle in a Node stage and copies `static/dist/`. Implement `Platform` (5.2) over the existing globals. `ui/`: Popover, Menu, Dialog, Tooltip, Avatar, DatePicker, ColorDot, Button, Input, using existing CSS variables, light and dark. A demo route `/dev/ui` (admins only) renders them all.
Accept: fresh clone to running app is documented and works on Windows and in Docker; `window.CutlinePages.mount` renders inside the legacy page with the user's theme; `platform.fetch` gets a 401 handled like legacy code (e2e); typecheck and tests green.

**F5. Routes and shell** (M)
Owns: `web/src/router.ts`, `web/src/shell/`, server routes for the URLs in 5.3. Touchpoints: `static/js/features/navigation.js`, `static/js/app.js` (start-up routing only), tab markup in `static/index.html`.
Build: path-based routing with history; a left sidebar with Home, Personal space and Projects (each expandable to Review and Pages; trees are filled by P5); the legacy Review, Lounge and (until removed) Tasks/Docs views show and hide by route. Old `?project=` links redirect. Guests keep their current single-project view and see no sidebar.
Accept: deep links to every route load correctly when logged in and return there after login; back/forward work; guest flow unchanged (e2e).

**F6. Spike: collaborative editor end to end** (S) *(gate)*
Owns: `spikes/collab/` (deleted when P2 and P4 land).
Build: the smallest thing that proves D2 and D3: a Tiptap editor with Yjs in the bundle, a FastAPI WebSocket that holds a `pycrdt` document, applies and relays updates, persists them to SQLite and can print the document's plain text; reconnect after the server restarts keeps content; two browsers typing in one paragraph both keep their text.
Accept: a written result in section 9: versions used, what worked, measured update sizes, anything in 5.7 that should change. If `pycrdt` cannot do it, propose the alternative (server as a dumb relay storing opaque updates, text extraction done by clients) before Phase 1 continues.

### Phase 1: Pages

**P1. Pages: data and REST** (M) *(contract-defining)*
Owns: `database/pages.py`, `api/routes/pages.py`, migration, `tests/test_pages.py`, page helpers in `api/auth.py`.
Build: section 5.4 `pages`, 5.5 rules, 5.7 REST (not the WebSocket, not files). Tree ordering with fractional `sort_order`; moving a page under its own descendant is refused; archiving a page archives its subtree; `page_changed` live events.
Accept: tests for every endpoint and every permission rule, including guests (always refused) and personal pages (owner only, admins included in "refused").

**P2. Page sync server** (M) Needs P1, F6.
Owns: `api/pagesync.py`, `api/routes/pagesync.py`, migration for `page_updates`, `tests/test_pagesync.py`.
Build: protocol 5.7, snapshot job, `pages.text`, read-only sockets, sockets tracked for logout (`track_socket`), task pages (`kind='task'`) with access taken from the task's project.
Accept: tests with two socket clients: convergence, restart persistence, read-only enforced, access removed closes the socket, snapshot folds updates and content survives.

**P3. Editor core** (L) Needs F4.
Owns: `web/src/pages/editor/`.
Build: Tiptap with the base schema (5.8) and `callout`; slash menu; floating toolbar on selection; markdown input rules and paste (markdown and HTML); drag handle to reorder blocks; links; keyboard shortcuts; placeholder; a block registry so other WPs add nodes and slash entries without editing this WP's files (`registerBlock({ node, slash, view })`). The editor takes a `Y.Doc` and awareness as props; this WP provides an in-memory provider for tests.
Accept: vitest for input rules and paste conversions; e2e typing every base block; no `execCommand`.

**P4. Collaboration client** (M) Needs P2, P3.
Owns: `web/src/pages/sync/`.
Build: provider for protocol 5.7 using `platform.openSocket`: reconnect with backoff, resync through state vectors, "saving / saved / offline" indicator, remote cursors with name and colour, legacy import flow (5.7), read-only mode.
Accept: e2e with two users: same paragraph, both texts survive; offline edits merge on reconnect; cursor of the other user is visible; reload shows the same document.

**P5. Page tree** (M) Needs P1, F5.
Owns: `web/src/pages/tree/`, `web/src/pages/PageView.tsx` (title, icon, breadcrumbs, page menu).
Build: tree in the sidebar per space; create, rename inline, move by drag, archive, restore from an "Archived" list, delete for good; live updates from `page_changed`.
Accept: e2e: create nested pages, move, rename seen by a second user without reload, archive and restore.

**P6. Images and files in pages** (S) Needs P1, P3.
Owns: file endpoint and serving route in `api/routes/pages.py` (coordinate with P1's owner), `web/src/pages/editor/blocks/image*`, `file*`.
Build: upload by paste, drop and slash menu; stored under a pages folder; served only to readers of the page (cookie auth, like media); size and type limits; images resized on upload.
Accept: tests for access (other project's member refused, anonymous refused); e2e paste an image.

**P7. Move Docs into Pages** (M) Needs P1 to P5.
Owns: migration, `tests/test_docs_migration.py`. Touchpoints: none in legacy code.
Build: every `documents` row becomes a page with `legacy_html`; every `doc_folders` row becomes a page with its documents as children; order and titles kept; idempotent. The Docs tab is hidden once the migration has run.
Accept: test with a seeded old database: counts match, hierarchy matches, opening a migrated page imports its content exactly once with two simultaneous clients (e2e).

**P8. Remove the old Docs** (S) Needs P7 verified on the production data.
Owns: deletion of `static/js/modules/docs/`, `api/routes/documents.py`, `database/documents.py`, their CSS and tests; migration dropping `documents` and `doc_folders`.
Accept: nothing references the removed code; suite green.

### Phase 2: Tables and views

**T1. Table API and the tasks source** (L) *(contract-defining)* Needs F1, F2.
Owns: `api/tables/` (`source.py`, `query.py`, `tasks_source.py`), `api/routes/tables.py`, `tests/test_tables.py`.
Build: section 5.6 for `tasks:<projectId>` and `tasks:*`: schema (builtin columns mapped from today's task fields: name, status, assignees, priority, stage, dueDate, section, clip, createdAt, createdBy), query engine (filters incl. relative dates and `@me`, multi-sort, grouping with labels and colours, summaries, hierarchy, search, paging), row CRUD mapping to the existing task functions, permissions per row, `rows_changed` events (alongside the existing `task_*` events).
Accept: a test per filter operator and per summary function; cross-project query returns only permitted rows; editing through the table API and through the old task API produce the same stored result.

**T2. Custom columns** (M) Needs T1.
Owns: `api/tables/columns.py`, migration for `table_columns`, column endpoints, tests.
Build: add, rename, retype (with value conversion rules), reorder, delete; values in `tasks.custom_fields`; types text, longtext, number, checkbox, date, select, multiselect, url, person; `schema_changed` events.
Accept: tests for each type through create, filter, sort, group and summarise; deleting a column removes its values.

**T3. Row store and `useView`** (M) Needs T1, F4.
Owns: `web/src/tables/store/`, `web/src/api/tables.ts`, `web/src/api/views.ts`.
Build: `useView(viewId)` returns `LayoutProps` minus rendering; optimistic updates with rollback and a toast on failure; debounced re-query on `rows_changed` / `schema_changed` / `view_changed`; one query per view even when several components use it; `platform.live.watch` kept in step with mounted views.
Accept: vitest with a fake API: optimistic update, rollback, re-query coalescing, unmount stops watching.

**T4. Views and the view shell** (M) *(contract-defining)* Needs T1, T3.
Owns: `api/routes/views.py`, `database/views.py`, migration, tests; `web/src/tables/ViewShell.tsx`, `web/src/tables/toolbar/`.
Build: view CRUD with permissions; the shell around every layout: name, layout switcher, filter builder (nested and/or), sort, group, column visibility and order, summaries picker, search, "new row"; a layout registry (`registerLayout(name, component, defaults)`).
Accept: API tests; e2e building a filter + sort + group on tasks and seeing it persist for a second user.

**T5. Cells** (M) Needs F4.
Owns: `web/src/tables/cells/`.
Build: for every `ColumnType`: a display component and an editor, with one interface (`{ column, value, row, onCommit, onCancel }`), keyboard-first, usable in table cells, board cards and the task panel. Reuse behaviour of the current task cells (status, assignees, priority, stage, date).
Accept: vitest per cell: commit, cancel, keyboard; visual check page under `/dev/ui`.

**T6. Table layout** (L) Needs T4, T5.
Owns: `web/src/tables/layouts/table/`.
Build: virtualised grid; inline editing; column resize and reorder; grouping with collapsible groups and per-group summaries; footer summaries; subtasks (expand, indent, add); multi-select with bulk edit and delete; quick-add row; drag to reorder when unsorted; keyboard navigation; copy and paste of cells.
Accept: parity checklist against today's task list (kept in the WP's PR); 2,000 rows scroll smoothly; e2e for edit, group, bulk delete, subtasks.

**T7. Board layout** (M) Needs T4, T5. Owns `layouts/board/`.
Columns from any select-like or person column; drag between columns updates the value; drag within a column reorders; card shows chosen columns; collapsed columns; per-column count and summary; quick add per column.
Accept: e2e drag between columns seen by a second user.

**T8. Calendar layout** (M) Needs T4, T5. Owns `layouts/calendar/`.
Month and week; rows on their date (or span with an end column); drag to move, drag edge to resize; rows without a date in a side list that can be dragged in; click a day to create.
Accept: e2e move a task to another day; time zones: dates are date-only and never shift.

**T9. Gantt layout** (L) Needs T4, T5.
Owns: `layouts/gantt/`, migration `tasks.start_date`, `startDate` builtin column in `api/tables/tasks_source.py` (coordinate with T1's owner).
Bars from start to end; drag to move and resize; day, week, month scale; today line; grouping; subtasks as nested rows; rows without dates shown as "unscheduled". Optional second part: `task_dependencies` with arrows and "push dependants".
Accept: e2e resize a bar; unscheduled rows can be scheduled by dragging.

**T10. List layout** (S) Needs T4, T5. Owns `layouts/list/`.
Compact rows: checkbox (done status), title, a few secondary values. Built for dashboards and narrow blocks.
Accept: e2e check off a task from a list.

**T11. Task panel** (L) Needs T5, P3, P4.
Owns: `web/src/task/`. Touchpoint: `?task=` handling in the router.
Build: side panel opened from any view, chip or link: title, all columns of the row's table as properties (using T5 cells), body as a collaborative page (`/api/tasks/{id}/page`; existing `description` imported as legacy content), subtasks as an embedded list view, linked clips, comments, activity. Existing checklists shown as today.
Accept: parity checklist against `taskDetail.js`; e2e two users editing the same task body and property.

**T12. View block** (M) Needs T4, P3.
Owns: `web/src/pages/editor/blocks/viewBlock/`.
Build: `/table`, `/board`, `/calendar`, `/gantt`, `/list` insert a new view (default source: the page's project tasks; in personal space: `tasks:*` filtered to `@me`); pick an existing view instead; block header with name and "open full page"; resize; deleting the block deletes views it owns after a confirm; copy and paste duplicates the view.
Accept: e2e insert a board, edit a card, second user sees it; a reader without task access sees an empty state, not an error.

**T13. Tasks become a page** (M) Needs T6, T11, T12.
Owns: migration creating a "Tasks" page per project (one table view of all tasks, grouped as the project's list is today); removal of `static/js/modules/projects/`, `PropertyRegistry.js`, `TaskUpdater.js`, the old task CSS and the `task_*` live events; redirect of the old Tasks tab.
Accept: every item on the T6 and T11 parity checklists is met; nothing references the removed code; suite green.

### Phase 3: Personal space and dashboard

**S1. Personal space** (S) Needs P5. Sidebar section, routes, "move to project / move to personal" with a warning about who gains or loses access.
**S2. Cross-project sources** (M) Needs T1, T3. `tasks:*` in the UI: project column, project filter, create-row asks for the project; `live.watch({ allTasks: true })` on the server (events for every project the user has task access to, re-checked when access changes).
**S3. Summary block and inline numbers** (M) Needs T4, T12. `summary` node: one number or progress bar from a view's summary (count, sum, percent done), with a label; updates live.
**S4. Home** (S) Needs S1, S2, S3. A "My dashboard" page created for each user from a template (my open tasks, due this week, recently changed pages); "set as home" on any personal page; `/` shows it.
**S5. Mentions, links and backlinks** (M) Needs P2, P3. `@` menu for people, tasks, pages, clips; `page_refs` filled at snapshot; "Mentioned in" on tasks and pages; a notification when a person is mentioned.
**S6. Clips on pages, and comments to tasks** (M) Needs P3. `clipEmbed` block (thumbnail, status, opens review at the frame); "Create task" on a review comment (task linked to the clip and timecode).

### Phase 4: Custom tables

**C1.** Generic `custom_tables` / `custom_rows` implementing `TableSource` (L).
**C2.** Create a table from a page, edit columns in the UI (M).
**C3.** Relation columns between tables, including to tasks (M).
**C4.** Formula columns: a small expression language (arithmetic, `if`, date math, lookups through relations), evaluated on the server (L).
**C5.** Chart block over a view (bar, line, donut) (M).

### Phase 5: Hardening (independent)

**H1.** Global search: pages (text), tasks, comments, clips; one endpoint, one palette (`Ctrl+K`) that also runs commands.
**H2.** Page history: named and automatic versions from Yjs snapshots; view and restore.
**H3.** Trash for tasks and rows, with undo toasts for deletes.
**H4.** Templates for pages and projects.
**H5.** Export: page to Markdown and PDF; view to CSV.
**H6.** Email notifications (mentions, assignments, due dates, comments), with per-user settings.
**H7.** Mobile layout for Pages and the task panel.
**H8.** Object storage for media and page files.
**H9.** Remaining legacy strings to English; one place for UI text.
**H10.** Multi-process readiness: no in-memory projects/tasks as the source of truth; live hub over a broker.

---

## 8. Open questions and deliberate omissions

| Topic | Default taken in this plan | Decide before |
|---|---|---|
| Name of the surface | "Pages"; rows are still "tasks" | F5 |
| Guests and pages | Guests never see pages | F5 |
| Task checklists | Kept as they are; later they can become to-do items in the task body | T11 |
| Sections (`task_sections`) | Exposed as a select column `section`; the unused sections API is removed in T13 | T1 |
| Statuses | Stay global (shared with clips); per-table status sets come with custom tables | C1 |
| Publishing a page by link | Not planned | after Phase 3 |
| Per-page permissions inside a project | Not planned; the space decides | after Phase 3 |
| Offline editing | Not planned beyond "keeps typing while the line is down" | later |

Risks:

- **F6 fails** (pycrdt not sufficient). Fallback is written into F6. Phase 2 is unaffected.
- **Parity** when removing the old task UI (T13) and old Docs (P8). Both are gated by explicit checklists and happen last.
- **Two UI stacks** for a while. Bounded by F5 (one router, one shell) and ends for Tasks/Docs with T13/P8. Review and Lounge stay legacy.
- **Bundle and build step** add a moving part to deployment. Covered by F4's acceptance (Docker and Windows).

---

## 9. Status

| WP | State | Branch / PR | Notes |
|---|---|---|---|
| F1 | not started | | |
| F2 | not started | | |
| F3 | not started | | |
| F4 | not started | | |
| F5 | not started | | |
| F6 | not started | | |
| P1 | not started | | |
| P2 | not started | | |
| P3 | not started | | |
| P4 | not started | | |
| P5 | not started | | |
| P6 | not started | | |
| P7 | not started | | |
| P8 | not started | | |
| T1 | not started | | |
| T2 | not started | | |
| T3 | not started | | |
| T4 | not started | | |
| T5 | not started | | |
| T6 | not started | | |
| T7 | not started | | |
| T8 | not started | | |
| T9 | not started | | |
| T10 | not started | | |
| T11 | not started | | |
| T12 | not started | | |
| T13 | not started | | |
| S1 to S6 | not started | | |
| C1 to C5 | not started | | |
| H1 to H10 | not started | | |
