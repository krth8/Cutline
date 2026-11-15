/**
 * Guards for the theme file (static/css/theme.css):
 *  1. bundle CSS contains no literal colours, except in the files listed below;
 *  2. every var(--x) used in bundle CSS is defined in theme.css, in the same file, or set from TSX.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = path.resolve(__dirname);
const THEME_CSS = path.resolve(SRC, '../../static/css/theme.css');

/**
 * Files that still hold literal colours because another change is restyling them right now.
 * This list must shrink to zero: when you touch one of these files, replace its colours with tokens
 * from theme.css and delete the entry.
 */
const COLOUR_ALLOW_LIST = new Set([
  'pages/editor/editor.css',
  'pages/sync/sync.css',
  'pages/tree/tree.css',
  'task/task.css',
  'tables/toolbar/toolbar.css',
]);

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

const allFiles = walk(SRC);
const cssFiles = allFiles.filter((f) => f.endsWith('.css'));
const rel = (f: string) => path.relative(SRC, f).split(path.sep).join('/');
const stripComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '');

const COLOUR = /#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/g;

describe('theme: no literal colours in bundle CSS', () => {
  it('finds the bundle CSS', () => {
    expect(cssFiles.length).toBeGreaterThan(20);
  });

  for (const file of cssFiles) {
    const name = rel(file);
    if (COLOUR_ALLOW_LIST.has(name)) continue;
    it(`${name} uses tokens only`, () => {
      const found = stripComments(readFileSync(file, 'utf8')).match(COLOUR) ?? [];
      expect(found, 'use a colour token from static/css/theme.css').toEqual([]);
    });
  }

  it('keeps the allow-list honest: every entry exists and still needs it', () => {
    for (const name of COLOUR_ALLOW_LIST) {
      const file = cssFiles.find((f) => rel(f) === name);
      expect(file, `${name} no longer exists: remove it from the allow-list`).toBeTruthy();
      const found = stripComments(readFileSync(file!, 'utf8')).match(COLOUR) ?? [];
      expect(found.length, `${name} has no literal colours any more: remove it from the allow-list`).toBeGreaterThan(0);
    }
  });
});

describe('theme: every variable is defined', () => {
  const themeCss = stripComments(readFileSync(THEME_CSS, 'utf8'));
  const defined = (css: string) => new Set([...css.matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]!));
  const themeVars = defined(themeCss);

  // Variables that TSX sets through style objects or setProperty, e.g. '--cl-table-cols'
  const fromTsx = new Set<string>();
  for (const f of allFiles.filter((x) => /\.tsx?$/.test(x) && !/\.test\./.test(x))) {
    for (const m of readFileSync(f, 'utf8').matchAll(/['"`](--[\w-]+)['"`]/g)) fromTsx.add(m[1]!);
  }

  it('theme.css defines the documented groups', () => {
    for (const v of ['--bg-dark', '--text', '--accent', '--font-size-md', '--space-4', '--z-dialog', '--control-height-md', '--cl-surface']) {
      expect(themeVars.has(v), v).toBe(true);
    }
  });

  for (const file of cssFiles) {
    const name = rel(file);
    // A variable with a fallback, var(--x, auto), is an optional hook and may stay undefined
    it(`${name} only uses defined variables`, () => {
      const css = stripComments(readFileSync(file, 'utf8'));
      const local = defined(css);
      const missing = [...css.matchAll(/var\(\s*(--[\w-]+)\s*\)/g)]
        .map((m) => m[1]!)
        .filter((v) => !themeVars.has(v) && !local.has(v) && !fromTsx.has(v));
      expect([...new Set(missing)], 'define it in static/css/theme.css').toEqual([]);
    });
  }

  it('every colour and size alias resolves to a defined base token', () => {
    for (const m of themeCss.matchAll(/(--cl-[\w-]+)\s*:\s*var\((--[\w-]+)\)/g)) {
      expect(themeVars.has(m[2]!), `${m[1]} -> ${m[2]}`).toBe(true);
    }
  });

  it('the light palette overrides only tokens the dark palette defines', () => {
    const light = /\[data-theme="light"\]\s*\{([\s\S]*?)\n\}/.exec(themeCss)?.[1] ?? '';
    const dark = /\[data-theme="dark"\]\s*\{([\s\S]*?)\n\}/.exec(themeCss)?.[1] ?? '';
    const darkVars = defined(dark);
    expect(darkVars.size).toBeGreaterThan(50);
    for (const v of defined(light)) expect(darkVars.has(v), `${v} is in the light palette only`).toBe(true);
  });
});
