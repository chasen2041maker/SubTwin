import type {
  TranslationBatch,
  TranslationCueInput,
  TranslationRequest,
  TranslationResult,
} from './types';
import { hashTranslationSource } from './cache';

export type TranslationPriority = 'bulk' | 'urgent';

export interface ScheduledTranslationTask extends TranslationRequest {
  readonly provider: Exclude<TranslationRequest['provider'], 'unset'>;
  readonly priority: TranslationPriority;
}

export interface SchedulerGeneration {
  readonly episodeGeneration: number;
  readonly providerGeneration: number;
}

export interface TranslationCommitGuard {
  readonly signal: AbortSignal;
  readonly isCurrent: () => boolean;
}

export interface TranslationSchedulerOptions {
  readonly generation: SchedulerGeneration;
  readonly execute: (
    task: ScheduledTranslationTask,
    signal: AbortSignal,
  ) => Promise<TranslationResult>;
  readonly writeCache: (
    task: ScheduledTranslationTask,
    batch: TranslationBatch,
    guard: TranslationCommitGuard,
  ) => Promise<void>;
  readonly render: (
    task: ScheduledTranslationTask,
    batch: TranslationBatch,
  ) => void;
  readonly maxConcurrent?: number;
  readonly reservedUrgent?: number;
  readonly maxUrgentQueue?: number;
  readonly maxBulkQueue?: number;
  readonly retryLimit?: number;
}

export type SchedulerEnqueueResult =
  | 'deduplicated'
  | 'promoted'
  | 'queued'
  | 'rejected';

interface InternalTask {
  readonly baseKey: string;
  readonly task: ScheduledTranslationTask;
  readonly attempt: number;
}

interface InFlightTask extends InternalTask {
  readonly controller: AbortController;
  readonly runId: number;
}

export class TranslationScheduler {
  readonly #execute: TranslationSchedulerOptions['execute'];
  readonly #writeCache: TranslationSchedulerOptions['writeCache'];
  readonly #render: TranslationSchedulerOptions['render'];
  readonly #maxConcurrent: number;
  readonly #reservedUrgent: number;
  readonly #maxUrgentQueue: number;
  readonly #maxBulkQueue: number;
  readonly #retryLimit: number;
  #generation: SchedulerGeneration;
  #urgentQueue: InternalTask[] = [];
  #bulkQueue: InternalTask[] = [];
  readonly #pending = new Map<string, InternalTask>();
  readonly #inFlight = new Map<number, InFlightTask>();
  readonly #completed = new Set<string>();
  #nextRunId = 0;
  #pumpScheduled = false;
  #disposed = false;
  #idleWaiters: Array<() => void> = [];

  constructor(options: TranslationSchedulerOptions) {
    this.#execute = options.execute;
    this.#writeCache = options.writeCache;
    this.#render = options.render;
    this.#generation = options.generation;
    this.#maxConcurrent = clamp(options.maxConcurrent ?? 3, 1, 16);
    this.#reservedUrgent = clamp(
      options.reservedUrgent ?? 1,
      0,
      this.#maxConcurrent,
    );
    this.#maxUrgentQueue = clamp(options.maxUrgentQueue ?? 100, 1, 1_000);
    this.#maxBulkQueue = clamp(options.maxBulkQueue ?? 500, 1, 5_000);
    this.#retryLimit = clamp(options.retryLimit ?? 1, 0, 3);
  }

  enqueue(task: ScheduledTranslationTask): SchedulerEnqueueResult {
    if (this.#disposed || !this.#matchesGeneration(task) || task.cues.length === 0) {
      return 'rejected';
    }

    const cues = uniqueCues(task, task.cues).filter((cue) => {
      const key = cueIdentity(task, cue);
      if (this.#completed.has(key)) return false;
      if (this.#isQueued(key, 'urgent')) return false;
      if (this.#isInFlight(key, 'urgent')) return false;
      // Urgent work can still promote a cue out of a queued bulk task, but an
      // already in-flight bulk request owns that cue until it settles. Sending
      // the same subtitle twice creates duplicate provider charges and lets a
      // late bulk response overwrite the urgent result/cache.
      if (this.#isInFlight(key, 'bulk')) return false;
      return task.priority === 'urgent' || !this.#isQueued(key, 'bulk');
    });
    if (cues.length === 0) return 'deduplicated';

    const queue = task.priority === 'urgent' ? this.#urgentQueue : this.#bulkQueue;
    const limit = task.priority === 'urgent'
      ? this.#maxUrgentQueue
      : this.#maxBulkQueue;
    if (queue.length >= limit) return 'rejected';

    const effectiveTask = cues.length === task.cues.length ? task : { ...task, cues };
    const promoted = task.priority === 'urgent'
      ? this.#removeQueuedBulkCues(effectiveTask, cues)
      : false;
    const baseKey = taskIdentity(effectiveTask);
    const queued = { baseKey, task: effectiveTask, attempt: 0 };
    queue.push(queued);
    this.#pending.set(baseKey, queued);
    this.#schedulePump();
    return promoted ? 'promoted' : 'queued';
  }

  setGeneration(generation: SchedulerGeneration): void {
    if (
      generation.episodeGeneration === this.#generation.episodeGeneration &&
      generation.providerGeneration === this.#generation.providerGeneration
    ) return;

    this.#generation = generation;
    this.#urgentQueue = [];
    this.#bulkQueue = [];
    this.#pending.clear();
    this.#completed.clear();
    for (const inFlight of this.#inFlight.values()) inFlight.controller.abort();
    this.#resolveIdleIfNeeded();
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#urgentQueue = [];
    this.#bulkQueue = [];
    this.#pending.clear();
    this.#completed.clear();
    for (const inFlight of this.#inFlight.values()) inFlight.controller.abort();
    this.#resolveIdleIfNeeded();
  }

  snapshot(): {
    readonly bulkQueued: number;
    readonly inFlight: number;
    readonly urgentQueued: number;
  } {
    return {
      bulkQueued: this.#bulkQueue.length,
      inFlight: this.#inFlight.size,
      urgentQueued: this.#urgentQueue.length,
    };
  }

  whenIdle(): Promise<void> {
    if (this.#isIdle()) return Promise.resolve();
    return new Promise<void>((resolve) => this.#idleWaiters.push(resolve));
  }

  #schedulePump(): void {
    if (this.#pumpScheduled || this.#disposed) return;
    this.#pumpScheduled = true;
    queueMicrotask(() => {
      this.#pumpScheduled = false;
      this.#pump();
    });
  }

  #pump(): void {
    if (this.#disposed) return;
    while (this.#inFlight.size < this.#maxConcurrent) {
      const next = this.#takeNext();
      if (!next) break;
      this.#pending.delete(next.baseKey);
      const controller = new AbortController();
      const runId = this.#nextRunId;
      this.#nextRunId += 1;
      const inFlight: InFlightTask = { ...next, controller, runId };
      this.#inFlight.set(runId, inFlight);
      void this.#run(inFlight);
    }
    this.#resolveIdleIfNeeded();
  }

  #takeNext(): InternalTask | undefined {
    const urgent = this.#takeCurrent(this.#urgentQueue);
    if (urgent) return urgent;

    const bulkCapacity = this.#maxConcurrent - this.#reservedUrgent;
    const bulkInFlight = [...this.#inFlight.values()].filter(
      ({ task }) => task.priority === 'bulk',
    ).length;
    if (bulkInFlight >= bulkCapacity) return undefined;
    return this.#takeCurrent(this.#bulkQueue);
  }

  async #run(inFlight: InFlightTask): Promise<void> {
    try {
      const result = await this.#execute(inFlight.task, inFlight.controller.signal);
      if (!this.#isCurrent(inFlight)) return;

      if (!result.ok) {
        if (!result.error.retryable) {
          this.#markCompleted(inFlight.task, inFlight.task.cues);
        }
        return;
      }

      if (!isRelevantBatch(inFlight.task, result.value)) {
        this.#markCompleted(inFlight.task, inFlight.task.cues);
        return;
      }

      const accepted: TranslationBatch = {
        translations: result.value.translations,
        retryCueIds: [],
      };
      if (accepted.translations.length > 0) {
        try {
          await this.#writeCache(inFlight.task, accepted, {
            signal: inFlight.controller.signal,
            isCurrent: () => this.#isCurrent(inFlight),
          });
        } catch {
          // Persistence is best-effort; a current valid result still renders.
        }
        if (!this.#isCurrent(inFlight)) return;
        this.#render(inFlight.task, accepted);
      }

      const retryCues = selectRetryCues(
        inFlight.task.cues,
        result.value.retryCueIds,
      );
      const retryIds = new Set(retryCues.map(({ id }) => id));
      this.#markCompleted(
        inFlight.task,
        inFlight.task.cues.filter(({ id }) => !retryIds.has(id)),
      );
      if (retryCues.length > 0 && inFlight.attempt < this.#retryLimit) {
        this.#queuePartialRetry(inFlight, retryCues);
      } else {
        this.#markCompleted(inFlight.task, retryCues);
      }
    } catch {
      // Provider and cache failures are contained. The scheduler never owns an
      // additional provider-level retry; only validated partial cues requeue.
    } finally {
      if (this.#inFlight.get(inFlight.runId) === inFlight) {
        this.#inFlight.delete(inFlight.runId);
      }
      this.#schedulePump();
      this.#resolveIdleIfNeeded();
    }
  }

  #queuePartialRetry(
    previous: InFlightTask,
    cues: readonly TranslationCueInput[],
  ): void {
    if (!this.#isCurrent(previous)) return;
    const task: ScheduledTranslationTask = {
      ...previous.task,
      taskId: `${previous.task.taskId}:partial-${previous.attempt + 1}`,
      cues,
    };
    const retry: InternalTask = {
      baseKey: taskIdentity(task),
      attempt: previous.attempt + 1,
      task,
    };
    const queue = retry.task.priority === 'urgent' ? this.#urgentQueue : this.#bulkQueue;
    queue.unshift(retry);
    this.#pending.set(retry.baseKey, retry);
  }

  #isQueued(cueKey: string, priority: TranslationPriority): boolean {
    const queue = priority === 'urgent' ? this.#urgentQueue : this.#bulkQueue;
    return queue.some(({ task }) => task.cues.some(
      (cue) => cueIdentity(task, cue) === cueKey,
    ));
  }

  #isInFlight(cueKey: string, priority: TranslationPriority): boolean {
    return [...this.#inFlight.values()].some(({ task }) => (
      task.priority === priority && task.cues.some(
        (cue) => cueIdentity(task, cue) === cueKey,
      )
    ));
  }

  #removeQueuedBulkCues(
    promotedTask: ScheduledTranslationTask,
    cues: readonly TranslationCueInput[],
  ): boolean {
    const promotedKeys = new Set(cues.map((cue) => cueIdentity(promotedTask, cue)));
    let promoted = false;
    const remainingQueue: InternalTask[] = [];
    for (const queued of this.#bulkQueue) {
      const remainingCues = queued.task.cues.filter((cue) => {
        const remove = promotedKeys.has(cueIdentity(queued.task, cue));
        if (remove) promoted = true;
        return !remove;
      });
      if (remainingCues.length === queued.task.cues.length) {
        remainingQueue.push(queued);
        continue;
      }

      this.#pending.delete(queued.baseKey);
      if (remainingCues.length === 0) continue;
      const remainingTask = { ...queued.task, cues: remainingCues };
      const remaining: InternalTask = {
        ...queued,
        baseKey: taskIdentity(remainingTask),
        task: remainingTask,
      };
      remainingQueue.push(remaining);
      this.#pending.set(remaining.baseKey, remaining);
    }
    this.#bulkQueue = remainingQueue;
    return promoted;
  }

  #takeCurrent(queue: InternalTask[]): InternalTask | undefined {
    for (;;) {
      const queued = queue.shift();
      if (!queued) return undefined;
      this.#pending.delete(queued.baseKey);
      const cues = queued.task.cues.filter(
        (cue) => !this.#completed.has(cueIdentity(queued.task, cue)),
      );
      if (cues.length === 0) continue;
      if (cues.length === queued.task.cues.length) return queued;
      const task = { ...queued.task, cues };
      return { ...queued, baseKey: taskIdentity(task), task };
    }
  }

  #markCompleted(
    task: ScheduledTranslationTask,
    cues: readonly TranslationCueInput[],
  ): void {
    for (const cue of cues) this.#completed.add(cueIdentity(task, cue));
  }

  #matchesGeneration(task: ScheduledTranslationTask): boolean {
    return (
      task.episodeGeneration === this.#generation.episodeGeneration &&
      task.providerGeneration === this.#generation.providerGeneration
    );
  }

  #isCurrent(inFlight: InFlightTask): boolean {
    return (
      !this.#disposed &&
      !inFlight.controller.signal.aborted &&
      this.#matchesGeneration(inFlight.task) &&
      this.#inFlight.get(inFlight.runId) === inFlight
    );
  }

  #isIdle(): boolean {
    return (
      this.#urgentQueue.length === 0 &&
      this.#bulkQueue.length === 0 &&
      this.#inFlight.size === 0 &&
      !this.#pumpScheduled
    );
  }

  #resolveIdleIfNeeded(): void {
    if (!this.#isIdle()) return;
    const waiters = this.#idleWaiters;
    this.#idleWaiters = [];
    for (const resolve of waiters) resolve();
  }
}

export function createProviderTasks(
  base: Omit<ScheduledTranslationTask, 'cues' | 'priority'> & {
    readonly priority?: TranslationPriority;
  },
  cues: readonly TranslationCueInput[],
  priority: TranslationPriority,
): readonly ScheduledTranslationTask[] {
  const batches: TranslationCueInput[][] = [];
  if (base.provider === 'deepseek' && priority === 'bulk' && cues.length > 25) {
    const batchCount = Math.ceil(cues.length / 25);
    const baseSize = Math.floor(cues.length / batchCount);
    const largerBatches = cues.length % batchCount;
    let offset = 0;
    for (let index = 0; index < batchCount; index += 1) {
      const size = baseSize + (index >= batchCount - largerBatches ? 1 : 0);
      batches.push(cues.slice(offset, offset + size));
      offset += size;
    }
  } else {
    const batchSize = base.provider === 'google-free'
      ? 1
      : priority === 'urgent'
        ? 5
        : Math.max(1, cues.length);
    for (let offset = 0; offset < cues.length; offset += batchSize) {
      batches.push(cues.slice(offset, offset + batchSize));
    }
  }

  return batches.map((batch, index) => ({
    ...base,
    taskId: `${base.taskId}:${index}`,
    priority,
    cues: batch,
  }));
}

function taskIdentity(task: ScheduledTranslationTask): string {
  return [
    task.provider,
    task.sessionId,
    task.episodeGeneration,
    task.providerGeneration,
    task.episodeId,
    task.trackHash,
    ...task.cues.flatMap(({ id, text }) => [id, hashTranslationSource(text)]),
  ].join(':');
}

function cueIdentity(
  task: ScheduledTranslationTask,
  cue: TranslationCueInput,
): string {
  return [
    task.provider,
    task.sessionId,
    task.episodeGeneration,
    task.providerGeneration,
    task.episodeId,
    task.trackHash,
    cue.id,
    hashTranslationSource(cue.text),
  ].join(':');
}

function uniqueCues(
  task: ScheduledTranslationTask,
  cues: readonly TranslationCueInput[],
): readonly TranslationCueInput[] {
  const seen = new Set<string>();
  return cues.filter((cue) => {
    const key = cueIdentity(task, cue);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function isRelevantBatch(
  task: ScheduledTranslationTask,
  batch: TranslationBatch,
): boolean {
  const requested = new Set(task.cues.map(({ id }) => id));
  const translated = new Set<string>();
  for (const translation of batch.translations) {
    if (!requested.has(translation.cueId) || translated.has(translation.cueId)) {
      return false;
    }
    translated.add(translation.cueId);
  }

  const retry = new Set<string>();
  for (const cueId of batch.retryCueIds) {
    if (
      !requested.has(cueId) ||
      translated.has(cueId) ||
      retry.has(cueId)
    ) return false;
    retry.add(cueId);
  }
  return translated.size + retry.size === requested.size;
}

function selectRetryCues(
  cues: readonly TranslationCueInput[],
  retryCueIds: readonly string[],
): readonly TranslationCueInput[] {
  const requested = new Set(retryCueIds);
  return cues.filter(({ id }) => requested.has(id));
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, Math.floor(value)));
}
