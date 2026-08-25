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
  readonly rateLimitCooldownMs?: number;
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
  readonly #rateLimitCooldownMs: number;
  #generation: SchedulerGeneration;
  #urgentQueue: InternalTask[] = [];
  #bulkQueue: InternalTask[] = [];
  readonly #pending = new Map<string, InternalTask>();
  readonly #inFlight = new Map<number, InFlightTask>();
  readonly #parkedBulk = new Map<number, InFlightTask>();
  readonly #completed = new Set<string>();
  readonly #supersededBulkCues = new Set<string>();
  readonly #urgentDecisionWaiters = new Map<string, Set<() => void>>();
  #nextRunId = 0;
  #pumpScheduled = false;
  #cooldownUntil = 0;
  #cooldownTimer: ReturnType<typeof setTimeout> | undefined;
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
    this.#rateLimitCooldownMs = clamp(
      options.rateLimitCooldownMs ?? 30_000,
      1,
      5 * 60_000,
    );
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
      return task.priority === 'urgent' || (
        !this.#isQueued(key, 'bulk') && !this.#isInFlight(key, 'bulk')
      );
    });
    if (cues.length === 0) return 'deduplicated';

    const queue = task.priority === 'urgent' ? this.#urgentQueue : this.#bulkQueue;
    const limit = task.priority === 'urgent'
      ? this.#maxUrgentQueue
      : this.#maxBulkQueue;
    if (queue.length >= limit) return 'rejected';

    const effectiveTask = cues.length === task.cues.length ? task : { ...task, cues };
    if (task.priority === 'urgent') {
      for (const cue of cues) {
        const key = cueIdentity(effectiveTask, cue);
        if (this.#isInFlight(key, 'bulk')) this.#supersededBulkCues.add(key);
      }
    }
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
    this.#supersededBulkCues.clear();
    this.#resolveAllUrgentDecisionWaiters();
    this.#clearCooldown();
    for (const inFlight of this.#inFlight.values()) inFlight.controller.abort();
    for (const parked of this.#parkedBulk.values()) parked.controller.abort();
    this.#parkedBulk.clear();
    this.#resolveIdleIfNeeded();
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#urgentQueue = [];
    this.#bulkQueue = [];
    this.#pending.clear();
    this.#completed.clear();
    this.#supersededBulkCues.clear();
    this.#resolveAllUrgentDecisionWaiters();
    this.#clearCooldown();
    for (const inFlight of this.#inFlight.values()) inFlight.controller.abort();
    for (const parked of this.#parkedBulk.values()) parked.controller.abort();
    this.#parkedBulk.clear();
    this.#resolveIdleIfNeeded();
  }

  snapshot(): {
    readonly bulkQueued: number;
    readonly inFlight: number;
    readonly urgentQueued: number;
  } {
    return {
      bulkQueued: this.#bulkQueue.length,
      inFlight: this.#inFlight.size + this.#parkedBulk.size,
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
    if (this.#disposed) {
      this.#resolveIdleIfNeeded();
      return;
    }
    if (Date.now() < this.#cooldownUntil) {
      this.#scheduleCooldownWake();
      this.#resolveIdleIfNeeded();
      return;
    }
    this.#cooldownUntil = 0;
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
        this.#releaseFailedUrgentCues(inFlight.task, inFlight.task.cues);
        if (result.error.code === 'rate_limited') {
          this.#cooldownUntil = Math.max(
            this.#cooldownUntil,
            Date.now() + this.#rateLimitCooldownMs,
          );
        }
        if (!result.error.retryable) {
          this.#markCompleted(inFlight.task, this.#ownedCues(inFlight.task));
        }
        return;
      }

      if (!isRelevantBatch(inFlight.task, result.value)) {
        this.#releaseFailedUrgentCues(inFlight.task, inFlight.task.cues);
        this.#markCompleted(inFlight.task, this.#ownedCues(inFlight.task));
        return;
      }

      const initiallyOwned = this.#ownedCues(inFlight.task, inFlight.task.cues);
      const initiallyOwnedIds = new Set(initiallyOwned.map(({ id }) => id));
      let deferredCues: readonly TranslationCueInput[] = inFlight.task.cues.filter(
        ({ id }) => !initiallyOwnedIds.has(id),
      );
      deferredCues = uniqueCueList([
        ...deferredCues,
        ...await this.#settleBatchCues(inFlight, result.value, initiallyOwned),
      ]);

      while (inFlight.task.priority === 'bulk' && deferredCues.length > 0) {
        const waiting = deferredCues.filter((cue) =>
          this.#hasPendingUrgentDecision(inFlight.task, cue));
        if (waiting.length > 0) {
          this.#parkBulkRun(inFlight);
          await this.#waitForUrgentDecisions(inFlight, waiting);
          if (!this.#isCurrent(inFlight)) return;
        }

        const released = this.#ownedCues(inFlight.task, deferredCues);
        if (released.length === 0) break;
        deferredCues = uniqueCueList(
          await this.#settleBatchCues(inFlight, result.value, released),
        );
      }
    } catch {
      this.#releaseFailedUrgentCues(inFlight.task, inFlight.task.cues);
      // Provider and cache failures are contained. The scheduler never owns an
      // additional provider-level retry; only validated partial cues requeue.
    } finally {
      if (this.#inFlight.get(inFlight.runId) === inFlight) {
        this.#inFlight.delete(inFlight.runId);
      }
      if (this.#parkedBulk.get(inFlight.runId) === inFlight) {
        this.#parkedBulk.delete(inFlight.runId);
      }
      if (inFlight.task.priority === 'urgent') {
        for (const cue of inFlight.task.cues) {
          const key = cueIdentity(inFlight.task, cue);
          if (!this.#isQueued(key, 'urgent') && !this.#isInFlight(key, 'urgent')) {
            this.#notifyUrgentDecision(inFlight.task, [cue]);
          }
        }
      }
      if (inFlight.task.priority === 'bulk') {
        for (const cue of inFlight.task.cues) {
          this.#supersededBulkCues.delete(cueIdentity(inFlight.task, cue));
        }
      }
      this.#schedulePump();
      this.#resolveIdleIfNeeded();
    }
  }

  async #settleBatchCues(
    inFlight: InFlightTask,
    batch: TranslationBatch,
    candidates: readonly TranslationCueInput[],
  ): Promise<readonly TranslationCueInput[]> {
    if (candidates.length === 0 || !this.#isCurrent(inFlight)) return [];
    const ownedCues = this.#ownedCues(inFlight.task, candidates);
    const ownedIds = new Set(ownedCues.map(({ id }) => id));
    const accepted: TranslationBatch = {
      translations: batch.translations.filter(({ cueId }) => ownedIds.has(cueId)),
      retryCueIds: [],
    };

    if (accepted.translations.length > 0) {
      try {
        await this.#writeCache(inFlight.task, accepted, {
          signal: inFlight.controller.signal,
          isCurrent: () => {
            if (!this.#isCurrent(inFlight)) return false;
            const currentOwnedIds = new Set(
              this.#ownedCues(inFlight.task, ownedCues).map(({ id }) => id),
            );
            return accepted.translations.every(
              ({ cueId }) => currentOwnedIds.has(cueId),
            );
          },
        });
      } catch {
        // Persistence is best-effort; a current valid result still renders.
      }
      if (!this.#isCurrent(inFlight)) return [];
      const currentOwnedIds = new Set(
        this.#ownedCues(inFlight.task, ownedCues).map(({ id }) => id),
      );
      const currentAccepted: TranslationBatch = {
        translations: accepted.translations.filter(
          ({ cueId }) => currentOwnedIds.has(cueId),
        ),
        retryCueIds: [],
      };
      if (currentAccepted.translations.length > 0) {
        this.#render(inFlight.task, currentAccepted);
        if (inFlight.task.priority === 'urgent') {
          const successfulIds = new Set(
            currentAccepted.translations.map(({ cueId }) => cueId),
          );
          this.#notifyUrgentDecision(
            inFlight.task,
            ownedCues.filter(({ id }) => successfulIds.has(id)),
          );
        }
      }
    }

    const settledOwnedCues = this.#ownedCues(inFlight.task, ownedCues);
    const retryCues = selectRetryCues(settledOwnedCues, batch.retryCueIds);
    const retryIds = new Set(retryCues.map(({ id }) => id));
    this.#markCompleted(
      inFlight.task,
      settledOwnedCues.filter(({ id }) => !retryIds.has(id)),
    );
    if (retryCues.length > 0 && inFlight.attempt < this.#retryLimit) {
      this.#queuePartialRetry(inFlight, retryCues);
    } else {
      this.#releaseFailedUrgentCues(inFlight.task, retryCues);
      this.#markCompleted(inFlight.task, retryCues);
    }

    const settledIds = new Set(settledOwnedCues.map(({ id }) => id));
    return candidates.filter(({ id }) => !settledIds.has(id));
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

  #scheduleCooldownWake(): void {
    if (
      this.#cooldownTimer !== undefined ||
      (this.#urgentQueue.length === 0 && this.#bulkQueue.length === 0)
    ) return;
    const delay = Math.max(0, this.#cooldownUntil - Date.now());
    this.#cooldownTimer = setTimeout(() => {
      this.#cooldownTimer = undefined;
      this.#schedulePump();
    }, delay);
  }

  #clearCooldown(): void {
    this.#cooldownUntil = 0;
    if (this.#cooldownTimer === undefined) return;
    clearTimeout(this.#cooldownTimer);
    this.#cooldownTimer = undefined;
  }

  #isQueued(cueKey: string, priority: TranslationPriority): boolean {
    const queue = priority === 'urgent' ? this.#urgentQueue : this.#bulkQueue;
    return queue.some(({ task }) => task.cues.some(
      (cue) => cueIdentity(task, cue) === cueKey,
    ));
  }

  #isInFlight(cueKey: string, priority: TranslationPriority): boolean {
    return [
      ...this.#inFlight.values(),
      ...this.#parkedBulk.values(),
    ].some(({ task }) => (
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

  #ownedCues(
    task: ScheduledTranslationTask,
    cues: readonly TranslationCueInput[] = task.cues,
  ): readonly TranslationCueInput[] {
    if (task.priority !== 'bulk') return cues;
    return cues.filter(
      (cue) => !this.#supersededBulkCues.has(cueIdentity(task, cue)),
    );
  }

  #releaseFailedUrgentCues(
    task: ScheduledTranslationTask,
    cues: readonly TranslationCueInput[],
  ): void {
    if (task.priority !== 'urgent') return;
    for (const cue of cues) {
      this.#supersededBulkCues.delete(cueIdentity(task, cue));
    }
    this.#notifyUrgentDecision(task, cues);
  }

  #hasPendingUrgentDecision(
    task: ScheduledTranslationTask,
    cue: TranslationCueInput,
  ): boolean {
    const key = cueIdentity(task, cue);
    return this.#supersededBulkCues.has(key) && (
      this.#isQueued(key, 'urgent') || this.#isInFlight(key, 'urgent')
    );
  }

  #parkBulkRun(inFlight: InFlightTask): void {
    if (this.#inFlight.get(inFlight.runId) !== inFlight) return;
    this.#inFlight.delete(inFlight.runId);
    this.#parkedBulk.set(inFlight.runId, inFlight);
    this.#schedulePump();
  }

  async #waitForUrgentDecisions(
    inFlight: InFlightTask,
    cues: readonly TranslationCueInput[],
  ): Promise<void> {
    const waits: Promise<void>[] = [];
    for (const cue of cues) {
      const key = cueIdentity(inFlight.task, cue);
      if (!this.#hasPendingUrgentDecision(inFlight.task, cue)) continue;
      waits.push(new Promise<void>((resolve) => {
        const waiters = this.#urgentDecisionWaiters.get(key) ?? new Set();
        waiters.add(resolve);
        this.#urgentDecisionWaiters.set(key, waiters);
      }));
    }
    if (waits.length > 0) await Promise.all(waits);
  }

  #notifyUrgentDecision(
    task: ScheduledTranslationTask,
    cues: readonly TranslationCueInput[],
  ): void {
    for (const cue of cues) {
      const key = cueIdentity(task, cue);
      const waiters = this.#urgentDecisionWaiters.get(key);
      if (waiters === undefined) continue;
      this.#urgentDecisionWaiters.delete(key);
      for (const resolve of waiters) resolve();
    }
  }

  #resolveAllUrgentDecisionWaiters(): void {
    const waiting = [...this.#urgentDecisionWaiters.values()];
    this.#urgentDecisionWaiters.clear();
    for (const waiters of waiting) {
      for (const resolve of waiters) resolve();
    }
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
      (
        this.#inFlight.get(inFlight.runId) === inFlight ||
        this.#parkedBulk.get(inFlight.runId) === inFlight
      )
    );
  }

  #isIdle(): boolean {
    return (
      this.#urgentQueue.length === 0 &&
      this.#bulkQueue.length === 0 &&
      this.#inFlight.size === 0 &&
      this.#parkedBulk.size === 0 &&
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

function uniqueCueList(
  cues: readonly TranslationCueInput[],
): readonly TranslationCueInput[] {
  const seen = new Set<string>();
  return cues.filter(({ id }) => {
    if (seen.has(id)) return false;
    seen.add(id);
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
