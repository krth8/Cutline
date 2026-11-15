# Theme

All design tokens live in one file: `static/css/theme.css`. It loads before `main.css` (see `static/index.html`);
the server stamps its URL with a version like every other stylesheet, so a change shows up on the next load.
Open `/dev/theme` (admins) to see every token as a swatch or sample in the current theme, with a theme switch.

## What is in theme.css

1. **Palettes**: dark (the default, `:root` and `[data-theme="dark"]`) and light (`[data-theme="light"]`). Same token
   names in both. Groups: base, surfaces (`--bg-*`, `--modal-*`), borders, text, accent, status (success, warning,
   danger, info), neutral greys, categorical palette (`--cat-1..8`), shadow colours.
2. **Mode-independent tokens**: radii, shadows (`--shadow-sm/md/lg`), motion (`--transition-*`), typography
   (`--font-sans/mono`, `--font-size-xs..2xl`, `--font-weight-*`, `--line-height-*`), spacing (`--space-1..8`, on a
   4px grid, plus half steps `--space-0-5`, `--space-1-5`, `--space-2-5`), control sizes (`--control-height-xs/sm/md`,
   `--row-height`), layers (`--z-*`), layout sizes (`--sidebar-width`, `--header-height`, `--panel-width`,
   `--content-measure`).
3. **Semantic aliases `--cl-*`** (`--cl-surface`, `--cl-surface-raised`, `--cl-surface-hover`, `--cl-border`,
   `--cl-text`, `--cl-text-muted`, `--cl-accent`, `--cl-focus-ring`, ...). They are defined in terms of the base
   tokens. New component CSS should prefer them; older CSS uses the base names, which keep working.
4. **Small-screen overrides** of layout sizes.

Each token has a one-line comment saying what it is for.

## The rule for component CSS

- No literal colours (`#fff`, `rgb(...)`, `rgba(...)`, `hsl(...)`) in `web/src/**/*.css`. Use a token. If one is
  missing, add it to `theme.css` (both palettes if it depends on the mode).
- Sizes come from the tokens: font sizes, weights, line heights, spacing, radii, z-index, control heights.
  A value that is not on the scale may stay literal, but a repeated one is a sign the scale needs a step.
- Colours that are data (a status option colour chosen by a user or the server) are values, not tokens. Text on
  them is chosen with `readableTextColor()` in `web/src/tables/cells/util.ts` (black or white by contrast), which
  works the same in both themes.

`web/src/theme.test.ts` enforces this: it fails on a literal colour in a bundle CSS file that is not on the
allow-list, and on any `var(--x)` (without a fallback) that is not defined in `theme.css`, in the same file, or set from TSX.

## How to change the look

**Change the accent colour.** In `theme.css` change `--accent`, `--accent-hover`, `--accent-light`,
`--accent-lighter`, `--accent-glow`, `--accent-bg*` and `--border-glow` in the dark palette, and again in the light
palette (darker there, so white text on it keeps 4.5:1; check the ratio on `/dev/theme`).

**Make everything roomier.** Raise the spacing scale (for example `--space-2: 10px`, `--space-3: 14px`), the
control heights (`--control-height-md: 36px`, `--control-height-sm: 30px`) and `--row-height` / `--row-height-compact`.
Everything that uses the tokens follows. Spacing written as a literal in a CSS file does not move: replace it with a token.

**Add a third theme.** Copy the `[data-theme="light"]` block in `theme.css`, rename the selector, for example
`:root[data-theme="sepia"], [data-theme="sepia"]`, and change the colour values (keep the token names; add
`color-scheme: light` or `dark`). To make it selectable, add the name to the inline script in `static/index.html`
and to `ThemeChoice` and `THEME_CYCLE` in `web/src/theme.ts`. The `--cl-*` aliases and shadows are recomputed for
every element with a `data-theme` attribute, so nothing else needs to change.

## Light theme and the switch

- `localStorage["theme"]` holds `dark`, `light`, `system` or `custom`. Nothing stored means **Dark**.
  **System** follows `prefers-color-scheme` and reacts when the OS preference changes.
- A small inline script at the top of `<head>` in `static/index.html` resolves the choice and sets
  `<html data-theme="light|dark|custom">` before the stylesheets load, so there is no flash of the wrong theme.
  It also defines `window.CutlineTheme = { get(), resolved(), set(choice) }` and fires a `cutline-theme` event on
  `window` when the theme changes. `web/src/theme.ts` wraps it for the bundle.
- The palette command **Switch theme** (Ctrl+K, `>switch theme`) cycles System, Light, Dark. The Settings dialog
  (legacy page) has System, Dark, Light and Custom radios. **To do when the user menu is rebuilt:** add a
  "Theme: System / Light / Dark" item that calls `setThemeChoice` from `web/src/theme.ts`.
- A part of the page can stay in another theme by putting `data-theme="dark"` (or `light`) on its container; the
  container then gets that palette, background and text colour. The Review player currently uses the light theme
  with the rest of the page because the legacy CSS already follows the variables; the dark island mechanism is
  there if it is needed.

## Still on the allow-list (literal colours)

These files are being restyled by other work and still contain literal colours. The list is in
`web/src/theme.test.ts` (`COLOUR_ALLOW_LIST`) and must shrink to zero.



- `web/src/pages/tree/tree.css`
- `web/src/task/task.css`
- `web/src/tables/toolbar/toolbar.css`

In the light theme the hover fill in `tree.css` (`rgba(255, 255, 255, 0.12)`) is invisible; use `--bg-active`.
