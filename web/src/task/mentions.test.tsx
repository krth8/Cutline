import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { mentionQuery, withMentions } from './Comments';

describe('mentions in task comments', () => {
  it('finds the @ being typed right before the caret', () => {
    expect(mentionQuery('Hei @an', 7)).toBe('an');
    expect(mentionQuery('@', 1)).toBe('');
    expect(mentionQuery('mail@an', 7)).toBeNull(); // part of a word, not a mention
    expect(mentionQuery('Hei @anna takk', 14)).toBeNull();
    expect(mentionQuery('Hei @an', -1)).toBeNull();
  });

  it('sets @names apart in the text', () => {
    const { container } = render(<p>{withMentions('Takk @anna og @jonas.b! e-post a@b.no')}</p>);
    expect([...container.querySelectorAll('.cl-comment__mention')].map((e) => e.textContent)).toEqual(['@anna', '@jonas.b']);
    expect(container.textContent).toBe('Takk @anna og @jonas.b! e-post a@b.no');
  });
});
