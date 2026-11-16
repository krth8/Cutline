import { describe, expect, it } from 'vitest';
import { placeLabel } from './usePlace';

describe('placeLabel', () => {
  it('says where in a project a tab is', () => {
    expect(placeLabel({ kind: 'review', projectId: 'p', clip: 'shot_010' }, null)).toBe('Review: shot_010');
    expect(placeLabel({ kind: 'review', projectId: 'p' }, null)).toBe('Review');
    expect(placeLabel({ kind: 'lounge', projectId: 'p' }, null)).toBe('Lounge');
    expect(placeLabel({ kind: 'projectPages', projectId: 'p' }, null)).toBe('Dashboard');
    expect(placeLabel({ kind: 'projectTasks', projectId: 'p' }, null)).toBe('Tasks');
    expect(placeLabel({ kind: 'projectPage', projectId: 'p', pageId: 'x' }, 'Creative brief')).toBe('Creative brief');
    expect(placeLabel({ kind: 'projectPage', projectId: 'p', pageId: 'x' }, null)).toBe('A page');
    expect(placeLabel({ kind: 'home' }, null)).toBeNull();
  });
});
