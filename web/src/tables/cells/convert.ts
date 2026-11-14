import type { Column } from '../types';
import type { ParseResult } from './types';
import { asClip, type ClipValue } from './displays';
import { asArray, formatNumber, isISODate, matchOption, optionLabel, parseDateText, parseNumber } from './util';

/** Sort helper: empties last, then `cmp`. */
export function compareWith<T>(a: T | null, b: T | null, empty: (v: unknown) => boolean, cmp: (x: T, y: T) => number): number {
  const ea = empty(a);
  const eb = empty(b);
  if (ea || eb) return ea === eb ? 0 : ea ? 1 : -1;
  return cmp(a as T, b as T);
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
export const compareText = (a: string, b: string) => collator.compare(a, b);

export const textIsEmpty = (v: unknown) => typeof v !== 'string' || v.trim() === '';
export const numberIsEmpty = (v: unknown) => typeof v !== 'number' || Number.isNaN(v);
export const dateIsEmpty = (v: unknown) => !isISODate(v);
export const stringIsEmpty = (v: unknown) => typeof v !== 'string' || v === '';
export const listIsEmpty = (v: unknown) => !Array.isArray(v) || v.length === 0;

// ---- text-like ----

export const parseTextValue = (text: string): ParseResult => ({ value: text.trim() === '' ? null : text });
export const parseUrlValue = (text: string): ParseResult => ({ value: text.trim() === '' ? null : text.trim() });
export const stringToText = (v: unknown) => (typeof v === 'string' ? v : '');

export function parseNumberValue(text: string): ParseResult {
  const n = parseNumber(text);
  return n === undefined ? null : { value: n };
}
export const numberToText = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? String(v) : '');

// ---- checkbox ----

export function parseCheckboxValue(text: string): ParseResult {
  const t = text.trim().toLowerCase();
  if (['true', 'yes', 'y', '1', 'x', '✓', 'checked'].includes(t)) return { value: true };
  if (['', 'false', 'no', 'n', '0', 'unchecked'].includes(t)) return { value: false };
  return null;
}

// ---- date ----

export function parseDateValue(text: string): ParseResult {
  const d = parseDateText(text);
  return d === undefined ? null : { value: d };
}

// ---- option-based ----

export function selectToText(v: unknown, column: Column): string {
  return typeof v === 'string' && v ? optionLabel(column, v) : '';
}
export function parseSelectValue(text: string, column: Column): ParseResult {
  if (text.trim() === '') return { value: null };
  const o = matchOption(column, text);
  return o ? { value: o.value } : null;
}
export function listToText(v: unknown, column: Column): string {
  return asArray(v).map((x) => optionLabel(column, x)).join(', ');
}
export function parseListValue(text: string, column: Column): ParseResult {
  if (text.trim() === '') return { value: [] };
  const out: string[] = [];
  for (const part of text.split(',')) {
    const o = matchOption(column, part);
    if (!o) return null;
    if (!out.includes(o.value)) out.push(o.value);
  }
  return { value: out };
}

export function optionIndex(column: Column, v: unknown): number {
  const i = column.options?.findIndex((o) => o.value === v) ?? -1;
  return i < 0 ? Number.MAX_SAFE_INTEGER : i;
}

// ---- clip ----

export function clipToText(v: unknown): string {
  const c = asClip(v);
  return c ? (c.version !== undefined ? `${c.baseName} v${c.version}` : c.baseName) : '';
}
export function parseClipValue(text: string): ParseResult {
  const t = text.trim();
  if (!t) return { value: null };
  const m = /^(.*\S)\s+v(\d+)$/i.exec(t);
  const clip: ClipValue = m ? { baseName: m[1]!, version: Number(m[2]) } : { baseName: t };
  return { value: clip };
}

// ---- relation / formula ----

export const relationToText = (v: unknown) => asArray(v).join(', ');
export function formulaToText(v: unknown, column: Column): string {
  if (typeof v === 'number') return formatNumber(v, column);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  return typeof v === 'string' ? v : '';
}
