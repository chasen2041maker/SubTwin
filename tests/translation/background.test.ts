import { describe, expect, it, vi } from 'vitest';

import { createMessage } from '../../src/shared/messages';
import { createBackgroundTranslationHandler } from '../../src/translation/background';
import {
  MemoryTranslationCacheStore,
  TranslationCache,
  type TranslationCacheStore,
} from '../../src/translation/cache';

const request = createMessage({
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

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

describe('background translation boundary', () => {
  it('reports provider=unset truthfully while making zero calls', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const handler = createBackgroundTranslationHandler({
      fetch,
      readSettings: vi.fn().mockResolvedValue({ provider: 'unset' }),
    });

    const result = await handler({
      ...request,
      payload: { ...request.payload, provider: 'unset' as const },
    });

    expect(result).toMatchObject({
      ok: true,
      value: { payload: { provider: 'unset', status: 'error' } },
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    [{ provider: 'unset' }, request],
    [{ provider: 'deepseek', deepseekApiKey: 'test-only', deepseekModel: 'deepseek-v4-flash' }, request],
    [{ provider: 'google-free' }, {
      ...request,
      payload: { ...request.payload, provider: 'deepseek' as const },
    }],
  ])('makes zero provider calls for unset or stored/request provider mismatch', async (stored, message) => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const handler = createBackgroundTranslationHandler({
      fetch,
      readSettings: vi.fn().mockResolvedValue(stored),
      googleOptions: { minStartIntervalMs: 0 },
    });

    const result = await handler(message);

    expect(result).toMatchObject({ ok: true, value: { payload: { status: 'error' } } });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('uses Google only when it is the exact stored provider', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      response([[['你好。', 'Hello.']]]),
    );
    const handler = createBackgroundTranslationHandler({
      fetch,
      readSettings: vi.fn().mockResolvedValue({ provider: 'google-free' }),
      googleOptions: { minStartIntervalMs: 0 },
    });

    const result = await handler(request);

    expect(result).toMatchObject({
      ok: true,
      value: {
        source: 'background',
        type: 'translation/result',
        payload: {
          provider: 'google-free',
          status: 'success',
          translations: [{ cueId: 'cue-1', text: '你好。' }],
          errorCode: null,
        },
      },
    });
    expect(fetch).toHaveBeenCalledOnce();
    expect(String(fetch.mock.calls[0]?.[0])).toContain('translate.googleapis.com');
  });

  it('reads the DeepSeek key/model only in background and never returns credentials', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response({
      choices: [{
        finish_reason: 'stop',
        message: {
          content: JSON.stringify({
            translations: [{ id: 'cue-1', text: '你好。' }],
          }),
        },
      }],
    }));
    const readSettings = vi.fn().mockResolvedValue({
      provider: 'deepseek',
      deepseekApiKey: 'background-only-test-key',
      deepseekModel: 'deepseek-v4-pro',
    });
    const handler = createBackgroundTranslationHandler({ fetch, readSettings });
    const deepseekRequest = {
      ...request,
      payload: { ...request.payload, provider: 'deepseek' as const },
    };

    const result = await handler(deepseekRequest);

    expect(readSettings).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch.mock.calls[0]?.[1]?.headers).toMatchObject({
      Authorization: 'Bearer background-only-test-key',
    });
    expect(JSON.stringify(result)).not.toContain('background-only-test-key');
    expect(JSON.stringify(result)).not.toContain('deepseek-v4-pro');
  });

  it('does not silently cross-fallback after a selected provider failure', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response({}, 403));
    const handler = createBackgroundTranslationHandler({
      fetch,
      readSettings: vi.fn().mockResolvedValue({ provider: 'google-free' }),
      googleOptions: { minStartIntervalMs: 0 },
    });

    const result = await handler(request);

    expect(result).toMatchObject({
      ok: true,
      value: { payload: { status: 'error', errorCode: 'provider_forbidden' } },
    });
    expect(fetch).toHaveBeenCalledOnce();
    expect(String(fetch.mock.calls[0]?.[0])).toContain('translate.googleapis.com');
  });

  it('does not call DeepSeek without a stored key', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const handler = createBackgroundTranslationHandler({
      fetch,
      readSettings: vi.fn().mockResolvedValue({
        provider: 'deepseek',
        deepseekApiKey: '',
        deepseekModel: 'deepseek-v4-flash',
      }),
    });

    const result = await handler({
      ...request,
      payload: { ...request.payload, provider: 'deepseek' as const },
    });

    expect(result).toMatchObject({
      ok: true,
      value: { payload: { status: 'error', errorCode: 'invalid_configuration' } },
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('contains storage read failures as a non-sensitive local error', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const handler = createBackgroundTranslationHandler({
      fetch,
      readSettings: vi.fn().mockRejectedValue(new Error('secret storage detail')),
    });

    await expect(handler(request)).resolves.toMatchObject({
      ok: true,
      value: {
        payload: {
          status: 'error',
          errorCode: 'invalid_configuration',
          retryable: false,
        },
      },
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('returns a repeated provider-specific cue from persistent cache without another API call', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      response([[['你好。', 'Hello.']]]),
    );
    const store = new MemoryTranslationCacheStore();
    const firstWorker = createBackgroundTranslationHandler({
      fetch,
      readSettings: vi.fn().mockResolvedValue({ provider: 'google-free' }),
      googleOptions: { minStartIntervalMs: 0 },
      cache: new TranslationCache({ store, debounceMs: 0 }),
    });
    const first = await firstWorker(request);
    const restartedWorker = createBackgroundTranslationHandler({
      fetch,
      readSettings: vi.fn().mockResolvedValue({ provider: 'google-free' }),
      googleOptions: { minStartIntervalMs: 0 },
      cache: new TranslationCache({ store, debounceMs: 0 }),
    });
    const second = await restartedWorker({ ...request, id: 'translation-2' });

    expect(first).toMatchObject({ ok: true, value: { payload: { status: 'success' } } });
    expect(second).toMatchObject({
      ok: true,
      value: { payload: { translations: [{ cueId: 'cue-1', text: '你好。' }] } },
    });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('rejects a late old-generation result before response or cache write', async () => {
    let resolveOld = (_response: Response): void => undefined;
    const oldResponse = new Promise<Response>((resolve) => { resolveOld = resolve; });
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockReturnValueOnce(oldResponse)
      .mockResolvedValueOnce(response([[['新', 'New']]]));
    const store = new MemoryTranslationCacheStore();
    const handler = createBackgroundTranslationHandler({
      fetch,
      readSettings: vi.fn().mockResolvedValue({ provider: 'google-free' }),
      googleOptions: { minStartIntervalMs: 0, maxAttempts: 1 },
      cache: new TranslationCache({ store, debounceMs: 0 }),
    });

    const old = handler(request);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    const newerMessage = {
      ...request,
      id: 'translation-new',
      payload: {
        ...request.payload,
        taskId: 'task-new',
        episodeId: 'episode_hash_2',
        episodeGeneration: 2,
        cues: [{ id: 'cue-new', startMs: 0, endMs: 1_000, text: 'New' }],
      },
    };
    const newer = handler(newerMessage);
    resolveOld(response([[['旧', 'Hello.']]]));

    expect(await old).toMatchObject({
      ok: true,
      value: { payload: { status: 'error', errorCode: 'stale_generation' } },
    });
    expect(await newer).toMatchObject({
      ok: true,
      value: { payload: { status: 'success' } },
    });
    expect(store.records.map(({ cueId }) => cueId)).toEqual(['cue-new']);
  });

  it('isolates generation state between concurrent playback sessions', async () => {
    let resolveFirst = (_response: Response): void => undefined;
    const firstResponse = new Promise<Response>((resolve) => { resolveFirst = resolve; });
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockReturnValueOnce(firstResponse)
      .mockResolvedValueOnce(response([[['第二个', 'Second']]]));
    const handler = createBackgroundTranslationHandler({
      fetch,
      readSettings: vi.fn().mockResolvedValue({ provider: 'google-free' }),
      googleOptions: { minStartIntervalMs: 0, maxAttempts: 1 },
    });

    const first = handler(request);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    const second = handler({
      ...request,
      id: 'translation-session-2',
      payload: {
        ...request.payload,
        taskId: 'task-session-2',
        sessionId: 'session-2',
        episodeId: 'episode_hash_2',
        episodeGeneration: 2,
        cues: [{ id: 'cue-2', startMs: 0, endMs: 1_000, text: 'Second' }],
      },
    });

    await expect(second).resolves.toMatchObject({
      ok: true,
      value: { payload: { status: 'success', sessionId: 'session-2' } },
    });
    resolveFirst(response([[['第一个', 'Hello.']]]));
    await expect(first).resolves.toMatchObject({
      ok: true,
      value: { payload: { status: 'success', sessionId: 'session-1' } },
    });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('rechecks generation after an asynchronous settings read before fetch', async () => {
    let resolveOldSettings = (_value: unknown): void => undefined;
    const oldSettings = new Promise<unknown>((resolve) => {
      resolveOldSettings = resolve;
    });
    const readSettings = vi.fn()
      .mockReturnValueOnce(oldSettings)
      .mockResolvedValueOnce({ provider: 'google-free' });
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      response([[['新的', 'New']]]),
    );
    const handler = createBackgroundTranslationHandler({
      fetch,
      readSettings,
      googleOptions: { minStartIntervalMs: 0, maxAttempts: 1 },
    });

    const old = handler(request);
    await vi.waitFor(() => expect(readSettings).toHaveBeenCalledOnce());
    const newer = handler({
      ...request,
      id: 'translation-new-settings',
      payload: {
        ...request.payload,
        taskId: 'task-new-settings',
        episodeGeneration: 2,
        cues: [{ id: 'cue-new', startMs: 0, endMs: 1_000, text: 'New' }],
      },
    });
    await expect(newer).resolves.toMatchObject({
      ok: true,
      value: { payload: { status: 'success' } },
    });
    resolveOldSettings({ provider: 'google-free' });

    await expect(old).resolves.toMatchObject({
      ok: true,
      value: { payload: { errorCode: 'stale_generation' } },
    });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('explicitly cancels a disposed playback session without a follow-up request or cache write', async () => {
    let resolveResponse = (_response: Response): void => undefined;
    const pendingResponse = new Promise<Response>((resolve) => {
      resolveResponse = resolve;
    });
    const fetch = vi.fn<typeof globalThis.fetch>().mockReturnValue(pendingResponse);
    const readSettings = vi.fn().mockResolvedValue({ provider: 'google-free' });
    const store = new MemoryTranslationCacheStore();
    const handler = createBackgroundTranslationHandler({
      fetch,
      readSettings,
      googleOptions: { minStartIntervalMs: 0, maxAttempts: 1 },
      cache: new TranslationCache({ store, debounceMs: 0 }),
    });

    const inFlight = handler(request);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    const cancellation = await handler(createMessage({
      id: 'translation-cancel-1',
      source: 'content',
      type: 'translation/cancel',
      payload: {
        sessionId: request.payload.sessionId,
        episodeGeneration: request.payload.episodeGeneration,
        providerGeneration: request.payload.providerGeneration,
        reason: 'player-disposed',
      },
    }));
    resolveResponse(response([[['过期译文', 'Hello.']]]));

    expect(cancellation).toMatchObject({
      ok: true,
      value: {
        source: 'background',
        type: 'translation/cancelled',
        payload: { sessionId: 'session-1', accepted: true },
      },
    });
    await expect(inFlight).resolves.toMatchObject({
      ok: true,
      value: { payload: { status: 'error', errorCode: 'stale_generation' } },
    });
    expect(store.records).toEqual([]);
    expect(readSettings).toHaveBeenCalledOnce();

    await expect(handler({ ...request, id: 'stale-after-dispose' })).resolves.toMatchObject({
      ok: true,
      value: { payload: { errorCode: 'stale_generation' } },
    });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('cancels only the addressed playback session', async () => {
    let resolveFirst = (_response: Response): void => undefined;
    let resolveSecond = (_response: Response): void => undefined;
    const firstResponse = new Promise<Response>((resolve) => { resolveFirst = resolve; });
    const secondResponse = new Promise<Response>((resolve) => { resolveSecond = resolve; });
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockReturnValueOnce(firstResponse)
      .mockReturnValueOnce(secondResponse);
    const handler = createBackgroundTranslationHandler({
      fetch,
      readSettings: vi.fn().mockResolvedValue({ provider: 'google-free' }),
      googleOptions: { minStartIntervalMs: 0, maxAttempts: 1 },
    });
    const otherRequest = {
      ...request,
      id: 'translation-session-2',
      payload: {
        ...request.payload,
        taskId: 'task-session-2',
        sessionId: 'session-2',
        cues: [{ id: 'cue-2', startMs: 0, endMs: 1_000, text: 'Second' }],
      },
    };

    const first = handler(request);
    const second = handler(otherRequest);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    await handler(createMessage({
      id: 'cancel-session-1',
      source: 'content',
      type: 'translation/cancel',
      payload: {
        sessionId: 'session-1',
        episodeGeneration: 1,
        providerGeneration: 1,
        reason: 'disabled',
      },
    }));
    resolveFirst(response([[['过期', 'Hello.']]]));
    resolveSecond(response([[['第二个', 'Second']]]));

    await expect(first).resolves.toMatchObject({
      ok: true,
      value: { payload: { errorCode: 'stale_generation' } },
    });
    await expect(second).resolves.toMatchObject({
      ok: true,
      value: {
        payload: {
          status: 'success',
          sessionId: 'session-2',
          translations: [{ cueId: 'cue-2', text: '第二个' }],
        },
      },
    });
  });

  it('treats a cache read failure as a miss and still returns a valid translation', async () => {
    const failingStore: TranslationCacheStore = {
      get: vi.fn().mockRejectedValue(new Error('private cache failure')),
      put: vi.fn().mockResolvedValue(undefined),
      deleteEpisode: vi.fn().mockResolvedValue(undefined),
      clear: vi.fn().mockResolvedValue(undefined),
    };
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      response([[['你好。', 'Hello.']]]),
    );
    const handler = createBackgroundTranslationHandler({
      fetch,
      readSettings: vi.fn().mockResolvedValue({ provider: 'google-free' }),
      googleOptions: { minStartIntervalMs: 0, maxAttempts: 1 },
      cache: new TranslationCache({ store: failingStore, debounceMs: 0 }),
    });

    await expect(handler(request)).resolves.toMatchObject({
      ok: true,
      value: { payload: { status: 'success' } },
    });
    expect(fetch).toHaveBeenCalledOnce();
  });
});
