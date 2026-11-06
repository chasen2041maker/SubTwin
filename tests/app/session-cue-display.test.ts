import { afterEach, describe, expect, it, vi } from 'vitest';

import { CUE_TRANSLATION_WAIT_MS } from '../../src/app/cue-display-policy';
import type { LanguageRoute } from '../../src/app/language-router';
import {
  createSubtitleSessionController,
  type SubtitleSessionController,
  type TranslationTaskCallbacks,
} from '../../src/app/session-controller';
import { DEFAULT_SETTINGS } from '../../src/storage/schema';
import type { SubtitleTrack } from '../../src/subtitles/types';
import type { ScheduledTranslationTask } from '../../src/translation/scheduler';

const WAIT_MS = CUE_TRANSLATION_WAIT_MS;
const ROUTE: LanguageRoute = {
  mode: 'deepseek', provider: 'deepseek', externalCallsAllowed: true,
  schedulingScope: 'urgent-window', sourceMode: 'external-translation',
};
const TRACK: SubtitleTrack = {
  id: 'english', format: 'webvtt', language: { tag: 'en', kind: 'subtitles' },
  cues: [
    { id: 'first', startMs: 0, endMs: 5_000, text: 'First line' },
    { id: 'second', startMs: 5_000, endMs: 10_000, text: 'Second line' },
  ],
};
const controllers: SubtitleSessionController[] = [];

afterEach(() => {
  for (const controller of controllers.splice(0)) controller.dispose();
  vi.useRealTimers();
});

function harness(options: {
  wait?: boolean; route?: LanguageRoute; chineseVisible?: boolean; live?: boolean;
  subscribeFailureThrows?: boolean; unsubscribeFailureThrows?: boolean; failWhileWaiting?: boolean;
} = {}) {
  vi.useFakeTimers();
  const render = vi.fn(() => true);
  const clear = vi.fn();
  const failureListeners = new Set<() => void>();
  const failRender = (): void => { for (const listener of failureListeners) listener(); };
  const waitForTranslation = vi.fn(() => { if (options.failWhileWaiting) failRender(); });
  const unsubscribeFailure = vi.fn(() => {
    if (options.unsubscribeFailureThrows) throw new Error('Synthetic unsubscribe failure');
    failureListeners.clear();
  });
  const subscribeRenderFailure = vi.fn((listener: () => void) => {
    if (options.subscribeFailureThrows) throw new Error('Synthetic subscribe failure');
    failureListeners.add(listener);
    return unsubscribeFailure;
  });
  const scheduled: Array<{ task: ScheduledTranslationTask; callbacks: TranslationTaskCallbacks }> = [];
  const appearance = {
    ...DEFAULT_SETTINGS.appearance,
    chinese: { ...DEFAULT_SETTINGS.appearance.chinese, visible: options.chineseVisible ?? true },
  };
  const controller = createSubtitleSessionController({
    sessionId: 'session', episodeId: 'episode', trackHash: 'hash', episodeGeneration: 1,
    enabled: true, englishTrack: options.live ? null : TRACK,
    route: options.route ?? ROUTE, appearance,
    tickSource: { currentTimeMs: () => 1_000, subscribe: () => () => undefined },
    taskClient: {
      enqueue(task, callbacks) { scheduled.push({ task, callbacks }); },
      cancel() {},
    },
    overlay: { render, clear, subscribeRenderFailure, ...(options.wait === false ? {} : { waitForTranslation }) },
    status: { publish() {} },
  });
  controllers.push(controller);
  return {
    controller, render, clear, waitForTranslation, scheduled, appearance,
    failRender, failureListeners, unsubscribeFailure,
    result(cueId = 'first', text = '测试译文') {
      const entry = scheduled.find(({ task }) => task.cues.some(({ id }) => id === cueId));
      if (entry === undefined) throw new Error(`Missing task for ${cueId}`);
      entry.callbacks.onResult({ translations: [{ cueId, text }], retryCueIds: [] });
    },
  };
}

describe('bounded atomic bilingual cue display', () => {
  it('waits without exposing English before an on-time bilingual result', () => {
    const h = harness();
    expect(h.waitForTranslation).toHaveBeenCalledOnce();
    expect(h.render).not.toHaveBeenCalled();
    expect(h.clear).not.toHaveBeenCalled();
    vi.advanceTimersByTime(WAIT_MS - 1);
    h.result();
    expect(h.render).toHaveBeenLastCalledWith({ english: 'First line', chinese: '测试译文' }, h.appearance);
    vi.advanceTimersByTime(1);
    expect(h.clear).not.toHaveBeenCalled();
  });

  it('falls back once at the deadline, then upgrades the same cue when its late result lands', () => {
    const h = harness();
    vi.advanceTimersByTime(WAIT_MS);
    expect(h.clear).toHaveBeenCalledOnce();
    expect(h.render).not.toHaveBeenCalled();
    h.result();
    expect(h.render).toHaveBeenCalledOnce();
    expect(h.render).toHaveBeenLastCalledWith({ english: 'First line', chinese: '测试译文' }, h.appearance);
    h.controller.tick({ currentTimeMs: 1_100 });
    vi.advanceTimersByTime(WAIT_MS);
    expect(h.render).toHaveBeenCalledOnce();
    expect(h.clear).toHaveBeenCalledOnce();
  });

  it('locks a failed cue to native while allowing a late result to warm replay', () => {
    const h = harness();
    h.scheduled[0]?.callbacks.onError({ code: 'timeout', retryable: true, message: 'Synthetic timeout' });
    expect(h.clear).toHaveBeenCalledOnce();
    h.result();
    expect(h.render).not.toHaveBeenCalled();
    h.controller.seek(1_000);
    expect(h.render).toHaveBeenCalledOnce();
  });

  it('keeps a late bilingual upgrade through a real seek tick within the same cue', () => {
    const h = harness();
    vi.advanceTimersByTime(WAIT_MS);
    h.result();
    expect(h.render).toHaveBeenLastCalledWith({ english: 'First line', chinese: '测试译文' }, h.appearance);

    h.controller.tick({ seeking: true, currentTimeMs: 1_000 });
    const clears = h.clear.mock.calls.length;
    vi.advanceTimersByTime(WAIT_MS);
    expect(h.clear).toHaveBeenCalledTimes(clears);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    ['seek API', (c: SubtitleSessionController) => c.seek(10_500)],
    ['seeking tick', (c: SubtitleSessionController) => c.tick({ seeking: true, currentTimeMs: 10_500 })],
  ] as const)('immediately restores native when %s leaves a pending cue for a subtitle gap', (_name, seek) => {
    const h = harness();
    expect(h.waitForTranslation).toHaveBeenCalledOnce();
    seek(h.controller);
    expect(h.clear).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    h.controller.tick({ visibleText: '', currentTimeMs: 10_600 });
    h.result();
    vi.advanceTimersByTime(WAIT_MS);
    expect(h.clear).toHaveBeenCalledOnce();
    expect(h.waitForTranslation).toHaveBeenCalledOnce();
    expect(h.render).not.toHaveBeenCalled();
  });

  it('restores native after a failed atomic render and does not retry halfway through the cue', () => {
    const h = harness();
    h.render.mockReturnValue(false);
    h.result();
    expect(h.clear).toHaveBeenCalledOnce();
    h.render.mockReturnValue(true);
    h.result('first', '迟到修订');
    expect(h.render).toHaveBeenCalledOnce();
  });

  it('keeps a terminal provider failure on native instead of rendering English alone', () => {
    const h = harness();
    h.scheduled[0]?.callbacks.onError({ code: 'authentication_failed', retryable: false, message: 'Synthetic failure' });
    h.controller.tick({ currentTimeMs: 1_000 });
    expect(h.render).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('locks an asynchronous renderer failure through revisions and appearance changes until the next cue', () => {
    const h = harness();
    h.result();
    h.failRender();
    expect(h.clear).toHaveBeenCalledOnce();
    h.result('first', '迟到修订');
    h.controller.updateAppearance({ ...h.appearance, lineSpacingPx: 8 });
    expect(h.render).toHaveBeenCalledOnce();
    h.controller.tick({ visibleText: 'Second line', currentTimeMs: 5_100 });
    h.result('second');
    expect(h.render).toHaveBeenCalledTimes(2);
    expect(h.render).toHaveBeenLastCalledWith({ english: 'Second line', chinese: '测试译文' }, expect.anything());
  });

  it('cancels a wait immediately when mounting its waiting surface fails', () => {
    const h = harness({ failWhileWaiting: true });
    expect(h.clear).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    h.result();
    expect(h.render).not.toHaveBeenCalled();
  });

  it('unsubscribes renderer failures on dispose and ignores subsequent notifications', () => {
    const h = harness();
    expect(h.failureListeners.size).toBe(1);
    h.controller.dispose();
    expect(h.unsubscribeFailure).toHaveBeenCalledOnce();
    expect(h.failureListeners.size).toBe(0);
    const clears = h.clear.mock.calls.length;
    h.failRender();
    expect(h.clear).toHaveBeenCalledTimes(clears);
  });

  it('contains renderer failure subscription and cleanup exceptions', () => {
    const unavailable = harness({ subscribeFailureThrows: true });
    unavailable.result();
    expect(unavailable.render).toHaveBeenCalledOnce();
    const unremovable = harness({ unsubscribeFailureThrows: true });
    expect(() => unremovable.controller.dispose()).not.toThrow();
    const clears = unremovable.clear.mock.calls.length;
    unremovable.failRender();
    expect(unremovable.clear).toHaveBeenCalledTimes(clears);
  });

  it('cancels the previous cue deadline before waiting for the next cue', () => {
    const h = harness();
    vi.advanceTimersByTime(WAIT_MS - 100);
    h.controller.tick({ visibleText: 'Second line', currentTimeMs: 5_100 });
    const clears = h.clear.mock.calls.length;
    vi.advanceTimersByTime(200);
    expect(h.clear).toHaveBeenCalledTimes(clears);
    h.result('second');
    vi.advanceTimersByTime(WAIT_MS);
    expect(h.clear).toHaveBeenCalledTimes(clears);
    expect(h.render).toHaveBeenLastCalledWith({ english: 'Second line', chinese: '测试译文' }, h.appearance);
  });

  it.each([
    ['seek', (c: SubtitleSessionController) => c.seek(1_000)],
    ['provider change', (c: SubtitleSessionController) => c.updateRoute({ ...ROUTE, mode: 'google-free', provider: 'google-free' })],
    ['configuration', (c: SubtitleSessionController) => c.refreshProviderConfiguration()],
    ['disable', (c: SubtitleSessionController) => c.setEnabled(false)],
    ['remount', (c: SubtitleSessionController) => c.playerRemounted('next-session')],
    ['tracks', (c: SubtitleSessionController) => c.updateTracks({ englishTrack: { ...TRACK }, officialChineseTrack: null })],
    ['episode', (c: SubtitleSessionController) => c.changeEpisode({
      sessionId: 'next-session', episodeId: 'next-episode', trackHash: 'next-hash', englishTrack: TRACK, route: ROUTE,
    })],
    ['dispose', (c: SubtitleSessionController) => c.dispose()],
  ] as const)('revokes the old deadline on %s', (_name, operation) => {
    const h = harness();
    vi.advanceTimersByTime(WAIT_MS - 100);
    operation(h.controller);
    const clears = h.clear.mock.calls.length;
    vi.advanceTimersByTime(200);
    expect(h.clear).toHaveBeenCalledTimes(clears);
  });

  it('renders English-only immediately and cancels an existing bilingual wait', () => {
    const h = harness({ chineseVisible: false });
    expect(h.waitForTranslation).not.toHaveBeenCalled();
    expect(h.render).toHaveBeenLastCalledWith({ english: 'First line', chinese: null }, h.appearance);
    const bilingual = { ...h.appearance, chinese: { ...h.appearance.chinese, visible: true } };
    h.controller.updateAppearance(bilingual);
    expect(h.waitForTranslation).toHaveBeenCalledOnce();
    h.controller.updateAppearance(h.appearance);
    const clears = h.clear.mock.calls.length;
    vi.advanceTimersByTime(WAIT_MS);
    expect(h.clear).toHaveBeenCalledTimes(clears);
  });

  it('does not start waiting for official alignment gaps or legacy sinks', () => {
    const legacy = harness({ wait: false });
    const official = harness({ route: {
      mode: 'official', provider: null, externalCallsAllowed: false,
      schedulingScope: 'none', sourceMode: 'official-alignment',
    } });
    expect(legacy.waitForTranslation).not.toHaveBeenCalled();
    expect(official.waitForTranslation).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    legacy.result();
    expect(legacy.render).toHaveBeenCalledOnce();
  });

  it('clears an explicit native gap without reviving a live cue on time-only ticks', () => {
    const h = harness({ live: true });
    h.controller.appendEnglishCue('live', { id: 'live', startMs: 750, endMs: 7_000, text: 'Live line' });
    h.controller.tick({ visibleText: 'Live line', currentTimeMs: 1_000 });
    h.result('live');
    expect(h.render).toHaveBeenCalledOnce();
    h.controller.tick({ visibleText: '', currentTimeMs: 1_100 });
    const clears = h.clear.mock.calls.length;
    expect(clears).toBeGreaterThan(0);
    h.controller.tick({ currentTimeMs: 1_200 });
    h.result('live', '迟到修订');
    expect(h.render).toHaveBeenCalledOnce();
    expect(h.clear).toHaveBeenCalledTimes(clears);
  });

  it('revokes pending waits on a native gap and ignores their late result', () => {
    const h = harness();
    h.controller.tick({ visibleText: 'First line', currentTimeMs: 1_000 });
    h.controller.tick({ visibleText: '', currentTimeMs: 1_100 });
    const clears = h.clear.mock.calls.length;
    vi.advanceTimersByTime(WAIT_MS);
    h.result();
    expect(h.clear).toHaveBeenCalledTimes(clears);
    expect(h.render).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
