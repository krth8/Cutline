import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { getPlatform } from './platform';
import { getResolvedTheme, getThemeChoice, onThemeChange, setThemeChoice, THEME_LABELS, type ThemeChoice } from './theme';
import { Avatar, Button, ColorDot, Dialog, Input, Menu } from './ui';
import './devTheme.css';

type Rgba = [number, number, number, number];

/** Parse the computed value of a colour ("rgb(1, 2, 3)", "rgba(...)" or "color(srgb r g b / a)"). */
export function parseCssColor(value: string): Rgba | null {
  const rgb = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+%?))?\s*\)$/.exec(value.trim());
  if (rgb) {
    const a = rgb[4] === undefined ? 1 : rgb[4].endsWith('%') ? parseFloat(rgb[4]) / 100 : parseFloat(rgb[4]);
    return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3]), a];
  }
  const srgb = /^color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+%?))?\)$/.exec(value.trim());
  if (srgb) {
    const a = srgb[4] === undefined ? 1 : srgb[4].endsWith('%') ? parseFloat(srgb[4]) / 100 : parseFloat(srgb[4]);
    return [Number(srgb[1]) * 255, Number(srgb[2]) * 255, Number(srgb[3]) * 255, a];
  }
  return null;
}

/** Lay `top` over the opaque colour `under`. */
export function flatten(top: Rgba, under: Rgba): Rgba {
  const a = top[3];
  return [top[0] * a + under[0] * (1 - a), top[1] * a + under[1] * (1 - a), top[2] * a + under[2] * (1 - a), 1];
}

function luminance([r, g, b]: Rgba): number {
  const f = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

/** WCAG contrast ratio (1..21) of two opaque colours. */
export function contrast(a: Rgba, b: Rgba): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

const SURFACE_TOKEN = '--bg-solid';

const COLOR_GROUPS: Array<{ title: string; tokens: string[] }> = [
  { title: 'Surfaces', tokens: ['--bg-dark', '--bg-secondary', '--bg-solid', '--bg-panel', '--bg-elevated', '--bg-hover', '--bg-active', '--modal-bg', '--modal-elevated', '--modal-field'] },
  { title: 'Borders', tokens: ['--border-light', '--border', '--border-medium', '--border-glow'] },
  { title: 'Text', tokens: ['--text', '--text-secondary', '--text-muted', '--text-on-accent'] },
  { title: 'Accent', tokens: ['--accent', '--accent-hover', '--accent-light', '--accent-lighter', '--accent-bg', '--accent-bg-strong'] },
  { title: 'Success', tokens: ['--success', '--success-light', '--success-bg', '--success-border'] },
  { title: 'Warning', tokens: ['--warning', '--warning-light', '--warning-bg', '--orange'] },
  { title: 'Danger', tokens: ['--danger', '--danger-dark', '--danger-bg', '--danger-border'] },
  { title: 'Info', tokens: ['--info', '--info-light', '--info-bg'] },
  { title: 'Categorical palette', tokens: ['--cat-1', '--cat-2', '--cat-3', '--cat-4', '--cat-5', '--cat-6', '--cat-7', '--cat-8'] },
];

const FONT_SIZES = ['xs', 'sm', 'md', 'lg', 'xl', '2xl'];
const SPACES = ['0-5', '1', '1-5', '2', '2-5', '3', '4', '5', '6', '7', '8'];
const RADII = ['xs', 'sm', 'md', 'lg', 'xl', 'full'];
const SHADOWS = ['sm', 'md', 'lg'];
const SEMANTIC = ['--cl-surface', '--cl-surface-panel', '--cl-surface-field', '--cl-surface-raised', '--cl-surface-hover', '--cl-border', '--cl-border-strong', '--cl-text', '--cl-text-secondary', '--cl-text-muted', '--cl-accent', '--cl-accent-text', '--cl-accent-soft', '--cl-focus-ring', '--cl-danger', '--cl-success', '--cl-warning', '--cl-info'];

/** Resolve a colour token to a flattened computed colour using a probe element. */
function resolveToken(probe: HTMLElement, token: string): Rgba | null {
  probe.style.color = `var(${token})`;
  return parseCssColor(getComputedStyle(probe).color);
}

function Chip({ token, probe, surface }: { token: string; probe: HTMLElement | null; surface: Rgba | null }) {
  let ratio = '';
  let value = '';
  if (probe && surface) {
    const c = resolveToken(probe, token);
    if (c) {
      value = c[3] < 1 ? `a ${c[3].toFixed(2)}` : '';
      ratio = `${contrast(flatten(c, surface), surface).toFixed(1)}:1`;
    }
  }
  return (
    <div className="cl-theme__chip" data-testid={`chip${token}`}>
      <span className="cl-theme__swatch" style={{ background: `var(${token})` }} />
      <span className="cl-theme__chipname">{token}</span>
      <span className="cl-theme__chipmeta">
        {ratio} {value}
      </span>
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="cl-theme__section">
      <h2>{title}</h2>
      {children}
    </section>
  );
}

/** Every design token as swatches and samples, plus the core components in the active theme (route /dev/theme, admins only). */
export function DevTheme() {
  const platform = getPlatform();
  const choice = useSyncExternalStore(onThemeChange, getThemeChoice);
  const resolved = useSyncExternalStore(onThemeChange, getResolvedTheme);
  const probeRef = useRef<HTMLSpanElement>(null);
  const menuRef = useRef<HTMLButtonElement>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [, force] = useState(0);
  const [surface, setSurface] = useState<Rgba | null>(null);

  // Recompute the contrast ratios whenever the theme changes (the palettes are applied by CSS)
  useEffect(() => {
    const probe = probeRef.current;
    if (!probe) return;
    probe.style.color = `var(${SURFACE_TOKEN})`;
    setSurface(parseCssColor(getComputedStyle(probe).color));
    force((n) => n + 1);
  }, [resolved]);

  const probe = probeRef.current;
  return (
    <main className="cl-theme" data-testid="dev-theme">
      <span ref={probeRef} className="cl-theme__probe" aria-hidden="true" />
      <h1>Cutline theme</h1>
      <p className="cl-theme__hint">
        Tokens live in static/css/theme.css. Contrast ratios are measured against the input surface (--bg-solid).
        Active theme: <strong data-testid="theme-resolved">{resolved}</strong>.
      </p>
      <div className="cl-theme__switch" role="group" aria-label="Theme">
        {(['system', 'light', 'dark'] as ThemeChoice[]).map((c) => (
          <Button key={c} size="sm" variant={choice === c ? 'primary' : 'secondary'} onClick={() => setThemeChoice(c)} aria-pressed={choice === c}>
            {THEME_LABELS[c]}
          </Button>
        ))}
      </div>

      {COLOR_GROUPS.map((g) => (
        <Section key={g.title} title={g.title}>
          <div className="cl-theme__chips">
            {g.tokens.map((t) => (
              <Chip key={t} token={t} probe={probe} surface={surface} />
            ))}
          </div>
        </Section>
      ))}

      <Section title="Semantic aliases (--cl-*)">
        <div className="cl-theme__chips">
          {SEMANTIC.map((t) => (
            <Chip key={t} token={t} probe={probe} surface={surface} />
          ))}
        </div>
      </Section>

      <Section title="Type scale">
        {FONT_SIZES.map((s) => (
          <div key={s} className="cl-theme__type" style={{ fontSize: `var(--font-size-${s})` }}>
            <code>--font-size-{s}</code> The quick brown fox jumps over the lazy dog
          </div>
        ))}
        <div className="cl-theme__row">
          {(['regular', 'medium', 'semibold', 'bold'] as const).map((w) => (
            <span key={w} style={{ fontWeight: `var(--font-weight-${w})` }}>
              {w}
            </span>
          ))}
          <span style={{ fontFamily: 'var(--font-mono)' }}>mono: 0123 abc</span>
        </div>
      </Section>

      <Section title="Spacing">
        {SPACES.map((s) => (
          <div key={s} className="cl-theme__space">
            <code>--space-{s}</code>
            <span className="cl-theme__bar" style={{ width: `var(--space-${s})` }} />
          </div>
        ))}
      </Section>

      <Section title="Radii">
        <div className="cl-theme__row">
          {RADII.map((r) => (
            <div key={r} className="cl-theme__box" style={{ borderRadius: `var(--radius-${r})` }}>
              {r}
            </div>
          ))}
        </div>
      </Section>

      <Section title="Shadows">
        <div className="cl-theme__row">
          {SHADOWS.map((s) => (
            <div key={s} className="cl-theme__box" style={{ boxShadow: `var(--shadow-${s})` }}>
              {s}
            </div>
          ))}
        </div>
      </Section>

      <Section title="Components">
        <div className="cl-theme__row">
          <Button variant="primary">Primary</Button>
          <Button>Secondary</Button>
          <Button variant="ghost">Ghost</Button>
          <Button variant="danger">Danger</Button>
          <Button disabled>Disabled</Button>
        </div>
        <div className="cl-theme__row">
          <Input placeholder="Input" aria-label="Input" />
          <Input placeholder="Invalid" invalid aria-label="Invalid input" />
        </div>
        <div className="cl-theme__row">
          <span className="cl-theme__pill cl-theme__pill--success">Done</span>
          <span className="cl-theme__pill cl-theme__pill--warning">Review</span>
          <span className="cl-theme__pill cl-theme__pill--danger">Blocked</span>
          <span className="cl-theme__pill cl-theme__pill--info">Planned</span>
          <span className="cl-theme__pill cl-theme__pill--accent">Selected</span>
          <ColorDot color="var(--cat-2)" label="Data colour" />
        </div>
        <div className="cl-theme__row">
          <Avatar name="Ada Lovelace" />
          <Avatar name="grace.hopper" size={36} />
          <Button ref={menuRef} onClick={() => setMenuOpen((o) => !o)} aria-haspopup="menu" aria-expanded={menuOpen}>
            Open menu
          </Button>
          <Menu
            open={menuOpen}
            onOpenChange={setMenuOpen}
            anchorRef={menuRef}
            aria-label="Demo menu"
            items={[
              { id: 'rename', label: 'Rename', onSelect: () => platform.toast('info', 'Rename') },
              { id: 'off', label: 'Disabled item', disabled: true, onSelect: () => undefined },
              { type: 'separator' },
              { id: 'delete', label: 'Delete', danger: true, onSelect: () => platform.toast('error', 'Deleted') },
            ]}
          />
          <Button onClick={() => setDialogOpen(true)}>Open dialog</Button>
          <Dialog
            open={dialogOpen}
            onClose={() => setDialogOpen(false)}
            title="Demo dialog"
            footer={
              <>
                <Button variant="ghost" onClick={() => setDialogOpen(false)}>
                  Cancel
                </Button>
                <Button variant="primary" onClick={() => setDialogOpen(false)}>
                  Save
                </Button>
              </>
            }
          >
            <Input placeholder="Name" aria-label="Name" style={{ width: '100%' }} />
          </Dialog>
        </div>
      </Section>
    </main>
  );
}
