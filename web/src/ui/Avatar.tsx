import { useState } from 'react';
import { cx } from './hooks';
import './avatar.css';

export interface AvatarProps {
  name: string;
  /** Picture URL (profile image). Falls back to initials if missing or broken. */
  src?: string | undefined;
  size?: number;
  className?: string;
}

export function initials(name: string): string {
  const words = name.trim().split(/[\s._-]+/).filter(Boolean);
  if (!words.length) return '?';
  const first = words[0]!;
  const letters = words.length > 1 ? first[0]! + words[words.length - 1]![0]! : first.slice(0, 2);
  return letters.toUpperCase();
}

/** A stable hue per name so the same person always gets the same colour. */
export function hueFor(name: string): number {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % 360;
  return h;
}

export function Avatar({ name, src, size = 28, className }: AvatarProps) {
  const [broken, setBroken] = useState<string | null>(null);
  const showImage = !!src && broken !== src;
  return (
    <span
      className={cx('cl-avatar', className)}
      role="img"
      aria-label={name}
      title={name}
      style={{
        width: size,
        height: size,
        fontSize: Math.max(10, Math.round(size * 0.4)),
        background: showImage ? undefined : `hsl(${hueFor(name)} 45% 42%)`,
      }}
    >
      {showImage ? <img src={src} alt="" onError={() => setBroken(src ?? null)} /> : initials(name)}
    </span>
  );
}
