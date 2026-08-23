import type { AppError, Result } from '../shared/result';

export type TranslationProviderId = 'deepseek' | 'google-free';
export type TranslationProviderSelection = TranslationProviderId | 'unset';

export interface TranslationCueInput {
  readonly id: string;
  readonly startMs: number;
  readonly endMs: number;
  readonly text: string;
}

export interface TranslationRequest {
  readonly taskId: string;
  readonly sessionId: string;
  readonly episodeId: string;
  readonly trackHash: string;
  readonly provider: TranslationProviderSelection;
  readonly sourceLanguage: 'en';
  readonly targetLanguage: 'zh-Hans';
  readonly episodeGeneration: number;
  readonly providerGeneration: number;
  readonly cues: readonly TranslationCueInput[];
  readonly context: readonly TranslationCueInput[];
}

export interface TranslatedCue {
  readonly cueId: string;
  readonly text: string;
}

export interface TranslationBatch {
  readonly translations: readonly TranslatedCue[];
  readonly retryCueIds: readonly string[];
}

export type TranslationErrorCode =
  | 'aborted'
  | 'authentication_failed'
  | 'insufficient_balance'
  | 'invalid_configuration'
  | 'invalid_request'
  | 'invalid_response'
  | 'provider_forbidden'
  | 'provider_unavailable'
  | 'provider_unset'
  | 'rate_limited'
  | 'stale_generation'
  | 'timeout';

export type TranslationError = AppError<TranslationErrorCode>;
export type TranslationResult = Result<TranslationBatch, TranslationError>;

export interface TranslationProvider {
  readonly id: TranslationProviderId;
  readonly contractVersion: string;
  translate(
    request: TranslationRequest,
    signal: AbortSignal,
  ): Promise<TranslationResult>;
}

export interface TranslationClock {
  now(): number;
  sleep(milliseconds: number, signal?: AbortSignal): Promise<void>;
}

export const systemTranslationClock: TranslationClock = {
  now: () => Date.now(),
  sleep: (milliseconds, signal) => new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }

    const finish = () => {
      signal?.removeEventListener('abort', abort);
      resolve();
    };
    const abort = () => {
      clearTimeout(timeout);
      reject(new DOMException('Aborted', 'AbortError'));
    };
    const timeout = setTimeout(finish, Math.max(0, milliseconds));
    signal?.addEventListener('abort', abort, { once: true });
  }),
};
