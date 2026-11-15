import { useEffect, useRef, useState } from 'react';
import { Button } from '../../ui';
import { SearchIcon } from './icons';

/**
 * Search as an icon that expands into a field (it stays open while it holds text). Reports the text 250 ms
 * after typing stops and follows outside changes of `value`.
 */
export function SearchBox({ value, onChange, delayMs = 250 }: { value: string; onChange: (text: string) => void; delayMs?: number }) {
  const [text, setText] = useState(value);
  const [open, setOpen] = useState(false);
  const reported = useRef(value);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const wantFocus = useRef(false);

  useEffect(() => {
    if (value !== reported.current) {
      reported.current = value;
      setText(value);
    }
  }, [value]);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  useEffect(() => {
    if (open && wantFocus.current) {
      wantFocus.current = false;
      input.current?.focus();
    }
  }, [open]);

  function report(next: string) {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      reported.current = next;
      onChange(next);
    }, delayMs);
  }

  if (!open && !text) {
    return (
      <Button
        size="sm"
        variant="ghost"
        className="cl-viewbar__icon-btn"
        aria-label="Search rows"
        data-testid="toolbar-search-toggle"
        onClick={() => {
          wantFocus.current = true;
          setOpen(true);
        }}
      >
        <SearchIcon />
      </Button>
    );
  }
  return (
    <input
      ref={input}
      type="search"
      className="cl-viewbar__search"
      placeholder="Search"
      aria-label="Search rows"
      data-testid="toolbar-search"
      value={text}
      onChange={(e) => {
        setText(e.target.value);
        report(e.target.value);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          setText('');
          report('');
          setOpen(false);
        }
      }}
      onBlur={() => !text && setOpen(false)}
    />
  );
}
