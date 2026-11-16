import { describe, expect, it } from 'vitest';
import { buildRoute, parseRoute, routeProjectId, rowOfUrl, taskIdOfUrl, withRowParam, withTaskParam, type Route } from './router';

const samples: Array<[string, Route]> = [
  ['/home', { kind: 'home' }],
  ['/me', { kind: 'me' }],
  ['/me/page/pg1', { kind: 'mePage', pageId: 'pg1' }],
  ['/p/proj1/pages', { kind: 'projectPages', projectId: 'proj1' }],
  ['/p/proj1/tasks', { kind: 'projectTasks', projectId: 'proj1' }],
  ['/p/proj1/view/v1', { kind: 'projectView', projectId: 'proj1', viewId: 'v1' }],
  ['/me/view/v1?task=t1', { kind: 'meView', viewId: 'v1', task: 't1' }],
  ['/p/proj1/page/pg1', { kind: 'projectPage', projectId: 'proj1', pageId: 'pg1' }],
  ['/lounge', { kind: 'lounge' }],
  ['/p/proj1/lounge', { kind: 'lounge', projectId: 'proj1' }],
  ['/projects', { kind: 'projects' }],
  ['/p/proj1/review', { kind: 'review', projectId: 'proj1' }],
  ['/p/proj1/review?clip=7&v=2&session=s9', { kind: 'review', projectId: 'proj1', clip: '7', v: '2', session: 's9' }],
  ['/home?task=t1', { kind: 'home', task: 't1' }],
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

  it('reads the bare "/" as Home too, and writes Home as /home', () => {
    expect(parseRoute('/')).toEqual({ kind: 'home' });
    expect(parseRoute('/?task=t1')).toEqual({ kind: 'home', task: 't1' });
    expect(buildRoute({ kind: 'home' })).toBe('/home');
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

describe('task param helpers', () => {
  it('reads ?task= from any path, including unknown ones', () => {
    expect(taskIdOfUrl('/p/p1/pages?task=t1')).toBe('t1');
    expect(taskIdOfUrl('/dev/view/v1?task=t%201&x=2')).toBe('t 1');
    expect(taskIdOfUrl('/me')).toBeNull();
    expect(taskIdOfUrl('/me?task=')).toBeNull();
  });

  it('sets and removes the param and keeps the rest of the URL', () => {
    expect(withTaskParam('/p/p1/review?clip=7', 't9')).toBe('/p/p1/review?clip=7&task=t9');
    expect(withTaskParam('/p/p1/review?clip=7&task=t9', null)).toBe('/p/p1/review?clip=7');
    expect(withTaskParam('/dev/view/v1?task=a', 'b')).toBe('/dev/view/v1?task=b');
    expect(withTaskParam('/me?task=a', null)).toBe('/me');
  });
});

describe('row param helpers', () => {
  it('reads ?row=<ref>:<id> from any path', () => {
    expect(rowOfUrl('/p/p1/page/x?row=tbl_a1:r1')).toEqual({ ref: 'tbl_a1', id: 'r1' });
    expect(rowOfUrl('/me?row=tbl_a1:a-b_c')).toEqual({ ref: 'tbl_a1', id: 'a-b_c' });
    expect(rowOfUrl('/me?row=tbl_a1')).toBeNull();
    expect(rowOfUrl('/me?row=:r1')).toBeNull();
    expect(rowOfUrl('/me?row=tbl_a1:')).toBeNull();
    expect(rowOfUrl('/me')).toBeNull();
  });

  it('sets and removes the param and keeps the rest of the URL (including the task param)', () => {
    expect(withRowParam('/p/p1/pages?x=1', { ref: 'tbl_a1', id: 'r1' })).toBe('/p/p1/pages?x=1&row=tbl_a1%3Ar1');
    expect(rowOfUrl(withRowParam('/p/p1/pages', { ref: 'tbl_a1', id: 'r 1' }))).toEqual({ ref: 'tbl_a1', id: 'r 1' });
    expect(withRowParam('/p/p1/pages?task=t1&row=tbl_a1:r1', null)).toBe('/p/p1/pages?task=t1');
  });
});
