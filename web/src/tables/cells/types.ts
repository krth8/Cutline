import type { ComponentType } from 'react';
import type { Column, Row } from '../types';

export interface CellDisplayProps {
  column: Column;
  value: unknown;
  row?: Row;
  /** Tighter rendering for board cards and list rows (avatars without names, no padding). */
  compact?: boolean;
  /** Checkbox only: called when the box is clicked in display mode. Without it the box is read-only. */
  onToggle?: (next: boolean) => void;
}

export interface CellEditorProps {
  column: Column;
  value: unknown;
  row?: Row;
  /** Commit the new value. Called at most once; unchanged values are reported too. */
  onCommit(value: unknown): void;
  /** Leave without changing anything. */
  onCancel(): void;
  /** Element a popover editor attaches to (the cell). Without it the editor anchors to itself. */
  anchor?: HTMLElement | null;
  /** Focus the editor when it mounts (default true). */
  autoFocus?: boolean;
  /** A character typed on the focused cell: starts editing with it replacing the value (filter text in pickers). */
  initialKey?: string;
}

/** Result of `parseText`: `{ value }` when the text is valid for the column (value may be null), `null` when it is not. */
export type ParseResult = { value: unknown } | null;

export interface CellDef {
  Display: ComponentType<CellDisplayProps>;
  Editor: ComponentType<CellEditorProps>;
  /** True for null, '', [], false (checkbox) and other "nothing here" values. */
  isEmpty(value: unknown): boolean;
  /** Plain text for clipboard, search and export. */
  toText(value: unknown, column: Column): string;
  /** Inverse of `toText` (also used for paste); absent for read-only types. */
  parseText?(text: string, column: Column): ParseResult;
  /** Sort order: empty values sort after filled ones in ascending order. */
  compare?(a: unknown, b: unknown, column: Column): number;
}
