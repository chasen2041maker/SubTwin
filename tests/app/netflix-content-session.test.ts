import { describe, expect, it } from 'vitest';

import {
  bufferEarlyCatalogPayload,
  createNetflixContentSession,
  type NetflixContentRestartReason,
  type NetflixContentSessionState,
} from '../../src/app/netflix-content-session';
import type {
  ProviderNeutralTaskClient,
  SessionCancellationReason,
  SessionOverlaySink,
  SessionStatusSink,
  SubtitleSessionTick,
  SubtitleSessionTickSource,
  TranslationTaskCallbacks,
} from '../../src/app/session-controller';
import type { NetflixBridgePayload } from '../../src/netflix/bridge';
import type { NormalizedActiveCueState } from '../../src/renderer/SubtitleOverlay';
import {
  DEFAULT_SETTINGS,
  type RuntimeSettingsState,
} from '../../src/storage/schema';
import type {
  ScheduledTranslationTask,
  SchedulerGeneration,
} from '../../src/translation/scheduler';

describe('Netflix isolated content session', () => {
  it('keeps an authoritative early catalog when foreign provisional catalogs interleave', () => {
    let payloads: NetflixBridgePayload[] = [];

    payloads = bufferEarlyCatalogPayload(payloads, catalog('title-a', 'authoritative', [
      descriptor('a-en', 'en'),
    ]), 2);
    payloads = bufferEarlyCatalogPayload(payloads, catalog('title-b', 'provisional', [
      descriptor('b-en', 'en'),
    ]), 2);
    payloads = bufferEarlyCatalogPayload(payloads, catalog('title-a', 'provisional', [
      descriptor('a-preview', 'en'),
    ]), 2);

    expect(payloads.filter(({ type }) => type === 'catalog')).toEqual([
      catalog('title-a', 'authoritative', [descriptor('a-en', 'en')]),
      catalog('title-b', 'provisional', [descriptor('b-en', 'en')]),
    ]);
  });

  it('aligns authoritative official English and Simplified Chinese with zero provider calls', () => {
    const harness = createHarness(settings('deepseek', true));
    harness.session.handlePayload(catalog('title-1', 'authoritative', [
      descriptor('en-main', 'en-US'),
      descriptor('zh-main', 'zh-CN'),
    ]));
    harness.session.handlePayload(timedText(
      'title-1',
      'tt_0123456789abcdef',
      'en-main',
      'en-US',
      'Hello',
    ));
    harness.session.handlePayload(timedText(
      'title-1',
      'tt_fedcba9876543210',
      'zh-main',
      'zh-CN',
      '你好',
    ));

    harness.ticks.emit({ visibleText: 'Hello', currentTimeMs: 500 });

    expect(harness.tasks.scheduled).toHaveLength(0);
    expect(harness.overlay.last()).toEqual({ english: 'Hello', chinese: '你好' });
    expect(harness.status.values.at(-1)).toEqual({ mode: 'official' });
  });

  it('keeps discovery and provider-unset catalogs at exactly zero external work', () => {
    const discovering = createHarness(settings('google-free', false));
    discovering.session.handlePayload(catalog('title-1', 'provisional', [
      descriptor('en-main', 'en'),
    ]));
    discovering.session.handlePayload(timedText(
      'title-1',
      'tt_0123456789abcdef',
      'en-main',
      'en',
      'Hello',
    ));
    discovering.ticks.emit({ visibleText: 'Hello', currentTimeMs: 500 });
    expect(discovering.tasks.scheduled).toHaveLength(0);
    expect(discovering.status.values.at(-1)).toEqual({ mode: 'discovering' });

    const unset = createHarness(settings('unset', false));
    unset.session.handlePayload(catalog('title-2', 'authoritative', [
      descriptor('en-main', 'en'),
    ]));
    unset.session.handlePayload(timedText(
      'title-2',
      'tt_fedcba9876543210',
      'en-main',
      'en',
      'Hello',
    ));
    unset.ticks.emit({ visibleText: 'Hello', currentTimeMs: 500 });
    expect(unset.tasks.scheduled).toHaveLength(0);
    expect(unset.status.values.at(-1)).toEqual({ mode: 'unset' });
  });

  it('unlocks only the explicitly selected provider after native English activity is confirmed', () => {
    const harness = createHarness(settings('google-free', false));
    harness.session.handlePayload(catalog('title-1', 'authoritative', [
      descriptor('en-main', 'en'),
    ]));
    harness.session.handlePayload(timedText(
      'title-1',
      'tt_0123456789abcdef',
      'en-main',
      'en',
      'Hello',
    ));
    expect(harness.tasks.scheduled).toHaveLength(0);

    harness.ticks.emit({ visibleText: 'Hello', currentTimeMs: 500 });

    expect(harness.tasks.scheduled.length).toBeGreaterThan(0);
    expect(harness.tasks.scheduled.every(
      ({ task }) => task.provider === 'google-free' && task.cues.length === 1,
    )).toBe(true);
  });

  it('caps one native-text match to urgent work until a second distinctive cue confirms the track', () => {
    const harness = createHarness(settings('google-free', false));
    harness.session.handlePayload(catalog('title-1', 'authoritative', [
      descriptor('en-main', 'en'),
    ]));
    harness.session.handlePayload(timedTextWithCues(
      'title-1',
      'tt_0123456789abcdef',
      'en-main',
      'en',
      [
        'A distinctive opening sentence',
        'Another unmistakable English sentence',
        'The third subtitle line',
        'The fourth subtitle line',
        'The fifth subtitle line',
        'The sixth subtitle line',
      ],
    ));

    harness.ticks.emit({
      visibleText: 'A distinctive opening sentence',
      currentTimeMs: 500,
    });
    expect(harness.tasks.scheduled.length).toBeGreaterThan(0);
    expect(harness.tasks.scheduled.every(
      ({ task }) => task.priority === 'urgent',
    )).toBe(true);

    const beforeStrongConfirmation = harness.tasks.scheduled.length;
    harness.ticks.emit({
      visibleText: 'Another unmistakable English sentence',
      currentTimeMs: 1_500,
    });
    expect(harness.tasks.scheduled.slice(beforeStrongConfirmation).some(
      ({ task }) => task.priority === 'bulk',
    )).toBe(true);
  });

  it('invalidates the selected provider on a settings switch and closes it when official Chinese appears', () => {
    const harness = createHarness(settings('google-free', false));
    harness.session.handlePayload(catalog('title-1', 'authoritative', [
      descriptor('en-main', 'en'),
    ]));
    harness.session.handlePayload(timedText(
      'title-1',
      'tt_0123456789abcdef',
      'en-main',
      'en',
      'Hello',
    ));
    harness.ticks.emit({ visibleText: 'Hello', currentTimeMs: 500 });
    const google = harness.tasks.scheduled[0];
    expect(google?.callbacks.isCurrent()).toBe(true);

    harness.session.updateSettings(settings('deepseek', true), {
      translationConfigurationChanged: true,
    });
    expect(google?.callbacks.isCurrent()).toBe(false);
    expect(harness.tasks.scheduled.some(
      ({ task }) => task.provider === 'deepseek',
    )).toBe(true);

    const beforeOfficial = harness.tasks.scheduled.length;
    harness.session.handlePayload(catalog('title-1', 'authoritative', [
      descriptor('en-main', 'en'),
      descriptor('zh-main', 'zh-Hans'),
    ]));
    expect(harness.tasks.scheduled).toHaveLength(beforeOfficial);
    expect(harness.status.values.at(-1)).toEqual({ mode: 'official' });
  });

  it('uses only a unique language alias and refuses to guess between subtitle variants', () => {
    const unique = createHarness(settings('google-free', false));
    unique.session.handlePayload(catalog('unique-title', 'authoritative', [
      descriptor('catalog-en', 'en'),
    ]));
    unique.session.handlePayload(timedText(
      'unique-title',
      'tt_0123456789abcdef',
      'network-resource-id',
      'en-US',
      'Unique',
    ));
    unique.ticks.emit({ visibleText: 'Unique', currentTimeMs: 500 });
    expect(unique.tasks.scheduled.length).toBeGreaterThan(0);

    const ambiguous = createHarness(settings('google-free', false));
    ambiguous.session.handlePayload(catalog('ambiguous-title', 'authoritative', [
      descriptor('en-subtitle', 'en', 'subtitle'),
      descriptor('en-cc', 'en-US', 'closed-caption'),
    ]));
    ambiguous.session.handlePayload(timedText(
      'ambiguous-title',
      'tt_fedcba9876543210',
      'network-resource-id',
      'en',
      'Ambiguous',
    ));
    ambiguous.ticks.emit({ visibleText: 'Ambiguous', currentTimeMs: 500 });
    expect(ambiguous.tasks.scheduled).toHaveLength(0);
  });

  it('ignores a foreign provisional catalog while an authoritative title is active', () => {
    const harness = createHarness(settings('unset', false));
    harness.session.handlePayload(catalog('current-title', 'authoritative', [
      descriptor('current-en', 'en'),
    ]));
    const statesBeforePreview = harness.states.length;

    harness.session.handlePayload(catalog('preview-title', 'provisional', [
      descriptor('preview-en', 'en'),
    ]));

    expect(harness.restarts).toEqual([]);
    expect(harness.states).toHaveLength(statesBeforePreview);

    harness.session.handlePayload(catalog('next-title', 'authoritative', [
      descriptor('next-en', 'en'),
    ]));
    expect(harness.restarts).toEqual(['episode-change']);
  });

  it('rejects timed text whose title does not match the active catalog', () => {
    const harness = createHarness(settings('google-free', false));
    harness.session.handlePayload(catalog('title-1', 'authoritative', [
      descriptor('en-main', 'en'),
    ]));
    const resourceId = 'tt_0123456789abcdef';
    harness.session.handlePayload(timedText(
      'preview-title',
      resourceId,
      'en-main',
      'en',
      'Wrong episode subtitle',
    ));

    harness.ticks.emit({
      visibleText: 'Wrong episode subtitle',
      currentTimeMs: 500,
    });
    expect(harness.tasks.scheduled).toHaveLength(0);

    harness.session.handlePayload(timedText(
      'title-1',
      resourceId,
      'en-main',
      'en',
      'Current episode subtitle',
    ));
    harness.ticks.emit({
      visibleText: 'Current episode subtitle',
      currentTimeMs: 500,
    });
    expect(harness.tasks.scheduled.length).toBeGreaterThan(0);
  });

  it('accepts a complete retry after an incomplete timed-text body fails to parse', () => {
    const harness = createHarness(settings('google-free', false));
    harness.session.handlePayload(catalog('title-1', 'authoritative', [
      descriptor('en-main', 'en'),
    ]));
    const resourceId = 'tt_0123456789abcdef';
    harness.session.handlePayload({
      ...timedText('title-1', resourceId, 'en-main', 'en', 'ignored'),
      body: 'incomplete timed text',
    });
    harness.session.handlePayload(timedText(
      'title-1',
      resourceId,
      'en-main',
      'en',
      'Recovered subtitle',
    ));

    harness.ticks.emit({
      visibleText: 'Recovered subtitle',
      currentTimeMs: 500,
    });

    expect(harness.tasks.scheduled.length).toBeGreaterThan(0);
  });

  it('replaces a valid partial resource body with a more complete body', () => {
    const harness = createHarness(settings('google-free', false));
    harness.session.handlePayload(catalog('title-1', 'authoritative', [
      descriptor('en-main', 'en'),
    ]));
    const resourceId = 'tt_0123456789abcdef';
    harness.session.handlePayload(timedTextWithCues(
      'title-1',
      resourceId,
      'en-main',
      'en',
      ['First partial cue'],
    ));
    harness.ticks.emit({ visibleText: 'First partial cue', currentTimeMs: 500 });

    harness.session.handlePayload(timedTextWithCues(
      'title-1',
      resourceId,
      'en-main',
      'en',
      ['First partial cue', 'Second recovered cue'],
    ));
    harness.ticks.emit({ visibleText: 'Second recovered cue', currentTimeMs: 1_500 });

    expect(harness.overlay.last()?.english).toBe('Second recovered cue');
  });

  it('reports episode/remount lifecycle once and ignores all work after disposal', () => {
    const harness = createHarness(settings('unset', false));
    harness.session.handlePayload(catalog('title-1', 'authoritative', [
      descriptor('en-main', 'en'),
    ]));
    harness.session.handlePayload(catalog('title-2', 'authoritative', [
      descriptor('en-next', 'en'),
    ]));
    harness.session.playerRemounted();
    harness.session.dispose();
    harness.session.dispose();
    const reportsBeforeLatePayload = harness.states.length;
    harness.session.handlePayload(catalog('title-3', 'authoritative', []));

    expect(harness.restarts).toEqual(['episode-change', 'player-remount']);
    expect(harness.states.map(({ state }) => state)).toEqual([
      'active',
      'disposed',
      'active',
      'disposed',
      'active',
      'disposed',
    ]);
    expect(harness.states).toHaveLength(reportsBeforeLatePayload);
    expect(harness.overlay.clearCount).toBeGreaterThan(0);
  });
});

function createHarness(runtimeSettings: RuntimeSettingsState) {
  const ticks = new RecordingTicks(500);
  const tasks = new RecordingTasks();
  const overlay = new RecordingOverlay();
  const status = new RecordingStatus();
  const states: NetflixContentSessionState[] = [];
  const restarts: NetflixContentRestartReason[] = [];
  const session = createNetflixContentSession({
    settings: runtimeSettings,
    tickSource: ticks,
    taskClient: tasks,
    overlay,
    status,
    nonceFactory: () => '0123456789abcdef0123456789abcdef',
    onSessionState: (state) => states.push(state),
    onBridgeRestart: (reason) => restarts.push(reason),
  });
  return { session, ticks, tasks, overlay, status, states, restarts };
}

class RecordingTicks implements SubtitleSessionTickSource {
  private readonly listeners = new Set<(tick: SubtitleSessionTick) => void>();

  constructor(private readonly timeMs: number | undefined) {}

  currentTimeMs(): number | undefined {
    return this.timeMs;
  }

  subscribe(listener: (tick: SubtitleSessionTick) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(tick: SubtitleSessionTick): void {
    for (const listener of [...this.listeners]) listener(tick);
  }
}

class RecordingTasks implements ProviderNeutralTaskClient {
  readonly scheduled: Array<{
    readonly task: ScheduledTranslationTask;
    readonly callbacks: TranslationTaskCallbacks;
  }> = [];
  readonly cancelled: Array<{
    readonly generation: SchedulerGeneration;
    readonly reason: SessionCancellationReason;
  }> = [];

  enqueue(task: ScheduledTranslationTask, callbacks: TranslationTaskCallbacks): void {
    this.scheduled.push({ task, callbacks });
  }

  cancel(generation: SchedulerGeneration, reason: SessionCancellationReason): void {
    this.cancelled.push({ generation, reason });
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

  last(): NormalizedActiveCueState | undefined {
    return this.states.at(-1);
  }
}

class RecordingStatus implements SessionStatusSink {
  readonly values: Parameters<SessionStatusSink['publish']>[0][] = [];

  publish(status: Parameters<SessionStatusSink['publish']>[0]): void {
    this.values.push(status);
  }
}

function settings(
  provider: RuntimeSettingsState['provider'],
  deepseekKeyReady: boolean,
): RuntimeSettingsState {
  return {
    enabled: true,
    provider,
    deepseekKeyReady,
    appearance: DEFAULT_SETTINGS.appearance,
  };
}

function catalog(
  titleId: string,
  authority: 'authoritative' | 'provisional',
  tracks: ReturnType<typeof descriptor>[],
): Extract<NetflixBridgePayload, { type: 'catalog' }> {
  return { type: 'catalog', titleId, authority, tracks };
}

function descriptor(
  id: string,
  language: string,
  kind: 'subtitle' | 'closed-caption' = 'subtitle',
) {
  return { id, language, kind } as const;
}

function timedText(
  titleId: string,
  resourceId: string,
  trackId: string,
  language: string,
  text: string,
): Extract<NetflixBridgePayload, { type: 'timed-text' }> {
  return {
    type: 'timed-text',
    titleId,
    resourceId,
    trackId,
    language,
    format: 'webvtt',
    body: `WEBVTT\n\n00:00:00.000 --> 00:00:01.000\n${text}\n`,
  };
}

function timedTextWithCues(
  titleId: string,
  resourceId: string,
  trackId: string,
  language: string,
  texts: readonly string[],
): Extract<NetflixBridgePayload, { type: 'timed-text' }> {
  const body = texts.map((text, index) => {
    const start = String(index).padStart(2, '0');
    const end = String(index + 1).padStart(2, '0');
    return `00:00:${start}.000 --> 00:00:${end}.000\n${text}`;
  }).join('\n\n');
  return {
    type: 'timed-text',
    titleId,
    resourceId,
    trackId,
    language,
    format: 'webvtt',
    body: `WEBVTT\n\n${body}\n`,
  };
}
