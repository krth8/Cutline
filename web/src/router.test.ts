import { describe, expect, it } from 'vitest';
import { buildRoute, parseRoute, routeProjectId, type Route } from './router';

const samples: Array<[string, Route]> = [
  ['/', { kind: 'home' }],
  ['/me', { kind: 'me' }],
  ['/me/page/pg1', { kind: 'mePage', pageId: 'pg1' }],
  ['/p/proj1/pages', { kind: 'projectPages', projectId: 'proj1' }],
  ['/p/proj1/page/pg1', { kind: 'projectPage', projectId: 'proj1', pageId: 'pg1' }],
  ['/p/proj1/review', { kind: 'review', projectId: 'proj1' }],
  ['/p/proj1/review?clip=7&v=2&session=s9', { kind: 'review', projectId: 'proj1', clip: '7', v: '2', session: 's9' }],
  ['/?task=t1', { kind: 'home', task: 't1' }],
  ['/me?task=t1', { kind: 'me', task: 't1' }],
  ['/me/page/pg1?task=t1', { kind: 'mePage', pageId: 'pg1', task: 't1' }],
  ['/p/a/pages?task=t1', { kind: 'projectPages', projectId: 'a', task: 't1' }],
  ['/p/a/page/b?task=t1', { kind: 'projectPage', projectId: 'a', pageId: 'b', task: 't1' }],
  ['/p/a/review?clip=3&task=t1', { kind: 'review', projectId: 'a', clip: '3', task: 't1' }],
];

describe('router', () => {
  it.each(samples)('parses %s and builds it back', (url, route) => {
    expect(parseRoute(url)).toEqual(route);
    expect(buildRoute(route)).toBe(url);
    expect(parseRoute(buildRoute(route))).toEqual(route);
  });

  it('accepts full URLs and trailing slashes', () => {
    expect(parseRoute('https://example.com/p/a/pages/')).toEqual({ kind: 'projectPages', projectId: 'a' });
    expect(parseRoute('/me/')).toEqual({ kind: 'me' });
  });

  it('ignores unrelated query parameters and empty values', () => {
    expect(parseRoute('/me?foo=1&task=')).toEqual({ kind: 'me' });
  });

  it.each(['/dev/ui', '/s/abc', '/me/other', '/me/page', '/p', '/p/a', '/p/a/unknown', '/p/a/page', '/p/a/pages/extra', '/x/y'])(
    'gives notFound for %s',
    (url) => {
      expect(parseRoute(url)).toEqual({ kind: 'notFound', path: url });
      expect(buildRoute(parseRoute(url))).toBe(url);
    },
  );

  it('treats a malformed escape as notFound', () => {
    expect(parseRoute('/p/%E0%A4%A/pages').kind).toBe('notFound');
  });

  it('encodes ids with special characters and decodes them again', () => {
    const route: Route = { kind: 'projectPage', projectId: 'a b/c', pageId: 'ä?#&' };
    const url = buildRoute(route);
    expect(url).toBe('/p/a%20b%2Fc/page/%C3%A4%3F%23%26');
    expect(parseRoute(url)).toEqual(route);
  });

  it('encodes query values', () => {
    const route: Route = { kind: 'review', projectId: 'p', clip: 'a&b=c', task: 'x y' };
    expect(parseRoute(buildRoute(route))).toEqual(route);
  });

  it('routeProjectId', () => {
    expect(routeProjectId({ kind: 'review', projectId: 'p' })).toBe('p');
    expect(routeProjectId({ kind: 'me' })).toBeNull();
  });
});
