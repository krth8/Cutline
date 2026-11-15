import { useEffect, useRef, useState } from 'react';
import { Input } from '../../ui';

/** Search field; reports the text 250 ms after typing stops. Follows outside changes of `value`. */
export function SearchBox({ value, onChange, delayMs = 250 }: { value: string; onChange: (text: string) => void; delayMs?: number }) {
  const [text, setText] = useState(value);
  const reported = useRef(value);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

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

  return (
    <Input
      type="search"
      className="cl-toolbar__search"
      placeholder="Search"
      aria-label="Search rows"
      data-testid="toolbar-search"
      value={text}
      onChange={(e) => {
        const next = e.target.value;
        setText(next);
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => {
          reported.current = next;
          onChange(next);
        }, delayMs);
      }}
    />
  );
}
