import type { Column, ColumnType } from '../types';
import type { CellDef } from './types';
import * as D from './displays';
import * as E from './editors';
import * as P from './pickers';
import * as C from './convert';
import { asArray, optionLabel } from './util';

const text = (a: unknown) => (typeof a === 'string' ? a : '');

const textDef: CellDef = {
  Display: D.TextDisplay,
  Editor: E.TextEditor,
  isEmpty: C.textIsEmpty,
  toText: C.stringToText,
  parseText: C.parseTextValue,
  compare: (a, b) => C.compareWith(a as string | null, b as string | null, C.textIsEmpty, (x, y) => C.compareText(x, y)),
};

const selectLike: CellDef = {
  Display: D.SelectDisplay,
  Editor: P.SelectEditor,
  isEmpty: C.stringIsEmpty,
  toText: C.selectToText,
  parseText: C.parseSelectValue,
  compare: (a, b, col) =>
    C.compareWith(a as string | null, b as string | null, C.stringIsEmpty, (x, y) => {
      const d = C.optionIndex(col, x) - C.optionIndex(col, y);
      return d !== 0 ? d : C.compareText(optionLabel(col, x), optionLabel(col, y));
    }),
};

const listCompare = (a: unknown, b: unknown, col: Column) =>
  C.compareWith(a as string[] | null, b as string[] | null, C.listIsEmpty, (x, y) => {
    const d = x.length - y.length;
    return d !== 0 ? d : C.compareText(C.listToText(x, col), C.listToText(y, col));
  });

const cells: Record<ColumnType, CellDef> = {
  text: textDef,
  longtext: { ...textDef, Display: D.LongTextDisplay, Editor: E.LongTextEditor },
  url: { ...textDef, Display: D.UrlDisplay, Editor: E.UrlEditor, parseText: C.parseUrlValue },
  number: {
    Display: D.NumberDisplay,
    Editor: E.NumberEditor,
    isEmpty: C.numberIsEmpty,
    toText: C.numberToText,
    parseText: C.parseNumberValue,
    compare: (a, b) => C.compareWith(a as number | null, b as number | null, C.numberIsEmpty, (x, y) => x - y),
  },
  checkbox: {
    Display: D.CheckboxDisplay,
    Editor: E.CheckboxEditor,
    isEmpty: (v) => v !== true,
    toText: (v) => (v === true ? 'true' : 'false'),
    parseText: C.parseCheckboxValue,
    compare: (a, b) => Number(a === true) - Number(b === true),
  },
  date: {
    Display: D.DateDisplay,
    Editor: P.DateEditor,
    isEmpty: C.dateIsEmpty,
    toText: (v) => (C.dateIsEmpty(v) ? '' : text(v)),
    parseText: C.parseDateValue,
    compare: (a, b) => C.compareWith(a as string | null, b as string | null, C.dateIsEmpty, (x, y) => (x < y ? -1 : x > y ? 1 : 0)),
  },
  select: selectLike,
  status: selectLike,
  priority: selectLike,
  multiselect: {
    Display: D.MultiSelectDisplay,
    Editor: P.MultiSelectEditor,
    isEmpty: C.listIsEmpty,
    toText: C.listToText,
    parseText: C.parseListValue,
    compare: listCompare,
  },
  person: {
    ...selectLike,
    Display: D.PersonDisplay,
    compare: (a, b, col) =>
      C.compareWith(a as string | null, b as string | null, C.stringIsEmpty, (x, y) => C.compareText(optionLabel(col, x), optionLabel(col, y))),
  },
  people: {
    Display: D.PeopleDisplay,
    Editor: P.MultiSelectEditor,
    isEmpty: C.listIsEmpty,
    toText: C.listToText,
    parseText: C.parseListValue,
    compare: listCompare,
  },
  clip: {
    Display: D.ClipDisplay,
    Editor: E.ClipEditor,
    isEmpty: (v) => D.asClip(v) === null,
    toText: C.clipToText,
    parseText: C.parseClipValue,
    compare: (a, b) =>
      C.compareWith(D.asClip(a), D.asClip(b), (v) => v === null, (x, y) => C.compareText(x.baseName, y.baseName) || (x.version ?? 0) - (y.version ?? 0)),
  },
  relation: {
    Display: D.RelationDisplay,
    Editor: E.ReadonlyEditor,
    isEmpty: C.listIsEmpty,
    toText: C.relationToText,
    compare: (a, b) => asArray(a).length - asArray(b).length,
  },
  formula: {
    Display: D.FormulaDisplay,
    Editor: E.ReadonlyEditor,
    isEmpty: (v) => v === null || v === undefined || v === '',
    toText: C.formulaToText,
    compare: (a, b, col) =>
      C.compareWith(a as string | number | boolean | null, b as string | number | boolean | null, (v) => v === null || v === undefined || v === '', (x, y) =>
        typeof x === 'number' && typeof y === 'number' ? x - y : C.compareText(C.formulaToText(x, col), C.formulaToText(y, col)),
      ),
  },
};

export function getCell(type: ColumnType): CellDef {
  return cells[type];
}

/** Types that can never be edited by a user, whatever the column says. */
export const READONLY_TYPES: ReadonlySet<ColumnType> = new Set<ColumnType>(['formula', 'relation']);

export function isColumnEditable(column: Column): boolean {
  return !column.readonly && !READONLY_TYPES.has(column.type);
}
