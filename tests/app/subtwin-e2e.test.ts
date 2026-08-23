import { describe, expect, it, vi } from 'vitest';

import {
  createExtensionTranslationTaskClient,
  type ExtensionTranslationTaskClient,
} from '../../src/app/extension-task-client';
import { createNetflixContentSession } from '../../src/app/netflix-content-session';
import type {
  SessionOverlaySink,
  SessionStatusSink,
  SubtitleSessionTick,
  SubtitleSessionTickSource,
} from '../../src/app/session-controller';
import type { NetflixBridgePayload } from '../../src/netflix/bridge';
import type { NormalizedActiveCueState } from '../../src/renderer/SubtitleOverlay';
import {
  createMessage,
  parseMessageEnvelope,
  type MessageFor,
} from '../../src/shared/messages';
import { ok } from '../../src/shared/result';
import {
  DEFAULT_SETTINGS,
  type RuntimeSettingsState,
} from '../../src/storage/schema';
import type {
  TranslationErrorCode,
  TranslationProviderId,
} from '../../src/translation/types';

describe('SubTwin content-to-background E2E simulation', () => {
  it('keeps official bilingual, discovery, and provider-unset paths at zero provider network calls', async () => {
    const background = new MemoryBackgroundWithTransparentProviderCache();

    const official = createHarness(background, settings('deepseek', true));
    official.session.handlePayload(catalog('official-title', 'authoritative', [
      descriptor('official-en', 'en-US'),
      descriptor('official-zh', 'zh-Hans'),
    ]));
    official.session.handlePayload(timedText(
      'official-title',
      'tt_0123456789abcdef',
      'official-en',
      'en-US',
      'Official English',
    ));
    official.session.handlePayload(timedText(
      'official-title',
      'tt_fedcba9876543210',
      'official-zh',
      'zh-Hans',
      '官方中文',
    ));
    official.ticks.emit({ visibleText: 'Official English', currentTimeMs: 500 });
    await official.client.whenIdle();

    expect(official.overlay.last()).toEqual({
      english: 'Official English',
      chinese: '官方中文',
    });

    const discovery = createHarness(background, settings('google-free', false));
    discovery.session.handlePayload(catalog('discovery-title', 'provisional', [
      descriptor('discovery-en', 'en'),
    ]));
    discovery.session.handlePayload(timedText(
      'discovery-title',
      'tt_0011223344556677',
      'discovery-en',
      'en',
      'Still discovering',
    ));
    discovery.ticks.emit({ visibleText: 'Still discovering', currentTimeMs: 500 });
    await discovery.client.whenIdle();

    const unset = createHarness(background, settings('unset', false));
    unset.session.handlePayload(catalog('unset-title', 'authoritative', [
      descriptor('unset-en', 'en'),
    ]));
    unset.session.handlePayload(timedText(
      'unset-title',
      'tt_8899aabbccddeeff',
      'unset-en',
      'en',
      'No provider selected',
    ));
    unset.ticks.emit({ visibleText: 'No provider selected', currentTimeMs: 500 });
    await unset.client.whenIdle();

    expect(background.providerNetworkCalls).toEqual([]);
    expect(discovery.status.last()).toEqual({ mode: 'discovering' });
    expect(unset.status.last()).toEqual({ mode: 'unset' });

    await Promise.all([official.dispose(), discovery.dispose(), unset.dispose()]);
  });

  it.each([
    ['google-free', false],
    ['deepseek', true],
  ] as const)(
    'authoritative English-only calls only the explicitly selected %s provider after a native tick',
    async (provider, deepseekKeyReady) => {
      const background = new MemoryBackgroundWithTransparentProviderCache();
      const harness = createHarness(
        background,
        settings(provider, deepseekKeyReady),
      );
      harness.session.handlePayload(catalog(`${provider}-title`, 'authoritative', [
        descriptor(`${provider}-en`, 'en'),
      ]));
      harness.session.handlePayload(timedText(
        `${provider}-title`,
        'tt_0123456789abcdef',
        `${provider}-en`,
        'en',
        'Translate this line',
      ));

      await Promise.resolve();
      expect(background.providerNetworkCalls).toEqual([]);

      harness.ticks.emit({ visibleText: 'Translate this line', currentTimeMs: 500 });
      await harness.client.whenIdle();

      expect(background.providerNetworkCalls.map(({ provider: called }) => called))
        .toEqual([provider]);
      expect(harness.overlay.last()).toEqual({
        english: 'Translate this line',
        chinese: `${provider}:Translate this line`,
      });

      await harness.dispose();
    },
  );

  it('replays a same-provider transparent background cache without a second provider network call', async () => {
    const background = new MemoryBackgroundWithTransparentProviderCache();
    const first = createHarness(background, settings('google-free', false));

    loadEnglishOnly(first, 'cache-title', 'Cache this line');
    first.ticks.emit({ visibleText: 'Cache this line', currentTimeMs: 500 });
    await first.client.whenIdle();

    expect(background.providerNetworkCalls).toHaveLength(1);
    expect(background.cacheHits).toBe(0);
    await first.dispose();

    const replay = createHarness(background, settings('google-free', false));
    loadEnglishOnly(replay, 'cache-title', 'Cache this line');
    replay.ticks.emit({ visibleText: 'Cache this line', currentTimeMs: 500 });
    await replay.client.whenIdle();

    expect(background.providerNetworkCalls).toHaveLength(1);
    expect(background.cacheHits).toBe(1);
    expect(replay.overlay.last()?.chinese).toBe('google-free:Cache this line');

    await replay.dispose();
  });

  it('drops a late old-provider response after switching providers', async () => {
    const background = new MemoryBackgroundWithTransparentProviderCache();
    background.deferNext('google-free');
    const harness = createHarness(background, settings('google-free', false));
    loadEnglishOnly(harness, 'switch-title', 'Provider switch');
    harness.ticks.emit({ visibleText: 'Provider switch', currentTimeMs: 500 });

    await vi.waitFor(() => {
      expect(background.pendingCount('google-free')).toBe(1);
    });
    harness.session.updateSettings(settings('deepseek', true), {
      translationConfigurationChanged: true,
    });
    await harness.client.whenIdle();

    expect(harness.overlay.last()?.chinese).toBe('deepseek:Provider switch');
    expect(background.providerNetworkCalls.map(({ provider }) => provider)).toEqual([
      'google-free',
      'deepseek',
    ]);

    background.resolveNext('google-free', 'late-google');
    await flushMicrotasks();

    expect(harness.overlay.last()?.chinese).toBe('deepseek:Provider switch');
    expect(harness.overlay.states.some(({ chinese }) => chinese === 'late-google'))
      .toBe(false);

    await harness.dispose();
  });

  it('keeps a late provider response out after an official Chinese track appears', async () => {
    const background = new MemoryBackgroundWithTransparentProviderCache();
    background.deferNext('google-free');
    const harness = createHarness(background, settings('google-free', false));
    loadEnglishOnly(harness, 'late-official-title', 'Official takes over');
    harness.ticks.emit({ visibleText: 'Official takes over', currentTimeMs: 500 });

    await vi.waitFor(() => {
      expect(background.pendingCount('google-free')).toBe(1);
    });
    harness.session.handlePayload(catalog(
      'late-official-title',
      'authoritative',
      [
        descriptor('en-main', 'en'),
        descriptor('zh-main', 'zh-CN'),
      ],
    ));
    harness.session.handlePayload(timedText(
      'late-official-title',
      'tt_fedcba9876543210',
      'zh-main',
      'zh-CN',
      '官方接管',
    ));
    harness.ticks.emit({ visibleText: 'Official takes over', currentTimeMs: 500 });

    expect(harness.overlay.last()?.chinese).toBe('官方接管');
    background.resolveNext('google-free', 'late-provider');
    await flushMicrotasks();

    expect(background.providerNetworkCalls.map(({ provider }) => provider))
      .toEqual(['google-free']);
    expect(harness.overlay.last()?.chinese).toBe('官方接管');
    expect(harness.overlay.states.some(({ chinese }) => chinese === 'late-provider'))
      .toBe(false);

    await harness.dispose();
  });

  it('contains a selected-provider failure without falling through to another provider', async () => {
    const background = new MemoryBackgroundWithTransparentProviderCache();
    background.fail('google-free', 'provider_unavailable');
    const harness = createHarness(background, settings('google-free', false));
    loadEnglishOnly(harness, 'failure-title', 'Do not fall back');
    harness.ticks.emit({ visibleText: 'Do not fall back', currentTimeMs: 500 });
    await harness.client.whenIdle();

    expect(background.providerNetworkCalls.map(({ provider }) => provider))
      .toEqual(['google-free']);
    expect(background.providerNetworkCalls.some(({ provider }) => provider === 'deepseek'))
      .toBe(false);
    expect(harness.overlay.last()).toEqual({
      english: 'Do not fall back',
      chinese: null,
    });
    expect(harness.status.last()).toEqual({
      mode: 'error',
      code: 'provider_unavailable',
    });

    await harness.dispose();
  });
});

class MemoryBackgroundWithTransparentProviderCache {
  readonly providerNetworkCalls: Array<{
    readonly provider: TranslationProviderId;
    readonly texts: readonly string[];
  }> = [];
  cacheHits = 0;

  readonly #cache = new Map<string, readonly { cueId: string; text: string }[]>();
  readonly #deferCounts = new Map<TranslationProviderId, number>();
  readonly #failures = new Map<TranslationProviderId, TranslationErrorCode>();
  readonly #pending = new Map<TranslationProviderId, Array<{
    readonly request: MessageFor<'translation/request'>;
    readonly resolve: (value: unknown) => void;
  }>>();

  readonly handleMessage = async (candidate: unknown): Promise<unknown> => {
    const parsed = parseMessageEnvelope(candidate);
    if (!parsed.ok) return parsed;
    const message = parsed.value;
    if (message.type === 'translation/cancel') {
      return ok(createMessage({
        id: `${message.id}:background`,
        source: 'background',
        type: 'translation/cancelled',
        payload: {
          sessionId: message.payload.sessionId,
          episodeGeneration: message.payload.episodeGeneration,
          providerGeneration: message.payload.providerGeneration,
          accepted: true,
        },
      }));
    }
    if (message.type !== 'translation/request') {
      throw new Error(`Unexpected E2E message: ${message.type}`);
    }
    if (message.payload.provider === 'unset') {
      throw new Error('The provider gate leaked an unset request.');
    }

    const provider: TranslationProviderId = message.payload.provider;
    const request: MessageFor<'translation/request'> = message;
    const key = cacheKey(request);
    const cached = this.#cache.get(key);
    if (cached !== undefined) {
      this.cacheHits += 1;
      return successResponse(request, cached);
    }

    this.providerNetworkCalls.push({
      provider,
      texts: request.payload.cues.map(({ text }) => text),
    });

    const failure = this.#failures.get(provider);
    if (failure !== undefined) return errorResponse(request, failure);

    const deferred = this.#deferCounts.get(provider) ?? 0;
    if (deferred > 0) {
      this.#deferCounts.set(provider, deferred - 1);
      return new Promise((resolve) => {
        const queue = this.#pending.get(provider) ?? [];
        queue.push({ request, resolve });
        this.#pending.set(provider, queue);
      });
    }

    const translations = translate(request);
    this.#cache.set(key, translations);
    return successResponse(request, translations);
  };

  deferNext(provider: TranslationProviderId): void {
    this.#deferCounts.set(provider, (this.#deferCounts.get(provider) ?? 0) + 1);
  }

  fail(provider: TranslationProviderId, code: TranslationErrorCode): void {
    this.#failures.set(provider, code);
  }

  pendingCount(provider: TranslationProviderId): number {
    return this.#pending.get(provider)?.length ?? 0;
  }

  resolveNext(provider: TranslationProviderId, text: string): void {
    const queue = this.#pending.get(provider) ?? [];
    const pending = queue.shift();
    if (pending === undefined) throw new Error(`No pending ${provider} request.`);
    this.#pending.set(provider, queue);
    const translations = pending.request.payload.cues.map(({ id }) => ({
      cueId: id,
      text,
    }));
    this.#cache.set(cacheKey(pending.request), translations);
    pending.resolve(successResponse(pending.request, translations));
  }
}

function createHarness(
  background: MemoryBackgroundWithTransparentProviderCache,
  runtimeSettings: RuntimeSettingsState,
) {
  const ticks = new RecordingTicks(500);
  const overlay = new RecordingOverlay();
  const status = new RecordingStatus();
  const client = createExtensionTranslationTaskClient({
    sendMessage: background.handleMessage,
    maxConcurrent: 1,
    reservedUrgent: 1,
  });
  const session = createNetflixContentSession({
    settings: runtimeSettings,
    tickSource: ticks,
    taskClient: client,
    overlay,
    status,
    nonceFactory: () => '0123456789abcdef0123456789abcdef',
  });
  return {
    client,
    overlay,
    session,
    status,
    ticks,
    async dispose() {
      session.dispose();
      await client.whenIdle();
      client.dispose();
    },
  };
}

type Harness = ReturnType<typeof createHarness>;

class RecordingTicks implements SubtitleSessionTickSource {
  readonly #listeners = new Set<(tick: SubtitleSessionTick) => void>();

  constructor(readonly timeMs: number | undefined) {}

  currentTimeMs(): number | undefined {
    return this.timeMs;
  }

  subscribe(listener: (tick: SubtitleSessionTick) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  emit(tick: SubtitleSessionTick): void {
    for (const listener of [...this.#listeners]) listener(tick);
  }
}

class RecordingOverlay implements SessionOverlaySink {
  readonly states: NormalizedActiveCueState[] = [];

  render(state: NormalizedActiveCueState): boolean {
    this.states.push(state);
    return true;
  }

  clear(): void {
    // Clearing restores Netflix native subtitles; state history remains observable.
  }

  last(): NormalizedActiveCueState | undefined {
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

function loadEnglishOnly(harness: Harness, titleId: string, text: string): void {
  harness.session.handlePayload(catalog(titleId, 'authoritative', [
    descriptor('en-main', 'en'),
  ]));
  harness.session.handlePayload(timedText(
    titleId,
    'tt_0123456789abcdef',
    'en-main',
    'en',
    text,
  ));
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

function cacheKey(request: MessageFor<'translation/request'>): string {
  return JSON.stringify({
    provider: request.payload.provider,
    sourceLanguage: request.payload.sourceLanguage,
    targetLanguage: request.payload.targetLanguage,
    cues: request.payload.cues.map(({ id, text }) => ({ id, text })),
  });
}

function translate(
  request: MessageFor<'translation/request'>,
): readonly { cueId: string; text: string }[] {
  return request.payload.cues.map(({ id, text }) => ({
    cueId: id,
    text: `${request.payload.provider}:${text}`,
  }));
}

function successResponse(
  request: MessageFor<'translation/request'>,
  translations: readonly { cueId: string; text: string }[],
) {
  return ok(createMessage({
    id: `${request.id}:background`,
    source: 'background',
    type: 'translation/result',
    payload: {
      taskId: request.payload.taskId,
      sessionId: request.payload.sessionId,
      provider: request.payload.provider,
      episodeGeneration: request.payload.episodeGeneration,
      providerGeneration: request.payload.providerGeneration,
      status: 'success',
      translations,
      retryCueIds: [],
      errorCode: null,
      retryable: false,
    },
  }));
}

function errorResponse(
  request: MessageFor<'translation/request'>,
  errorCode: TranslationErrorCode,
) {
  return ok(createMessage({
    id: `${request.id}:background`,
    source: 'background',
    type: 'translation/result',
    payload: {
      taskId: request.payload.taskId,
      sessionId: request.payload.sessionId,
      provider: request.payload.provider,
      episodeGeneration: request.payload.episodeGeneration,
      providerGeneration: request.payload.providerGeneration,
      status: 'error',
      translations: [],
      retryCueIds: [],
      errorCode,
      retryable: false,
    },
  }));
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}
