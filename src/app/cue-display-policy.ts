// 等待期间原字幕被隐藏、画面没有任何字幕；等待过长会让人感觉字幕"慢半拍"。
// 预取正常时译文在字幕出现前已就绪，此等待只兜底首句、拖动进度等少数情况。
export const CUE_TRANSLATION_WAIT_MS = 500;

export interface CueDisplayPolicyOptions {
  readonly onWait: () => void;
  readonly onFallback: () => void;
  readonly schedule?: (callback: () => void, delayMs: number) => unknown;
  readonly cancel?: (handle: unknown) => void;
}

/**
 * 一次字幕展示先限时等待中英同显；超时先回退原字幕，译文在本句内到达时再升级为双语。
 * 翻译或渲染失败（fail）则本句固定保留原字幕，避免反复重试渲染。
 * reset 撤销当前展示及计时器，不操作字幕层；失效计时器不能影响下一句。
 */
export function createCueDisplayPolicy(options: CueDisplayPolicyOptions) {
  const schedule = options.schedule ?? ((callback, delayMs) => setTimeout(callback, delayMs));
  const cancel = options.cancel ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  let cueId: string | null = null;
  let state: 'idle' | 'waiting' | 'ready' | 'timed-out' | 'native' = 'idle';
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
  const fallBack = (next: 'timed-out' | 'native'): void => {
    cancelTimer();
    state = next;
    options.onFallback();
  };
  const fail = (candidate: string): void => {
    if (candidate !== cueId || state === 'idle' || state === 'native') return;
    if (state === 'timed-out') { state = 'native'; return; }
    fallBack('native');
  };

  return {
    shouldRender(candidate: string, ready: boolean): boolean {
      if (candidate !== cueId) { reset(); cueId = candidate; }
      if (state === 'native') return false;
      if (ready) { cancelTimer(); state = 'ready'; return true; }
      if (state === 'waiting' || state === 'timed-out') return false;
      state = 'waiting';
      const currentVersion = version;
      try {
        options.onWait();
        if (currentVersion !== version) return false;
        timer = schedule(() => {
          if (currentVersion === version && cueId === candidate && state === 'waiting') {
            fallBack('timed-out');
          }
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
