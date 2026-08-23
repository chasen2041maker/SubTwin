import { describe, expect, it, vi } from 'vitest';

import type { SubtitleSessionTick } from '../../src/app/session-controller';
import type { NativeSubtitleTick } from '../../src/netflix/native-subtitle-clock';
import {
  createVideoTickSource,
  type VideoTickEventTarget,
  type VideoTickMutationObserver,
} from '../../src/netflix/video-tick-source';

class FakeVideo implements VideoTickEventTarget {
  readonly listeners = new Map<string, Set<() => void>>();
  currentTime = 0;
  paused = true;
  ended = false;

  addEventListener(type: string, listener: () => void): void {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: () => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  emit(type: string): void {
    for (const listener of this.listeners.get(type) ?? []) listener();
  }

  listenerCount(): number {
    return [...this.listeners.values()].reduce(
      (total, listeners) => total + listeners.size,
      0,
    );
  }
}

class FakeObserver implements VideoTickMutationObserver {
  observeCount = 0;
  disconnectCount = 0;

  constructor(readonly callback: () => void) {}

  observe(): void {
    this.observeCount += 1;
  }

  disconnect(): void {
    this.disconnectCount += 1;
  }

  emit(): void {
    this.callback();
  }
}

function createHarness() {
  let video: FakeVideo | null = new FakeVideo();
  let observer: FakeObserver | undefined;
  let now = 0;
  let nextFrame = 0;
  const frames = new Map<number, () => void>();
  const cancelled: number[] = [];
  const onVideoRemount = vi.fn();

  const source = createVideoTickSource({
    document: {
      root: {},
      querySelector: () => video,
    },
    createObserver: (callback) => {
      observer = new FakeObserver(callback);
      return observer;
    },
    requestAnimationFrame: (callback) => {
      const handle = ++nextFrame;
      frames.set(handle, callback);
      return handle;
    },
    cancelAnimationFrame: (handle) => {
      const frame = Number(handle);
      cancelled.push(frame);
      frames.delete(frame);
    },
    now: () => now,
    onVideoRemount,
  });

  return {
    source,
    onVideoRemount,
    cancelled,
    get observer() {
      return observer;
    },
    get video() {
      return video;
    },
    setVideo(next: FakeVideo | null) {
      video = next;
    },
    setNow(next: number) {
      now = next;
    },
    runNextFrame() {
      const entry = frames.entries().next().value as
        | [number, () => void]
        | undefined;
      if (entry === undefined) throw new Error('No animation frame queued.');
      frames.delete(entry[0]);
      entry[1]();
    },
    queuedFrameCount() {
      return frames.size;
    },
  };
}

describe('createVideoTickSource', () => {
  it('starts once for the first subscriber and converts finite video seconds to milliseconds', () => {
    const harness = createHarness();
    const first: SubtitleSessionTick[] = [];
    const second: SubtitleSessionTick[] = [];
    harness.video!.currentTime = 1.25;

    expect(harness.source.currentTimeMs()).toBe(1_250);

    const unsubscribeFirst = harness.source.subscribe((tick) => first.push(tick));
    const unsubscribeSecond = harness.source.subscribe((tick) => second.push(tick));

    expect(harness.observer?.observeCount).toBe(1);
    expect(harness.video!.listenerCount()).toBe(7);
    expect(harness.source.currentTimeMs()).toBe(1_250);

    harness.video!.emit('timeupdate');
    expect(first).toEqual([{ currentTimeMs: 1_250 }]);
    expect(second).toEqual([{ currentTimeMs: 1_250 }]);

    unsubscribeFirst();
    unsubscribeSecond();
    expect(harness.video!.listenerCount()).toBe(0);
    expect(harness.observer?.disconnectCount).toBe(1);
  });

  it('emits seeking ticks immediately and ignores unsafe video times', () => {
    const harness = createHarness();
    const ticks: SubtitleSessionTick[] = [];
    harness.source.subscribe((tick) => ticks.push(tick));

    harness.video!.currentTime = 8.75;
    harness.video!.emit('seeking');
    harness.video!.currentTime = Number.NaN;
    harness.video!.emit('seeked');
    harness.video!.currentTime = -1;
    harness.video!.emit('timeupdate');

    expect(ticks).toEqual([{ currentTimeMs: 8_750 }]);
    expect(harness.source.currentTimeMs()).toBeUndefined();
  });

  it('uses a single throttled animation-frame fallback only while playing', () => {
    const harness = createHarness();
    const ticks: SubtitleSessionTick[] = [];
    harness.source.subscribe((tick) => ticks.push(tick));
    harness.video!.currentTime = 2;
    harness.video!.paused = false;

    harness.video!.emit('playing');
    expect(ticks).toEqual([{ currentTimeMs: 2_000 }]);
    expect(harness.queuedFrameCount()).toBe(1);

    harness.setNow(100);
    harness.video!.currentTime = 2.1;
    harness.runNextFrame();
    expect(ticks).toHaveLength(1);
    expect(harness.queuedFrameCount()).toBe(1);

    harness.setNow(170);
    harness.video!.currentTime = 2.17;
    harness.runNextFrame();
    expect(ticks.at(-1)).toEqual({ currentTimeMs: 2_170 });
    expect(harness.queuedFrameCount()).toBe(1);

    harness.video!.paused = true;
    harness.video!.emit('pause');
    expect(ticks.at(-1)).toEqual({ currentTimeMs: 2_170 });
    expect(harness.queuedFrameCount()).toBe(0);
  });

  it('passes native subtitle ticks through unchanged and gives them priority over fallback', () => {
    const harness = createHarness();
    const ticks: SubtitleSessionTick[] = [];
    harness.source.subscribe((tick) => ticks.push(tick));
    harness.video!.paused = false;
    harness.video!.currentTime = 4;
    harness.video!.emit('play');
    ticks.length = 0;

    const nativeTick: NativeSubtitleTick = {
      sessionId: 'session-a',
      generation: 3,
      sequence: 9,
      visibleText: 'Hello',
      currentTimeMs: 4_020,
    };
    harness.setNow(100);
    harness.source.emitNative(nativeTick);
    expect(ticks).toEqual([nativeTick]);
    expect(ticks[0]).toBe(nativeTick);

    harness.setNow(200);
    harness.runNextFrame();
    expect(ticks).toEqual([nativeTick]);
    harness.setNow(270);
    harness.runNextFrame();
    expect(ticks.at(-1)).toEqual({ currentTimeMs: 4_000 });
  });

  it('rebinds a replaced video exactly once without retaining old listeners', () => {
    const harness = createHarness();
    const ticks: SubtitleSessionTick[] = [];
    harness.source.subscribe((tick) => ticks.push(tick));
    const oldVideo = harness.video!;
    const nextVideo = new FakeVideo();
    nextVideo.currentTime = 12;

    harness.setVideo(nextVideo);
    harness.observer!.emit();
    harness.observer!.emit();

    expect(oldVideo.listenerCount()).toBe(0);
    expect(nextVideo.listenerCount()).toBe(7);
    expect(harness.onVideoRemount).toHaveBeenCalledTimes(1);
    oldVideo.emit('timeupdate');
    nextVideo.emit('timeupdate');
    expect(ticks).toEqual([{ currentTimeMs: 12_000 }]);
  });

  it('is fail-safe around host exceptions and dispose is idempotent', () => {
    const observer = new FakeObserver(() => undefined);
    const source = createVideoTickSource({
      document: {
        root: {},
        querySelector: () => {
          throw new Error('Netflix DOM is changing');
        },
      },
      createObserver: () => observer,
      requestAnimationFrame: () => {
        throw new Error('frame unavailable');
      },
      cancelAnimationFrame: () => {
        throw new Error('frame already gone');
      },
      now: () => {
        throw new Error('clock unavailable');
      },
    });

    expect(() => source.subscribe(() => undefined)).not.toThrow();
    expect(source.currentTimeMs()).toBeUndefined();
    expect(() => source.emitNative({
      sessionId: 'session',
      generation: 1,
      sequence: 1,
      visibleText: 'safe',
    })).not.toThrow();
    expect(() => {
      source.dispose();
      source.dispose();
    }).not.toThrow();
    expect(observer.disconnectCount).toBe(1);
  });

  it('disconnects an observer whose observe call fails', () => {
    const video = new FakeVideo();
    const observer = {
      disconnectCount: 0,
      observe() {
        throw new Error('detached root');
      },
      disconnect() {
        this.disconnectCount += 1;
      },
    };
    const source = createVideoTickSource({
      document: { root: {}, querySelector: () => video },
      createObserver: () => observer,
      requestAnimationFrame: () => 1,
      cancelAnimationFrame: () => undefined,
      now: () => 0,
    });

    source.subscribe(() => undefined);

    expect(observer.disconnectCount).toBe(1);
    source.dispose();
  });
});
