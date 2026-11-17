import { describe, expect, it } from 'vitest';
import { buildRoute, parseRoute } from '../router';

describe('lounge channel routes', () => {
  it('a channel has its own address', () => {
    expect(buildRoute({ kind: 'lounge', channelId: 'c1' })).toBe('/lounge/c/c1');
    expect(parseRoute('/lounge/c/c1')).toEqual({ kind: 'lounge', channelId: 'c1' });
    expect(buildRoute({ kind: 'lounge', projectId: 'p1' })).toBe('/p/p1/lounge');
    expect(buildRoute({ kind: 'lounge' })).toBe('/lounge');
  });
});
