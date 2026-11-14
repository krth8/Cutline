# Table cells

Display and editor components for every `ColumnType` (PLAN.md 5.6), used by all layouts and the
task panel. Cells receive values and options as props and never call the server.

```ts
import { getCell, CellHost } from '../tables/cells';
const { Display, Editor, isEmpty, toText, parseText, compare } = getCell(column.type);
```

## Value shapes (contract for the server work packages)

| type | value | empty | notes |
| --- | --- | --- | --- |
| `text`, `longtext`, `url` | `string \| null` | `null`, `''`, whitespace | `url` is trimmed; only http(s)/mailto/bare domains become links |
| `number` | `number \| null` | `null` | editor accepts `1,5` and `1.5`; `config.decimals?: number` fixes the display precision |
| `checkbox` | `boolean` | `false` | never null |
| `date` | `'YYYY-MM-DD' \| null` | `null` | date-only, never converted through a time zone; "today" is the viewer's local day |
| `select`, `status`, `priority` | option `value` `string \| null` | `null`, `''` | options from `column.options`; an unknown value is shown as plain text |
| `multiselect` | `string[]` (option values) | `[]` | |
| `person` | user id `string \| null` | `null` | options: `value` = user id, `label` = name; `config.avatars?: Record<userId, url>` |
| `people` | `string[]` (user ids) | `[]` | same options as `person`; `config.maxAvatars?: number` (default 4, compact 3) |
| `clip` | `{ baseName: string; version?: number } \| null` | `null` | text form is `"baseName v3"` |
| `relation` | `string[]` (row ids) | `[]` | display only for now |
| `formula` | `string \| number \| boolean \| null` | `null`, `''` | read-only |

Other column config read by cells: `config.overdue?: boolean` on `date` (overdue colouring is on
unless the column is `readonly`; set it explicitly to override).

## Interface

```ts
interface CellDisplayProps { column; value; row?; compact?; onToggle?(next: boolean) }  // onToggle: checkbox only
interface CellEditorProps  { column; value; row?; onCommit(value); onCancel(); anchor?; autoFocus?; initialKey? }
interface CellDef { Display; Editor; isEmpty(v); toText(v, column); parseText?(text, column): { value } | null; compare?(a, b, column): number }
```

- `parseText` returns `{ value }` (value may be `null`/`[]` for empty text) or `null` for invalid text.
- `compare` is ascending and sorts empty values last; select-like types follow the order of `column.options`, people sort by name.
- Editors report exactly one outcome (`onCommit` or `onCancel`); an unchanged value is still passed to `onCommit`
  (`CellHost` filters it out).

## Keyboard

| | text, number, url, clip, longtext | date | select, status, priority, person | multiselect, people | checkbox |
| --- | --- | --- | --- | --- | --- |
| Enter | commit (longtext: Shift+Enter = newline) | commit typed date | pick highlighted | with filter text: toggle highlighted and clear the text; otherwise commit | toggle |
| Escape | cancel | cancel | cancel | **commit** ("commits on close", as the old assignee dropdown) | cancel |
| Tab | commit, focus moves on | commit typed date (invalid: cancel) | picks the highlighted entry if there is filter text, otherwise reports the unchanged value | commit | cancel |
| click outside | commit | cancel | cancel | commit | cancel |
| other | invalid number text restores the old value and cancels | ArrowDown enters the calendar; Today / Tomorrow / Next week (next Monday) / Clear | type to filter, arrows, "None" entry clears | Space toggles, "Clear all" | |

`CellHost` (`{ column, value, row?, readOnly?, onChange?, compact?, onEditingChange? }`): click, Enter or F2
start editing, typing a character starts editing with it (`initialKey`; filter text in pickers), Delete/Backspace
clear, checkboxes toggle on click or Space. After the editor closes, focus returns to the cell unless the user
moved on (Tab, click elsewhere). Rows with `canEdit: false`, `readonly` columns, `formula` and `relation` never edit.

## Testing and checking

- `npm test` covers every type (`cells.test.tsx`, `util.test.ts`). `setCellClock(() => new Date(...))` injects "today".
- `python web/dev/check_cells.py [outdir]` builds a dev bundle of `CellsDemo`, drives it in Chromium (popover
  placement inside a scrolled container, keyboard paths) and writes dark/light screenshots.
- `CellsDemo` (exported) shows every type as empty / filled / read-only for the `/dev/ui` page.
