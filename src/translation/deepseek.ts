import { err } from '../shared/result';
import { readBoundedJsonResponse } from './bounded-json';
import { buildDeepSeekPrompt } from './prompt';
import type {
  TranslationError,
  TranslationProvider,
  TranslationRequest,
  TranslationResult,
} from './types';
import { validateDeepSeekPayload } from './validate';

export const DEEPSEEK_CONTRACT_VERSION = 'deepseek-v1' as const;
const DEEPSEEK_ENDPOINT = 'https://api.deepseek.com/chat/completions';
const DEEPSEEK_MODELS = ['deepseek-v4-flash', 'deepseek-v4-pro'] as const;
const MAX_DEEPSEEK_REQUEST_BYTES = 256 * 1024;
const MAX_DEEPSEEK_RESPONSE_BYTES = 1024 * 1024;

export interface PersonalDeepSeekProviderOptions {
  readonly apiKey: string;
  readonly fetch: typeof globalThis.fetch;
  readonly model?: string;
  readonly timeoutMs?: number;
}

export class PersonalDeepSeekProvider implements TranslationProvider {
  readonly id = 'deepseek' as const;
  readonly contractVersion = DEEPSEEK_CONTRACT_VERSION;
  readonly #apiKey: string;
  readonly #fetch: typeof globalThis.fetch;
  readonly #model: string;
  readonly #timeoutMs: number;

  constructor(options: PersonalDeepSeekProviderOptions) {
    this.#apiKey = options.apiKey;
    this.#fetch = options.fetch;
    this.#model = options.model ?? 'deepseek-v4-flash';
    this.#timeoutMs = options.timeoutMs ?? 15_000;
  }

  async translate(
    request: TranslationRequest,
    signal: AbortSignal,
  ): Promise<TranslationResult> {
    if (signal.aborted) {
      return failure('aborted', 'Translation was aborted.', false);
    }
    if (
      request.provider !== this.id ||
      request.targetLanguage !== 'zh-Hans' ||
      request.cues.length === 0 ||
      request.cues.length > 25 ||
      this.#apiKey.trim().length === 0 ||
      !isBoundedRequest(request)
    ) {
      return invalidRequest();
    }
    if (!isSupportedModel(this.#model)) {
      return failure(
        'invalid_configuration',
        'Unsupported DeepSeek model configuration.',
        false,
      );
    }

    const prompt = buildDeepSeekPrompt(request);
    const requestBody = JSON.stringify({
      model: this.#model,
      messages: [
        { role: 'system', content: prompt.system },
        { role: 'user', content: prompt.user },
      ],
      response_format: { type: 'json_object' },
      thinking: { type: 'disabled' },
      stream: false,
      temperature: 0.2,
      max_tokens: 4_096,
    });
    if (byteLength(requestBody) > MAX_DEEPSEEK_REQUEST_BYTES) return invalidRequest();
    const controller = new AbortController();
    const relayAbort = () => controller.abort();
    signal.addEventListener('abort', relayAbort, { once: true });
    const timeout = setTimeout(() => controller.abort(), this.#timeoutMs);

    try {
      const response = await this.#fetch(DEEPSEEK_ENDPOINT, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.#apiKey}`,
          'Content-Type': 'application/json',
        },
        body: requestBody,
        signal: controller.signal,
      });

      if (!response.ok) return classifyStatus(response.status);
      const envelope = await readBoundedJsonResponse(
        response,
        MAX_DEEPSEEK_RESPONSE_BYTES,
      );
      if (envelope === null) return invalidResponse();
      const choice = getResponseChoice(envelope);
      if (choice === null) return invalidResponse();
      if (choice.finishReason !== 'stop') {
        return classifyFinishReason(choice.finishReason);
      }

      let payload: unknown;
      try {
        payload = JSON.parse(choice.content);
      } catch {
        return invalidResponse();
      }
      return validateDeepSeekPayload(request, payload);
    } catch (error) {
      return classifyThrown(error, signal, controller.signal);
    } finally {
      clearTimeout(timeout);
      signal.removeEventListener('abort', relayAbort);
    }
  }
}

interface DeepSeekResponseChoice {
  readonly content: string;
  readonly finishReason: string;
}

function getResponseChoice(input: unknown): DeepSeekResponseChoice | null {
  if (!isRecord(input) || !Array.isArray(input.choices) || input.choices.length !== 1) {
    return null;
  }
  const choice = input.choices[0];
  if (
    !isRecord(choice) ||
    typeof choice.finish_reason !== 'string' ||
    !isRecord(choice.message) ||
    typeof choice.message.content !== 'string'
  ) return null;
  return {
    content: choice.message.content,
    finishReason: choice.finish_reason,
  };
}

function classifyStatus(status: number): TranslationResult {
  if (status === 400 || status === 422) {
    return failure('invalid_request', 'DeepSeek rejected the request contract.', false);
  }
  if (status === 401 || status === 403) {
    return failure('authentication_failed', 'DeepSeek authentication failed.', false);
  }
  if (status === 402) {
    return failure('insufficient_balance', 'DeepSeek account balance is insufficient.', false);
  }
  if (status === 429) {
    return failure('rate_limited', 'DeepSeek rate limit was reached.', true);
  }
  return failure('provider_unavailable', 'DeepSeek is unavailable.', status >= 500);
}

function classifyFinishReason(reason: string): TranslationResult {
  if (reason === 'length') {
    return failure('invalid_response', 'DeepSeek response was truncated.', true);
  }
  if (reason === 'insufficient_system_resource') {
    return failure('provider_unavailable', 'DeepSeek has insufficient system resources.', true);
  }
  return failure('invalid_response', 'DeepSeek response was not accepted.', false);
}

function classifyThrown(
  thrown: unknown,
  externalSignal: AbortSignal,
  requestSignal: AbortSignal,
): TranslationResult {
  if (externalSignal.aborted) return failure('aborted', 'Translation was aborted.', false);
  if (
    requestSignal.aborted ||
    (thrown instanceof DOMException && thrown.name === 'TimeoutError')
  ) {
    return failure('timeout', 'Translation request timed out.', true);
  }
  return failure('provider_unavailable', 'DeepSeek is unavailable.', true);
}

function invalidRequest(): TranslationResult {
  return failure('invalid_request', 'Invalid DeepSeek translation request.', false);
}

function invalidResponse(): TranslationResult {
  return failure('invalid_response', 'DeepSeek returned an invalid response.', false);
}

function failure(
  code: TranslationError['code'],
  message: string,
  retryable: boolean,
): TranslationResult {
  return err({ code, message, retryable });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSupportedModel(model: string): boolean {
  return DEEPSEEK_MODELS.some((allowed) => allowed === model);
}

function isBoundedRequest(request: TranslationRequest): boolean {
  if (request.context.length > 50) return false;
  const allCues = [...request.cues, ...request.context];
  const ids = new Set<string>();
  for (const cue of request.cues) {
    if (ids.has(cue.id)) return false;
    ids.add(cue.id);
  }
  return allCues.every((cue) =>
    /^[A-Za-z0-9._:-]{1,128}$/u.test(cue.id) &&
    cue.text.trim().length > 0 &&
    cue.text.length <= 32_768 &&
    Number.isSafeInteger(cue.startMs) &&
    Number.isSafeInteger(cue.endMs) &&
    cue.startMs >= 0 &&
    cue.endMs > cue.startMs,
  );
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}
