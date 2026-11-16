import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_WIDTH, MAX_WIDTH, MIN_WIDTH, clampWidth, usePanelWidth } from './usePanelWidth';

afterEach(() => {
  vi.restoreAllMocks();
  window.localStorage.clear();
});

describe('usePanelWidth', () => {
  it('starts at the default and remembers a resized width for the next panel', () => {
    const first = renderHook(() => usePanelWidth());
    expect(first.result.current.width).toBe(DEFAULT_WIDTH);
    act(() => first.result.current.remember(600));
    expect(first.result.current.width).toBe(600);
    first.unmount();
    expect(renderHook(() => usePanelWidth()).result.current.width).toBe(600);
  });

  it('keeps the width inside the limits', () => {
    expect(clampWidth(100, 2000)).toBe(MIN_WIDTH);
    expect(clampWidth(5000, 2000)).toBe(MAX_WIDTH);
    expect(clampWidth(700, 800)).toBe(560); // leaves 240 px of the page
  });

  it('still works when localStorage throws', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    const { result } = renderHook(() => usePanelWidth());
    expect(result.current.width).toBe(DEFAULT_WIDTH);
    act(() => result.current.remember(500));
    expect(result.current.width).toBe(500);
  });
});
