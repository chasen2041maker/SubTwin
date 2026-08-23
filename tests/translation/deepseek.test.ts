import { describe, expect, it, vi } from 'vitest';

import { PersonalDeepSeekProvider } from '../../src/translation/deepseek';
import { TranslationProviderRouter } from '../../src/translation/provider';
import type {
  TranslationProvider,
  TranslationRequest,
} from '../../src/translation/types';

const request: TranslationRequest = {
  taskId: 'task-1',
  sessionId: 'session-1',
  episodeId: 'episode_hash_1',
  trackHash: 'track_hash_1',
  provider: 'deepseek',
  sourceLanguage: 'en',
  targetLanguage: 'zh-Hans',
  episodeGeneration: 2,
  providerGeneration: 3,
  cues: [
    { id: 'cue-1', startMs: 0, endMs: 1_000, text: 'Hello.' },
    { id: 'cue-2', startMs: 1_000, endMs: 2_000, text: 'Come in.' },
  ],
  context: [
    { id: 'context-0', startMs: 0, endMs: 1, text: 'Previously' },
  ],
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function oversizedChunkedResponse(
  chunkSize: number,
  onCancel: (reason: unknown) => void,
): Response {
  let emitted = 0;
  return new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      if (emitted < 2) {
        emitted += 1;
        controller.enqueue(new Uint8Array(chunkSize).fill(120));
      } else {
        controller.close();
      }
    },
    cancel: onCancel,
  }, { highWaterMark: 0 }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

describe('PersonalDeepSeekProvider', () => {
  it('sends a strict contextual request and maps stable cue IDs', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      jsonResponse({
        choices: [{
          finish_reason: 'stop',
          message: {
            content: JSON.stringify({
              translations: [
                { id: 'cue-1', text: '你好。' },
                { id: 'cue-2', text: '进来。' },
              ],
            }),
          },
        }],
      }),
    );
    const provider = new PersonalDeepSeekProvider({
      apiKey: 'test-key-not-real',
      fetch,
      model: 'deepseek-v4-flash',
    });

    const result = await provider.translate(request, new AbortController().signal);

    expect(result).toEqual({
      ok: true,
      value: {
        translations: [
          { cueId: 'cue-1', text: '你好。' },
          { cueId: 'cue-2', text: '进来。' },
        ],
        retryCueIds: [],
      },
    });
    expect(fetch).toHaveBeenCalledOnce();
    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(url).toBe('https://api.deepseek.com/chat/completions');
    expect(init?.method).toBe('POST');
    expect(init?.headers).toMatchObject({
      Authorization: 'Bearer test-key-not-real',
      'Content-Type': 'application/json',
    });
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    expect(body).toMatchObject({
      model: 'deepseek-v4-flash',
      response_format: { type: 'json_object' },
      thinking: { type: 'disabled' },
    });
    expect(JSON.stringify(body)).toContain('context-0');
    expect(JSON.stringify(body)).toContain('cue-1');
  });

  it.each([
    ['missing ID', JSON.stringify({ translations: [{ id: 'cue-1', text: '你好' }] }), ['cue-2']],
    ['duplicate ID', JSON.stringify({ translations: [
      { id: 'cue-1', text: '你好' },
      { id: 'cue-1', text: '重复' },
      { id: 'cue-2', text: '进来' },
    ] }), ['cue-1']],
    ['empty output', JSON.stringify({ translations: [
      { id: 'cue-1', text: '' },
      { id: 'cue-2', text: '进来' },
    ] }), ['cue-1']],
    ['explanatory output', JSON.stringify({ translations: [
      { id: 'cue-1', text: 'Translation: 你好' },
      { id: 'cue-2', text: '进来' },
    ] }), ['cue-1']],
    ['unchanged output', JSON.stringify({ translations: [
      { id: 'cue-1', text: 'Hello.' },
      { id: 'cue-2', text: '进来' },
    ] }), ['cue-1']],
    ['case-only English output', JSON.stringify({ translations: [
      { id: 'cue-1', text: '  hello!  ' },
      { id: 'cue-2', text: '进来' },
    ] }), ['cue-1']],
    ['implausibly long output', JSON.stringify({ translations: [
      { id: 'cue-1', text: '很'.repeat(500) },
      { id: 'cue-2', text: '进来' },
    ] }), ['cue-1']],
  ])('keeps valid cues and selects only %s cues for partial retry', async (_name, content, retryCueIds) => {
    const provider = new PersonalDeepSeekProvider({
      apiKey: 'test-key-not-real',
      fetch: vi.fn<typeof globalThis.fetch>().mockResolvedValue(
        jsonResponse({ choices: [{ finish_reason: 'stop', message: { content } }] }),
      ),
    });

    const result = await provider.translate(request, new AbortController().signal);

    expect(result).toMatchObject({ ok: true, value: { retryCueIds } });
    if (result.ok) {
      for (const cue of result.value.translations) {
        expect(retryCueIds).not.toContain(cue.cueId);
      }
    }
  });

  it.each([
    ['invalid JSON', 'not-json'],
    ['unknown ID', JSON.stringify({ translations: [
      { id: 'cue-1', text: '你好' },
      { id: 'unknown', text: '不可信' },
    ] })],
  ])('rejects an untrusted whole batch for %s', async (_name, content) => {
    const provider = new PersonalDeepSeekProvider({
      apiKey: 'test-key-not-real',
      fetch: vi.fn<typeof globalThis.fetch>().mockResolvedValue(
        jsonResponse({ choices: [{ finish_reason: 'stop', message: { content } }] }),
      ),
    });

    const result = await provider.translate(request, new AbortController().signal);

    expect(result).toMatchObject({
      ok: false,
      error: { code: 'invalid_response', retryable: false },
    });
  });

  it.each([
    [401, 'authentication_failed', false],
    [402, 'insufficient_balance', false],
    [429, 'rate_limited', true],
    [500, 'provider_unavailable', true],
  ])('classifies HTTP %i without exposing response details', async (status, code, retryable) => {
    const provider = new PersonalDeepSeekProvider({
      apiKey: 'test-key-not-real',
      fetch: vi.fn<typeof globalThis.fetch>().mockResolvedValue(
        jsonResponse({ error: { message: 'sensitive upstream detail' } }, status),
      ),
    });

    const result = await provider.translate(request, new AbortController().signal);

    expect(result).toMatchObject({ ok: false, error: { code, retryable } });
    expect(JSON.stringify(result)).not.toContain('sensitive upstream detail');
    expect(JSON.stringify(result)).not.toContain('test-key-not-real');
  });

  it('classifies timeout and network failure without leaking cue text', async () => {
    const timeoutFetch = vi.fn<typeof globalThis.fetch>().mockRejectedValue(
      new DOMException('Hello. leaked', 'TimeoutError'),
    );
    const provider = new PersonalDeepSeekProvider({
      apiKey: 'test-key-not-real',
      fetch: timeoutFetch,
    });
    const result = await provider.translate(request, new AbortController().signal);

    expect(result).toMatchObject({
      ok: false,
      error: { code: 'timeout', retryable: true },
    });
    expect(JSON.stringify(result)).not.toContain('Hello.');
  });

  it('rejects a legacy or unknown model before fetch', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const provider = new PersonalDeepSeekProvider({
      apiKey: 'test-key-not-real',
      fetch,
      model: 'deepseek-chat',
    });

    const result = await provider.translate(request, new AbortController().signal);

    expect(result).toMatchObject({
      ok: false,
      error: { code: 'invalid_configuration', retryable: false },
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('makes zero calls when already aborted or request text exceeds the bound', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const provider = new PersonalDeepSeekProvider({
      apiKey: 'test-key-not-real',
      fetch,
    });
    const controller = new AbortController();
    controller.abort();

    const aborted = await provider.translate(request, controller.signal);
    const oversized = await provider.translate({
      ...request,
      cues: [{ ...request.cues[0]!, text: 'x'.repeat(70_000) }],
    }, new AbortController().signal);

    expect(aborted).toMatchObject({ ok: false, error: { code: 'aborted' } });
    expect(oversized).toMatchObject({ ok: false, error: { code: 'invalid_request' } });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects an oversized response before parsing it', async () => {
    const provider = new PersonalDeepSeekProvider({
      apiKey: 'test-key-not-real',
      fetch: vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response('x', {
        status: 200,
        headers: { 'content-length': '2000000' },
      })),
    });

    const result = await provider.translate(request, new AbortController().signal);

    expect(result).toMatchObject({ ok: false, error: { code: 'invalid_response' } });
  });

  it('cancels a chunked response without Content-Length as soon as it exceeds the byte limit', async () => {
    const cancel = vi.fn();
    const provider = new PersonalDeepSeekProvider({
      apiKey: 'test-key-not-real',
      fetch: vi.fn<typeof globalThis.fetch>().mockResolvedValue(
        oversizedChunkedResponse(600 * 1024, cancel),
      ),
    });

    const result = await provider.translate(request, new AbortController().signal);

    expect(result).toMatchObject({
      ok: false,
      error: { code: 'invalid_response', retryable: false },
    });
    expect(cancel).toHaveBeenCalledOnce();
    expect(JSON.stringify(result)).not.toContain('test-key-not-real');
    expect(JSON.stringify(result)).not.toContain('Hello.');
  });

  it.each([
    ['length', 'invalid_response', true],
    ['content_filter', 'invalid_response', false],
    ['tool_calls', 'invalid_response', false],
    ['insufficient_system_resource', 'provider_unavailable', true],
  ])('does not accept finish_reason=%s', async (finishReason, code, retryable) => {
    const provider = new PersonalDeepSeekProvider({
      apiKey: 'test-key-not-real',
      fetch: vi.fn<typeof globalThis.fetch>().mockResolvedValue(jsonResponse({
        choices: [{
          finish_reason: finishReason,
          message: { content: JSON.stringify({ translations: [] }) },
        }],
      })),
    });

    const result = await provider.translate(request, new AbortController().signal);

    expect(result).toMatchObject({ ok: false, error: { code, retryable } });
  });
});

describe('explicit provider routing', () => {
  it('never invokes another provider after the selected provider fails', async () => {
    const deepseek: TranslationProvider = {
      id: 'deepseek',
      contractVersion: 'deepseek-v1',
      translate: vi.fn().mockResolvedValue({
        ok: false,
        error: { code: 'provider_unavailable', message: 'Unavailable.', retryable: true },
      }),
    };
    const google: TranslationProvider = {
      id: 'google-free',
      contractVersion: 'google-free-v1',
      translate: vi.fn(),
    };
    const router = new TranslationProviderRouter([google, deepseek]);

    const result = await router.translate(request, new AbortController().signal);

    expect(result.ok).toBe(false);
    expect(deepseek.translate).toHaveBeenCalledOnce();
    expect(google.translate).not.toHaveBeenCalled();
  });

  it('provider=unset returns locally with zero provider calls', async () => {
    const provider: TranslationProvider = {
      id: 'google-free',
      contractVersion: 'google-free-v1',
      translate: vi.fn(),
    };
    const router = new TranslationProviderRouter([provider]);

    const result = await router.translate(
      { ...request, provider: 'unset' },
      new AbortController().signal,
    );

    expect(result).toMatchObject({
      ok: false,
      error: { code: 'provider_unset', retryable: false },
    });
    expect(provider.translate).not.toHaveBeenCalled();
  });
});
