import {
  createMessage,
  parseMessageEnvelope,
  type MessageFor,
} from '../shared/messages';
import { err, ok } from '../shared/result';
import {
  TranslationScheduler,
  type ScheduledTranslationTask,
  type SchedulerEnqueueResult,
  type SchedulerGeneration,
} from '../translation/scheduler';
import type {
  TranslationError,
  TranslationResult,
} from '../translation/types';
import type {
  ProviderNeutralTaskClient,
  SessionCancellationReason,
  TranslationTaskCallbacks,
} from './session-controller';
import type { RuntimeStatus } from './status';

export interface ExtensionTranslationTaskClientOptions {
  readonly sendMessage: (message: unknown) => Promise<unknown>;
  readonly isOnline?: () => boolean;
  readonly onRuntimeStatus?: (status: RuntimeStatus) => void;
  readonly maxConcurrent?: number;
  readonly reservedUrgent?: number;
}

export interface ExtensionTranslationTaskClient
  extends ProviderNeutralTaskClient {
  whenIdle(): Promise<void>;
  dispose(): void;
}

export function createExtensionTranslationTaskClient(
  options: ExtensionTranslationTaskClientOptions,
): ExtensionTranslationTaskClient {
  let scheduler: TranslationScheduler | undefined;
  let schedulerGeneration: SchedulerGeneration | undefined;
  let activeSessionId: string | undefined;
  let cancellationTail: Promise<void> = Promise.resolve();
  let messageSequence = 0;
  let disposed = false;
  const callbacksByTask = new Map<string, TranslationTaskCallbacks>();

  const callbacksFor = (
    task: ScheduledTranslationTask,
  ): TranslationTaskCallbacks | undefined =>
    callbacksByTask.get(callbackKey(task));

  const publishRuntimeStatus = (status: RuntimeStatus): void => {
    try {
      options.onRuntimeStatus?.(status);
    } catch {
      // Runtime status is diagnostic-only.
    }
  };

  const reportError = (
    task: ScheduledTranslationTask,
    error: TranslationError,
    offline: boolean,
  ): void => {
    const callbacks = callbacksFor(task);
    if (!callbacks?.isCurrent()) return;

    // Retryable failures are deliberately NOT forwarded to the session
    // controller. The controller treats onError as a terminal provider failure
    // and invalidates the generation, which used to turn a single timeout/429
    // into a dead translation session for the rest of the episode. The
    // scheduler leaves retryable cues incomplete, so a later seek/promotion can
    // try them again while already translated cues stay visible.
    if (error.retryable) {
      publishRuntimeStatus(runtimeStatusForRetryableError(error, offline));
      return;
    }

    try {
      callbacks.onError(error);
    } catch {
      // A controller callback cannot break queue cleanup.
    }
    if (offline) publishRuntimeStatus({ mode: 'error', code: 'offline' });
  };

  const execute = async (
    task: ScheduledTranslationTask,
    signal: AbortSignal,
  ): Promise<TranslationResult> => {
    const callbacks = callbacksFor(task);
    if (signal.aborted || callbacks === undefined || !callbacks.isCurrent()) {
      return aborted();
    }
    await cancellationTail;
    if (signal.aborted || disposed || !callbacks.isCurrent()) return aborted();

    const request = createMessage({
      id: `translation-request-${Date.now()}-${++messageSequence}`,
      source: 'content',
      type: 'translation/request',
      payload: {
        taskId: task.taskId,
        sessionId: task.sessionId,
        episodeId: task.episodeId,
        trackHash: task.trackHash,
        provider: task.provider,
        sourceLanguage: task.sourceLanguage,
        targetLanguage: task.targetLanguage,
        episodeGeneration: task.episodeGeneration,
        providerGeneration: task.providerGeneration,
        priority: task.priority,
        cues: task.cues,
        context: task.context,
      },
    });

    let response: unknown;
    try {
      response = await options.sendMessage(request);
    } catch {
      if (signal.aborted || !callbacks.isCurrent()) return aborted();
      const offline = isOffline(options.isOnline);
      const error: TranslationError = {
        code: 'provider_unavailable',
        message: 'The extension background translation service is unavailable.',
        retryable: true,
      };
      reportError(task, error, offline);
      return err(error);
    }

    if (signal.aborted || disposed || !callbacks.isCurrent()) return aborted();
    const result = parseTranslationResponse(response, request);
    if (!result.ok) reportError(task, result.error, false);
    return result;
  };

  const createScheduler = (generation: SchedulerGeneration): TranslationScheduler =>
    new TranslationScheduler({
      generation,
      execute,
      writeCache: async () => undefined,
      render(task, batch) {
        const callbacks = callbacksFor(task);
        if (callbacks?.isCurrent()) {
          try {
            callbacks.onResult(batch);
          } catch {
            // Rendering errors are contained by the session controller boundary.
          }
        }
      },
      ...(options.maxConcurrent === undefined
        ? {}
        : { maxConcurrent: options.maxConcurrent }),
      ...(options.reservedUrgent === undefined
        ? {}
        : { reservedUrgent: options.reservedUrgent }),
    });

  const client: ExtensionTranslationTaskClient = {
    enqueue(task, callbacks) {
      if (disposed) return;
      const generation = generationOf(task);
      if (!sameGeneration(schedulerGeneration, generation)) {
        scheduler?.dispose();
        callbacksByTask.clear();
        schedulerGeneration = generation;
        scheduler = createScheduler(generation);
      }
      activeSessionId = task.sessionId;
      callbacksByTask.set(callbackKey(task), callbacks);
      const activeScheduler = scheduler;
      if (activeScheduler === undefined) return;
      const enqueued: SchedulerEnqueueResult = activeScheduler.enqueue(task);
      if (enqueued === 'rejected') callbacksByTask.delete(callbackKey(task));
    },

    cancel(generation, reason) {
      if (disposed) return;
      scheduler?.dispose();
      scheduler = undefined;
      schedulerGeneration = undefined;
      callbacksByTask.clear();
      const sessionId = activeSessionId;
      if (sessionId === undefined) return;
      const cancel = createMessage({
        id: `translation-cancel-${Date.now()}-${++messageSequence}`,
        source: 'content',
        type: 'translation/cancel',
        payload: {
          sessionId,
          episodeGeneration: generation.episodeGeneration,
          providerGeneration: generation.providerGeneration,
          reason,
        },
      });
      cancellationTail = cancellationTail
        .then(async () => {
          try {
            await options.sendMessage(cancel);
          } catch {
            // Local generation guards still reject late results if IPC is lost.
          }
        })
        .catch(() => undefined);
    },

    async whenIdle() {
      for (;;) {
        const observedTail = cancellationTail;
        const observedScheduler = scheduler;
        await observedTail;
        await observedScheduler?.whenIdle();
        if (
          observedTail === cancellationTail &&
          observedScheduler === scheduler
        ) return;
      }
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      scheduler?.dispose();
      scheduler = undefined;
      schedulerGeneration = undefined;
      callbacksByTask.clear();
    },
  };
  return client;
}

function parseTranslationResponse(
  candidate: unknown,
  request: MessageFor<'translation/request'>,
): TranslationResult {
  if (
    !isRecord(candidate) ||
    !hasExactlyKeys(candidate, ['ok', 'value']) ||
    candidate.ok !== true
  ) return invalidResponse();
  const parsed = parseMessageEnvelope(candidate.value);
  if (!parsed.ok || parsed.value.type !== 'translation/result') {
    return invalidResponse();
  }
  const response = parsed.value;
  if (
    response.id !== `${request.id}:background` ||
    response.payload.taskId !== request.payload.taskId ||
    response.payload.sessionId !== request.payload.sessionId ||
    response.payload.provider !== request.payload.provider ||
    response.payload.episodeGeneration !== request.payload.episodeGeneration ||
    response.payload.providerGeneration !== request.payload.providerGeneration
  ) return invalidResponse();

  if (response.payload.status === 'success') {
    return ok({
      translations: response.payload.translations,
      retryCueIds: response.payload.retryCueIds,
    });
  }
  const errorCode = response.payload.errorCode;
  if (errorCode === null) return invalidResponse();
  return translationFailure(
    errorCode,
    'The selected translation provider rejected the request.',
    response.payload.retryable,
  );
}

function invalidResponse(): TranslationResult {
  return translationFailure(
    'invalid_response',
    'The extension background returned an invalid translation response.',
    false,
  );
}

function aborted(): TranslationResult {
  return translationFailure('aborted', 'Translation was cancelled.', false);
}

function translationFailure(
  code: TranslationError['code'],
  message: string,
  retryable: boolean,
): TranslationResult {
  return err({ code, message, retryable });
}

function runtimeStatusForRetryableError(
  error: TranslationError,
  offline: boolean,
): RuntimeStatus {
  if (offline) return { mode: 'error', code: 'offline' };
  switch (error.code) {
    case 'rate_limited':
      return { mode: 'error', code: 'rate_limited' };
    case 'timeout':
      return { mode: 'error', code: 'timeout' };
    case 'provider_unavailable':
      return { mode: 'error', code: 'provider_unavailable' };
    default:
      return { mode: 'error', code: 'provider_unavailable' };
  }
}

function generationOf(task: ScheduledTranslationTask): SchedulerGeneration {
  return {
    episodeGeneration: task.episodeGeneration,
    providerGeneration: task.providerGeneration,
  };
}

function sameGeneration(
  left: SchedulerGeneration | undefined,
  right: SchedulerGeneration,
): boolean {
  return left !== undefined &&
    left.episodeGeneration === right.episodeGeneration &&
    left.providerGeneration === right.providerGeneration;
}

function callbackKey(task: ScheduledTranslationTask): string {
  const baseTaskId = task.taskId.replace(/(?::partial-\d+)+$/u, '');
  return [
    task.sessionId,
    task.episodeGeneration,
    task.providerGeneration,
    baseTaskId,
  ].join(':');
}

function isOffline(readOnline: (() => boolean) | undefined): boolean {
  try {
    return readOnline?.() === false;
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactlyKeys(
  value: Readonly<Record<string, unknown>>,
  expected: readonly string[],
): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && keys.every((key) => expected.includes(key));
}
