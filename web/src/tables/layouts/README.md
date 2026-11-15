# Layouts

A layout draws the rows of a view (table, board, list, calendar, gantt). `ViewShell` owns everything around it:
view name, layout switcher, filter, sort, group, columns, summaries, search and "New". A layout only draws
and edits rows.

## Adding a layout (T6 to T10)

1. Work in `web/src/tables/layouts/<name>/` (your own folder, CSS next to the components, classes prefixed `cl-`).
2. Write a component that takes `LayoutProps` (`web/src/tables/types.ts`) and nothing else:

   ```tsx
   import type { LayoutProps } from '../../types';
   export function BoardLayout({ schema, view, result, loading, actions }: LayoutProps) { ... }
   ```

3. Register it in `layouts/<name>/index.ts`:

   ```ts
   import { registerLayout } from '../registry';
   registerLayout('board', BoardLayout, { board: { groupBy: 'status', cardColumns: [] } });
   ```

   Signature: `registerLayout(name, component, defaults?, label?)`. `name` is the `View['layout']` value.
   `defaults` is the part of `view.config` your layout needs, as an object or a function of the table schema
   (`(schema) => ({ ... })`). The shell merges it into the view when a user switches to your layout; keys the view
   already has are kept. Registering a name again replaces the earlier registration.
4. Add one import line to `layouts/index.ts` (`import './board';`). That file is the only shared one.

## What a layout receives

`LayoutProps` (PLAN.md 5.6): `schema`, `view`, `result` (rows, `total`, `groups`, `summaries`), `loading`, and `actions`
(`updateRow`, `createRow`, `deleteRows`, `reorder`, `openRow`, `updateConfig`, `loadChildren`).

- The query (filter, sort, group, search) is already applied by the server: draw `result.rows`; with
  `view.config.query.groupBy` set, `result.groups` lists the groups in order (the rows are flat in `result.rows`).
- Columns: use `visibleColumns(schema, view.config)` from `web/src/tables/viewColumns.ts` for the columns to show, in
  order (hidden ones left out). `orderedColumns` also returns widths and hidden flags. To change widths or order
  call `actions.updateConfig({ columns: [...] })` with the full list.
- Layout settings live in `view.config.<name>` (`board`, `calendar`, `gantt`, `list`); change them with
  `actions.updateConfig({ board: { ... } })` (debounced save, other users see it live).
- Cells: `CellHost` and `getCell` from `web/src/tables/cells` for every column type.
- Do not fetch rows yourself and do not touch the filter/sort/group config: that is the toolbar's job.

## Checking your layout

`/dev/view/<viewId>` (any logged-in user) shows one view full screen through `ViewShell`; create a view with
`POST /api/views` (`{ tableRef: 'tasks:<projectId>', name, layout, config: { query: {} } }`).
