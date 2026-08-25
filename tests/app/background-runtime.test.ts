import { describe, expect, it, vi } from 'vitest';

import {
  createBackgroundMessageRouter,
  createNetflixSessionRegistry,
  runtimeSettingsState,
} from '../../src/app/background-runtime';
import { createMessage, type MessageFor } from '../../src/shared/messages';
import { ok } from '../../src/shared/result';
import {
  DEFAULT_SETTINGS,
  cloneSettings,
  type RuntimeSettingsState,
} from '../../src/storage/schema';

const RUNTIME_ID = 'subtwin-extension-id';
const EXTENSION_BASE = `chrome-extension://${RUNTIME_ID}/`;
const CONTENT_SENDER = {
  id: RUNTIME_ID,
  tab: { id: 17 },
  url: 'https://www.netflix.com/watch/81234567',
} as const;

function translationRequest(
  overrides: Partial<MessageFor<'translation/request'>['payload']> = {},
): MessageFor<'translation/request'> {
  return createMessage({
    id: 'translation-1',
    source: 'content',
    type: 'translation/request',
    payload: {
      taskId: 'task-1',
      sessionId: 'session-1',
      episodeId: 'episode_hash_1',
      trackHash: 'track_hash_1',
      provider: 'deepseek',
      sourceLanguage: 'en',
      targetLanguage: 'zh-Hans',
      episodeGeneration: 1,
      providerGeneration: 1,
      priority: 'urgent',
      cues: [{ id: 'cue-1', startMs: 0, endMs: 1_000, text: 'Hello.' }],
      context: [],
      ...overrides,
    },
  });
}

function sessionState(
  overrides: Partial<MessageFor<'netflix/session-state'>['payload']> = {},
): MessageFor<'netflix/session-state'> {
  return createMessage({
    id: 'session-state-1',
    source: 'content',
    type: 'netflix/session-state',
    payload: {
      sessionId: 'session-1',
      episodeId: 'episode_hash_1',
      generation: 1,
      state: 'active',
      ...overrides,
    },
  });
}

function catalogSummary(
  authority: 'authoritative' | 'provisional',
  languages: readonly string[],
  overrides: Partial<MessageFor<'netflix/catalog-summary'>['payload']> = {},
): MessageFor<'netflix/catalog-summary'> {
  return createMessage({
    id: `catalog-${authority}-${languages.join('-')}`,
    source: 'content',
    type: 'netflix/catalog-summary',
    payload: {
      sessionId: 'session-1',
      generation: 1,
      authority,
      tracks: languages.map((language, index) => ({
        id: `track-${index}`,
        language,
        kind: 'subtitle' as const,
      })),
      ...overrides,
    },
  });
}

async function registerCatalog(
  runtime: ReturnType<typeof harness>,
  authority: 'authoritative' | 'provisional',
  languages: readonly string[],
  sender = CONTENT_SENDER,
): Promise<void> {
  await runtime.router(sessionState(), sender);
  await runtime.router(catalogSummary(authority, languages), sender);
}

function successfulEnabledResult(
  requestId: string,
): ReturnType<typeof ok<MessageFor<'settings/enabled-set-result'>>> {
  return ok(createMessage({
    id: `${requestId}:background`,
    source: 'background',
    type: 'settings/enabled-set-result',
    payload: {
      status: 'success',
      errorCode: null,
      enabled: false,
      provider: 'deepseek',
    },
  }));
}

function harness() {
  const settings = cloneSettings(DEFAULT_SETTINGS);
  settings.provider = 'deepseek';
  settings.deepseek.apiKey = 'local-secret';
  const handleTranslation = vi.fn(async (_candidate: unknown, _tabId: number) => ({
    translation: true,
  }));
  const handleSettingsAction = vi.fn(async (candidate: unknown): Promise<unknown> => {
    const message = candidate as MessageFor<'settings/enabled-set'>;
    return successfulEnabledResult(message.id);
  });
  const writeRuntimeStatus = vi.fn(async () => undefined);
  const broadcastRuntimeSettings = vi.fn(async (
    _settings: RuntimeSettingsState,
    _translationConfigurationChanged: boolean,
  ): Promise<void> => undefined);
  const persistSessionRegistry = vi.fn(async () => undefined);
  const registry = createNetflixSessionRegistry();
  const router = createBackgroundMessageRouter({
    runtimeId: RUNTIME_ID,
    extensionBaseUrl: EXTENSION_BASE,
    sessionRegistry: registry,
    loadSettings: vi.fn(async () => settings),
    handleTranslation,
    handleSettingsAction,
    writeRuntimeStatus,
    broadcastRuntimeSettings,
    persistSessionRegistry,
  });
  return {
    broadcastRuntimeSettings,
    handleSettingsAction,
    handleTranslation,
    persistSessionRegistry,
    registry,
    router,
    settings,
    writeRuntimeStatus,
  };
}

describe('background runtime security router', () => {
  it('accepts page settings only from the matching Netflix content tab and broadcasts the saved state', async () => {
    const runtime = harness();
    const appearance = {
      ...DEFAULT_SETTINGS.appearance,
      order: 'chinese-first' as const,
      english: {
        ...DEFAULT_SETTINGS.appearance.english,
        fontFamily: 'serif' as const,
      },
    };
    const update = createMessage({
      id: 'settings-page-update-router',
      source: 'content',
      type: 'settings/page-update',
      payload: {
        enabled: false,
        provider: 'unset',
        appearance,
        updateEnabled: true,
        updateAppearance: true,
        updateProvider: false,
      },
    });
    runtime.handleSettingsAction.mockImplementationOnce(async () => {
      runtime.settings.enabled = false;
      runtime.settings.appearance = appearance;
      return ok(createMessage({
        id: `${update.id}:background`,
        source: 'background',
        type: 'settings/page-update-result',
        payload: {
          status: 'success',
          errorCode: null,
          enabled: false,
          provider: 'unset',
          appearance,
        },
      }));
    });

    await expect(runtime.router(update, CONTENT_SENDER)).resolves.toMatchObject({
      ok: true,
      value: { type: 'settings/page-update-result' },
    });
    expect(runtime.handleSettingsAction).toHaveBeenCalledExactlyOnceWith(update);
    expect(runtime.broadcastRuntimeSettings).toHaveBeenCalledWith(
      expect.objectContaining({ enabled: false, appearance }),
      false,
    );

    for (const sender of [
      { ...CONTENT_SENDER, id: 'other-extension' },
      { ...CONTENT_SENDER, url: 'https://example.test/watch/1' },
      { id: RUNTIME_ID, url: `${EXTENSION_BASE}options.html` },
    ]) {
      await expect(runtime.router(update, sender)).resolves.toBeUndefined();
    }
    expect(runtime.handleSettingsAction).toHaveBeenCalledOnce();
  });

  it('serializes settings commits through their broadcasts across popup and page mutations', async () => {
    const runtime = harness();
    const appearance = {
      ...DEFAULT_SETTINGS.appearance,
      lineSpacingPx: 19,
    };
    const enabledSet = createMessage({
      id: 'settings-ordered-disable',
      source: 'popup',
      type: 'settings/enabled-set',
      payload: { enabled: false },
    });
    const pageUpdate = createMessage({
      id: 'settings-ordered-appearance',
      source: 'content',
      type: 'settings/page-update',
      payload: {
        enabled: true,
        provider: 'unset',
        appearance,
        updateEnabled: false,
        updateAppearance: true,
        updateProvider: false,
      },
    });
    runtime.handleSettingsAction.mockImplementation(async (candidate) => {
      const message = candidate as MessageFor<'settings/enabled-set'> | MessageFor<'settings/page-update'>;
      if (message.type === 'settings/enabled-set') {
        runtime.settings.enabled = message.payload.enabled;
        return successfulEnabledResult(message.id);
      }
      runtime.settings.appearance = appearance;
      return ok(createMessage({
        id: `${message.id}:background`,
        source: 'background',
        type: 'settings/page-update-result',
        payload: {
          status: 'success',
          errorCode: null,
          enabled: runtime.settings.enabled,
          provider: runtime.settings.provider,
          appearance,
        },
      }));
    });
    let releaseFirstBroadcast!: () => void;
    runtime.broadcastRuntimeSettings.mockImplementationOnce(() => new Promise<void>((resolve) => {
      releaseFirstBroadcast = resolve;
    }));

    const first = runtime.router(enabledSet, {
      id: RUNTIME_ID,
      url: `${EXTENSION_BASE}popup.html`,
    });
    await vi.waitFor(() => {
      expect(runtime.broadcastRuntimeSettings).toHaveBeenCalledTimes(1);
    });
    const second = runtime.router(pageUpdate, CONTENT_SENDER);
    await Promise.resolve();
    await Promise.resolve();

    expect(runtime.handleSettingsAction).toHaveBeenCalledOnce();
    releaseFirstBroadcast();
    await Promise.all([first, second]);
    expect(runtime.broadcastRuntimeSettings.mock.calls.map(([snapshot]) => ({
      enabled: snapshot.enabled,
      appearance: snapshot.appearance,
    }))).toEqual([
      { enabled: false, appearance: DEFAULT_SETTINGS.appearance },
      { enabled: false, appearance },
    ]);
  });

  it('keeps options patches in the same commit-and-broadcast queue as page patches', async () => {
    const runtime = harness();
    runtime.settings.provider = 'google-free';
    runtime.settings.deepseek.apiKey = '';
    const appearance = {
      ...DEFAULT_SETTINGS.appearance,
      verticalOffsetPercent: 17,
    };
    const pageUpdate = createMessage({
      id: 'settings-page-before-options',
      source: 'content',
      type: 'settings/page-update',
      payload: {
        enabled: true,
        provider: 'google-free',
        appearance,
        updateEnabled: false,
        updateAppearance: true,
        updateProvider: false,
      },
    });
    const optionsUpdate = createMessage({
      id: 'settings-options-after-page',
      source: 'options',
      type: 'settings/options-update',
      payload: {
        patch: {
          provider: 'deepseek',
          deepseek: { apiKey: 'new-key', model: 'deepseek-v4-pro' },
        },
      },
    });
    runtime.handleSettingsAction.mockImplementation(async (candidate) => {
      const message = candidate as MessageFor<'settings/page-update'> |
        MessageFor<'settings/options-update'>;
      if (message.type === 'settings/page-update') {
        runtime.settings.appearance = appearance;
        return ok(createMessage({
          id: `${message.id}:background`,
          source: 'background',
          type: 'settings/page-update-result',
          payload: {
            status: 'success',
            errorCode: null,
            enabled: runtime.settings.enabled,
            provider: runtime.settings.provider,
            appearance,
          },
        }));
      }
      runtime.settings.provider = 'deepseek';
      runtime.settings.deepseek = { apiKey: 'new-key', model: 'deepseek-v4-pro' };
      return ok(createMessage({
        id: `${message.id}:background`,
        source: 'background',
        type: 'settings/options-update-result',
        payload: {
          status: 'success',
          errorCode: null,
          enabled: runtime.settings.enabled,
        },
      }));
    });
    let releasePageBroadcast!: () => void;
    runtime.broadcastRuntimeSettings.mockImplementationOnce(() => new Promise<void>((resolve) => {
      releasePageBroadcast = resolve;
    }));

    const page = runtime.router(pageUpdate, CONTENT_SENDER);
    await vi.waitFor(() => {
      expect(runtime.broadcastRuntimeSettings).toHaveBeenCalledTimes(1);
    });
    const options = runtime.router(optionsUpdate, {
      id: RUNTIME_ID,
      url: `${EXTENSION_BASE}options.html`,
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(runtime.handleSettingsAction).toHaveBeenCalledOnce();

    releasePageBroadcast();
    await Promise.all([page, options]);
    expect(runtime.broadcastRuntimeSettings.mock.calls.map(([snapshot]) => ({
      appearance: snapshot.appearance,
      provider: snapshot.provider,
      deepseekKeyReady: snapshot.deepseekKeyReady,
    }))).toEqual([
      {
        appearance,
        provider: 'google-free',
        deepseekKeyReady: false,
      },
      {
        appearance,
        provider: 'deepseek',
        deepseekKeyReady: true,
      },
    ]);
  });

  it('routes translation only for a registered authoritative Netflix session', async () => {
    const runtime = harness();
    const request = translationRequest();

    await expect(runtime.router(request, CONTENT_SENDER)).resolves.toMatchObject({
      ok: true,
      value: {
        id: 'translation-1:background',
        type: 'translation/result',
        payload: { errorCode: 'stale_generation' },
      },
    });
    expect(runtime.handleTranslation).not.toHaveBeenCalled();

    await registerCatalog(runtime, 'authoritative', ['en-US']);
    await expect(runtime.router(request, CONTENT_SENDER)).resolves.toEqual({
      translation: true,
    });
    expect(runtime.handleTranslation).toHaveBeenCalledOnce();

    for (const sender of [
      { ...CONTENT_SENDER, id: 'other-extension' },
      { ...CONTENT_SENDER, url: 'https://www.netflix.com.evil.test/watch/1' },
      { id: RUNTIME_ID, url: `${EXTENSION_BASE}options.html` },
    ]) {
      await expect(runtime.router(request, sender)).resolves.toBeUndefined();
    }
    expect(runtime.handleTranslation).toHaveBeenCalledOnce();
  });

  it('fails closed before external translation until an authoritative English-only catalog is registered', async () => {
    const request = translationRequest();

    const unregistered = harness();
    const unregisteredResponse = await unregistered.router(request, CONTENT_SENDER);
    expect(unregisteredResponse).toMatchObject({
      ok: true,
      value: {
        type: 'translation/result',
        payload: { errorCode: 'stale_generation', retryable: false },
      },
    });
    expect(unregistered.handleTranslation).not.toHaveBeenCalled();

    const provisional = harness();
    await registerCatalog(provisional, 'provisional', ['en-US']);
    await provisional.router(request, CONTENT_SENDER);
    expect(provisional.handleTranslation).not.toHaveBeenCalled();

    const officialChinese = harness();
    await registerCatalog(officialChinese, 'authoritative', ['en-US', 'zh-Hans']);
    await officialChinese.router(request, CONTENT_SENDER);
    expect(officialChinese.handleTranslation).not.toHaveBeenCalled();

    const authorized = harness();
    await registerCatalog(authorized, 'authoritative', ['en-US']);
    await authorized.router(request, CONTENT_SENDER);
    expect(authorized.handleTranslation).toHaveBeenCalledOnce();
  });

  it('does not authorize a catalog from another tab or session', async () => {
    const runtime = harness();
    await registerCatalog(runtime, 'authoritative', ['en-US']);
    const request = translationRequest();

    expect(runtime.registry.authorize(CONTENT_SENDER.tab.id, request)).toEqual({
      allowed: true,
      stateChanged: true,
    });
    expect(runtime.registry.authorize(99, request)).toEqual({
      allowed: false,
      stateChanged: false,
    });
    expect(runtime.registry.authorize(CONTENT_SENDER.tab.id, createMessage({
      ...request,
      payload: { ...request.payload, sessionId: 'other-session' },
    }))).toEqual({
      allowed: false,
      stateChanged: false,
    });
  });

  it.each([
    { authority: 'provisional' as const, languages: ['en-US'], name: 'provisional catalog' },
    { authority: 'authoritative' as const, languages: ['fr-FR'], name: 'missing English' },
    {
      authority: 'authoritative' as const,
      languages: ['en-US', 'zh-Hans'],
      name: 'official Simplified Chinese',
    },
  ])('rejects translation for $name', async ({ authority, languages }) => {
    const runtime = harness();
    await registerCatalog(runtime, authority, languages);

    const response = await runtime.router(translationRequest(), CONTENT_SENDER);

    expect(response).toMatchObject({
      ok: true,
      value: { type: 'translation/result', payload: { errorCode: 'stale_generation' } },
    });
    expect(runtime.handleTranslation).not.toHaveBeenCalled();
  });

  it('binds authorization to tab, session, episode, and episode generation', async () => {
    const runtime = harness();
    await registerCatalog(runtime, 'authoritative', ['en-US']);
    const otherTab = { ...CONTENT_SENDER, tab: { id: 18 } };

    for (const [request, sender] of [
      [translationRequest(), otherTab],
      [translationRequest({ sessionId: 'other-session' }), CONTENT_SENDER],
      [translationRequest({ episodeId: 'other-episode' }), CONTENT_SENDER],
      [translationRequest({ episodeGeneration: 0 }), CONTENT_SENDER],
    ] as const) {
      await expect(runtime.router(request, sender)).resolves.toMatchObject({
        ok: true,
        value: { type: 'translation/result', payload: { errorCode: 'stale_generation' } },
      });
    }
    expect(runtime.handleTranslation).not.toHaveBeenCalled();
  });

  it('requires fresh catalog evidence when an episode changes within the same session generation', async () => {
    const runtime = harness();
    await registerCatalog(runtime, 'authoritative', ['en-US']);
    await runtime.router(translationRequest(), CONTENT_SENDER);
    expect(runtime.handleTranslation).toHaveBeenCalledOnce();

    await runtime.router(sessionState({
      episodeId: 'episode_hash_2',
    }), CONTENT_SENDER);
    await runtime.router(
      catalogSummary('authoritative', ['en-US']),
      CONTENT_SENDER,
    );
    const response = await runtime.router(translationRequest({
      episodeId: 'episode_hash_2',
      providerGeneration: 2,
    }), CONTENT_SENDER);

    expect(response).toMatchObject({
      ok: true,
      value: { type: 'translation/result', payload: { errorCode: 'stale_generation' } },
    });
    expect(runtime.handleTranslation).toHaveBeenCalledOnce();
  });

  it('requires enabled settings and the saved provider at the final routing boundary', async () => {
    const runtime = harness();
    await registerCatalog(runtime, 'authoritative', ['en-US']);

    runtime.settings.enabled = false;
    await expect(runtime.router(translationRequest(), CONTENT_SENDER)).resolves.toMatchObject({
      ok: true,
      value: { type: 'translation/result', payload: { errorCode: 'invalid_configuration' } },
    });
    runtime.settings.enabled = true;
    runtime.settings.provider = 'google-free';
    await expect(runtime.router(translationRequest(), CONTENT_SENDER)).resolves.toMatchObject({
      ok: true,
      value: { type: 'translation/result', payload: { errorCode: 'invalid_configuration' } },
    });

    expect(runtime.handleTranslation).not.toHaveBeenCalled();
  });

  it('persists provider generation only when authorization advances', async () => {
    const runtime = harness();
    await registerCatalog(runtime, 'authoritative', ['en-US']);
    runtime.persistSessionRegistry.mockClear();

    await runtime.router(translationRequest(), CONTENT_SENDER);
    await runtime.router(translationRequest({ taskId: 'same-generation' }), CONTENT_SENDER);
    await runtime.router(translationRequest({
      taskId: 'next-generation',
      providerGeneration: 2,
    }), CONTENT_SENDER);

    expect(runtime.persistSessionRegistry).toHaveBeenCalledTimes(2);
  });

  it('latches late official Chinese, cancels current work, and never reopens that generation', async () => {
    const runtime = harness();
    await registerCatalog(runtime, 'authoritative', ['en-US']);
    await runtime.router(translationRequest({ providerGeneration: 4 }), CONTENT_SENDER);
    expect(runtime.handleTranslation).toHaveBeenCalledOnce();

    await runtime.router(
      catalogSummary('authoritative', ['en-US', 'zh-CN']),
      CONTENT_SENDER,
    );

    expect(runtime.handleTranslation).toHaveBeenCalledTimes(2);
    expect(runtime.handleTranslation.mock.calls[1]?.[0]).toMatchObject({
      type: 'translation/cancel',
      payload: {
        sessionId: 'session-1',
        episodeGeneration: 1,
        providerGeneration: 4,
        reason: 'official-track',
      },
    });
    expect(runtime.handleTranslation.mock.calls[1]?.[1]).toBe(17);

    await runtime.router(catalogSummary('authoritative', ['en-US']), CONTENT_SENDER);
    await runtime.router(translationRequest({ providerGeneration: 5 }), CONTENT_SENDER);

    expect(runtime.handleTranslation).toHaveBeenCalledTimes(2);
  });

  it('persists the official-Chinese latch before a best-effort cancellation', async () => {
    const runtime = harness();
    await registerCatalog(runtime, 'authoritative', ['en-US']);
    await runtime.router(translationRequest({ providerGeneration: 4 }), CONTENT_SENDER);
    runtime.persistSessionRegistry.mockClear();
    let persisted: unknown;
    runtime.persistSessionRegistry.mockImplementation(async () => {
      persisted = JSON.parse(JSON.stringify(runtime.registry.snapshot())) as unknown;
    });
    runtime.handleTranslation.mockRejectedValueOnce(new Error('cancel failed'));

    await expect(runtime.router(
      catalogSummary('authoritative', ['en-US', 'zh-Hans']),
      CONTENT_SENDER,
    )).resolves.toBeUndefined();

    expect(runtime.persistSessionRegistry).toHaveBeenCalledOnce();
    const restarted = createNetflixSessionRegistry();
    expect(restarted.restore(persisted)).toBe(true);
    expect(restarted.authorize(
      CONTENT_SENDER.tab.id,
      translationRequest({ providerGeneration: 5 }),
    )).toEqual({ allowed: false, stateChanged: false });
  });

  it('returns a credential-free settings snapshot only to a trusted Netflix tab', async () => {
    const runtime = harness();
    const request = createMessage({
      id: 'runtime-settings-1',
      source: 'content',
      type: 'runtime/settings-get',
      payload: {},
    });

    const response = await runtime.router(request, CONTENT_SENDER);

    expect(response).toEqual(ok(createMessage({
      id: 'runtime-settings-1:background',
      source: 'background',
      type: 'runtime/settings-state',
      payload: {
        enabled: true,
        provider: 'deepseek',
        deepseekKeyReady: true,
        appearance: DEFAULT_SETTINGS.appearance,
      },
    })));
    expect(JSON.stringify(response)).not.toContain('local-secret');
    await expect(runtime.router(request, {
      id: RUNTIME_ID,
      url: `${EXTENSION_BASE}popup.html`,
    })).resolves.toBeUndefined();
  });

  it('persists only validated enum runtime status from trusted Netflix content', async () => {
    const runtime = harness();
    const request = createMessage({
      id: 'runtime-status-1',
      source: 'content',
      type: 'runtime/status-set',
      payload: { mode: 'error', code: 'rate_limited' },
    });

    await runtime.router(request, CONTENT_SENDER);
    expect(runtime.writeRuntimeStatus).toHaveBeenCalledWith({
      mode: 'error',
      code: 'rate_limited',
    });

    await runtime.router(request, { ...CONTENT_SENDER, url: 'https://evil.test/' });
    expect(runtime.writeRuntimeStatus).toHaveBeenCalledOnce();
  });

  it('authorizes settings pages exactly and broadcasts only successful mutations', async () => {
    const runtime = harness();
    const request = createMessage({
      id: 'enabled-1',
      source: 'options',
      type: 'settings/enabled-set',
      payload: { enabled: false },
    });
    const sender = {
      id: RUNTIME_ID,
      url: `${EXTENSION_BASE}options.html`,
    };

    await runtime.router(request, sender);

    expect(runtime.handleSettingsAction).toHaveBeenCalledOnce();
    expect(runtime.broadcastRuntimeSettings).toHaveBeenCalledWith(
      {
        enabled: true,
        provider: 'deepseek',
        deepseekKeyReady: true,
        appearance: DEFAULT_SETTINGS.appearance,
      },
      false,
    );

    await runtime.router(request, { ...sender, tab: { id: 1 } });
    expect(runtime.handleSettingsAction).toHaveBeenCalledTimes(2);

    await runtime.router(request, {
      id: RUNTIME_ID,
      tab: { id: 1 },
      url: 'https://www.netflix.com/watch/81234567',
    });
    expect(runtime.handleSettingsAction).toHaveBeenCalledTimes(2);
  });

  it('does not broadcast settings when a mutation result is an error', async () => {
    const runtime = harness();
    runtime.handleSettingsAction.mockResolvedValueOnce(ok(createMessage({
      id: 'enabled-1:background',
      source: 'background',
      type: 'settings/enabled-set-result',
      payload: {
        status: 'error',
        errorCode: 'settings_unavailable',
        enabled: false,
        provider: 'unset',
      },
    })));
    const request = createMessage({
      id: 'enabled-1',
      source: 'popup',
      type: 'settings/enabled-set',
      payload: { enabled: false },
    });

    await runtime.router(request, {
      id: RUNTIME_ID,
      url: `${EXTENSION_BASE}popup.html`,
    });

    expect(runtime.broadcastRuntimeSettings).not.toHaveBeenCalled();
  });
});

describe('trusted Netflix session registry', () => {
  it('quarantines a catalog that arrives before session-state and attaches only the exact matching session', () => {
    const registry = createNetflixSessionRegistry();
    const request = translationRequest();
    const catalog = createMessage({
      id: 'catalog-first',
      source: 'content',
      type: 'netflix/catalog-summary',
      payload: {
        sessionId: 'session-1',
        generation: 1,
        authority: 'authoritative' as const,
        tracks: [{ id: 'en', language: 'en', kind: 'subtitle' as const }],
      },
    });

    expect(registry.recordCatalog(CONTENT_SENDER.tab.id, catalog)).toBeNull();
    expect(registry.authorize(CONTENT_SENDER.tab.id, request)).toEqual({
      allowed: false,
      stateChanged: false,
    });

    expect(registry.record(CONTENT_SENDER.tab.id, createMessage({
      id: 'session-after-catalog',
      source: 'content',
      type: 'netflix/session-state',
      payload: {
        sessionId: 'session-1',
        episodeId: 'episode_hash_1',
        generation: 1,
        state: 'active' as const,
      },
    }))).toBe(true);
    expect(registry.authorize(CONTENT_SENDER.tab.id, request)).toEqual({
      allowed: true,
      stateChanged: true,
    });

    const officialChinese = createNetflixSessionRegistry();
    expect(officialChinese.recordCatalog(CONTENT_SENDER.tab.id, createMessage({
      ...catalog,
      id: 'official-chinese-first',
      payload: {
        ...catalog.payload,
        tracks: [
          { id: 'en', language: 'en', kind: 'subtitle' as const },
          { id: 'zh', language: 'zh-Hans', kind: 'subtitle' as const },
        ],
      },
    }))).toBeNull();
    officialChinese.record(CONTENT_SENDER.tab.id, createMessage({
      id: 'official-chinese-session',
      source: 'content',
      type: 'netflix/session-state',
      payload: {
        sessionId: 'session-1',
        episodeId: 'episode_hash_1',
        generation: 1,
        state: 'active' as const,
      },
    }));
    expect(officialChinese.authorize(CONTENT_SENDER.tab.id, request)).toEqual({
      allowed: false,
      stateChanged: false,
    });
  });

  it('tracks the most recently active episode and ignores stale disposal', () => {
    const registry = createNetflixSessionRegistry();
    const state = (episodeId: string, generation: number, sessionId = 'session-1') =>
      createMessage({
        id: `${episodeId}:${generation}`,
        source: 'content',
        type: 'netflix/session-state',
        payload: { sessionId, episodeId, generation, state: 'active' as const },
      });

    expect(registry.record(1, state('episode_a', 2))).toBe(true);
    expect(registry.record(2, state('episode_b', 1, 'session-2'))).toBe(true);
    expect(registry.readCurrentEpisodeId()).toBe('episode_b');
    expect(registry.record(1, state('episode_stale', 1))).toBe(false);

    const staleDispose = createMessage({
      ...state('episode_a', 1),
      id: 'dispose-stale',
      payload: {
        ...state('episode_a', 1).payload,
        state: 'disposed' as const,
      },
    });
    expect(registry.record(1, staleDispose)).toBe(false);
    expect(registry.readCurrentEpisodeId()).toBe('episode_b');

    registry.removeTab(2);
    expect(registry.readCurrentEpisodeId()).toBe('episode_a');
  });

  it('tombstones a disposed session even when disposal arrives before active state', () => {
    const registry = createNetflixSessionRegistry();
    registry.recordCatalog(17, catalogSummary('authoritative', ['en-US']));

    expect(registry.record(17, sessionState({ state: 'disposed' }))).toBe(true);
    expect(registry.record(17, sessionState())).toBe(false);
    expect(registry.authorize(17, translationRequest())).toEqual({
      allowed: false,
      stateChanged: false,
    });
  });

  it('keeps a quarantined next-session catalog when the current catalog updates', () => {
    const registry = createNetflixSessionRegistry();
    expect(registry.record(17, sessionState({
      sessionId: 'session-a',
      episodeId: 'episode-a',
    }))).toBe(true);
    registry.recordCatalog(17, catalogSummary('authoritative', ['en-US'], {
      sessionId: 'session-a',
    }));
    registry.recordCatalog(17, catalogSummary('authoritative', ['en-US'], {
      sessionId: 'session-b',
    }));

    registry.recordCatalog(17, catalogSummary('authoritative', ['en-US'], {
      sessionId: 'session-a',
    }));
    expect(registry.record(17, sessionState({
      sessionId: 'session-b',
      episodeId: 'episode-b',
    }))).toBe(true);
    expect(registry.authorize(17, translationRequest({
      sessionId: 'session-b',
      episodeId: 'episode-b',
    }))).toEqual({ allowed: true, stateChanged: true });
  });

  it('restores quarantined catalog evidence across a service-worker restart', () => {
    const original = createNetflixSessionRegistry();
    original.recordCatalog(17, catalogSummary('authoritative', ['en-US']));
    const restarted = createNetflixSessionRegistry();

    expect(restarted.restore(
      JSON.parse(JSON.stringify(original.snapshot())) as unknown,
    )).toBe(true);
    expect(restarted.record(17, sessionState())).toBe(true);
    expect(restarted.authorize(17, translationRequest())).toEqual({
      allowed: true,
      stateChanged: true,
    });
  });

  it('removes only the matching current session on disposal', () => {
    const registry = createNetflixSessionRegistry();
    const active = createMessage({
      id: 'active',
      source: 'content',
      type: 'netflix/session-state',
      payload: {
        sessionId: 'current-session',
        episodeId: 'episode_a',
        generation: 5,
        state: 'active' as const,
      },
    });
    registry.record(3, active);

    expect(registry.record(3, createMessage({
      ...active,
      id: 'wrong-dispose',
      payload: { ...active.payload, sessionId: 'old-session', state: 'disposed' },
    }))).toBe(true);
    expect(registry.readCurrentEpisodeId()).toBe('episode_a');
    expect(registry.record(3, createMessage({
      ...active,
      id: 'delayed-old-active',
      payload: { ...active.payload, sessionId: 'old-session' },
    }))).toBe(false);

    expect(registry.record(3, createMessage({
      ...active,
      id: 'dispose',
      payload: { ...active.payload, state: 'disposed' },
    }))).toBe(true);
    expect(registry.readCurrentEpisodeId()).toBeUndefined();
  });

  it('never lets a delayed active message resurrect a retired session', () => {
    const registry = createNetflixSessionRegistry();
    const state = (
      sessionId: string,
      episodeId: string,
      generation: number,
      state: 'active' | 'disposed',
    ) => createMessage({
      id: `${sessionId}:${state}`,
      source: 'content',
      type: 'netflix/session-state',
      payload: { sessionId, episodeId, generation, state },
    });

    expect(registry.record(7, state('old-session', 'old-episode', 1, 'active'))).toBe(true);
    expect(registry.record(7, state('new-session', 'new-episode', 1, 'active'))).toBe(true);

    expect(registry.record(7, state('old-session', 'old-episode', 1, 'active'))).toBe(false);
    expect(registry.record(7, state('old-session', 'old-episode', 1, 'disposed'))).toBe(false);
    expect(registry.readCurrentEpisodeId()).toBe('new-episode');
  });

  it('restores authoritative authorization after a service-worker restart', () => {
    const original = createNetflixSessionRegistry();
    expect(original.record(17, sessionState())).toBe(true);
    original.recordCatalog(17, catalogSummary('authoritative', ['en-US']));
    expect(original.authorize(
      17,
      translationRequest({ providerGeneration: 4 }),
    )).toEqual({ allowed: true, stateChanged: true });

    const persisted = JSON.parse(JSON.stringify(original.snapshot())) as unknown;
    const restarted = createNetflixSessionRegistry();

    expect(restarted.restore(persisted)).toBe(true);
    expect(restarted.authorize(
      17,
      translationRequest({ providerGeneration: 1 }),
    )).toEqual({ allowed: false, stateChanged: false });
    expect(restarted.authorize(
      17,
      translationRequest({ providerGeneration: 4 }),
    )).toEqual({ allowed: true, stateChanged: false });
    expect(restarted.readCurrentEpisodeId()).toBe('episode_hash_1');
    expect(restarted.recordCatalog(
      17,
      catalogSummary('authoritative', ['en-US', 'zh-Hans']),
    )).toEqual({
      sessionId: 'session-1',
      episodeGeneration: 1,
      providerGeneration: 4,
    });
  });
});

describe('runtime settings projection', () => {
  it('derives key readiness without exposing key or model', () => {
    const settings = cloneSettings(DEFAULT_SETTINGS);
    settings.deepseek.apiKey = '  local-only  ';
    settings.deepseek.model = 'deepseek-v4-pro';

    const state = runtimeSettingsState(settings);

    expect(state.deepseekKeyReady).toBe(true);
    expect(JSON.stringify(state)).not.toContain('local-only');
    expect(JSON.stringify(state)).not.toContain('deepseek-v4-pro');
  });
});
