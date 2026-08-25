import type {
  SubtitleSessionTick,
  SubtitleSessionTickSource,
} from '../app/session-controller';
import type { NativeSubtitleTick } from './native-subtitle-clock';

const VIDEO_SELECTOR = 'video';
const FALLBACK_INTERVAL_MS = 160;
const VIDEO_EVENTS = [
  'timeupdate',
  'seeking',
  'seeked',
  'play',
  'playing',
  'pause',
  'ended',
] as const;

type VideoTickEvent = (typeof VIDEO_EVENTS)[number];

export interface VideoTickEventTarget {
  readonly currentTime: number;
  readonly paused?: boolean;
  readonly ended?: boolean;
  addEventListener(type: VideoTickEvent, listener: () => void): void;
  removeEventListener(type: VideoTickEvent, listener: () => void): void;
}

export interface VideoTickDocument {
  readonly root: unknown;
  querySelector(selector: typeof VIDEO_SELECTOR): VideoTickEventTarget | null;
}

export interface VideoTickMutationObserver {
  observe(
    target: unknown,
    options: {
      readonly childList: boolean;
      readonly subtree: boolean;
    },
  ): void;
  disconnect(): void;
}

export interface VideoTickSourceOptions {
  readonly document: VideoTickDocument;
  readonly createObserver: (
    callback: () => void,
  ) => VideoTickMutationObserver;
  readonly requestAnimationFrame: (callback: () => void) => unknown;
  readonly cancelAnimationFrame: (handle: unknown) => void;
  readonly now: () => number;
  readonly onVideoRemount?: () => void;
}

export interface VideoTickSource extends SubtitleSessionTickSource {
  emitNative(tick: NativeSubtitleTick): void;
  dispose(): void;
}

/**
 * Combines Netflix's subtitle-mutation clock with a conservative video clock.
 * Native subtitle mutations are delivered verbatim; video events and the
 * throttled animation-frame loop only keep cue selection moving between them.
 */
export function createVideoTickSource(
  options: VideoTickSourceOptions,
): VideoTickSource {
  const listeners = new Set<(tick: SubtitleSessionTick) => void>();
  let disposed = false;
  let started = false;
  let observer: VideoTickMutationObserver | undefined;
  let video: VideoTickEventTarget | null = null;
  let hasBoundVideo = false;
  let playing = false;
  let framePending = false;
  let frameHandle: unknown;
  let lastClockEmissionMs: number | undefined;
  let lastNativeVisibleText: string | undefined;

  const safeNow = (): number | undefined => {
    try {
      const value = options.now();
      return Number.isFinite(value) ? value : undefined;
    } catch {
      return undefined;
    }
  };

  const currentTimeMs = (): number | undefined => {
    let currentVideo = video;
    if (currentVideo === null && !disposed) {
      try {
        currentVideo = options.document.querySelector(VIDEO_SELECTOR);
      } catch {
        return undefined;
      }
    }
    if (currentVideo === null) return undefined;

    try {
      const seconds = currentVideo.currentTime;
      if (
        !Number.isFinite(seconds) ||
        seconds < 0 ||
        seconds > Number.MAX_SAFE_INTEGER / 1_000
      ) {
        return undefined;
      }

      const milliseconds = Math.round(seconds * 1_000);
      return Number.isSafeInteger(milliseconds) ? milliseconds : undefined;
    } catch {
      return undefined;
    }
  };

  const emit = (tick: SubtitleSessionTick): void => {
    if (disposed) return;
    for (const listener of [...listeners]) {
      try {
        listener(tick);
      } catch {
        // A consumer must not break the Netflix player or other consumers.
      }
    }
  };

  const markClockEmission = (): void => {
    const timestamp = safeNow();
    if (timestamp !== undefined) lastClockEmissionMs = timestamp;
  };

  const emitCurrentTime = (): void => {
    const value = currentTimeMs();
    if (value === undefined) return;
    markClockEmission();
    emit(lastNativeVisibleText === undefined
      ? { currentTimeMs: value }
      : { visibleText: lastNativeVisibleText, currentTimeMs: value });
  };

  const cancelFrame = (): void => {
    if (!framePending) return;
    framePending = false;
    const handle = frameHandle;
    frameHandle = undefined;
    try {
      options.cancelAnimationFrame(handle);
    } catch {
      // The page may have invalidated the animation frame during a remount.
    }
  };

  const runFallback = (): void => {
    const timestamp = safeNow();
    if (
      timestamp !== undefined &&
      lastClockEmissionMs !== undefined &&
      timestamp - lastClockEmissionMs < FALLBACK_INTERVAL_MS
    ) {
      return;
    }
    emitCurrentTime();
  };

  const scheduleFrame = (): void => {
    if (disposed || !started || !playing || framePending) return;

    framePending = true;
    try {
      frameHandle = options.requestAnimationFrame(() => {
        framePending = false;
        frameHandle = undefined;
        if (disposed || !started || !playing) return;
        runFallback();
        scheduleFrame();
      });
    } catch {
      framePending = false;
      frameHandle = undefined;
    }
  };

  const startPlayback = (): void => {
    if (!playing) {
      playing = true;
      emitCurrentTime();
    }
    scheduleFrame();
  };

  const stopPlayback = (): void => {
    playing = false;
    cancelFrame();
    emitCurrentTime();
  };

  const eventListeners: Record<VideoTickEvent, () => void> = {
    timeupdate: emitCurrentTime,
    seeking: emitCurrentTime,
    seeked: emitCurrentTime,
    play: startPlayback,
    playing: startPlayback,
    pause: stopPlayback,
    ended: stopPlayback,
  };

  const unbindVideo = (): void => {
    cancelFrame();
    playing = false;
    const boundVideo = video;
    video = null;
    if (boundVideo === null) return;

    for (const event of VIDEO_EVENTS) {
      try {
        boundVideo.removeEventListener(event, eventListeners[event]);
      } catch {
        // Continue removing the remaining listeners when Netflix swaps nodes.
      }
    }
  };

  const bindVideo = (nextVideo: VideoTickEventTarget): void => {
    video = nextVideo;
    for (const event of VIDEO_EVENTS) {
      try {
        nextVideo.addEventListener(event, eventListeners[event]);
      } catch {
        // A partially mounted player is recoverable on the next root mutation.
      }
    }

    try {
      playing = nextVideo.paused === false && nextVideo.ended !== true;
    } catch {
      playing = false;
    }
    if (playing) scheduleFrame();
  };

  const refreshVideoBinding = (): void => {
    let nextVideo: VideoTickEventTarget | null;
    try {
      nextVideo = options.document.querySelector(VIDEO_SELECTOR);
    } catch {
      return;
    }
    if (nextVideo === video) return;

    const isRemount = hasBoundVideo && nextVideo !== null;
    unbindVideo();
    if (nextVideo === null) return;

    bindVideo(nextVideo);
    if (isRemount) {
      try {
        options.onVideoRemount?.();
      } catch {
        // Lifecycle notification is advisory and must remain fail-safe.
      }
    }
    hasBoundVideo = true;
  };

  const start = (): void => {
    if (disposed || started) return;
    started = true;
    refreshVideoBinding();

    try {
      const nextObserver = options.createObserver(refreshVideoBinding);
      observer = nextObserver;
      nextObserver.observe(options.document.root, {
        childList: true,
        subtree: true,
      });
    } catch {
      try {
        observer?.disconnect();
      } catch {
        // Nothing else to release.
      }
      observer = undefined;
    }
  };

  const stop = (): void => {
    if (!started) return;
    started = false;
    try {
      observer?.disconnect();
    } catch {
      // The document can disappear while an extension context is unloading.
    }
    observer = undefined;
    unbindVideo();
    hasBoundVideo = false;
    lastClockEmissionMs = undefined;
    lastNativeVisibleText = undefined;
  };

  return {
    currentTimeMs,
    subscribe(listener) {
      if (disposed) return () => undefined;
      listeners.add(listener);
      if (listeners.size === 1) start();

      let subscribed = true;
      return () => {
        if (!subscribed) return;
        subscribed = false;
        listeners.delete(listener);
        if (listeners.size === 0) stop();
      };
    },
    emitNative(tick) {
      if (disposed) return;
      lastNativeVisibleText = tick.visibleText;
      markClockEmission();
      emit(tick);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      listeners.clear();
      stop();
    },
  };
}
