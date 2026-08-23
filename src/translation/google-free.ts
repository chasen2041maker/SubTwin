import { err } from '../shared/result';
import { readBoundedJsonResponse } from './bounded-json';
import type {
  TranslationClock,
  TranslationError,
  TranslationProvider,
  TranslationRequest,
  TranslationResult,
} from './types';
import { systemTranslationClock } from './types';
import { validateGoogleFreePayload } from './validate';

export const GOOGLE_FREE_CONTRACT_VERSION = 'google-free-v1' as const;
const GOOGLE_FREE_ENDPOINT = 'https://translate.googleapis.com/translate_a/single';
const MAX_GOOGLE_RESPONSE_BYTES = 256 * 1024;

export interface GoogleFreeProviderOptions {
  readonly fetch: typeof globalThis.fetch;
  readonly clock?: TranslationClock;
  readonly maxAttempts?: number;
  readonly maxConcurrent?: number;
  readonly minStartIntervalMs?: number;
  readonly cooldownMs?: number;
  readonly rateLimitCooldownThreshold?: number;
  readonly requestTimeoutMs?: number;
}

export class GoogleFreeProvider implements TranslationProvider {
  readonly id = 'google-free' as const;
  readonly contractVersion = GOOGLE_FREE_CONTRACT_VERSION;
  readonly #fetch: typeof globalThis.fetch;
  readonly #clock: TranslationClock;
  readonly #maxAttempts: number;
  readonly #maxConcurrent: number;
  readonly #minStartIntervalMs: number;
  readonly #cooldownMs: number;
  readonly #rateLimitCooldownThreshold: number;
  readonly #requestTimeoutMs: number;
  #active = 0;
  #permitWaiters: Array<() => void> = [];
  #startGate: Promise<void> = Promise.resolve();
  #lastStartAt: number | null = null;
  #consecutiveRateLimits = 0;
  #cooldownUntil = 0;

  constructor(options: GoogleFreeProviderOptions) {
    this.#fetch = options.fetch;
    this.#clock = options.clock ?? systemTranslationClock;
    this.#maxAttempts = clamp(options.maxAttempts ?? 3, 1, 3);
    this.#maxConcurrent = clamp(options.maxConcurrent ?? 2, 1, 2);
    this.#minStartIntervalMs = Math.max(0, options.minStartIntervalMs ?? 200);
    this.#cooldownMs = Math.max(1_000, options.cooldownMs ?? 30_000);
    this.#rateLimitCooldownThreshold = clamp(
      options.rateLimitCooldownThreshold ?? 3,
      1,
      10,
    );
    this.#requestTimeoutMs = clamp(options.requestTimeoutMs ?? 8_000, 500, 30_000);
  }

  async translate(
    request: TranslationRequest,
    signal: AbortSignal,
  ): Promise<TranslationResult> {
    if (
      request.provider !== this.id ||
      request.sourceLanguage !== 'en' ||
      request.targetLanguage !== 'zh-Hans' ||
      request.cues.length !== 1 ||
      !isBoundedGoogleRequest(request)
    ) {
      return failure('invalid_request', 'Invalid Google Free translation request.', false);
    }
    if (signal.aborted) return failure('aborted', 'Translation was aborted.', false);
    if (this.#clock.now() < this.#cooldownUntil) {
      return failure('rate_limited', 'Google Free is cooling down.', true);
    }

    let acquired = false;
    try {
      await this.#acquirePermit(signal);
      acquired = true;
      if (signal.aborted) return failure('aborted', 'Translation was aborted.', false);
      if (this.#clock.now() < this.#cooldownUntil) {
        return failure('rate_limited', 'Google Free is cooling down.', true);
      }
      return await this.#translateWithRetry(request, signal);
    } catch (error) {
      return classifyThrown(error, signal);
    } finally {
      if (acquired) this.#releasePermit();
    }
  }

  async #translateWithRetry(
    request: TranslationRequest,
    signal: AbortSignal,
  ): Promise<TranslationResult> {
    const cue = request.cues[0];
    if (!cue) return failure('invalid_request', 'Invalid Google Free translation request.', false);

    for (let attempt = 1; attempt <= this.#maxAttempts; attempt += 1) {
      if (this.#clock.now() < this.#cooldownUntil) {
        return failure('rate_limited', 'Google Free is cooling down.', true);
      }
      let observed: GoogleFetchResult;
      try {
        observed = await this.#startFetch(buildGoogleUrl(cue.text), signal);
      } catch (error) {
        const classified = classifyThrown(error, signal);
        if (attempt === this.#maxAttempts || !classified.ok && !classified.error.retryable) {
          return classified;
        }
        await this.#clock.sleep(backoffMs(attempt), signal);
        continue;
      }

      const response = observed.response;

      if (response.ok) {
        this.#consecutiveRateLimits = 0;
        if (observed.payload === null || observed.payload === undefined) {
          return failure('invalid_response', 'Google Free returned an invalid response.', false);
        }
        return validateGoogleFreePayload(cue.text, cue.id, observed.payload);
      }

      if (response.status === 403) {
        return failure('provider_forbidden', 'Google Free rejected the request.', false);
      }
      if (response.status === 429) {
        this.#consecutiveRateLimits += 1;
        if (this.#consecutiveRateLimits >= this.#rateLimitCooldownThreshold) {
          this.#cooldownUntil = this.#clock.now() + this.#cooldownMs;
        }
        if (attempt < this.#maxAttempts && this.#clock.now() >= this.#cooldownUntil) {
          await this.#clock.sleep(backoffMs(attempt), signal);
          continue;
        }
        return failure('rate_limited', 'Google Free rate limit was reached.', true);
      }
      if (response.status >= 500 && attempt < this.#maxAttempts) {
        await this.#clock.sleep(backoffMs(attempt), signal);
        continue;
      }
      return failure('provider_unavailable', 'Google Free is unavailable.', response.status >= 500);
    }

    return failure('provider_unavailable', 'Google Free is unavailable.', true);
  }

  async #acquirePermit(signal: AbortSignal): Promise<void> {
    if (this.#active < this.#maxConcurrent) {
      this.#active += 1;
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const wake = () => {
        signal.removeEventListener('abort', abort);
        this.#active += 1;
        resolve();
      };
      const abort = () => {
        const index = this.#permitWaiters.indexOf(wake);
        if (index >= 0) this.#permitWaiters.splice(index, 1);
        reject(new DOMException('Aborted', 'AbortError'));
      };
      this.#permitWaiters.push(wake);
      signal.addEventListener('abort', abort, { once: true });
    });
  }

  #releasePermit(): void {
    this.#active = Math.max(0, this.#active - 1);
    this.#permitWaiters.shift()?.();
  }

  async #startFetch(
    url: string,
    signal: AbortSignal,
  ): Promise<GoogleFetchResult> {
    const previous = this.#startGate;
    let release = (): void => undefined;
    this.#startGate = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    let request: Promise<Response>;
    const controller = new AbortController();
    const relayAbort = () => controller.abort();
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', relayAbort, { once: true });
    const timeout = setTimeout(() => controller.abort(), this.#requestTimeoutMs);
    try {
      try {
        if (this.#lastStartAt !== null) {
          const wait = this.#lastStartAt + this.#minStartIntervalMs - this.#clock.now();
          if (wait > 0) await this.#clock.sleep(wait, signal);
        }
        if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
        this.#lastStartAt = this.#clock.now();
        request = this.#fetch(url, { method: 'GET', signal: controller.signal });
      } finally {
        release();
      }

      const response = await request;
      const payload = response.ok
        ? await readBoundedJsonResponse(response, MAX_GOOGLE_RESPONSE_BYTES)
        : undefined;
      return { response, payload };
    } catch (error) {
      if (!signal.aborted && controller.signal.aborted) {
        throw new DOMException('Timed out', 'TimeoutError');
      }
      throw error;
    } finally {
      clearTimeout(timeout);
      signal.removeEventListener('abort', relayAbort);
    }
  }
}

interface GoogleFetchResult {
  readonly response: Response;
  readonly payload: unknown | null | undefined;
}

function buildGoogleUrl(text: string): string {
  const query = new URLSearchParams({
    client: 'gtx',
    sl: 'en',
    tl: 'zh-CN',
    dt: 't',
    q: text,
  });
  return `${GOOGLE_FREE_ENDPOINT}?${query.toString()}`;
}

function classifyThrown(thrown: unknown, signal: AbortSignal): TranslationResult {
  if (signal.aborted || thrown instanceof DOMException && thrown.name === 'AbortError') {
    return failure('aborted', 'Translation was aborted.', false);
  }
  if (thrown instanceof DOMException && thrown.name === 'TimeoutError') {
    return failure('timeout', 'Translation request timed out.', true);
  }
  return failure('provider_unavailable', 'Google Free is unavailable.', true);
}

function backoffMs(attempt: number): number {
  return Math.min(2_000, 200 * 2 ** Math.max(0, attempt - 1));
}

function failure(
  code: TranslationError['code'],
  message: string,
  retryable: boolean,
): TranslationResult {
  return err({ code, message, retryable });
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, Math.floor(value)));
}

function isBoundedGoogleRequest(request: TranslationRequest): boolean {
  const cue = request.cues[0];
  return Boolean(
    cue &&
    /^[A-Za-z0-9._:-]{1,128}$/u.test(cue.id) &&
    cue.text.trim().length > 0 &&
    cue.text.length <= 32_768 &&
    Number.isSafeInteger(cue.startMs) &&
    Number.isSafeInteger(cue.endMs) &&
    cue.startMs >= 0 &&
    cue.endMs > cue.startMs &&
    request.context.length <= 50,
  );
}
