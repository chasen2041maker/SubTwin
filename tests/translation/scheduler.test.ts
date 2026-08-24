import { describe, expect, it, vi } from 'vitest';

import {
  TranslationScheduler,
  createProviderTasks,
  type ScheduledTranslationTask,
} from '../../src/translation/scheduler';
import type { TranslationResult } from '../../src/translation/types';

function task(
  taskId: string,
  priority: 'bulk' | 'urgent',
  cueIds: readonly string[] = [taskId],
): ScheduledTranslationTask {
  return {
    taskId,
    sessionId: 'session-a',
    priority,
    episodeId: 'episode-a',
    trackHash: 'track-a',
    provider: 'deepseek',
    sourceLanguage: 'en',
    targetLanguage: 'zh-Hans',
    episodeGeneration: 1,
    providerGeneration: 1,
    cues: cueIds.map((id, index) => ({
      id,
      startMs: index * 1_000,
      endMs: index * 1_000 + 900,
      text: `source-${id}`,
    })),
    context: [],
  };
}

const translated = (cueIds: readonly string[]): TranslationResult => ({
  ok: true,
  value: {
    translations: cueIds.map((cueId) => ({ cueId, text: `translated-${cueId}` })),
    retryCueIds: [],
  },
});

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolve = (_value: T): void => undefined;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe('TranslationScheduler priority and capacity', () => {
  it('reserves capacity for urgent work instead of filling all slots with bulk work', async () => {
    const pending = new Map<string, ReturnType<typeof deferred<TranslationResult>>>();
    const execute = vi.fn((scheduled: ScheduledTranslationTask) => {
      const result = deferred<TranslationResult>();
      pending.set(scheduled.taskId, result);
      return result.promise;
    });
    const scheduler = new TranslationScheduler({
      generation: { episodeGeneration: 1, providerGeneration: 1 },
      execute,
      writeCache: vi.fn().mockResolvedValue(undefined),
      render: vi.fn(),
      maxConcurrent: 2,
      reservedUrgent: 1,
    });

    scheduler.enqueue(task('bulk-1', 'bulk'));
    scheduler.enqueue(task('bulk-2', 'bulk'));
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(1));
    scheduler.enqueue(task('urgent-1', 'urgent'));
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(2));

    expect(execute.mock.calls.map(([scheduled]) => scheduled.taskId)).toEqual([
      'bulk-1',
      'urgent-1',
    ]);
    pending.get('bulk-1')?.resolve(translated(['bulk-1']));
    pending.get('urgent-1')?.resolve(translated(['urgent-1']));
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(3));
    pending.get('bulk-2')?.resolve(translated(['bulk-2']));
    await scheduler.whenIdle();
  });

  it('promotes a queued seek neighborhood ahead of background work without duplication', async () => {
    const first = deferred<TranslationResult>();
    const execute = vi.fn((scheduled: ScheduledTranslationTask) =>
      scheduled.taskId === 'blocker'
        ? first.promise
        : Promise.resolve(translated(scheduled.cues.map(({ id }) => id))),
    );
    const scheduler = new TranslationScheduler({
      generation: { episodeGeneration: 1, providerGeneration: 1 },
      execute,
      writeCache: vi.fn().mockResolvedValue(undefined),
      render: vi.fn(),
      maxConcurrent: 1,
      reservedUrgent: 0,
    });

    scheduler.enqueue(task('blocker', 'urgent'));
    await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
    scheduler.enqueue(task('later', 'bulk'));
    scheduler.enqueue(task('seek', 'bulk'));
    expect(scheduler.enqueue(task('seek', 'urgent'))).toBe('promoted');
    first.resolve(translated(['blocker']));
    await scheduler.whenIdle();

    expect(execute.mock.calls.map(([scheduled]) => scheduled.taskId)).toEqual([
      'blocker',
      'seek',
      'later',
    ]);
    expect(execute.mock.calls.filter(([scheduled]) => scheduled.taskId === 'seek')).toHaveLength(1);
    expect(scheduler.enqueue(task('seek', 'urgent'))).toBe('deduplicated');
  });

  it('splits a queued DeepSeek bulk batch when a seek promotes a cue subset', async () => {
    const blocker = deferred<TranslationResult>();
    const execute = vi.fn((scheduled: ScheduledTranslationTask) =>
      scheduled.taskId === 'blocker'
        ? blocker.promise
        : Promise.resolve(translated(scheduled.cues.map(({ id }) => id))),
    );
    const scheduler = new TranslationScheduler({
      generation: { episodeGeneration: 1, providerGeneration: 1 },
      execute,
      writeCache: vi.fn().mockResolvedValue(undefined),
      render: vi.fn(),
      maxConcurrent: 1,
      reservedUrgent: 0,
    });
    const bulkCueIds = Array.from({ length: 20 }, (_, index) => `cue-${index}`);
    const urgentCueIds = bulkCueIds.slice(7, 12);

    scheduler.enqueue(task('blocker', 'urgent'));
    await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
    scheduler.enqueue(task('bulk', 'bulk', bulkCueIds));
    expect(scheduler.enqueue(task('seek', 'urgent', urgentCueIds))).toBe('promoted');
    blocker.resolve(translated(['blocker']));
    await scheduler.whenIdle();

    const translatedTasks = execute.mock.calls
      .map(([scheduled]) => scheduled)
      .filter(({ taskId }) => taskId !== 'blocker');
    expect(translatedTasks.map(({ priority, cues }) => ({
      priority,
      cueIds: cues.map(({ id }) => id),
    }))).toEqual([
      { priority: 'urgent', cueIds: urgentCueIds },
      {
        priority: 'bulk',
        cueIds: bulkCueIds.filter((id) => !urgentCueIds.includes(id)),
      },
    ]);
    expect(translatedTasks.flatMap(({ cues }) => cues.map(({ id }) => id)).sort()).toEqual(
      [...bulkCueIds].sort(),
    );
  });

  it('does not execute a completed cue subset again', async () => {
    const execute = vi.fn((scheduled: ScheduledTranslationTask) =>
      Promise.resolve(translated(scheduled.cues.map(({ id }) => id))),
    );
    const scheduler = new TranslationScheduler({
      generation: { episodeGeneration: 1, providerGeneration: 1 },
      execute,
      writeCache: vi.fn().mockResolvedValue(undefined),
      render: vi.fn(),
    });

    scheduler.enqueue(task('initial', 'urgent', ['cue-1', 'cue-2', 'cue-3']));
    await scheduler.whenIdle();

    expect(scheduler.enqueue(task('seek', 'urgent', ['cue-2']))).toBe('deduplicated');
    await scheduler.whenIdle();
    expect(execute).toHaveBeenCalledOnce();
  });

  it('deduplicates an urgent cue that is already owned by an in-flight bulk request', async () => {
    const bulk = deferred<TranslationResult>();
    const execute = vi.fn((scheduled: ScheduledTranslationTask) =>
      scheduled.priority === 'bulk'
        ? bulk.promise
        : Promise.resolve(translated(scheduled.cues.map(({ id }) => id))),
    );
    const scheduler = new TranslationScheduler({
      generation: { episodeGeneration: 1, providerGeneration: 1 },
      execute,
      writeCache: vi.fn().mockResolvedValue(undefined),
      render: vi.fn(),
      maxConcurrent: 2,
      reservedUrgent: 1,
    });

    scheduler.enqueue(task('bulk', 'bulk', ['cue-1', 'cue-2', 'cue-3']));
    await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
    expect(scheduler.enqueue(task('seek', 'urgent', ['cue-2']))).toBe('deduplicated');
    expect(execute).toHaveBeenCalledOnce();

    bulk.resolve(translated(['cue-1', 'cue-2', 'cue-3']));
    await scheduler.whenIdle();
    expect(execute).toHaveBeenCalledOnce();
  });

  it('filters only overlapping in-flight bulk cues and still runs new urgent cues', async () => {
    const bulk = deferred<TranslationResult>();
    const urgent = deferred<TranslationResult>();
    const execute = vi.fn((scheduled: ScheduledTranslationTask) =>
      scheduled.priority === 'bulk' ? bulk.promise : urgent.promise,
    );
    const scheduler = new TranslationScheduler({
      generation: { episodeGeneration: 1, providerGeneration: 1 },
      execute,
      writeCache: vi.fn().mockResolvedValue(undefined),
      render: vi.fn(),
      maxConcurrent: 2,
      reservedUrgent: 1,
    });

    scheduler.enqueue(task('bulk', 'bulk', ['cue-1']));
    await vi.waitFor(() => expect(scheduler.snapshot().inFlight).toBe(1));
    expect(scheduler.enqueue(task('seek', 'urgent', ['cue-1', 'cue-2']))).toBe('queued');
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(2));
    expect(execute.mock.calls[1]?.[0].cues.map(({ id }) => id)).toEqual(['cue-2']);
    expect(scheduler.snapshot().inFlight).toBe(2);

    urgent.resolve(translated(['cue-2']));
    bulk.resolve(translated(['cue-1']));
    await scheduler.whenIdle();
    expect(scheduler.snapshot().inFlight).toBe(0);
  });

  it.each(['dispose', 'generation'] as const)(
    '%s aborts every concurrent execution controller',
    async (action) => {
      const pending = [deferred<TranslationResult>(), deferred<TranslationResult>()];
      const signals: AbortSignal[] = [];
      const execute = vi.fn((
        _scheduled: ScheduledTranslationTask,
        signal: AbortSignal,
      ) => {
        signals.push(signal);
        return pending[signals.length - 1]!.promise;
      });
      const scheduler = new TranslationScheduler({
        generation: { episodeGeneration: 1, providerGeneration: 1 },
        execute,
        writeCache: vi.fn().mockResolvedValue(undefined),
        render: vi.fn(),
        maxConcurrent: 2,
        reservedUrgent: 1,
      });

      scheduler.enqueue(task('bulk', 'bulk', ['cue-1']));
      await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
      scheduler.enqueue(task('seek', 'urgent', ['cue-2']));
      await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(2));

      if (action === 'dispose') scheduler.dispose();
      else scheduler.setGeneration({ episodeGeneration: 2, providerGeneration: 1 });

      expect(signals).toHaveLength(2);
      expect(signals.every(({ aborted }) => aborted)).toBe(true);
      pending[0]!.resolve(translated(['cue-1']));
      pending[1]!.resolve(translated(['cue-2']));
      await scheduler.whenIdle();
    },
  );

  it('deduplicates the same provider/generation/cue content even when task IDs differ', async () => {
    const blocker = deferred<TranslationResult>();
    const scheduler = new TranslationScheduler({
      generation: { episodeGeneration: 1, providerGeneration: 1 },
      execute: vi.fn().mockReturnValue(blocker.promise),
      writeCache: vi.fn().mockResolvedValue(undefined),
      render: vi.fn(),
      maxConcurrent: 1,
      reservedUrgent: 0,
    });
    const original = task('arbitrary-a', 'bulk', ['same-cue']);
    const renamed = { ...original, taskId: 'arbitrary-b' };

    expect(scheduler.enqueue(original)).toBe('queued');
    expect(scheduler.enqueue(renamed)).toBe('deduplicated');
    blocker.resolve(translated(['same-cue']));
    await scheduler.whenIdle();
  });

  it('keeps completed cue identities isolated between Netflix tab sessions', async () => {
    const execute = vi.fn((scheduled: ScheduledTranslationTask) =>
      Promise.resolve(translated(scheduled.cues.map(({ id }) => id))),
    );
    const scheduler = new TranslationScheduler({
      generation: { episodeGeneration: 1, providerGeneration: 1 },
      execute,
      writeCache: vi.fn().mockResolvedValue(undefined),
      render: vi.fn(),
    });

    scheduler.enqueue(task('tab-a', 'urgent', ['cue-1']));
    await scheduler.whenIdle();
    expect(scheduler.enqueue({
      ...task('tab-b', 'urgent', ['cue-1']),
      sessionId: 'session-b',
    })).toBe('queued');
    await scheduler.whenIdle();

    expect(execute).toHaveBeenCalledTimes(2);
  });
});

describe('TranslationScheduler retries and generations', () => {
  it.each([
    {
      name: 'unknown translation IDs',
      result: {
        ok: true as const,
        value: {
          translations: [{ cueId: 'unknown', text: '越界' }],
          retryCueIds: [],
        },
      },
    },
    {
      name: 'duplicate translation IDs',
      result: {
        ok: true as const,
        value: {
          translations: [
            { cueId: 'cue-1', text: '第一个' },
            { cueId: 'cue-1', text: '重复' },
          ],
          retryCueIds: [],
        },
      },
    },
    {
      name: 'overlapping translated and retry IDs',
      result: {
        ok: true as const,
        value: {
          translations: [{ cueId: 'cue-1', text: '有效' }],
          retryCueIds: ['cue-1'],
        },
      },
    },
    {
      name: 'missing IDs without an explicit retry selection',
      result: {
        ok: true as const,
        value: {
          translations: [{ cueId: 'cue-1', text: '只有一条' }],
          retryCueIds: [],
        },
      },
    },
  ])('rejects provider contract violations with $name', async ({ result }) => {
    const execute = vi.fn().mockResolvedValue(result);
    const writeCache = vi.fn().mockResolvedValue(undefined);
    const render = vi.fn();
    const scheduler = new TranslationScheduler({
      generation: { episodeGeneration: 1, providerGeneration: 1 },
      execute,
      writeCache,
      render,
      retryLimit: 1,
    });

    scheduler.enqueue(task('invalid-result', 'urgent', ['cue-1', 'cue-2']));
    await scheduler.whenIdle();

    expect(execute).toHaveBeenCalledOnce();
    expect(writeCache).not.toHaveBeenCalled();
    expect(render).not.toHaveBeenCalled();
  });

  it('retries only invalid or missing cues once and never resends valid cues', async () => {
    const execute = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        value: {
          translations: [{ cueId: 'cue-1', text: '有效' }],
          retryCueIds: ['cue-2'],
        },
      })
      .mockResolvedValueOnce(translated(['cue-2']));
    const render = vi.fn();
    const scheduler = new TranslationScheduler({
      generation: { episodeGeneration: 1, providerGeneration: 1 },
      execute,
      writeCache: vi.fn().mockResolvedValue(undefined),
      render,
      retryLimit: 1,
    });

    scheduler.enqueue(task('batch', 'urgent', ['cue-1', 'cue-2']));
    await scheduler.whenIdle();

    expect(execute).toHaveBeenCalledTimes(2);
    expect(execute.mock.calls[0]?.[0].cues.map(({ id }: { id: string }) => id)).toEqual(['cue-1', 'cue-2']);
    expect(execute.mock.calls[1]?.[0].cues.map(({ id }: { id: string }) => id)).toEqual(['cue-2']);
    expect(render.mock.calls.flatMap(([, batch]) => batch.translations.map(({ cueId }: { cueId: string }) => cueId))).toEqual([
      'cue-1',
      'cue-2',
    ]);
  });

  it('does not retry a provider-level failure even when it is marked retryable', async () => {
    const execute = vi.fn().mockResolvedValue({
      ok: false,
      error: { code: 'rate_limited', message: 'Rate limited.', retryable: true },
    });
    const scheduler = new TranslationScheduler({
      generation: { episodeGeneration: 1, providerGeneration: 1 },
      execute,
      writeCache: vi.fn().mockResolvedValue(undefined),
      render: vi.fn(),
      retryLimit: 1,
    });

    scheduler.enqueue(task('failure', 'urgent'));
    await scheduler.whenIdle();

    expect(execute).toHaveBeenCalledOnce();
  });

  it('allows the controller to explicitly retry a transient provider failure', async () => {
    const execute = vi.fn()
      .mockResolvedValueOnce({
        ok: false,
        error: { code: 'rate_limited', message: 'Rate limited.', retryable: true },
      })
      .mockResolvedValueOnce(translated(['cue-1']));
    const scheduler = new TranslationScheduler({
      generation: { episodeGeneration: 1, providerGeneration: 1 },
      execute,
      writeCache: vi.fn().mockResolvedValue(undefined),
      render: vi.fn(),
    });
    const retryableTask = task('transient', 'urgent', ['cue-1']);

    scheduler.enqueue(retryableTask);
    await scheduler.whenIdle();
    expect(scheduler.enqueue(retryableTask)).toBe('queued');
    await scheduler.whenIdle();

    expect(execute).toHaveBeenCalledTimes(2);
  });

  it('renders a current valid result even if its cache write fails', async () => {
    const render = vi.fn();
    const scheduler = new TranslationScheduler({
      generation: { episodeGeneration: 1, providerGeneration: 1 },
      execute: vi.fn().mockResolvedValue(translated(['cue-1'])),
      writeCache: vi.fn().mockRejectedValue(new Error('disk failure')),
      render,
    });

    scheduler.enqueue(task('cache-failure', 'urgent', ['cue-1']));
    await scheduler.whenIdle();

    expect(render).toHaveBeenCalledOnce();
  });

  it('aborts old work and rejects a late result before cache or render', async () => {
    const late = deferred<TranslationResult>();
    const writeCache = vi.fn().mockResolvedValue(undefined);
    const render = vi.fn();
    const scheduler = new TranslationScheduler({
      generation: { episodeGeneration: 1, providerGeneration: 1 },
      execute: vi.fn().mockReturnValue(late.promise),
      writeCache,
      render,
    });

    scheduler.enqueue(task('old', 'urgent'));
    await vi.waitFor(() => expect(scheduler.snapshot().inFlight).toBe(1));
    scheduler.setGeneration({ episodeGeneration: 2, providerGeneration: 1 });
    late.resolve(translated(['old']));
    await scheduler.whenIdle();

    expect(writeCache).not.toHaveBeenCalled();
    expect(render).not.toHaveBeenCalled();
  });

  it('aborts a guarded cache write if generation changes before commit', async () => {
    const cacheStarted = deferred<void>();
    const allowCache = deferred<void>();
    let committed = false;
    const writeCache = vi.fn(async (
      _task: ScheduledTranslationTask,
      _result: unknown,
      guard: { readonly signal: AbortSignal; readonly isCurrent: () => boolean },
    ) => {
      cacheStarted.resolve();
      await allowCache.promise;
      if (!guard.signal.aborted && guard.isCurrent()) committed = true;
    });
    const render = vi.fn();
    const scheduler = new TranslationScheduler({
      generation: { episodeGeneration: 1, providerGeneration: 1 },
      execute: vi.fn().mockResolvedValue(translated(['old'])),
      writeCache,
      render,
    });

    scheduler.enqueue(task('old', 'urgent'));
    await cacheStarted.promise;
    scheduler.setGeneration({ episodeGeneration: 2, providerGeneration: 1 });
    allowCache.resolve();
    await scheduler.whenIdle();

    expect(committed).toBe(false);
    expect(render).not.toHaveBeenCalled();
  });
});

describe('provider batching contract', () => {
  it('uses single cues for Google and 15-25 cue background batches for DeepSeek', () => {
    const cues = Array.from({ length: 41 }, (_, index) => ({
      id: `cue-${index}`,
      startMs: index * 1_000,
      endMs: index * 1_000 + 900,
      text: `source-${index}`,
    }));
    const base = task('base', 'bulk');

    const googleTasks = createProviderTasks({ ...base, provider: 'google-free' }, cues, 'bulk');
    const deepseekTasks = createProviderTasks(base, cues, 'bulk');

    expect(googleTasks).toHaveLength(41);
    expect(googleTasks.every(({ cues: batch }) => batch.length === 1)).toBe(true);
    expect(deepseekTasks.map(({ cues: batch }) => batch.length)).toEqual([20, 21]);
  });
});
