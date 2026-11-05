import { describe, expect, it, vi } from 'vitest';

import {
  createBackgroundMessageRouter,
  createNetflixSessionRegistry,
} from '../../src/app/background-runtime';
import { createExtensionTranslationTaskClient } from '../../src/app/extension-task-client';
import { createNetflixContentSession } from '../../src/app/netflix-content-session';
import type { SubtitleSessionTick } from '../../src/app/session-controller';
import { createMessage, parseMessageEnvelope } from '../../src/shared/messages';
import { ok } from '../../src/shared/result';
import { cloneSettings, DEFAULT_SETTINGS } from '../../src/storage/schema';
import type { TranslationProviderSelection } from '../../src/translation/types';

const RUNTIME_ID = 'subtwin-extension-id';
const SENDER = { id: RUNTIME_ID, tab: { id: 17 }, url: 'https://www.netflix.com/watch/title-1' };

function createHarness(provider: TranslationProviderSelection, enabled = true) {
  const settings = cloneSettings(DEFAULT_SETTINGS);
  settings.provider = provider;
  settings.enabled = enabled;
  const registry = createNetflixSessionRegistry();
  const handleTranslation = vi.fn(async (candidate: unknown): Promise<unknown> => {
    const parsed = parseMessageEnvelope(candidate);
    if (!parsed.ok || parsed.value.type !== 'translation/request') return undefined;
    const request = parsed.value;
    return ok(createMessage({
      id: `${request.id}:background`, source: 'background', type: 'translation/result',
      payload: {
        taskId: request.payload.taskId, sessionId: request.payload.sessionId,
        provider: request.payload.provider, episodeGeneration: request.payload.episodeGeneration,
        providerGeneration: request.payload.providerGeneration, status: 'success',
        translations: request.payload.cues.map(({ id }) => ({ cueId: id, text: '测试译文。' })),
        retryCueIds: [], errorCode: null, retryable: false,
      },
    }));
  });
  const router = createBackgroundMessageRouter({
    runtimeId: RUNTIME_ID, extensionBaseUrl: `chrome-extension://${RUNTIME_ID}/`,
    sessionRegistry: registry, loadSettings: async () => settings,
    handleTranslation, handleSettingsAction: async () => undefined,
    writeRuntimeStatus: async () => undefined, broadcastRuntimeSettings: async () => undefined,
  });
  const messages: unknown[] = [];
  const taskClient = createExtensionTranslationTaskClient({
    sendMessage: async (message) => {
      const response = await router(message, SENDER);
      messages.push(response);
      return response;
    },
  });
  const render = vi.fn(() => true);
  const listeners = new Set<(tick: SubtitleSessionTick) => void>();
  const registrations: Promise<unknown>[] = [];
  let sequence = 0;
  const session = createNetflixContentSession({
    settings: { enabled, provider, deepseekKeyReady: true, appearance: settings.appearance },
    tickSource: {
      currentTimeMs: () => 500,
      subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    },
    taskClient, overlay: { render, clear() {} }, status: { publish() {} },
    onSessionState: (state) => {
      registrations.push(router(createMessage({
        id: `session-${++sequence}`, source: 'content', type: 'netflix/session-state', payload: state,
      }), SENDER));
    },
    onCatalogSummary: (summary) => {
      registrations.push(router(createMessage({
        id: `catalog-${++sequence}`, source: 'content', type: 'netflix/catalog-summary', payload: summary,
      }), SENDER));
    },
  });
  return {
    handleTranslation, render, messages,
    async run() {
      session.handlePayload({
        type: 'catalog', titleId: 'title-1', authority: 'authoritative',
        tracks: [
          { id: 'en-subtitle', language: 'en', kind: 'subtitle' },
          { id: 'en-cc', language: 'en', kind: 'closed-caption' },
          { id: 'zh-main', language: 'zh-Hans', kind: 'subtitle' },
        ],
      });
      await Promise.all(registrations);
      for (const listener of listeners) {
        listener({ visibleText: 'Synthetic native English subtitle.', currentTimeMs: 500 });
      }
      await taskClient.whenIdle();
    },
    dispose() { session.dispose(); taskClient.dispose(); },
  };
}

describe('native subtitle translation through the real background authorization boundary', () => {
  it.each(['deepseek', 'google-free'] as const)('renders %s translations even when the catalog contains official Chinese', async (provider) => {
    const harness = createHarness(provider);
    try {
      await harness.run();
      expect(harness.handleTranslation).toHaveBeenCalledOnce();
      expect(harness.render).toHaveBeenLastCalledWith({
        english: 'Synthetic native English subtitle.', chinese: '测试译文。',
      }, expect.anything());
      expect(harness.messages).toContainEqual(expect.objectContaining({
        value: expect.objectContaining({ payload: expect.objectContaining({ status: 'success' }) }),
      }));
    } finally {
      harness.dispose();
    }
  });

  it.each([
    { provider: 'unset' as const, enabled: true },
    { provider: 'deepseek' as const, enabled: false },
    { provider: 'google-free' as const, enabled: false },
  ])('makes no provider call for $provider when enabled=$enabled', async ({ provider, enabled }) => {
    const harness = createHarness(provider, enabled);
    try {
      await harness.run();
      expect(harness.handleTranslation).not.toHaveBeenCalled();
    } finally {
      harness.dispose();
    }
  });
});
