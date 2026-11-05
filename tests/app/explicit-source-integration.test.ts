import { afterEach, describe, expect, it } from 'vitest';

import {
  createBackgroundMessageRouter,
  createNetflixSessionRegistry,
} from '../../src/app/background-runtime';
import { createExtensionTranslationTaskClient } from '../../src/app/extension-task-client';
import { createNetflixContentSession } from '../../src/app/netflix-content-session';
import { parseRuntimeSettingsResponse } from '../../src/app/runtime-settings-client';
import type {
  SubtitleSessionTick,
  SubtitleSessionTickSource,
} from '../../src/app/session-controller';
import type { RuntimeStatus } from '../../src/app/status';
import type { NetflixCatalogPayload } from '../../src/netflix/bridge';
import type { NormalizedActiveCueState } from '../../src/renderer/SubtitleOverlay';
import {
  createMessage,
  parseMessageEnvelope,
  type MessageFor,
} from '../../src/shared/messages';
import { ok } from '../../src/shared/result';
import {
  cloneSettings,
  DEFAULT_SETTINGS,
  type TranslationProviderSetting,
} from '../../src/storage/schema';

const RUNTIME_ID = 'subtwin-integration-extension';
const CONTENT_SENDER = {
  id: RUNTIME_ID,
  tab: { id: 41 },
  url: 'https://www.netflix.com/watch/integration-title',
} as const;
const TITLE_ID = 'integration-title';
const MAIN_ENGLISH = 'Synthetic regular English subtitle';
const CC_ENGLISH = 'Synthetic English closed caption';
const OFFICIAL_CHINESE = '合成的官方中文字幕。';
const TRANSLATED_CHINESE = '合成的外部服务译文。';
const PROVIDERS = ['unset', 'google-free', 'deepseek'] as const;
const ENGLISH_CATALOGS = ['none', 'single', 'subtitle-and-cc'] as const;
const ARRIVAL_ORDERS = ['catalog-first', 'session-first'] as const;
const BODY_MODES = ['downloaded', 'native-fallback'] as const;

type EnglishCatalog = (typeof ENGLISH_CATALOGS)[number];
type ArrivalOrder = (typeof ARRIVAL_ORDERS)[number];
type BodyMode = (typeof BODY_MODES)[number];
type LifecycleMessage =
  | MessageFor<'netflix/session-state'>
  | MessageFor<'netflix/catalog-summary'>;

interface Scenario {
  readonly provider: TranslationProviderSetting;
  readonly english: EnglishCatalog;
  readonly chinese: boolean;
  readonly order: ArrivalOrder;
  readonly bodies: BodyMode;
}

const scenarios: Scenario[] = PROVIDERS.flatMap((provider) =>
  ENGLISH_CATALOGS.flatMap((english) =>
    [false, true].flatMap((chinese) =>
      ARRIVAL_ORDERS.flatMap((order) =>
        (english === 'none' ? ['downloaded'] as const : BODY_MODES)
          .map((bodies) => ({ provider, english, chinese, order, bodies }))))));

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

class NativeTicks implements SubtitleSessionTickSource {
  private readonly listeners = new Set<(tick: SubtitleSessionTick) => void>();

  currentTimeMs(): number { return 500; }

  subscribe(listener: (tick: SubtitleSessionTick) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(visibleText: string): void {
    for (const listener of [...this.listeners]) {
      listener({ visibleText, currentTimeMs: 500 });
    }
  }
}

function catalogFor(scenario: Pick<Scenario, 'english' | 'chinese'>): NetflixCatalogPayload {
  const tracks: NetflixCatalogPayload['tracks'][number][] = [];
  if (scenario.english !== 'none') {
    tracks.push({ id: 'en-main', language: 'en', kind: 'subtitle' });
  }
  if (scenario.english === 'subtitle-and-cc') {
    tracks.push({ id: 'en-cc', language: 'en', kind: 'closed-caption' });
  }
  if (scenario.chinese) {
    tracks.push({ id: 'zh-main', language: 'zh-Hans', kind: 'subtitle' });
  }
  return { type: 'catalog', titleId: TITLE_ID, authority: 'authoritative', tracks };
}

function currentEnglish(english: EnglishCatalog): string {
  return english === 'subtitle-and-cc' ? CC_ENGLISH : MAIN_ENGLISH;
}

function translatedResult(request: MessageFor<'translation/request'>) {
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
      translations: request.payload.cues.map(({ id }) => ({
        cueId: id,
        text: TRANSLATED_CHINESE,
      })),
      retryCueIds: [],
      errorCode: null,
      retryable: false,
    },
  }));
}

async function deliverLifecycle(
  router: ReturnType<typeof createBackgroundMessageRouter>,
  lifecycle: LifecycleMessage[],
  order: ArrivalOrder,
  omit?: LifecycleMessage['type'],
): Promise<void> {
  const firstType = order === 'catalog-first'
    ? 'netflix/catalog-summary'
    : 'netflix/session-state';
  const ordered = [
    ...lifecycle.filter(({ type }) => type === firstType),
    ...lifecycle.filter(({ type }) => type !== firstType),
  ];
  for (const message of ordered) {
    if (message.type !== omit) await router(message, CONTENT_SENDER);
  }
  lifecycle.length = 0;
}

function loadTracks(
  session: ReturnType<typeof createNetflixContentSession>,
  scenario: Pick<Scenario, 'english' | 'chinese' | 'bodies'>,
): void {
  const catalog = catalogFor(scenario);
  session.handlePayload(catalog);
  for (const track of catalog.tracks) {
    if (track.language === 'en' && scenario.bodies === 'native-fallback') continue;
    const text = track.id === 'en-main'
      ? MAIN_ENGLISH
      : track.id === 'en-cc' ? CC_ENGLISH : OFFICIAL_CHINESE;
    const resourceDigit = track.id === 'en-main' ? '1' : track.id === 'en-cc' ? '2' : '3';
    session.handlePayload({
      type: 'timed-text',
      titleId: TITLE_ID,
      resourceId: `tt_${resourceDigit.repeat(16)}`,
      trackId: track.id,
      language: track.language,
      format: 'webvtt',
      body: `WEBVTT\n\n00:00:00.000 --> 00:00:01.000\n${text}\n`,
    });
  }
}

async function createHarness(
  provider: TranslationProviderSetting,
  options: { readonly enabled?: boolean; readonly keyReady?: boolean } = {},
) {
  const settings = cloneSettings(DEFAULT_SETTINGS);
  settings.provider = provider;
  settings.enabled = options.enabled ?? true;
  settings.deepseek.apiKey = options.keyReady === false ? '' : 'synthetic-test-key';
  const registry = createNetflixSessionRegistry();
  const handlerRequests: MessageFor<'translation/request'>[] = [];
  const sentRequests: MessageFor<'translation/request'>[] = [];
  const lifecycle: LifecycleMessage[] = [];
  const statuses: RuntimeStatus[] = [];
  let overlayState: NormalizedActiveCueState | undefined;
  const router = createBackgroundMessageRouter({
    runtimeId: RUNTIME_ID,
    extensionBaseUrl: `chrome-extension://${RUNTIME_ID}/`,
    sessionRegistry: registry,
    loadSettings: async () => cloneSettings(settings),
    handleTranslation: async (candidate: unknown) => {
      const parsed = parseMessageEnvelope(candidate);
      if (!parsed.ok) throw new Error('Expected a valid translation envelope.');
      if (parsed.value.type !== 'translation/request') return undefined;
      handlerRequests.push(parsed.value);
      return translatedResult(parsed.value);
    },
    handleSettingsAction: async () => {
      throw new Error('Unexpected settings mutation.');
    },
    writeRuntimeStatus: async () => undefined,
    broadcastRuntimeSettings: async () => undefined,
  });
  const settingsRequest = createMessage({
    id: 'integration-runtime-settings',
    source: 'content',
    type: 'runtime/settings-get',
    payload: {},
  });
  const runtimeSettings = parseRuntimeSettingsResponse(
    await router(settingsRequest, CONTENT_SENDER),
    settingsRequest.id,
  );
  if (runtimeSettings === null) throw new Error('Runtime settings were rejected.');
  const taskClient = createExtensionTranslationTaskClient({
    sendMessage: async (candidate: unknown) => {
      const parsed = parseMessageEnvelope(candidate);
      if (parsed.ok && parsed.value.type === 'translation/request') {
        sentRequests.push(parsed.value);
      }
      return router(candidate, CONTENT_SENDER);
    },
    isOnline: () => true,
    onRuntimeStatus: (status) => statuses.push(status),
  });
  const ticks = new NativeTicks();
  const session = createNetflixContentSession({
    settings: runtimeSettings,
    tickSource: ticks,
    taskClient,
    overlay: {
      render: (state) => { overlayState = state; return true; },
      clear: () => { overlayState = undefined; },
    },
    status: { publish: (status) => statuses.push(status) },
    nonceFactory: () => '0123456789abcdef0123456789abcdef',
    onSessionState: (state) => lifecycle.push(createMessage({
      id: `integration-session-${lifecycle.length}`,
      source: 'content',
      type: 'netflix/session-state',
      payload: state,
    })),
    onCatalogSummary: (summary) => lifecycle.push(createMessage({
      id: `integration-catalog-${lifecycle.length}`,
      source: 'content',
      type: 'netflix/catalog-summary',
      payload: summary,
    })),
  });
  cleanups.push(async () => {
    session.dispose();
    await taskClient.whenIdle();
    taskClient.dispose();
  });

  return {
    settings, registry, router, session, ticks, taskClient,
    handlerRequests, sentRequests, statuses,
    load: (scenario: Pick<Scenario, 'english' | 'chinese' | 'bodies'>) =>
      loadTracks(session, scenario),
    deliverLifecycle: (order: ArrivalOrder, omit?: LifecycleMessage['type']) =>
      deliverLifecycle(router, lifecycle, order, omit),
    overlay: () => overlayState,
  };
}

describe('explicit source across content, task client, router, and session registry', () => {
  it.each(scenarios)('$provider / en=$english / zh=$chinese / $order / $bodies', async (scenario) => {
    const runtime = await createHarness(scenario.provider);
    runtime.load(scenario);
    await runtime.deliverLifecycle(scenario.order);
    runtime.ticks.emit(scenario.english === 'none'
      ? scenario.chinese ? OFFICIAL_CHINESE : ''
      : currentEnglish(scenario.english));
    await runtime.taskClient.whenIdle();

    const external = scenario.provider !== 'unset' && scenario.english !== 'none';
    if (external) {
      expect(runtime.handlerRequests.length).toBeGreaterThan(0);
      expect(runtime.handlerRequests.every(({ payload }) =>
        payload.provider === scenario.provider)).toBe(true);
      expect(runtime.overlay()).toEqual({
        english: currentEnglish(scenario.english),
        chinese: TRANSLATED_CHINESE,
      });
    } else {
      expect(runtime.handlerRequests).toHaveLength(0);
      expect(runtime.sentRequests).toHaveLength(0);
      const official = scenario.provider === 'unset' &&
        scenario.english !== 'none' && scenario.chinese && scenario.bodies === 'downloaded';
      if (official) {
        expect(runtime.overlay()).toEqual({
          english: currentEnglish(scenario.english),
          chinese: OFFICIAL_CHINESE,
        });
      } else {
        expect(runtime.overlay()?.chinese ?? null).toBeNull();
      }
    }
  });

  it.each([false, true])('keeps missing-key DeepSeek at zero external calls with zh=$0', async (chinese) => {
    const runtime = await createHarness('deepseek', { keyReady: false });
    runtime.load({ english: 'subtitle-and-cc', chinese, bodies: 'downloaded' });
    await runtime.deliverLifecycle('catalog-first');
    runtime.ticks.emit(CC_ENGLISH);
    await runtime.taskClient.whenIdle();

    expect(runtime.sentRequests).toHaveLength(0);
    expect(runtime.handlerRequests).toHaveLength(0);
    expect(runtime.overlay()?.chinese ?? null).toBeNull();
    expect(runtime.statuses).toContainEqual({ mode: 'error', code: 'invalid_configuration' });
  });

  it.each(PROVIDERS)('keeps disabled $0 at zero external calls', async (provider) => {
    const runtime = await createHarness(provider, { enabled: false });
    runtime.load({ english: 'subtitle-and-cc', chinese: true, bodies: 'downloaded' });
    await runtime.deliverLifecycle('session-first');
    runtime.ticks.emit(CC_ENGLISH);
    await runtime.taskClient.whenIdle();

    expect(runtime.sentRequests).toHaveLength(0);
    expect(runtime.handlerRequests).toHaveLength(0);
    expect(runtime.overlay()).toBeUndefined();
  });

  it.each([
    ['deepseek', 'google-free'],
    ['deepseek', 'unset'],
    ['google-free', 'deepseek'],
    ['google-free', 'unset'],
  ] as const)('rejects stale content source %s after stored source becomes %s', async (contentProvider, savedProvider) => {
    const runtime = await createHarness(contentProvider);
    runtime.load({ english: 'single', chinese: true, bodies: 'native-fallback' });
    await runtime.deliverLifecycle('catalog-first');
    // 模拟后台设置已提交、页面尚未收到设置推送的窗口。
    runtime.settings.provider = savedProvider;
    runtime.ticks.emit(MAIN_ENGLISH);
    await runtime.taskClient.whenIdle();

    expect(runtime.sentRequests.length).toBeGreaterThan(0);
    expect(runtime.sentRequests.every(({ payload }) =>
      payload.provider === contentProvider)).toBe(true);
    expect(runtime.handlerRequests).toHaveLength(0);
    expect(runtime.overlay()?.chinese ?? null).toBeNull();
  });

  it.each(['google-free', 'deepseek'] as const)('rejects stale %s work after background disable', async (provider) => {
    const runtime = await createHarness(provider);
    runtime.load({ english: 'single', chinese: true, bodies: 'native-fallback' });
    await runtime.deliverLifecycle('session-first');
    runtime.settings.enabled = false;
    runtime.ticks.emit(MAIN_ENGLISH);
    await runtime.taskClient.whenIdle();

    expect(runtime.sentRequests.length).toBeGreaterThan(0);
    expect(runtime.handlerRequests).toHaveLength(0);
    expect(runtime.overlay()?.chinese ?? null).toBeNull();
  });

  it.each(['netflix/session-state', 'netflix/catalog-summary'] as const)(
    'never authorizes work when %s has not reached the background',
    async (missingType) => {
      const runtime = await createHarness('deepseek');
      runtime.load({ english: 'single', chinese: true, bodies: 'native-fallback' });
      await runtime.deliverLifecycle('catalog-first', missingType);
      runtime.ticks.emit(MAIN_ENGLISH);
      await runtime.taskClient.whenIdle();

      expect(runtime.sentRequests.length).toBeGreaterThan(0);
      expect(runtime.handlerRequests).toHaveLength(0);
      expect(runtime.overlay()?.chinese ?? null).toBeNull();
    },
  );
});
