import { err, ok, type AppError, type Result } from '../shared/result';

// 优先绑定常驻的字幕根节点：它包含所有文本区域，且不会随每句字幕重建。
const NATIVE_SUBTITLE_SELECTORS = [
  '.player-timedtext',
  '[data-uia="player-subtitle"]',
  '.player-timedtext-text-container',
] as const;

export interface NativeSubtitleNode {
  textContent: string | null;
  readonly nodeType?: number;
  readonly nodeName?: string;
  readonly childNodes?: ArrayLike<NativeSubtitleNode>;
}

export interface NativeSubtitleDocument {
  readonly root: unknown;
  querySelector(selector: string): NativeSubtitleNode | null;
}

export interface NativeSubtitleMutationObserver {
  observe(
    target: unknown,
    options?: {
      readonly childList: boolean;
      readonly characterData: boolean;
      readonly subtree: boolean;
    },
  ): void;
  disconnect(): void;
}

export interface NativeSubtitleClockScheduler {
  schedule(callback: () => void): unknown;
  cancel(handle: unknown): void;
}

/**
 * 在当前微任务检查点派发字幕更新，避免延迟到下一绘制帧。
 * 入队函数必须异步调度回调；句柄仅在当前调度器有效，取消或已执行后不会再次派发。
 * 入队失败时清理句柄并向调用方传播错误。
 */
export function createNativeSubtitleMicrotaskScheduler(
  enqueueMicrotask: (callback: () => void) => void,
): NativeSubtitleClockScheduler {
  const pending = new Set<object>();
  return {
    schedule(callback) {
      const handle = {};
      pending.add(handle);
      try {
        enqueueMicrotask(() => {
          if (pending.delete(handle)) callback();
        });
      } catch (error) {
        pending.delete(handle);
        throw error;
      }
      return handle;
    },
    cancel(handle) {
      if (typeof handle === 'object' && handle !== null) pending.delete(handle);
    },
  };
}

export interface NativeSubtitleTick {
  readonly sessionId: string;
  readonly generation: number;
  readonly sequence: number;
  readonly visibleText: string;
  readonly currentTimeMs?: number;
}

export type NativeSubtitleClockError = AppError<
  'native_subtitle_container_missing'
>;

export interface NativeSubtitleClockOptions {
  readonly document: NativeSubtitleDocument;
  readonly scheduler: NativeSubtitleClockScheduler;
  readonly createObserver: (
    callback: () => void,
  ) => NativeSubtitleMutationObserver;
  readonly sessionId: string;
  readonly generation: number;
  readonly onTick: (tick: NativeSubtitleTick) => void;
  readonly onDiagnostic?: (diagnostic: NativeSubtitleClockError) => void;
  readonly getCurrentTimeMs?: () => number | undefined;
  readonly isGenerationCurrent?: (generation: number) => boolean;
}

export interface NativeSubtitleClock {
  start(): Result<undefined, NativeSubtitleClockError>;
  dispose(): void;
}

export function createNativeSubtitleClock(
  options: NativeSubtitleClockOptions,
): NativeSubtitleClock {
  let started = false;
  let disposed = false;
  let sequence = 0;
  let bindingVersion = 0;
  let rootObserver: NativeSubtitleMutationObserver | undefined;
  let containerObserver: NativeSubtitleMutationObserver | undefined;
  let container: NativeSubtitleNode | null = null;
  let scheduledHandle: unknown;
  let hasScheduledTick = false;
  let missingContainerReported = false;

  const isCurrentGeneration = (): boolean =>
    options.isGenerationCurrent?.(options.generation) ?? true;

  const emitMissingContainer = (): NativeSubtitleClockError => {
    const diagnostic: NativeSubtitleClockError = {
      code: 'native_subtitle_container_missing',
      message: 'Netflix native subtitle container is not available.',
      retryable: true,
    };
    if (!missingContainerReported) {
      missingContainerReported = true;
      options.onDiagnostic?.(diagnostic);
    }
    return diagnostic;
  };

  const cancelScheduledTick = (): void => {
    if (!hasScheduledTick) {
      return;
    }

    options.scheduler.cancel(scheduledHandle);
    scheduledHandle = undefined;
    hasScheduledTick = false;
  };

  const isLiveBinding = (
    version: number,
    observedContainer: NativeSubtitleNode,
  ): boolean =>
    !disposed &&
    version === bindingVersion &&
    observedContainer === container &&
    isCurrentGeneration();

  const scheduleTick = (
    version: number,
    observedContainer: NativeSubtitleNode,
  ): void => {
    if (hasScheduledTick || !isLiveBinding(version, observedContainer)) {
      return;
    }

    hasScheduledTick = true;
    scheduledHandle = options.scheduler.schedule(() => {
      hasScheduledTick = false;
      scheduledHandle = undefined;

      if (!isLiveBinding(version, observedContainer)) {
        return;
      }

      const currentTimeMs = readCurrentTimeMs(options.getCurrentTimeMs);
      const baseTick = {
        sessionId: options.sessionId,
        generation: options.generation,
        sequence: ++sequence,
        visibleText: normalizeVisibleText(readNativeSubtitleText(observedContainer)),
      };

      options.onTick(
        currentTimeMs === undefined
          ? baseTick
          : { ...baseTick, currentTimeMs },
      );
    });
  };

  const bindCurrentContainer = (): Result<
    undefined,
    NativeSubtitleClockError
  > => {
    const nextContainer = findNativeSubtitleContainer(options.document);
    if (nextContainer === container && containerObserver !== undefined) {
      return ok(undefined);
    }

    cancelScheduledTick();
    bindingVersion += 1;
    containerObserver?.disconnect();
    containerObserver = undefined;
    container = nextContainer;

    if (nextContainer === null) {
      return err(emitMissingContainer());
    }

    missingContainerReported = false;

    const version = bindingVersion;
    const observer = options.createObserver(() => {
      scheduleTick(version, nextContainer);
    });
    containerObserver = observer;
    observer.observe(nextContainer, {
      childList: true,
      characterData: true,
      subtree: true,
    });
    scheduleTick(version, nextContainer);
    return ok(undefined);
  };

  return {
    start() {
      if (started || disposed) {
        return ok(undefined);
      }

      started = true;
      rootObserver = options.createObserver(() => {
        if (!disposed && isCurrentGeneration()) {
          bindCurrentContainer();
        }
      });
      rootObserver.observe(options.document.root, {
        childList: true,
        characterData: false,
        subtree: true,
      });

      return bindCurrentContainer();
    },

    dispose() {
      if (disposed) {
        return;
      }

      disposed = true;
      bindingVersion += 1;
      cancelScheduledTick();
      containerObserver?.disconnect();
      rootObserver?.disconnect();
      containerObserver = undefined;
      rootObserver = undefined;
      container = null;
    },
  };
}

function findNativeSubtitleContainer(
  document: NativeSubtitleDocument,
): NativeSubtitleNode | null {
  for (const selector of NATIVE_SUBTITLE_SELECTORS) {
    const candidate = document.querySelector(selector);
    if (candidate !== null) {
      return candidate;
    }
  }

  return null;
}

const TEXT_NODE = 3;
const ELEMENT_NODE = 1;
const BLOCK_ELEMENTS = new Set(['DIV', 'P', 'LI', 'SECTION']);

/**
 * Netflix 用 <br> 和多个文本区域分行；textContent 会把相邻两行直接粘连
 * （"house" + "without" → "housewithout"），导致与字幕文件匹配失败。
 * 这里按行边界插入换行，原字幕被隐藏时同样可读。
 */
export function readNativeSubtitleText(node: NativeSubtitleNode): string {
  if (node.childNodes === undefined) return node.textContent ?? '';
  const parts: string[] = [];
  const visit = (current: NativeSubtitleNode): void => {
    if (current.nodeType === TEXT_NODE) {
      parts.push(current.textContent ?? '');
      return;
    }
    const name = (current.nodeName ?? '').toUpperCase();
    if (name === 'BR') {
      parts.push('\n');
      return;
    }
    if (current.nodeType !== undefined && current.nodeType !== ELEMENT_NODE) return;
    const block = BLOCK_ELEMENTS.has(name);
    if (block) parts.push('\n');
    const children = current.childNodes;
    if (children === undefined) {
      parts.push(current.textContent ?? '');
    } else {
      for (let index = 0; index < children.length; index += 1) {
        const child = children[index];
        if (child !== undefined) visit(child);
      }
    }
    if (block) parts.push('\n');
  };
  visit(node);
  return parts.join('');
}

function normalizeVisibleText(value: string | null): string {
  return (value ?? '').replace(/\s+/gu, ' ').trim();
}

function readCurrentTimeMs(
  getCurrentTimeMs: (() => number | undefined) | undefined,
): number | undefined {
  if (getCurrentTimeMs === undefined) {
    return undefined;
  }

  try {
    const value = getCurrentTimeMs();
    return value !== undefined && Number.isFinite(value) && value >= 0
      ? value
      : undefined;
  } catch {
    return undefined;
  }
}
