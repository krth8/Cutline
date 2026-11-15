import { describe, expect, it } from 'vitest';
import { defaultValue, hasValue, opsFor } from './queryModel';

describe('the done operators of a status column', () => {
  it('are offered for status only and take no value', () => {
    expect(opsFor('status')).toEqual(expect.arrayContaining(['done', 'notDone']));
    expect(opsFor('select')).not.toContain('done');
    expect(hasValue('done')).toBe(false);
    expect(hasValue('notDone')).toBe(false);
    expect(hasValue('eq')).toBe(true);
    expect(defaultValue({ key: 'status', name: 'Status', type: 'status' } as never, 'notDone')).toBeUndefined();
  });
});
