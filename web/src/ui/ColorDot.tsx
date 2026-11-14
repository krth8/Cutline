import { cx } from './hooks';
import './colordot.css';

export interface ColorDotProps {
  color: string;
  size?: number;
  /** Accessible name, e.g. the status name. Without it the dot is decorative. */
  label?: string;
  /** Makes the dot a button (e.g. to pick a colour). */
  onClick?: () => void;
  selected?: boolean;
  className?: string;
}

export function ColorDot({ color, size = 10, label, onClick, selected, className }: ColorDotProps) {
  const style = { width: size, height: size, background: color };
  if (onClick) {
    return (
      <button
        type="button"
        className={cx('cl-colordot', 'cl-colordot--button', selected && 'is-selected', className)}
        style={style}
        aria-label={label}
        aria-pressed={selected ?? false}
        onClick={onClick}
      />
    );
  }
  return (
    <span
      className={cx('cl-colordot', className)}
      style={style}
      {...(label ? { role: 'img', 'aria-label': label } : { 'aria-hidden': true })}
    />
  );
}
