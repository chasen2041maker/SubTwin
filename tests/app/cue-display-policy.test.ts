import { describe, expect, it, vi } from 'vitest';

import { createCueDisplayPolicy, CUE_TRANSLATION_WAIT_MS } from '../../src/app/cue-display-policy';

describe('cue display deadline ownership', () => {
  it('ignores a revoked deadline even if cancellation cannot stop its callback', () => {
    const deadlines: Array<() => void> = [];
    const onWait = vi.fn();
    const onFallback = vi.fn();
    const cancel = vi.fn();
    const policy = createCueDisplayPolicy({
      onWait, onFallback, cancel,
      schedule(callback, delayMs) {
        expect(delayMs).toBe(CUE_TRANSLATION_WAIT_MS);
        deadlines.push(callback);
        return deadlines.length;
      },
    });
    expect(policy.shouldRender('first', false)).toBe(false);
    expect(policy.shouldRender('second', false)).toBe(false);
    deadlines[0]?.();
    expect(onFallback).not.toHaveBeenCalled();
    expect(policy.shouldRender('second', true)).toBe(true);
    deadlines[1]?.();
    expect(onFallback).not.toHaveBeenCalled();
    expect(onWait).toHaveBeenCalledTimes(2);
    expect(cancel).toHaveBeenCalledTimes(2);
  });

  it('falls back safely when starting a wait fails and unlocks only after reset', () => {
    const onFallback = vi.fn();
    const policy = createCueDisplayPolicy({
      onWait: () => { throw new Error('Synthetic renderer failure'); }, onFallback,
    });
    expect(policy.shouldRender('first', false)).toBe(false);
    expect(onFallback).toHaveBeenCalledOnce();
    expect(policy.shouldRender('first', true)).toBe(false);
    policy.reset();
    expect(policy.shouldRender('first', true)).toBe(true);
  });
});
