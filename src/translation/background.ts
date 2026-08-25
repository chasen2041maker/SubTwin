import { createMessage, parseMessageEnvelope, type MessageFor } from '../shared/messages';
import { ok, type AppError, type Result } from '../shared/result';
import { PersonalDeepSeekProvider } from './deepseek';
import { DEEPSEEK_CONTRACT_VERSION } from './deepseek';
import {
  GoogleFreeProvider,
  type GoogleFreeProviderOptions,
} from './google-free';
import { TranslationProviderRouter } from './provider';
import { DEEPSEEK_PROMPT_VERSION } from './prompt';
import {
  createTranslationCacheKey,
  hashTranslationSource,
  type TranslationCache,
  type TranslationCacheKeyParts,
} from './cache';
import { GOOGLE_FREE_CONTRACT_VERSION } from './google-free';
import type {
  TranslationErrorCode,
  TranslationProviderSelection,
  TranslationRequest,
} from './types';

export interface StoredTranslationSettings {
  readonly provider: TranslationProviderSelection;
  readonly deepseekApiKey?: string;
  readonly deepseekModel?: string;
}

export interface BackgroundTranslationHandlerOptions {
  readonly fetch: typeof globalThis.fetch;
  readonly readSettings: () => Promise<unknown>;
  readonly googleOptions?: Omit<GoogleFreeProviderOptions, 'fetch'>;
  readonly cache?: TranslationCache;
}

type BackgroundHandlerResult = Result<
  MessageFor<'translation/result'> | MessageFor<'translation/cancelled'>,
  AppError<string>
>;

const MAX_TRACKED_SESSIONS = 128;

interface ActiveTranslationSession {
  generation: {
    readonly episodeGeneration: number;
    readonly providerGeneration: number;
  };
  readonly active: Set<AbortController>;
  cancelled: boolean;
}

interface CacheCueOwnership {
  activeBulkLeases: number;
  readonly decisionWaiters: Set<() => void>;
  readonly urgentLeaseTokens: Set<number>;
  urgentWinner: boolean;
}

interface CachePriorityLease {
  canCommitCue(cueId: string, source: string): boolean;
  waitForCommitCue(
    cueId: string,
    source: string,
    signal: AbortSignal,
  ): Promise<boolean>;
  markUrgentWinner(cueIds: readonly string[]): void;
  release(): void;
}

export function createBackgroundTranslationHandler(
  options: BackgroundTranslationHandlerOptions,
): (
  candidate: unknown,
  tabId?: number,
) => Promise<BackgroundHandlerResult | undefined> {
  const google = new GoogleFreeProvider({
    fetch: options.fetch,
    ...options.googleOptions,
  });
  const sessions = new Map<string, ActiveTranslationSession>();
  const cacheOwnerships = new Map<string, CacheCueOwnership>();
  let cacheLeaseSequence = 0;

  return async (candidate, tabId = 0) => {
    const parsed = parseMessageEnvelope(candidate);
    if (!parsed.ok) return parsed;
    if (parsed.value.type === 'translation/cancel') {
      const message = parsed.value;
      const sessionKey = scopedSessionKey(tabId, message.payload.sessionId);
      const generation = {
        episodeGeneration: message.payload.episodeGeneration,
        providerGeneration: message.payload.providerGeneration,
      };
      let session = sessions.get(sessionKey);
      let accepted = false;
      if (session === undefined) {
        session = {
          generation,
          active: new Set(),
          cancelled: true,
        };
        sessions.set(sessionKey, session);
        accepted = true;
      } else if (!isOlderGeneration(generation, session.generation)) {
        abortSession(session);
        session.generation = generation;
        session.cancelled = true;
        accepted = true;
      }
      pruneInactiveSessions(sessions, sessionKey);
      return cancellationMessage(message, accepted);
    }
    if (parsed.value.type !== 'translation/request') return undefined;

    const message = parsed.value;
    const sessionKey = scopedSessionKey(tabId, message.payload.sessionId);
    const generation = {
      episodeGeneration: message.payload.episodeGeneration,
      providerGeneration: message.payload.providerGeneration,
    };
    let session = sessions.get(sessionKey);
    if (
      session !== undefined &&
      (isOlderGeneration(generation, session.generation) ||
        session.cancelled && sameGeneration(generation, session.generation))
    ) {
      return resultMessage(message, 'stale_generation', false);
    }
    if (session === undefined) {
      session = {
        generation,
        active: new Set(),
        cancelled: false,
      };
      sessions.set(sessionKey, session);
    } else if (!sameGeneration(generation, session.generation)) {
      abortSession(session);
      session.generation = generation;
      session.cancelled = false;
    }
    pruneInactiveSessions(sessions, sessionKey);

    const isCurrent = () =>
      sessions.get(sessionKey) === session &&
      !session.cancelled &&
      sameGeneration(generation, session.generation);

    const request: TranslationRequest = {
      taskId: message.payload.taskId,
      sessionId: message.payload.sessionId,
      episodeId: message.payload.episodeId,
      trackHash: message.payload.trackHash,
      provider: message.payload.provider,
      sourceLanguage: message.payload.sourceLanguage,
      targetLanguage: message.payload.targetLanguage,
      episodeGeneration: message.payload.episodeGeneration,
      providerGeneration: message.payload.providerGeneration,
      cues: message.payload.cues,
      context: message.payload.context,
    };
    const cachePriority = acquireCachePriority(
      cacheOwnerships,
      request,
      message.payload.priority,
      ++cacheLeaseSequence,
    );

    try {
      let storedSettings: unknown;
      try {
        storedSettings = await options.readSettings();
      } catch {
        return resultMessage(message, 'invalid_configuration', false);
      }
      if (!isCurrent()) return resultMessage(message, 'stale_generation', false);
      const settings = parseStoredSettings(storedSettings);
      if (!settings || settings.provider === 'unset') {
        return resultMessage(message, 'provider_unset', false);
      }
      if (settings.provider !== message.payload.provider) {
        return resultMessage(message, 'invalid_configuration', false);
      }

      const controller = new AbortController();
      session.active.add(controller);
      try {
        if (settings.provider === 'deepseek') {
          if (!settings.deepseekApiKey?.trim()) {
            return resultMessage(message, 'invalid_configuration', false);
          }
          const model = settings.deepseekModel ?? 'deepseek-v4-flash';
          if (model !== 'deepseek-v4-flash' && model !== 'deepseek-v4-pro') {
            return resultMessage(message, 'invalid_configuration', false);
          }
          const cached = await readCachedCues(options.cache, request, model);
          if (!isCurrent()) return resultMessage(message, 'stale_generation', false);
          cachePriority.markUrgentWinner(
            cached.translations.map(({ cueId }) => cueId),
          );
          if (cached.missing.length === 0) {
            return successMessage(message, {
              translations: cached.translations,
              retryCueIds: [],
            });
          }
          const deepseek = new PersonalDeepSeekProvider({
            fetch: options.fetch,
            apiKey: settings.deepseekApiKey,
            model,
          });
          const translated = await new TranslationProviderRouter([deepseek]).translate(
            { ...request, cues: cached.missing },
            controller.signal,
          );
          if (!isCurrent()) return resultMessage(message, 'stale_generation', false);
          if (!translated.ok) {
            return resultMessage(message, translated.error.code, translated.error.retryable);
          }
          await cacheTranslations(
            options.cache,
            request,
            translated.value.translations,
            model,
            controller.signal,
            isCurrent,
            cachePriority,
          );
          if (!isCurrent()) return resultMessage(message, 'stale_generation', false);
          cachePriority.markUrgentWinner(
            translated.value.translations.map(({ cueId }) => cueId),
          );
          return successMessage(message, {
            translations: orderTranslations(
              request,
              [...cached.translations, ...translated.value.translations],
            ),
            retryCueIds: translated.value.retryCueIds,
          });
        }

        const cached = await readCachedCues(options.cache, request);
        if (!isCurrent()) return resultMessage(message, 'stale_generation', false);
        cachePriority.markUrgentWinner(
          cached.translations.map(({ cueId }) => cueId),
        );
        if (cached.missing.length === 0) {
          return successMessage(message, {
            translations: cached.translations,
            retryCueIds: [],
          });
        }
        const translated = await new TranslationProviderRouter([google]).translate(
          { ...request, cues: cached.missing },
          controller.signal,
        );
        if (!isCurrent()) return resultMessage(message, 'stale_generation', false);
        if (!translated.ok) {
          return resultMessage(message, translated.error.code, translated.error.retryable);
        }
        await cacheTranslations(
          options.cache,
          request,
          translated.value.translations,
          undefined,
          controller.signal,
          isCurrent,
          cachePriority,
        );
        if (!isCurrent()) return resultMessage(message, 'stale_generation', false);
        cachePriority.markUrgentWinner(
          translated.value.translations.map(({ cueId }) => cueId),
        );
        return successMessage(message, translated.value);
      } finally {
        session.active.delete(controller);
      }
    } finally {
      cachePriority.release();
    }
  };
}

function scopedSessionKey(tabId: number, sessionId: string): string {
  return `${tabId}\u001f${sessionId}`;
}

function abortSession(session: ActiveTranslationSession): void {
  for (const controller of session.active) controller.abort();
}

function pruneInactiveSessions(
  sessions: Map<string, ActiveTranslationSession>,
  currentSessionKey: string,
): void {
  if (sessions.size <= MAX_TRACKED_SESSIONS) return;
  for (const [sessionId, session] of sessions) {
    if (sessionId === currentSessionKey || session.active.size > 0) continue;
    sessions.delete(sessionId);
    if (sessions.size <= MAX_TRACKED_SESSIONS) return;
  }
}

async function readCachedCues(
  cache: TranslationCache | undefined,
  request: TranslationRequest,
  model?: string,
): Promise<{
  readonly translations: readonly { readonly cueId: string; readonly text: string }[];
  readonly missing: TranslationRequest['cues'];
}> {
  if (!cache || request.provider === 'unset') {
    return { translations: [], missing: request.cues };
  }
  const translations: { cueId: string; text: string }[] = [];
  const missing = [];
  for (const cue of request.cues) {
    const parts = cacheKeyParts(request, cue.id, cue.text, model);
    let hit: { readonly cueId: string; readonly text: string } | null = null;
    try {
      hit = await cache.get(createTranslationCacheKey(parts));
    } catch {
      // Cache availability must not block a valid provider request.
    }
    if (hit?.cueId === cue.id) translations.push(hit);
    else missing.push(cue);
  }
  return { translations, missing };
}

async function cacheTranslations(
  cache: TranslationCache | undefined,
  request: TranslationRequest,
  translations: readonly { readonly cueId: string; readonly text: string }[],
  model: string | undefined,
  signal: AbortSignal,
  isCurrent: () => boolean,
  cachePriority: CachePriorityLease,
): Promise<void> {
  if (!cache || request.provider === 'unset') return;
  const sourceById = new Map(request.cues.map((cue) => [cue.id, cue.text]));
  await Promise.all(translations.map(async (translation) => {
    const source = sourceById.get(translation.cueId);
    if (!source) return;
    if (!await cachePriority.waitForCommitCue(
      translation.cueId,
      source,
      signal,
    )) return;
    const canCommit = () =>
      isCurrent() && cachePriority.canCommitCue(translation.cueId, source);
    if (!canCommit()) return;
    await cache.set(
      cacheKeyParts(request, translation.cueId, source, model),
      translation,
      { signal, isCurrent: canCommit },
    );
  }));
}

function acquireCachePriority(
  ownerships: Map<string, CacheCueOwnership>,
  request: TranslationRequest,
  priority: 'bulk' | 'urgent',
  leaseToken: number,
): CachePriorityLease {
  const sourceById = new Map(request.cues.map((cue) => [cue.id, cue.text]));
  const keys = new Set(request.cues.map((cue) =>
    cacheOwnershipIdentity(request, cue.id, cue.text)));
  for (const key of keys) {
    const ownership = ownerships.get(key) ?? {
      activeBulkLeases: 0,
      decisionWaiters: new Set<() => void>(),
      urgentLeaseTokens: new Set<number>(),
      urgentWinner: false,
    };
    if (priority === 'urgent') ownership.urgentLeaseTokens.add(leaseToken);
    else ownership.activeBulkLeases += 1;
    ownerships.set(key, ownership);
  }

  let released = false;
  return {
    canCommitCue(cueId, source) {
      if (released) return false;
      const ownership = ownerships.get(
        cacheOwnershipIdentity(request, cueId, source),
      );
      if (ownership === undefined) return false;
      return priority === 'urgent'
        ? ownership.urgentLeaseTokens.has(leaseToken)
        : ownership.urgentLeaseTokens.size === 0 && !ownership.urgentWinner;
    },
    waitForCommitCue(cueId, source, signal) {
      const key = cacheOwnershipIdentity(request, cueId, source);
      const decision = (): boolean | undefined => {
        if (released || signal.aborted) return false;
        const ownership = ownerships.get(key);
        if (ownership === undefined) return false;
        if (priority === 'urgent') {
          return ownership.urgentLeaseTokens.has(leaseToken);
        }
        if (ownership.urgentWinner) return false;
        return ownership.urgentLeaseTokens.size === 0 ? true : undefined;
      };
      const immediate = decision();
      if (immediate !== undefined) return Promise.resolve(immediate);
      const ownership = ownerships.get(key);
      if (ownership === undefined) return Promise.resolve(false);
      return new Promise<boolean>((resolve) => {
        let settled = false;
        const finish = (allowed: boolean): void => {
          if (settled) return;
          settled = true;
          ownership.decisionWaiters.delete(check);
          signal.removeEventListener('abort', abort);
          resolve(allowed);
        };
        const check = (): void => {
          const current = decision();
          if (current !== undefined) finish(current);
        };
        const abort = (): void => finish(false);
        ownership.decisionWaiters.add(check);
        signal.addEventListener('abort', abort, { once: true });
        check();
      });
    },
    markUrgentWinner(cueIds) {
      if (released || priority !== 'urgent') return;
      for (const cueId of cueIds) {
        const source = sourceById.get(cueId);
        if (source === undefined) continue;
        const ownership = ownerships.get(
          cacheOwnershipIdentity(request, cueId, source),
        );
        if (ownership?.urgentLeaseTokens.has(leaseToken) === true) {
          ownership.urgentWinner = true;
          notifyCacheDecisionWaiters(ownership);
        }
      }
    },
    release() {
      if (released) return;
      released = true;
      for (const key of keys) {
        const ownership = ownerships.get(key);
        if (ownership === undefined) continue;
        if (priority === 'urgent') ownership.urgentLeaseTokens.delete(leaseToken);
        else ownership.activeBulkLeases = Math.max(0, ownership.activeBulkLeases - 1);
        notifyCacheDecisionWaiters(ownership);
        if (
          ownership.activeBulkLeases === 0 &&
          ownership.urgentLeaseTokens.size === 0
        ) ownerships.delete(key);
      }
    },
  };
}

function notifyCacheDecisionWaiters(ownership: CacheCueOwnership): void {
  for (const notify of [...ownership.decisionWaiters]) notify();
}

function cacheOwnershipIdentity(
  request: TranslationRequest,
  cueId: string,
  source: string,
): string {
  return [
    request.provider,
    request.episodeId,
    request.trackHash,
    cueId,
    request.sourceLanguage,
    hashTranslationSource(source),
    request.targetLanguage,
  ].join('\u001f');
}

function cacheKeyParts(
  request: TranslationRequest,
  cueId: string,
  source: string,
  model?: string,
): TranslationCacheKeyParts {
  const common = {
    episodeId: request.episodeId,
    trackHash: request.trackHash,
    cueId,
    sourceLanguage: request.sourceLanguage,
    sourceHash: hashTranslationSource(source),
    targetLanguage: request.targetLanguage,
  } as const;
  if (request.provider === 'deepseek') {
    return {
      ...common,
      provider: 'deepseek',
      providerContractVersion: DEEPSEEK_CONTRACT_VERSION,
      model: model ?? 'deepseek-v4-flash',
      promptVersion: DEEPSEEK_PROMPT_VERSION,
    };
  }
  return {
    ...common,
    provider: 'google-free',
    providerContractVersion: GOOGLE_FREE_CONTRACT_VERSION,
  };
}

function orderTranslations(
  request: TranslationRequest,
  translations: readonly { readonly cueId: string; readonly text: string }[],
): readonly { readonly cueId: string; readonly text: string }[] {
  const byId = new Map(translations.map((translation) => [translation.cueId, translation]));
  return request.cues.flatMap(({ id }) => {
    const translation = byId.get(id);
    return translation ? [translation] : [];
  });
}

function sameGeneration(
  left: { readonly episodeGeneration: number; readonly providerGeneration: number },
  right: { readonly episodeGeneration: number; readonly providerGeneration: number } | null,
): boolean {
  return right !== null &&
    left.episodeGeneration === right.episodeGeneration &&
    left.providerGeneration === right.providerGeneration;
}

function isOlderGeneration(
  candidate: { readonly episodeGeneration: number; readonly providerGeneration: number },
  current: { readonly episodeGeneration: number; readonly providerGeneration: number } | null,
): boolean {
  if (!current) return false;
  return candidate.episodeGeneration < current.episodeGeneration ||
    candidate.episodeGeneration === current.episodeGeneration &&
    candidate.providerGeneration < current.providerGeneration;
}

function successMessage(
  request: MessageFor<'translation/request'>,
  batch: {
    readonly translations: readonly { readonly cueId: string; readonly text: string }[];
    readonly retryCueIds: readonly string[];
  },
): BackgroundHandlerResult {
  const provider = request.payload.provider;
  if (provider === 'unset') return resultMessage(request, 'provider_unset', false);
  return ok(createMessage({
    id: `${request.id}:background`,
    source: 'background',
    type: 'translation/result',
    payload: {
      taskId: request.payload.taskId,
      sessionId: request.payload.sessionId,
      provider,
      episodeGeneration: request.payload.episodeGeneration,
      providerGeneration: request.payload.providerGeneration,
      status: 'success',
      translations: batch.translations,
      retryCueIds: batch.retryCueIds,
      errorCode: null,
      retryable: false,
    },
  }));
}

function cancellationMessage(
  request: MessageFor<'translation/cancel'>,
  accepted: boolean,
): BackgroundHandlerResult {
  return ok(createMessage({
    id: `${request.id}:background`,
    source: 'background',
    type: 'translation/cancelled',
    payload: {
      sessionId: request.payload.sessionId,
      episodeGeneration: request.payload.episodeGeneration,
      providerGeneration: request.payload.providerGeneration,
      accepted,
    },
  }));
}

function resultMessage(
  request: MessageFor<'translation/request'>,
  errorCode: TranslationErrorCode,
  retryable: boolean,
): BackgroundHandlerResult {
  const provider = request.payload.provider;
  return ok(createMessage({
    id: `${request.id}:background`,
    source: 'background',
    type: 'translation/result',
    payload: {
      taskId: request.payload.taskId,
      sessionId: request.payload.sessionId,
      provider,
      episodeGeneration: request.payload.episodeGeneration,
      providerGeneration: request.payload.providerGeneration,
      status: 'error',
      translations: [],
      retryCueIds: [],
      errorCode,
      retryable,
    },
  }));
}

function parseStoredSettings(value: unknown): StoredTranslationSettings | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (
    record.provider !== 'unset' &&
    record.provider !== 'google-free' &&
    record.provider !== 'deepseek'
  ) return null;
  if (record.deepseekApiKey !== undefined && typeof record.deepseekApiKey !== 'string') {
    return null;
  }
  if (record.deepseekModel !== undefined && typeof record.deepseekModel !== 'string') {
    return null;
  }
  return {
    provider: record.provider,
    ...(typeof record.deepseekApiKey === 'string'
      ? { deepseekApiKey: record.deepseekApiKey }
      : {}),
    ...(typeof record.deepseekModel === 'string'
      ? { deepseekModel: record.deepseekModel }
      : {}),
  };
}
