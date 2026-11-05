export const CUE_TRANSLATION_WAIT_MS = 1_500;

export interface CueDisplayPolicyOptions {
  readonly onWait: () => void;
  readonly onFallback: () => void;
  readonly schedule?: (callback: () => void, delayMs: number) => unknown;
  readonly cancel?: (handle: unknown) => void;
}

/**
 * 一次字幕展示只允许等待后原子显示或回退原生；回退后的迟到译文留给重播。
 * reset 撤销当前展示及计时器，不操作字幕层；失效计时器不能影响下一句。
 */
export function createCueDisplayPolicy(options: CueDisplayPolicyOptions) {
  const schedule = options.schedule ?? ((callback, delayMs) => setTimeout(callback, delayMs));
  const cancel = options.cancel ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  let cueId: string | null = null;
  let state: 'idle' | 'waiting' | 'ready' | 'native' = 'idle';
  let timer: unknown;
  let version = 0;

  const cancelTimer = (): void => {
    version += 1;
    if (timer !== undefined) cancel(timer);
    timer = undefined;
  };
  const reset = (): boolean => {
    const active = cueId !== null;
    cancelTimer();
    cueId = null;
    state = 'idle';
    return active;
  };
  const fail = (candidate: string): void => {
    if (candidate !== cueId || state === 'idle' || state === 'native') return;
    cancelTimer();
    state = 'native';
    options.onFallback();
  };

  return {
    shouldRender(candidate: string, ready: boolean): boolean {
      if (candidate !== cueId) { reset(); cueId = candidate; }
      if (state === 'native') return false;
      if (ready) { cancelTimer(); state = 'ready'; return true; }
      if (state === 'waiting') return false;
      state = 'waiting';
      const currentVersion = version;
      try {
        options.onWait();
        if (currentVersion !== version) return false;
        timer = schedule(() => {
          if (currentVersion === version && cueId === candidate) fail(candidate);
        }, CUE_TRANSLATION_WAIT_MS);
      } catch {
        fail(candidate);
      }
      return false;
    },
    fail,
    reset,
  };
}
