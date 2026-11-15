import { describe, expect, it } from 'vitest';
import type { MovePreview } from '../../api/pageTree';
import { moveWarning } from './moveWarning';

const preview = (extra: Partial<MovePreview> = {}): MovePreview => ({
  from: 'me',
  to: 'p:spot',
  subPages: 0,
  gain: { count: 0, names: [] },
  lose: { count: 0, names: [] },
  limitedViews: [],
  ...extra,
});

describe('moveWarning', () => {
  it('personal to project: everyone in the project will see the page and its sub-pages', () => {
    const lines = moveWarning({
      preview: preview({ subPages: 3, gain: { count: 2, names: ['ana', 'ben'] } }),
      destinationName: 'Spot',
      sourceName: 'Personal space',
      destinationIsPersonal: false,
      sourceIsPersonal: true,
    });
    expect(lines[0]).toBe('Everyone in Spot will be able to see this page and its 3 sub-pages.');
    expect(lines[1]).toBe('2 people who cannot see it now will gain access: ana, ben.');
    expect(lines).toHaveLength(2);
  });

  it('uses the singular for one sub-page and one person', () => {
    const lines = moveWarning({
      preview: preview({ subPages: 1, gain: { count: 1, names: ['ana'] } }),
      destinationName: 'Spot',
      sourceName: 'Personal space',
      destinationIsPersonal: false,
      sourceIsPersonal: true,
    });
    expect(lines[0]).toContain('this page and its 1 sub-page.');
    expect(lines[1]).toContain('1 person who');
  });

  it('project to personal: only you will see it and the others lose access', () => {
    const lines = moveWarning({
      preview: preview({ from: 'p:spot', to: 'me', subPages: 0, lose: { count: 4, names: ['a', 'b', 'c'] } }),
      destinationName: 'Personal space',
      sourceName: 'Spot',
      destinationIsPersonal: true,
      sourceIsPersonal: false,
    });
    expect(lines[0]).toBe('Only you will be able to see this page.');
    expect(lines[1]).toBe('4 people in Spot will lose access: a, b, c and 1 more. If they have it open, it closes for them.');
  });

  it('project to project with nobody gaining or losing', () => {
    const none = moveWarning({
      preview: preview({ from: 'p:a', to: 'p:b' }),
      destinationName: 'Beta',
      sourceName: 'Alpha',
      destinationIsPersonal: false,
      sourceIsPersonal: false,
    });
    expect(none).toEqual([
      'Everyone in Beta will be able to see this page.',
      'Nobody who cannot see it now gains access.',
      'Nobody loses access.',
    ]);
  });

  it('warns about views whose tasks some readers of the destination cannot see', () => {
    const lines = moveWarning({
      preview: preview({
        subPages: 2,
        limitedViews: [{ projectId: 'p1', projectName: 'Alpha', viewCount: 2, readersWithoutAccess: 1 }],
      }),
      destinationName: 'Beta',
      sourceName: 'Personal space',
      destinationIsPersonal: false,
      sourceIsPersonal: true,
    });
    expect(lines[lines.length - 1]).toBe(
      '2 views on these pages show tasks of Alpha; 1 person in Beta cannot see those tasks and will see no rows.',
    );
  });
});
