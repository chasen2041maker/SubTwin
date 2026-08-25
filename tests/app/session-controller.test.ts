import { describe, expect, it, vi } from 'vitest';

import type { LanguageRoute } from '../../src/app/language-router';
import {
  createSubtitleSessionController,
  type ProviderNeutralTaskClient,
  type SessionCancellationReason,
  type SessionOverlaySink,
  type SessionStatusSink,
  type SubtitleSessionTick,
  type SubtitleSessionTickSource,
  type TranslationTaskCallbacks,
} from '../../src/app/session-controller';
import type { RuntimeErrorCode } from '../../src/app/status';
import type { NormalizedActiveCueState } from '../../src/renderer/SubtitleOverlay';
import { DEFAULT_SETTINGS } from '../../src/storage/schema';
import type { SubtitleCue, SubtitleTrack } from '../../src/subtitles/types';
import type {
  ScheduledTranslationTask,
  SchedulerGeneration,
} from '../../src/translation/scheduler';
import type {
  TranslationBatch,
  TranslationError,
} from '../../src/translation/types';

const APPEARANCE = DEFAULT_SETTINGS.appearance;

describe('subtitle session controller', () => {
  it('aligns official tracks on native ticks and never schedules a provider', () => {
    const harness = createHarness({
      englishTrack: track('english', 'en', [
        cue('en-1', 0, 1_000, 'One'),
        cue('en-2', 1_000, 2_000, 'Two'),
      ]),
      officialChineseTrack: track('chinese', 'zh-Hans', [
        cue('zh-1', 0, 1_100, '一'),
        cue('zh-2', 1_100, 2_000, '二'),
      ]),
      route: route('official'),
    });

    harness.controller.tick({ visibleText: 'Two', currentTimeMs: 100 });

    expect(harness.tasks.scheduled).toHaveLength(0);
    expect(harness.overlay.lastState()).toEqual({
      english: 'Two',
      chinese: '一\n二',
    });
    expect(harness.status.last()).toEqual({ mode: 'official' });
  });

  it('uses an explicitly selected external provider even when an official Chinese track exists', () => {
    const harness = createHarness({
      englishTrack: numberedTrack(6),
      officialChineseTrack: numberedTrack(6, 'zh-Hans', '官方中文'),
      route: route('google-free', 'bulk'),
      currentTimeMs: 100,
    });

    expect(harness.tasks.scheduled.length).toBeGreaterThan(0);
    expect(harness.tasks.scheduled.every(({ task }) => task.provider === 'google-free'))
      .toBe(true);
    expect(harness.status.last()).toEqual({ mode: 'google-free' });
  });

  it('schedules a live native English cue when a downloadable track is unavailable', () => {
    const harness = createHarness({
      englishTrack: null,
      route: route('google-free', 'urgent-window'),
      currentTimeMs: 500,
    });

    harness.controller.appendEnglishCue('native-en', cue(
      'native-live-1',
      0,
      4_000,
      'Translate the visible Netflix subtitle',
    ));
    harness.controller.tick({
      visibleText: 'Translate the visible Netflix subtitle',
      currentTimeMs: 500,
    });

    expect(harness.tasks.scheduled.some(({ task }) =>
      task.provider === 'google-free' &&
      task.cues.some(({ id }) => id === 'native-live-1'))).toBe(true);
  });

  it('reveals provider subtitles only when English and Chinese can appear together', () => {
    const harness = createHarness({
      route: route('deepseek', 'urgent-window'),
      currentTimeMs: 100,
    });
    const pending = harness.tasks.find('deepseek', 'cue-0');

    expect(harness.overlay.states).toHaveLength(0);

    pending.callbacks.onResult(batch('cue-0', '整句中文'));

    expect(harness.overlay.lastState()).toEqual({
      english: 'Line 0',
      chinese: '整句中文',
    });
  });

  it('preserves Netflix native subtitles until an official Chinese body can align', () => {
    const harness = createHarness({
      englishTrack: numberedTrack(3),
      officialChineseTrack: track('official-zh', 'zh-Hans', []),
      route: route('official'),
      currentTimeMs: 100,
    });

    expect(harness.tasks.scheduled).toHaveLength(0);
    expect(harness.overlay.states).toHaveLength(0);
    expect(harness.overlay.clearCount).toBeGreaterThan(0);
  });

  it.each([
    route('discovering'),
    route('provider-unset'),
    route('missing-key'),
    route('disabled'),
  ])('keeps %s route provider-free', (decision) => {
    const harness = createHarness({ route: decision });
    harness.controller.tick({ currentTimeMs: 100 });

    expect(harness.tasks.scheduled).toHaveLength(0);
  });

  it('rejects an internally inconsistent route instead of crossing providers', () => {
    const decision: LanguageRoute = {
      ...route('deepseek', 'bulk'),
      provider: 'google-free',
    };
    const harness = createHarness({ route: decision, currentTimeMs: 100 });

    expect(harness.tasks.scheduled).toHaveLength(0);
  });

  it('queues the initial playback neighborhood before bulk warming', () => {
    const englishTrack = numberedTrack(30);
    const harness = createHarness({
      englishTrack,
      route: route('deepseek', 'bulk'),
      currentTimeMs: 5_100,
    });

    expect(harness.tasks.scheduled.length).toBeGreaterThan(1);
    const first = harness.tasks.scheduled[0]?.task;
    expect(first?.provider).toBe('deepseek');
    expect(first?.priority).toBe('urgent');
    expect(first?.cues[0]?.id).toBe('cue-5');
    expect(harness.tasks.scheduled.some(({ task }) => task.priority === 'bulk')).toBe(true);
    expect(first?.episodeGeneration).toBe(7);
    expect(first?.providerGeneration).toBe(1);
  });

  it('renders cache and provider results only while their generations are current', () => {
    const harness = createHarness({
      route: route('deepseek', 'bulk'),
      currentTimeMs: 100,
    });
    const deepseek = harness.tasks.find('deepseek', 'cue-0');

    deepseek.callbacks.onCache(batch('cue-0', '缓存'));
    expect(harness.overlay.lastState()).toEqual({ english: 'Line 0', chinese: '缓存' });

    const countBeforeSwitch = harness.tasks.scheduled.length;
    harness.controller.updateRoute(route('google-free', 'bulk'));
    expect(deepseek.callbacks.isCurrent()).toBe(false);
    deepseek.callbacks.onResult(batch('cue-0', '过期'));

    expect(harness.overlay.states).not.toContainEqual({
      english: 'Line 0',
      chinese: '过期',
    });
    expect(harness.tasks.cancelled).toContainEqual({
      generation: {
        episodeGeneration: 7,
        providerGeneration: 1,
      },
      reason: 'provider-change',
    });
    expect(harness.tasks.scheduled.slice(countBeforeSwitch).every(
      ({ task }) => task.provider !== 'deepseek',
    )).toBe(true);
  });

  it('keeps an explicitly selected provider when an official track appears late', () => {
    const harness = createHarness({
      route: route('deepseek', 'bulk'),
      currentTimeMs: 100,
    });
    const pending = harness.tasks.find('deepseek', 'cue-0');
    pending.callbacks.onResult(batch('cue-0', '外部翻译'));
    const renderedBeforeOfficialTrack = harness.overlay.states.length;

    harness.controller.updateTracks({
      englishTrack: numberedTrack(6),
      officialChineseTrack: track('official-zh', 'zh-Hans', [
        cue('zh-0', 0, 1_000, '官方中文'),
      ]),
    });

    expect(pending.callbacks.isCurrent()).toBe(false);
    expect(harness.overlay.clearCount).toBeGreaterThan(0);
    expect(harness.overlay.states).toHaveLength(renderedBeforeOfficialTrack);
    expect(harness.overlay.lastState()).toEqual({
      english: 'Line 0',
      chinese: '外部翻译',
    });
    expect(harness.tasks.scheduled.some(
      ({ task }) => task !== pending.task && task.provider === 'deepseek',
    )).toBe(true);
    expect(harness.status.last()).toEqual({ mode: 'deepseek' });
    pending.callbacks.onResult(batch('cue-0', '过期外部文本'));
    expect(harness.overlay.states).not.toContainEqual({
      english: 'Line 0',
      chinese: '过期外部文本',
    });
  });

  it('updates the source track hash before scheduling a newly parsed track', () => {
    const harness = createHarness({
      englishTrack: null,
      route: route('deepseek', 'bulk'),
    });

    harness.controller.updateTracks({
      englishTrack: numberedTrack(4),
      officialChineseTrack: null,
      trackHash: 'track-hash-new-body',
    });

    expect(harness.tasks.scheduled.length).toBeGreaterThan(0);
    expect(harness.tasks.scheduled.every(
      ({ task }) => task.trackHash === 'track-hash-new-body',
    )).toBe(true);
  });

  it('prefers native visible-text ticks and falls back to binary-searched time', () => {
    const harness = createHarness({
      englishTrack: numberedTrack(6),
      officialChineseTrack: numberedTrack(6, 'zh-Hans', '中文'),
      route: route('official'),
    });

    harness.controller.tick({ visibleText: 'Line 4', currentTimeMs: 100 });
    expect(harness.overlay.lastState()?.english).toBe('Line 4');

    harness.controller.tick({ visibleText: 'unrelated native text', currentTimeMs: 2_100 });
    expect(harness.overlay.lastState()?.english).toBe('Line 2');
  });

  it('uses tick time to disambiguate repeated native subtitle text', () => {
    const englishTrack = track('repeated-en', 'en', [
      cue('first', 0, 1_000, 'Again'),
      cue('middle', 1_000, 2_000, 'Different'),
      cue('last', 2_000, 3_000, 'Again'),
    ]);
    const officialChineseTrack = track('repeated-zh', 'zh-Hans', [
      cue('zh-first', 0, 1_000, '第一次'),
      cue('zh-middle', 1_000, 2_000, '不同'),
      cue('zh-last', 2_000, 3_000, '再来一次'),
    ]);
    const harness = createHarness({
      englishTrack,
      officialChineseTrack,
      route: route('official'),
    });

    harness.controller.tick({ visibleText: 'Again', currentTimeMs: 100 });
    harness.controller.tick({ visibleText: 'Again', currentTimeMs: 2_100 });

    expect(harness.overlay.lastState()).toEqual({
      english: 'Again',
      chinese: '再来一次',
    });
  });

  it('promotes a seek neighborhood without silently changing providers', () => {
    const harness = createHarness({
      englishTrack: numberedTrack(40),
      route: route('google-free', 'bulk'),
      currentTimeMs: 100,
    });
    const beforeSeek = harness.tasks.scheduled.length;

    harness.controller.seek(25_100);

    const promoted = harness.tasks.scheduled.slice(beforeSeek).filter(
      ({ task }) => task.priority === 'urgent' &&
        task.cues.some(({ id }) => id === 'cue-25'),
    );
    expect(promoted.length).toBeGreaterThan(0);
    expect(promoted.every(({ task }) => task.provider === 'google-free')).toBe(true);
  });

  it('keeps Google Free tasks single-cue and does not attach DeepSeek context', () => {
    const harness = createHarness({
      route: route('google-free', 'bulk'),
      currentTimeMs: 2_100,
    });

    expect(harness.tasks.scheduled.length).toBeGreaterThan(0);
    expect(harness.tasks.scheduled.every(({ task }) =>
      task.cues.length === 1 && task.context.length === 0)).toBe(true);
  });

  it('invalidates work on disable, remount, episode change, and dispose without duplicating listeners', () => {
    const tickSource = new RecordingTickSource(100);
    const harness = createHarness({
      route: route('deepseek', 'urgent-window'),
      tickSource,
    });
    const initial = harness.tasks.find('deepseek', 'cue-0');

    harness.controller.setEnabled(false);
    expect(initial.callbacks.isCurrent()).toBe(false);
    harness.controller.setEnabled(true);
    harness.controller.playerRemounted('session-remount');
    expect(tickSource.subscribeCount).toBe(1);
    expect(tickSource.unsubscribeCount).toBe(0);

    const beforeEpisode = harness.tasks.scheduled.length;
    harness.controller.changeEpisode({
      sessionId: 'session-episode-2',
      episodeId: 'episode-2',
      trackHash: 'track-hash-2',
      englishTrack: numberedTrack(4),
      route: route('deepseek', 'urgent-window'),
    });
    expect(harness.tasks.scheduled.slice(beforeEpisode).every(
      ({ task }) => task.episodeId === 'episode-2' && task.episodeGeneration === 9,
    )).toBe(true);

    harness.controller.dispose();
    harness.controller.dispose();
    expect(tickSource.unsubscribeCount).toBe(1);
    const renders = harness.overlay.states.length;
    tickSource.emit({ currentTimeMs: 2_100 });
    expect(harness.overlay.states).toHaveLength(renders);
  });

  it('treats a disabled route as authoritative even before the settings flag update arrives', () => {
    const harness = createHarness({
      route: route('deepseek', 'urgent-window'),
      currentTimeMs: 100,
    });
    const rendersBeforeDisable = harness.overlay.states.length;

    harness.controller.updateRoute(route('disabled'));
    harness.controller.tick({ currentTimeMs: 1_100 });

    expect(harness.overlay.clearCount).toBeGreaterThan(0);
    expect(harness.overlay.states).toHaveLength(rendersBeforeDisable);
  });

  it('contains provider failures, renders no partial cue, and never calls a second provider', () => {
    const harness = createHarness({
      route: route('google-free', 'urgent-window'),
      currentTimeMs: 100,
    });
    const request = harness.tasks.find('google-free', 'cue-0');
    const error: TranslationError = {
      code: 'rate_limited',
      message: 'Rate limited.',
      retryable: true,
    };

    request.callbacks.onError(error);

    expect(harness.status.last()).toEqual({ mode: 'error', code: 'rate_limited' });
    expect(harness.overlay.states).toHaveLength(0);
    expect(harness.overlay.clearCount).toBeGreaterThan(0);
    expect(harness.tasks.scheduled.every(
      ({ task }) => task.provider === 'google-free',
    )).toBe(true);
  });

  it('keeps translated cues and scheduling alive after a retryable timeout', () => {
    const harness = createHarness({
      englishTrack: numberedTrack(30),
      route: route('deepseek', 'bulk'),
      currentTimeMs: 100,
    });
    const translated = harness.tasks.find('deepseek', 'cue-0');
    const failed = harness.tasks.find('deepseek', 'cue-20');
    translated.callbacks.onResult(batch('cue-0', '已翻译'));
    const scheduledBeforeFailure = harness.tasks.scheduled.length;

    failed.callbacks.onError({
      code: 'timeout',
      message: 'Timed out.',
      retryable: true,
    });

    expect(harness.tasks.cancelled).toHaveLength(0);
    expect(translated.callbacks.isCurrent()).toBe(true);
    expect(failed.callbacks.isCurrent()).toBe(true);
    expect(harness.overlay.lastState()).toEqual({ english: 'Line 0', chinese: '已翻译' });

    harness.controller.seek(25_100);

    expect(harness.tasks.scheduled.length).toBeGreaterThan(scheduledBeforeFailure);
    expect(harness.tasks.scheduled.slice(scheduledBeforeFailure).some(
      ({ task }) => task.cues.some(({ id }) => id === 'cue-25'),
    )).toBe(true);
  });

  it('holds rate-limited work during a cooldown and resumes afterward', () => {
    let now = 1_000;
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => now);
    try {
      const harness = createHarness({
        englishTrack: numberedTrack(8),
        route: route('google-free', 'bulk'),
        currentTimeMs: 100,
      });
      const failed = harness.tasks.find('google-free', 'cue-0');
      const scheduledBeforeFailure = harness.tasks.scheduled.length;

      failed.callbacks.onError({
        code: 'rate_limited',
        message: 'Rate limited.',
        retryable: true,
      });
      harness.controller.seek(4_100);

      expect(harness.tasks.cancelled).toHaveLength(0);
      expect(harness.tasks.scheduled).toHaveLength(scheduledBeforeFailure);

      now += 60_000;
      harness.controller.seek(7_100);

      expect(harness.tasks.scheduled.length).toBeGreaterThan(scheduledBeforeFailure);
      expect(harness.tasks.scheduled.slice(scheduledBeforeFailure).some(
        ({ task }) => task.cues.some(({ id }) => id === 'cue-7'),
      )).toBe(true);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('scopes a rate-limit cooldown to the provider that returned it', () => {
    const harness = createHarness({
      englishTrack: numberedTrack(8),
      route: route('google-free', 'bulk'),
      currentTimeMs: 100,
    });
    const failed = harness.tasks.find('google-free', 'cue-0');
    const scheduledBeforeSwitch = harness.tasks.scheduled.length;

    failed.callbacks.onError({
      code: 'rate_limited',
      message: 'Rate limited.',
      retryable: true,
    });
    harness.controller.updateRoute(route('deepseek', 'urgent-window'));

    expect(harness.tasks.scheduled.length).toBeGreaterThan(scheduledBeforeSwitch);
    expect(harness.tasks.scheduled.slice(scheduledBeforeSwitch).every(
      ({ task }) => task.provider === 'deepseek',
    )).toBe(true);
  });

  it.each([
    { code: 'invalid_request', retryable: false, statusCode: 'provider_unavailable' },
    { code: 'invalid_response', retryable: false, statusCode: 'provider_unavailable' },
    { code: 'provider_unavailable', retryable: true, statusCode: 'provider_unavailable' },
  ] satisfies readonly (Pick<TranslationError, 'code' | 'retryable'> & {
    readonly statusCode: RuntimeErrorCode;
  })[])(
    'contains $code to the failed task without sealing the provider generation',
    ({ code, retryable, statusCode }) => {
      const harness = createHarness({
        englishTrack: numberedTrack(10),
        route: route('deepseek', 'bulk'),
        currentTimeMs: 100,
      });
      const failed = harness.tasks.find('deepseek', 'cue-0');

      failed.callbacks.onError({ code, message: 'Task failed.', retryable });

      expect(harness.tasks.cancelled).toHaveLength(0);
      expect(failed.callbacks.isCurrent()).toBe(true);
      expect(harness.status.last()).toEqual({ mode: 'error', code: statusCode });
    },
  );

  it.each([
    { code: 'authentication_failed', retryable: false },
    { code: 'insufficient_balance', retryable: false },
    { code: 'invalid_configuration', retryable: false },
    { code: 'provider_forbidden', retryable: false },
    { code: 'provider_unset', retryable: false },
  ] satisfies readonly Pick<TranslationError, 'code' | 'retryable'>[])(
    'cancels and seals a provider generation after $code',
    ({ code, retryable }) => {
      const harness = createHarness({
        englishTrack: numberedTrack(30),
        route: route('google-free', 'bulk'),
        currentTimeMs: 100,
      });
      const failed = harness.tasks.find('google-free', 'cue-0');
      const stale = harness.tasks.find('google-free', 'cue-20');
      const scheduledBeforeFailure = harness.tasks.scheduled.length;

      failed.callbacks.onError({ code, message: 'Provider failed.', retryable });

      expect(harness.tasks.cancelled.at(-1)).toEqual({
        generation: { episodeGeneration: 7, providerGeneration: 1 },
        reason: 'provider-change',
      });
      expect(failed.callbacks.isCurrent()).toBe(false);
      expect(stale.callbacks.isCurrent()).toBe(false);

      stale.callbacks.onCache(batch('cue-20', '过期缓存'));
      stale.callbacks.onResult(batch('cue-20', '过期结果'));
      harness.controller.tick({ visibleText: 'Line 20', currentTimeMs: 20_100 });
      harness.controller.seek(25_100);

      expect(harness.tasks.scheduled).toHaveLength(scheduledBeforeFailure);
      expect(harness.overlay.states.some(
        ({ chinese }) => chinese === '过期缓存' || chinese === '过期结果',
      )).toBe(false);
    },
  );

  it('resumes only after an explicit provider switch opens a new generation', () => {
    const harness = createHarness({
      englishTrack: numberedTrack(30),
      route: route('deepseek', 'bulk'),
      currentTimeMs: 100,
    });
    const failed = harness.tasks.find('deepseek', 'cue-0');
    const scheduledBeforeFailure = harness.tasks.scheduled.length;

    failed.callbacks.onError({
      code: 'authentication_failed',
      message: 'Authentication failed.',
      retryable: false,
    });
    harness.controller.updateTracks({
      englishTrack: numberedTrack(31),
      officialChineseTrack: null,
      trackHash: 'refreshed-track',
    });
    harness.controller.updateRoute(route('deepseek', 'urgent-window'));
    harness.controller.tick({ visibleText: 'Line 20', currentTimeMs: 20_100 });

    expect(harness.tasks.scheduled).toHaveLength(scheduledBeforeFailure);
    expect(harness.tasks.scheduled.every(({ task }) => task.provider === 'deepseek'))
      .toBe(true);

    harness.controller.updateRoute(route('google-free', 'bulk'));

    const afterSwitch = harness.tasks.scheduled.slice(scheduledBeforeFailure);
    expect(afterSwitch.length).toBeGreaterThan(0);
    expect(afterSwitch.every(({ task, callbacks }) =>
      task.provider === 'google-free' && callbacks.isCurrent())).toBe(true);
    expect(failed.callbacks.isCurrent()).toBe(false);
  });

  it('clears an authentication block after provider configuration is refreshed', () => {
    const harness = createHarness({
      route: route('deepseek', 'bulk'),
      currentTimeMs: 100,
    });
    const failed = harness.tasks.find('deepseek', 'cue-0');

    failed.callbacks.onError({
      code: 'authentication_failed',
      message: 'Authentication failed.',
      retryable: false,
    });
    const scheduledWhileBlocked = harness.tasks.scheduled.length;
    harness.controller.seek(4_100);
    expect(harness.tasks.scheduled).toHaveLength(scheduledWhileBlocked);

    harness.controller.refreshProviderConfiguration();

    const resumed = harness.tasks.scheduled.slice(scheduledWhileBlocked);
    expect(resumed.length).toBeGreaterThan(0);
    expect(resumed.every(({ task, callbacks }) =>
      task.provider === 'deepseek' &&
      task.providerGeneration === 3 &&
      callbacks.isCurrent())).toBe(true);
  });

  it('stops the same synchronous scheduling loop when its first task fails', () => {
    const tasks = new RecordingTaskClient();
    let failed = false;
    tasks.onEnqueue = (_task, callbacks) => {
      if (failed) return;
      failed = true;
      callbacks.onError({
        code: 'authentication_failed',
        message: 'Authentication failed.',
        retryable: false,
      });
    };

    createHarness({
      englishTrack: numberedTrack(30),
      route: route('deepseek', 'bulk'),
      currentTimeMs: 100,
      taskClient: tasks,
    });

    expect(tasks.scheduled).toHaveLength(1);
    expect(tasks.cancelled).toHaveLength(1);
  });

  it('does not duplicate renders for the same active cue or work for an unchanged route', () => {
    const decision = route('deepseek', 'urgent-window');
    const harness = createHarness({ route: decision });
    const scheduled = harness.tasks.scheduled.length;

    harness.controller.tick({ currentTimeMs: 100 });
    const rendered = harness.overlay.states.length;
    harness.controller.tick({ currentTimeMs: 200 });
    harness.controller.updateRoute({ ...decision });

    expect(harness.overlay.states).toHaveLength(rendered);
    expect(harness.tasks.scheduled).toHaveLength(scheduled);
  });

  it('refreshes unchanged provider configuration with a new guarded generation', () => {
    const harness = createHarness({
      route: route('deepseek', 'urgent-window'),
      currentTimeMs: 100,
    });
    const stale = harness.tasks.find('deepseek', 'cue-0');
    stale.callbacks.onResult(batch('cue-0', '旧配置'));
    const beforeRefresh = harness.tasks.scheduled.length;
    const renderedBeforeRefresh = harness.overlay.states.length;

    harness.controller.refreshProviderConfiguration();

    expect(stale.callbacks.isCurrent()).toBe(false);
    expect(harness.tasks.cancelled.at(-1)).toEqual({
      generation: { episodeGeneration: 7, providerGeneration: 1 },
      reason: 'provider-change',
    });
    expect(harness.tasks.scheduled.slice(beforeRefresh).every(
      ({ task }) => task.provider === 'deepseek' && task.providerGeneration === 2,
    )).toBe(true);
    expect(harness.overlay.states).toHaveLength(renderedBeforeRefresh);
    expect(harness.overlay.lastState()).toEqual({ english: 'Line 0', chinese: '旧配置' });
    expect(harness.overlay.clearCount).toBeGreaterThan(0);
  });

  it('sends precise cancellation reasons for every lifecycle boundary', () => {
    const cases: ReadonlyArray<{
      readonly expected: SessionCancellationReason;
      readonly act: (harness: ReturnType<typeof createHarness>) => void;
    }> = [
      {
        expected: 'disabled',
        act: ({ controller }) => controller.updateRoute(route('disabled')),
      },
      {
        expected: 'official-track',
        act: ({ controller }) => controller.updateRoute(route('official')),
      },
      {
        expected: 'provider-change',
        act: ({ controller }) => controller.updateRoute(route('google-free', 'bulk')),
      },
      {
        expected: 'official-track',
        act: ({ controller }) => controller.updateTracks({
          englishTrack: numberedTrack(6),
          officialChineseTrack: numberedTrack(6, 'zh-Hans', '中文'),
        }),
      },
      {
        expected: 'disabled',
        act: ({ controller }) => controller.setEnabled(false),
      },
      {
        expected: 'player-disposed',
        act: ({ controller }) => controller.playerRemounted('new-player'),
      },
      {
        expected: 'episode-change',
        act: ({ controller }) => controller.changeEpisode({
          sessionId: 'new-session',
          episodeId: 'new-episode',
          trackHash: 'new-track',
          englishTrack: numberedTrack(2),
          route: route('deepseek', 'urgent-window'),
        }),
      },
      {
        expected: 'player-disposed',
        act: ({ controller }) => controller.dispose(),
      },
    ];

    for (const { act, expected } of cases) {
      const harness = createHarness({
        route: route('deepseek', 'urgent-window'),
        currentTimeMs: 100,
      });
      act(harness);
      expect(harness.tasks.cancelled[0]?.reason).toBe(expected);
    }
  });

  it('keeps provider work locked when English is unavailable', () => {
    const harness = createHarness({
      englishTrack: null,
      route: route('missing-English'),
    });

    expect(harness.tasks.scheduled).toHaveLength(0);
    expect(harness.status.last()).toEqual({ mode: 'error', code: 'missing_english' });
  });
});

interface HarnessOptions {
  readonly currentTimeMs?: number;
  readonly englishTrack?: SubtitleTrack | null;
  readonly officialChineseTrack?: SubtitleTrack;
  readonly route?: LanguageRoute;
  readonly tickSource?: RecordingTickSource;
  readonly taskClient?: RecordingTaskClient;
}

function createHarness(options: HarnessOptions = {}) {
  const tasks = options.taskClient ?? new RecordingTaskClient();
  const overlay = new RecordingOverlay();
  const status = new RecordingStatus();
  const tickSource = options.tickSource ?? new RecordingTickSource(
    options.currentTimeMs,
  );
  const englishTrack = options.englishTrack === undefined
    ? numberedTrack(6)
    : options.englishTrack;
  const base = {
    sessionId: 'session-1',
    episodeId: 'episode-1',
    trackHash: 'track-hash-1',
    episodeGeneration: 7,
    enabled: true,
    englishTrack,
    route: options.route ?? route('provider-unset'),
    appearance: APPEARANCE,
    tickSource,
    taskClient: tasks,
    overlay,
    status,
  };
  const controller = createSubtitleSessionController(
    options.officialChineseTrack === undefined
      ? base
      : { ...base, officialChineseTrack: options.officialChineseTrack },
  );
  return { controller, tasks, overlay, status, tickSource };
}

class RecordingTaskClient implements ProviderNeutralTaskClient {
  onEnqueue?: (
    task: ScheduledTranslationTask,
    callbacks: TranslationTaskCallbacks,
  ) => void;
  readonly scheduled: Array<{
    readonly task: ScheduledTranslationTask;
    readonly callbacks: TranslationTaskCallbacks;
  }> = [];
  readonly cancelled: Array<{
    readonly generation: SchedulerGeneration;
    readonly reason: SessionCancellationReason;
  }> = [];

  enqueue(
    task: ScheduledTranslationTask,
    callbacks: TranslationTaskCallbacks,
  ): void {
    this.scheduled.push({ task, callbacks });
    this.onEnqueue?.(task, callbacks);
  }

  cancel(
    generation: SchedulerGeneration,
    reason: SessionCancellationReason,
  ): void {
    this.cancelled.push({ generation, reason });
  }

  find(provider: ScheduledTranslationTask['provider'], cueId: string) {
    const index = this.scheduled.findIndex(({ task }) =>
      task.provider === provider && task.cues.some(({ id }) => id === cueId));
    const found = this.scheduled[index];
    if (found === undefined) throw new Error(`Missing ${provider} task for ${cueId}.`);
    return { ...found, index };
  }
}

class RecordingOverlay implements SessionOverlaySink {
  readonly states: NormalizedActiveCueState[] = [];
  clearCount = 0;

  render(state: NormalizedActiveCueState): boolean {
    this.states.push(state);
    return true;
  }

  clear(): void {
    this.clearCount += 1;
  }

  lastState(): NormalizedActiveCueState | undefined {
    return this.states.at(-1);
  }
}

class RecordingStatus implements SessionStatusSink {
  readonly values: Parameters<SessionStatusSink['publish']>[0][] = [];

  publish(value: Parameters<SessionStatusSink['publish']>[0]): void {
    this.values.push(value);
  }

  last(): Parameters<SessionStatusSink['publish']>[0] | undefined {
    return this.values.at(-1);
  }
}

class RecordingTickSource implements SubtitleSessionTickSource {
  subscribeCount = 0;
  unsubscribeCount = 0;
  #listener: ((tick: SubtitleSessionTick) => void) | undefined;

  constructor(readonly initialTimeMs: number | undefined) {}

  currentTimeMs(): number | undefined {
    return this.initialTimeMs;
  }

  subscribe(listener: (tick: SubtitleSessionTick) => void): () => void {
    this.subscribeCount += 1;
    this.#listener = listener;
    return () => {
      this.unsubscribeCount += 1;
      this.#listener = undefined;
    };
  }

  emit(tick: SubtitleSessionTick): void {
    this.#listener?.(tick);
  }
}

function route(
  mode: LanguageRoute['mode'],
  schedulingScope: LanguageRoute['schedulingScope'] = 'none',
): LanguageRoute {
  if (mode === 'deepseek' || mode === 'google-free') {
    return {
      mode,
      externalCallsAllowed: true,
      provider: mode,
      schedulingScope,
      sourceMode: 'external-translation',
    };
  }
  return {
    mode,
    externalCallsAllowed: false,
    provider: null,
    schedulingScope: 'none',
    sourceMode: mode === 'official' ? 'official-alignment' : 'native-only',
  };
}

function track(
  id: string,
  tag: string,
  cues: readonly SubtitleCue[],
): SubtitleTrack {
  return {
    id,
    format: 'webvtt',
    language: { tag },
    cues,
  };
}

function numberedTrack(
  count: number,
  tag = 'en',
  prefix = 'Line',
): SubtitleTrack {
  return track(`${tag}-track`, tag, Array.from({ length: count }, (_, index) =>
    cue(`cue-${index}`, index * 1_000, (index + 1) * 1_000, `${prefix} ${index}`)));
}

function cue(
  id: string,
  startMs: number,
  endMs: number,
  text: string,
): SubtitleCue {
  return { id, startMs, endMs, text };
}

function batch(cueId: string, text: string): TranslationBatch {
  return {
    translations: [{ cueId, text }],
    retryCueIds: [],
  };
}
