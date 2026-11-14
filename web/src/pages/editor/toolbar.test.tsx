import { describe, expect, it } from 'vitest';
import { normalizeUrl } from './Toolbar';

describe('normalizeUrl', () => {
  it.each([
    ['example.com', 'https://example.com'],
    ['  http://a.b/c  ', 'http://a.b/c'],
    ['mailto:a@b.c', 'mailto:a@b.c'],
    ['/p/abc/pages', '/p/abc/pages'],
    ['#section', '#section'],
    ['', ''],
  ])('%j -> %j', (input, expected) => {
    expect(normalizeUrl(input)).toBe(expected);
  });
});
