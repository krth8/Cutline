import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { cx } from '../../ui';
import type { CellEditorProps, ParseResult } from './types';
import {
  clipToText,
  numberToText,
  parseClipValue,
  parseNumberValue,
  parseTextValue,
  parseUrlValue,
  stringToText,
} from './convert';
import './cells.css';

/** Makes sure an editor reports exactly one outcome, whatever mix of Enter, Tab and blur happens. */
export function useSettle(onCommit: (v: unknown) => void, onCancel: () => void) {
  const done = useRef(false);
  const latest = useRef({ onCommit, onCancel });
  latest.current = { onCommit, onCancel };
  const commit = useCallback((v: unknown) => {
    if (done.current) return;
    done.current = true;
    latest.current.onCommit(v);
  }, []);
  const cancel = useCallback(() => {
    if (done.current) return;
    done.current = true;
    latest.current.onCancel();
  }, []);
  return { commit, cancel };
}

interface TextLikeConfig {
  toText(value: unknown, column: CellEditorProps['column']): string;
  parse(text: string, column: CellEditorProps['column']): ParseResult;
  multiline?: boolean;
  inputMode?: 'decimal' | 'url';
}

function makeTextEditor(cfg: TextLikeConfig) {
  return function TextLikeEditor({ column, value, onCommit, onCancel, autoFocus = true, initialKey }: CellEditorProps) {
    const original = cfg.toText(value, column);
    const [text, setText] = useState(initialKey !== undefined ? initialKey : original);
    const [invalid, setInvalid] = useState(false);
    const ref = useRef<HTMLInputElement & HTMLTextAreaElement>(null);
    const { commit, cancel } = useSettle(onCommit, onCancel);

    useEffect(() => {
      const el = ref.current;
      if (!el || !autoFocus) return;
      el.focus();
      if (initialKey !== undefined) el.setSelectionRange(el.value.length, el.value.length);
      else el.select();
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // Auto-grow the textarea with its content
    useLayoutEffect(() => {
      const el = ref.current;
      if (!cfg.multiline || !el) return;
      el.style.height = 'auto';
      el.style.height = `${el.scrollHeight}px`;
    }, [text]);

    function finish() {
      const parsed = cfg.parse(text, column);
      if (!parsed) {
        // Garbage: put the old value back and leave without changing anything
        setText(original);
        setInvalid(true);
        cancel();
        return;
      }
      commit(parsed.value);
    }

    function onKeyDown(e: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) {
      if (e.nativeEvent.isComposing) return;
      if (e.key === 'Enter' && !(cfg.multiline && e.shiftKey)) {
        e.preventDefault();
        finish();
      } else if (e.key === 'Tab') {
        finish(); // do not trap Tab: the parent decides where focus goes
      } else if (e.key === 'Escape') {
        e.preventDefault();
        cancel();
      }
    }

    const common = {
      className: cx('cl-input', 'cl-cell__input', invalid && 'cl-input--invalid'),
      value: text,
      'aria-label': column.name,
      'aria-invalid': invalid || undefined,
      onChange: (e: { target: { value: string } }) => {
        setText(e.target.value);
        setInvalid(false);
      },
      onKeyDown,
      onBlur: finish,
    };

    return cfg.multiline ? (
      <textarea {...common} ref={ref} rows={1} className={cx(common.className, 'cl-cell__textarea')} />
    ) : (
      <input {...common} ref={ref} type="text" {...(cfg.inputMode ? { inputMode: cfg.inputMode } : {})} />
    );
  };
}

export const TextEditor = makeTextEditor({ toText: stringToText, parse: parseTextValue });
export const LongTextEditor = makeTextEditor({ toText: stringToText, parse: parseTextValue, multiline: true });
export const UrlEditor = makeTextEditor({ toText: stringToText, parse: parseUrlValue, inputMode: 'url' });
export const NumberEditor = makeTextEditor({ toText: numberToText, parse: parseNumberValue, inputMode: 'decimal' });
export const ClipEditor = makeTextEditor({ toText: clipToText, parse: parseClipValue });

export function CheckboxEditor({ column, value, onCommit, onCancel, autoFocus = true }: CellEditorProps) {
  const ref = useRef<HTMLInputElement>(null);
  const { commit, cancel } = useSettle(onCommit, onCancel);
  useEffect(() => {
    if (autoFocus) ref.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <div className="cl-cell cl-cell--checkbox">
      <input
        ref={ref}
        type="checkbox"
        className="cl-cell__checkbox"
        aria-label={column.name}
        checked={value === true}
        onChange={(e) => commit(e.target.checked)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            commit(value !== true);
          } else if (e.key === 'Escape') {
            e.preventDefault();
            cancel();
          } else if (e.key === 'Tab') cancel();
        }}
        onBlur={cancel}
      />
    </div>
  );
}

/** For types that cannot be edited (formula, relation): leaves immediately. */
export function ReadonlyEditor({ onCancel }: CellEditorProps) {
  const cancel = useRef(onCancel);
  cancel.current = onCancel;
  useEffect(() => cancel.current(), []);
  return null;
}
