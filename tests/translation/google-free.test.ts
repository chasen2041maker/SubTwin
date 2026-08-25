import { describe, expect, it, vi } from 'vitest';

import { GoogleFreeProvider } from '../../src/translation/google-free';
import type { TranslationRequest } from '../../src/translation/types';

const request: TranslationRequest = {
  taskId: 'google-task-1',
  sessionId: 'session-1',
  episodeId: 'episode_hash_1',
  trackHash: 'track_hash_1',
  provider: 'google-free',
  sourceLanguage: 'en',
  targetLanguage: 'zh-Hans',
  episodeGeneration: 1,
  providerGeneration: 1,
  cues: [{ id: 'cue-1', startMs: 0, endMs: 1_000, text: 'How are you?' }],
  context: [],
};

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
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
  }, { highWaterMark: 0 }), { status: 200 });
}

describe('GoogleFreeProvider', () => {
  it('uses the fixed no-key mapping and joins translated segments', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      response([[['你好', 'Hello'], ['吗？', '?']]]),
    );
    const provider = new GoogleFreeProvider({ fetch, minStartIntervalMs: 0 });

    const result = await provider.translate(request, new AbortController().signal);

    expect(result).toEqual({
      ok: true,
      value: {
        translations: [{ cueId: 'cue-1', text: '你好吗？' }],
        retryCueIds: [],
      },
    });
    const [rawUrl, init] = fetch.mock.calls[0] ?? [];
    const url = new URL(String(rawUrl));
    expect(`${url.origin}${url.pathname}`).toBe(
      'https://translate.googleapis.com/translate_a/single',
    );
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      client: 'gtx',
      sl: 'en',
      tl: 'zh-CN',
      dt: 't',
      q: 'How are you?',
    });
    expect(init).toMatchObject({ method: 'GET' });
  });

  it('rejects batches because the experimental contract translates one cue at a time', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const provider = new GoogleFreeProvider({ fetch });

    const result = await provider.translate({
      ...request,
      cues: [...request.cues, { id: 'cue-2', startMs: 1_000, endMs: 2_000, text: 'Next' }],
    }, new AbortController().signal);

    expect(result).toMatchObject({
      ok: false,
      error: { code: 'invalid_request', retryable: false },
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('cancels a chunked response without Content-Length as soon as it exceeds the byte limit', async () => {
    const cancel = vi.fn();
    const provider = new GoogleFreeProvider({
      fetch: vi.fn<typeof globalThis.fetch>().mockResolvedValue(
        oversizedChunkedResponse(160 * 1024, cancel),
      ),
      maxAttempts: 1,
      minStartIntervalMs: 0,
    });

    const result = await provider.translate(request, new AbortController().signal);

    expect(result).toMatchObject({
      ok: false,
      error: { code: 'invalid_response', retryable: false },
    });
    expect(cancel).toHaveBeenCalledOnce();
    expect(JSON.stringify(result)).not.toContain('How are you?');
    expect(JSON.stringify(result)).not.toContain('translate.googleapis.com');
  });

  it('rejects an oversized cue before constructing or dispatching a GET URL', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const provider = new GoogleFreeProvider({ fetch });

    const result = await provider.translate({
      ...request,
      cues: [{ ...request.cues[0]!, text: 'x'.repeat(40_000) }],
    }, new AbortController().signal);

    expect(result).toMatchObject({
      ok: false,
      error: { code: 'invalid_request', retryable: false },
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    [[], 'invalid_response'],
    [[[]], 'invalid_response'],
    [[[['', 'source']]], 'invalid_response'],
    [[[['same', 'same']]], 'invalid_response'],
    [{ translatedText: '你好' }, 'invalid_response'],
  ])('rejects changed, malformed, empty, or unchanged response shape %#', async (body, code) => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response(body));
    const provider = new GoogleFreeProvider({ fetch, minStartIntervalMs: 0 });
    const sourceRequest = body === (undefined as unknown)
      ? request
      : { ...request, cues: [{ ...request.cues[0]!, text: 'same' }] };

    const result = await provider.translate(sourceRequest, new AbortController().signal);

    expect(result).toMatchObject({ ok: false, error: { code, retryable: false } });
  });

  it.each([
    ['case-only English', [[['  how are you!  ', 'How are you?']]]],
    ['implausibly long output', [[['很'.repeat(500), 'How are you?']]]],
  ])('rejects %s as an invalid translation', async (_name, body) => {
    const provider = new GoogleFreeProvider({
      fetch: vi.fn<typeof globalThis.fetch>().mockResolvedValue(response(body)),
      minStartIntervalMs: 0,
    });

    const result = await provider.translate(request, new AbortController().signal);

    expect(result).toMatchObject({
      ok: false,
      error: { code: 'invalid_response', retryable: false },
    });
  });

  it.each([
    'Netflix',
    'FBI',
    '2024',
    'John',
    'ChatGPT',
    'https://example.com/show',
    '@SubTwin',
  ])('accepts an unchanged protected token: %s', async (sourceText) => {
    const provider = new GoogleFreeProvider({
      fetch: vi.fn<typeof globalThis.fetch>().mockResolvedValue(
        response([[[sourceText, sourceText]]]),
      ),
      minStartIntervalMs: 0,
    });
    const sourceRequest: TranslationRequest = {
      ...request,
      cues: [{ ...request.cues[0]!, text: sourceText }],
    };

    const result = await provider.translate(
      sourceRequest,
      new AbortController().signal,
    );

    expect(result).toEqual({
      ok: true,
      value: {
        translations: [{ cueId: 'cue-1', text: sourceText }],
        retryCueIds: [],
      },
    });
  });

  it('never retries 403', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response({}, 403));
    const provider = new GoogleFreeProvider({ fetch, minStartIntervalMs: 0 });

    const result = await provider.translate(request, new AbortController().signal);

    expect(result).toMatchObject({
      ok: false,
      error: { code: 'provider_forbidden', retryable: false },
    });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('bounds 429 retries and enters cooldown after repeated rate limits', async () => {
    let now = 0;
    const sleeps: number[] = [];
    const clock = {
      now: () => now,
      sleep: vi.fn(async (ms: number) => { sleeps.push(ms); now += ms; }),
    };
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response({}, 429));
    const provider = new GoogleFreeProvider({
      fetch,
      clock,
      maxAttempts: 2,
      minStartIntervalMs: 200,
      cooldownMs: 5_000,
      rateLimitCooldownThreshold: 2,
    });

    const first = await provider.translate(request, new AbortController().signal);
    const callsAfterFirst = fetch.mock.calls.length;
    const second = await provider.translate(
      { ...request, taskId: 'google-task-2' },
      new AbortController().signal,
    );

    expect(first).toMatchObject({ ok: false, error: { code: 'rate_limited' } });
    expect(second).toMatchObject({ ok: false, error: { code: 'rate_limited' } });
    expect(callsAfterFirst).toBe(2);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(sleeps.some((ms) => ms >= 200)).toBe(true);
  });

  it('allows at most two in flight and spaces request starts by 200ms', async () => {
    let now = 0;
    let active = 0;
    let peak = 0;
    const starts: number[] = [];
    const releases: Array<() => void> = [];
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async () => {
      starts.push(now);
      active += 1;
      peak = Math.max(peak, active);
      await new Promise<void>((resolve) => releases.push(resolve));
      active -= 1;
      return response([[['好', 'x']]]);
    });
    const provider = new GoogleFreeProvider({
      fetch,
      clock: {
        now: () => now,
        sleep: async (ms) => { now += ms; },
      },
    });
    const jobs = [1, 2, 3].map((number) => provider.translate({
      ...request,
      taskId: `task-${number}`,
      cues: [{ ...request.cues[0]!, id: `cue-${number}`, text: `x${number}` }],
    }, new AbortController().signal));
    await vi.waitFor(() => expect(starts).toHaveLength(2));
    releases.shift()?.();
    await vi.waitFor(() => expect(starts).toHaveLength(3));
    while (releases.length > 0) releases.shift()?.();
    await Promise.all(jobs);

    expect(peak).toBe(2);
    expect(starts).toEqual([0, 200, 400]);
  });

  it('classifies timeouts and endpoint failures without including the GET URL or cue text', async () => {
    const provider = new GoogleFreeProvider({
      fetch: vi.fn<typeof globalThis.fetch>().mockRejectedValue(
        new DOMException('https://translate.googleapis.com/?q=How%20are%20you', 'TimeoutError'),
      ),
      minStartIntervalMs: 0,
      maxAttempts: 1,
    });

    const result = await provider.translate(request, new AbortController().signal);

    expect(result).toMatchObject({ ok: false, error: { code: 'timeout', retryable: true } });
    expect(JSON.stringify(result)).not.toContain('translate.googleapis.com');
    expect(JSON.stringify(result)).not.toContain('How are you');
  });

  it('returns a typed abort while queued for a permit and never dispatches it', async () => {
    let releaseFirst = (): void => undefined;
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async () => {
      await new Promise<void>((resolve) => { releaseFirst = resolve; });
      return response([[['好', 'x']]]);
    });
    const provider = new GoogleFreeProvider({
      fetch,
      maxConcurrent: 1,
      minStartIntervalMs: 0,
    });
    const first = provider.translate(request, new AbortController().signal);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    const controller = new AbortController();
    const queued = provider.translate(
      { ...request, taskId: 'queued', cues: [{ ...request.cues[0]!, id: 'queued' }] },
      controller.signal,
    );
    controller.abort();

    await expect(queued).resolves.toMatchObject({
      ok: false,
      error: { code: 'aborted', retryable: false },
    });
    expect(fetch).toHaveBeenCalledOnce();
    releaseFirst();
    await first;
  });

  it('rechecks cooldown after a queued job acquires its permit', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response({}, 429));
    const provider = new GoogleFreeProvider({
      fetch,
      maxConcurrent: 1,
      maxAttempts: 1,
      minStartIntervalMs: 0,
      rateLimitCooldownThreshold: 1,
    });

    const [first, queued] = await Promise.all([
      provider.translate(request, new AbortController().signal),
      provider.translate(
        { ...request, taskId: 'queued', cues: [{ ...request.cues[0]!, id: 'queued' }] },
        new AbortController().signal,
      ),
    ]);

    expect(first).toMatchObject({ ok: false, error: { code: 'rate_limited' } });
    expect(queued).toMatchObject({ ok: false, error: { code: 'rate_limited' } });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('aborts an unavailable endpoint at the provider timeout', async () => {
    vi.useFakeTimers();
    try {
      const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(
        async (_input, init) => new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new DOMException('timed out URL and text', 'AbortError'));
          }, { once: true });
        }),
      );
      const provider = new GoogleFreeProvider({
        fetch,
        maxAttempts: 1,
        minStartIntervalMs: 0,
        requestTimeoutMs: 1_000,
      });

      const pending = provider.translate(request, new AbortController().signal);
      await vi.advanceTimersByTimeAsync(1_000);

      await expect(pending).resolves.toMatchObject({
        ok: false,
        error: { code: 'timeout', retryable: true },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the provider timeout active while reading a stalled response body', async () => {
    vi.useFakeTimers();
    const lifecycle = new AbortController();
    try {
      const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(
        async (_input, init) => new Response(new ReadableStream<Uint8Array>({
          start(controller) {
            const rejectAbort = () => {
              controller.error(new DOMException('private body detail', 'AbortError'));
            };
            init?.signal?.addEventListener('abort', rejectAbort, { once: true });
            lifecycle.signal.addEventListener('abort', rejectAbort, { once: true });
          },
        }), { status: 200 }),
      );
      const provider = new GoogleFreeProvider({
        fetch,
        maxAttempts: 1,
        minStartIntervalMs: 0,
        requestTimeoutMs: 1_000,
      });
      let settled = false;
      const pending = provider.translate(request, lifecycle.signal).finally(() => {
        settled = true;
      });

      await vi.advanceTimersByTimeAsync(1_000);
      await Promise.resolve();

      expect(settled).toBe(true);
      await expect(pending).resolves.toMatchObject({
        ok: false,
        error: { code: 'timeout', retryable: true },
      });
    } finally {
      lifecycle.abort();
      await vi.runAllTimersAsync();
      vi.useRealTimers();
    }
  });

  it('clears its timeout when lifecycle aborts during dispatch spacing', async () => {
    vi.useFakeTimers();
    try {
      const provider = new GoogleFreeProvider({
        fetch: vi.fn<typeof globalThis.fetch>().mockResolvedValue(
          response([[['好', 'source']]]),
        ),
        maxAttempts: 1,
        minStartIntervalMs: 200,
        requestTimeoutMs: 1_000,
      });
      await provider.translate(request, new AbortController().signal);
      const lifecycle = new AbortController();
      const pending = provider.translate(
        {
          ...request,
          taskId: 'spacing-abort',
          cues: [{ ...request.cues[0]!, id: 'spacing-abort', text: 'source' }],
        },
        lifecycle.signal,
      );
      await Promise.resolve();
      await Promise.resolve();
      lifecycle.abort();

      await expect(pending).resolves.toMatchObject({
        ok: false,
        error: { code: 'aborted', retryable: false },
      });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });
});
