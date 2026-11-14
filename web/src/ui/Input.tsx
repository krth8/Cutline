import { forwardRef, useState, type ChangeEvent, type FocusEvent, type InputHTMLAttributes, type KeyboardEvent } from 'react';
import { cx } from './hooks';
import './input.css';

export interface InputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'size'> {
  invalid?: boolean;
  /**
   * Called with the final text when the user presses Enter, or leaves the field
   * with a changed value. Escape reverts to the last committed value and calls
   * `onCancel`. Meant for inline editing (cells, titles).
   */
  onCommit?: (value: string) => void;
  onCancel?: () => void;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { invalid, onCommit, onCancel, className, value, defaultValue, onChange, onKeyDown, onBlur, ...rest },
  ref,
) {
  const controlled = value !== undefined;
  const [inner, setInner] = useState(String(defaultValue ?? ''));
  const [committed, setCommitted] = useState(String(controlled ? value : (defaultValue ?? '')));
  const text = controlled ? String(value) : inner;

  function commit(next: string) {
    if (next === committed) return;
    setCommitted(next);
    onCommit?.(next);
  }

  function handleChange(e: ChangeEvent<HTMLInputElement>) {
    if (!controlled) setInner(e.target.value);
    onChange?.(e);
  }

  function handleKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    onKeyDown?.(e);
    if (e.defaultPrevented || !onCommit) return;
    if (e.key === 'Enter') {
      commit(e.currentTarget.value);
    } else if (e.key === 'Escape') {
      if (!controlled) setInner(committed);
      onCancel?.();
    }
  }

  function handleBlur(e: FocusEvent<HTMLInputElement>) {
    onBlur?.(e);
    if (onCommit) commit(e.currentTarget.value);
  }

  return (
    <input
      ref={ref}
      className={cx('cl-input', invalid && 'cl-input--invalid', className)}
      aria-invalid={invalid || undefined}
      value={text}
      onChange={handleChange}
      onKeyDown={handleKeyDown}
      onBlur={handleBlur}
      {...rest}
    />
  );
});
