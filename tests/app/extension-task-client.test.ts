import { describe, expect, it, vi } from 'vitest';

import {
  createExtensionTranslationTaskClient,
  type ExtensionTranslationTaskClient,
} from '../../src/app/extension-task-client';
import type { TranslationTaskCallbacks } from '../../src/app/session-controller';
import { createMessage, parseMessageEnvelope, type MessageFor } from '../../src/shared/messages';
import { ok } from '../../src/shared/result';
import type { ScheduledTranslationTask } from '../../src/translation/scheduler';

function task(
  provider: 'deepseek' | 'google-free' = 'deepseek',
  episodeGeneration = 1,
  providerGeneration = 1,
): ScheduledTranslationTask {
  return {
    taskId: `task-${provider}-${episodeGeneration}-${providerGeneration}`,
    sessionId: 'session-1',
    episodeId: 'episode-1',
    trackHash: 'track-hash-1',
    provider,
    sourceLanguage: 'en',
    targetLanguage: 'zh-Hans',
    episodeGeneration,
    providerGeneration,
    priority: 'urgent',
    cues: [{ id: 'cue-1', startMs: 0, endMs: 1_000, text: 'Hello.' }],
    context: [],
  };
}

function callbacks() {
  return {
    isCurrent: () => true,
    onCache: vi.fn<TranslationTaskCallbacks['onCache']>(),
    onError: vi.fn<TranslationTaskCallbacks['onError']>(),
    onResult: vi.fn<TranslationTaskCallbacks['onResult']>(),
  } satisfies TranslationTaskCallbacks;
}

function resultFor(
  request: MessageFor<'translation/request'>,
  text = '你好。',
): ReturnType<typeof ok<MessageFor<'translation/result'>>> {
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
      translations: [{ cueId: request.payload.cues[0]!.id, text }],
      retryCueIds: [],
      errorCode: null,
      retryable: false,
    },
  }));
}

function parsedRequest(candidate: unknown): MessageFor<'translation/request'> {
  const parsed = parseMessageEnvelope(candidate);
  if (!parsed.ok || parsed.value.type !== 'translation/request') {
    throw new Error('Expected a translation request.');
  }
  return parsed.value;
}

describe('extension translation task client', () => {
  it('sends a credential-free exact request and delivers a correlated result', async () => {
    const sent: unknown[] = [];
    const sendMessage = vi.fn(async (candidate: unknown) => {
      sent.push(candidate);
      return resultFor(parsedRequest(candidate));
    });
    const client = createExtensionTranslationTaskClient({ sendMessage });
    const sink = callbacks();

    client.enqueue(task(), sink);
    await client.whenIdle();

    expect(sink.onResult).toHaveBeenCalledWith({
      translations: [{ cueId: 'cue-1', text: '你好。' }],
      retryCueIds: [],
    });
    expect(sink.onError).not.toHaveBeenCalled();
    expect(sink.onCache).not.toHaveBeenCalled();
    expect(JSON.stringify(sent)).not.toMatch(/apiKey|Authorization|Bearer/iu);
  });

  it('rejects a mismatched provider/generation response as invalid', async () => {
    const sendMessage = vi.fn(async (candidate: unknown) => {
      const request = parsedRequest(candidate);
      const response = resultFor(request);
      if (!response.ok) return response;
      return ok({
        ...response.value,
        payload: { ...response.value.payload, providerGeneration: 99 },
      });
    });
    const client = createExtensionTranslationTaskClient({ sendMessage });
    const sink = callbacks();

    client.enqueue(task(), sink);
    await client.whenIdle();

    expect(sink.onResult).not.toHaveBeenCalled();
    expect(sink.onError).toHaveBeenCalledWith(expect.objectContaining({
      code: 'invalid_response',
      retryable: false,
    }));
  });

  it('serializes old-generation cancellation before the next request and drops late results', async () => {
    let resolveOld: ((value: unknown) => void) | undefined;
    let resolveCancel: ((value: unknown) => void) | undefined;
    const order: string[] = [];
    const sendMessage = vi.fn((candidate: unknown): Promise<unknown> => {
      const parsed = parseMessageEnvelope(candidate);
      if (!parsed.ok) return Promise.resolve(parsed);
      if (parsed.value.type === 'translation/cancel') {
        order.push('cancel');
        return new Promise((resolve) => { resolveCancel = resolve; });
      }
      if (parsed.value.type !== 'translation/request') {
        return Promise.resolve(undefined);
      }
      order.push(`request:${parsed.value.payload.providerGeneration}`);
      if (parsed.value.payload.providerGeneration === 1) {
        return new Promise((resolve) => { resolveOld = resolve; });
      }
      return Promise.resolve(resultFor(parsed.value, '新结果'));
    });
    const client = createExtensionTranslationTaskClient({ sendMessage });
    const oldSink = callbacks();
    const nextSink = callbacks();

    client.enqueue(task('deepseek', 1, 1), oldSink);
    await vi.waitFor(() => expect(order).toEqual(['request:1']));
    client.cancel(
      { episodeGeneration: 1, providerGeneration: 1 },
      'provider-change',
    );
    client.enqueue(task('google-free', 1, 2), nextSink);
    await vi.waitFor(() => expect(order).toEqual(['request:1', 'cancel']));
    expect(order).not.toContain('request:2');

    resolveCancel?.(undefined);
    await vi.waitFor(() => expect(order).toContain('request:2'));
    await client.whenIdle();
    expect(nextSink.onResult).toHaveBeenCalledWith(expect.objectContaining({
      translations: [{ cueId: 'cue-1', text: '新结果' }],
    }));

    const oldRequest = parsedRequest(sendMessage.mock.calls[0]![0]);
    resolveOld?.(resultFor(oldRequest, '迟到结果'));
    await Promise.resolve();
    expect(oldSink.onResult).not.toHaveBeenCalled();
  });

  it('keeps retryable provider errors cue-local and allows later retry', async () => {
    const providers: string[] = [];
    const status = vi.fn();
    const sendMessage = vi.fn(async (candidate: unknown) => {
      const request = parsedRequest(candidate);
      providers.push(request.payload.provider);
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
          errorCode: 'rate_limited',
          retryable: true,
        },
      }));
    });
    const client = createExtensionTranslationTaskClient({
      sendMessage,
      onRuntimeStatus: status,
    });
    const sink = callbacks();
    const scheduled = task('google-free');

    client.enqueue(scheduled, sink);
    await client.whenIdle();
    client.enqueue(scheduled, sink);
    await client.whenIdle();

    expect(providers).toEqual(['google-free', 'google-free']);
    expect(sink.onError).not.toHaveBeenCalled();
    expect(status).toHaveBeenLastCalledWith({ mode: 'error', code: 'rate_limited' });
  });

  it('contains Google cue validation failures without disabling the episode', async () => {
    const status = vi.fn();
    const sendMessage = vi.fn(async (candidate: unknown) => {
      const request = parsedRequest(candidate);
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
          errorCode: 'invalid_response',
          retryable: false,
        },
      }));
    });
    const client = createExtensionTranslationTaskClient({
      sendMessage,
      onRuntimeStatus: status,
    });
    const sink = callbacks();

    client.enqueue(task('google-free'), sink);
    await client.whenIdle();

    expect(sink.onError).not.toHaveBeenCalled();
    expect(status).toHaveBeenLastCalledWith({
      mode: 'error',
      code: 'provider_unavailable',
    });
  });

  it('publishes offline after containing a transport failure', async () => {
    const status = vi.fn();
    const client = createExtensionTranslationTaskClient({
      sendMessage: vi.fn(async () => {
        throw new Error('runtime unavailable');
      }),
      isOnline: () => false,
      onRuntimeStatus: status,
    });
    const sink = callbacks();

    client.enqueue(task(), sink);
    await client.whenIdle();

    expect(sink.onError).not.toHaveBeenCalled();
    expect(status).toHaveBeenLastCalledWith({ mode: 'error', code: 'offline' });
  });

  it('contains malformed outer results and supports idempotent disposal', async () => {
    const client: ExtensionTranslationTaskClient =
      createExtensionTranslationTaskClient({
        sendMessage: vi.fn(async () => ({ ok: true, value: { secret: 'bad' } })),
      });
    const sink = callbacks();

    client.enqueue(task(), sink);
    await client.whenIdle();
    client.dispose();
    client.dispose();
    client.enqueue(task('google-free', 2, 2), callbacks());

    expect(sink.onError).toHaveBeenCalledWith(expect.objectContaining({
      code: 'invalid_response',
    }));
  });
});
