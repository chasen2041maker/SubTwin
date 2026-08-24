import { describe, expect, it, vi } from 'vitest';

import {
  createBackgroundMessageRouter,
  createNetflixSessionRegistry,
  runtimeSettingsState,
} from '../../src/app/background-runtime';
import { createMessage, type MessageFor } from '../../src/shared/messages';
import { ok } from '../../src/shared/result';
import { DEFAULT_SETTINGS, cloneSettings } from '../../src/storage/schema';

const RUNTIME_ID = 'subtwin-extension-id';
const EXTENSION_BASE = `chrome-extension://${RUNTIME_ID}/`;
const CONTENT_SENDER = {
  id: RUNTIME_ID,
  tab: { id: 17 },
  url: 'https://www.netflix.com/watch/81234567',
} as const;

function translationRequest(): MessageFor<'translation/request'> {
  return createMessage({
    id: 'translation-1',
    source: 'content',
    type: 'translation/request',
    payload: {
      taskId: 'task-1',
      sessionId: 'session-1',
      episodeId: 'episode_hash_1',
      trackHash: 'track_hash_1',
      provider: 'google-free',
      sourceLanguage: 'en',
      targetLanguage: 'zh-Hans',
      episodeGeneration: 1,
      providerGeneration: 1,
      priority: 'urgent',
      cues: [{ id: 'cue-1', startMs: 0, endMs: 1_000, text: 'Hello.' }],
      context: [],
    },
  });
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
  const handleTranslation = vi.fn(async () => ({ translation: true }));
  const handleSettingsAction = vi.fn(async (candidate: unknown) => {
    const message = candidate as MessageFor<'settings/enabled-set'>;
    return successfulEnabledResult(message.id);
  });
  const writeRuntimeStatus = vi.fn(async () => undefined);
  const broadcastRuntimeSettings = vi.fn(async () => undefined);
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
  });
  return {
    broadcastRuntimeSettings,
    handleSettingsAction,
    handleTranslation,
    registry,
    router,
    settings,
    writeRuntimeStatus,
  };
}

function registerCatalog(
  runtime: ReturnType<typeof harness>,
  options: {
    readonly authority?: 'authoritative' | 'provisional';
    readonly chinese?: boolean;
  } = {},
): void {
  runtime.registry.record(CONTENT_SENDER.tab.id, createMessage({
    id: 'session-active',
    source: 'content',
    type: 'netflix/session-state',
    payload: {
      sessionId: 'session-1',
      episodeId: 'episode_hash_1',
      generation: 1,
      state: 'active',
    },
  }));
  runtime.registry.recordCatalog(CONTENT_SENDER.tab.id, createMessage({
    id: 'catalog-current',
    source: 'content',
    type: 'netflix/catalog-summary',
    payload: {
      sessionId: 'session-1',
      generation: 1,
      authority: options.authority ?? 'authoritative',
      tracks: [
        { id: 'en', language: 'en', kind: 'subtitle' },
        ...(options.chinese === true
          ? [{ id: 'zh', language: 'zh-Hans', kind: 'subtitle' as const }]
          : []),
      ],
    },
  }));
}

describe('background runtime security router', () => {
  it('routes translation only from this extension running in an authorized Netflix tab', async () => {
    const runtime = harness();
    const request = translationRequest();
    registerCatalog(runtime);

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
    expect(unregistered.handleTranslation).not.toHaveBeenCalled();
    expect(JSON.stringify(unregisteredResponse)).toContain('provider_unavailable');
    expect(JSON.stringify(unregisteredResponse)).toContain('"retryable":true');

    const provisional = harness();
    registerCatalog(provisional, { authority: 'provisional' });
    await provisional.router(request, CONTENT_SENDER);
    expect(provisional.handleTranslation).not.toHaveBeenCalled();

    const officialChinese = harness();
    registerCatalog(officialChinese, { chinese: true });
    await officialChinese.router(request, CONTENT_SENDER);
    expect(officialChinese.handleTranslation).not.toHaveBeenCalled();

    const authorized = harness();
    registerCatalog(authorized);
    await authorized.router(request, CONTENT_SENDER);
    expect(authorized.handleTranslation).toHaveBeenCalledOnce();
  });

  it('does not authorize a catalog from another tab or session', () => {
    const runtime = harness();
    registerCatalog(runtime);
    const request = translationRequest();
    expect(runtime.registry.authorizeTranslation(CONTENT_SENDER.tab.id, request)).toBe(true);
    expect(runtime.registry.authorizeTranslation(99, request)).toBe(false);
    expect(runtime.registry.authorizeTranslation(CONTENT_SENDER.tab.id, createMessage({
      ...request,
      payload: { ...request.payload, sessionId: 'other-session' },
    }))).toBe(false);
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
    }))).toBe(false);
    expect(registry.readCurrentEpisodeId()).toBe('episode_a');

    expect(registry.record(3, createMessage({
      ...active,
      id: 'dispose',
      payload: { ...active.payload, state: 'disposed' },
    }))).toBe(true);
    expect(registry.readCurrentEpisodeId()).toBeUndefined();
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
