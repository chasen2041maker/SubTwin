import { describe, expect, it } from 'vitest';

import {
  createNativeSubtitleClock,
  createNativeSubtitleMicrotaskScheduler,
  type NativeSubtitleClockScheduler,
  type NativeSubtitleDocument,
  type NativeSubtitleMutationObserver,
  type NativeSubtitleNode,
} from '../../src/netflix/native-subtitle-clock';

class FakeScheduler implements NativeSubtitleClockScheduler {
  private nextId = 0;
  private readonly callbacks = new Map<number, () => void>();

  schedule(callback: () => void): number {
    const id = ++this.nextId;
    this.callbacks.set(id, callback);
    return id;
  }

  cancel(id: unknown): void {
    if (typeof id === 'number') {
      this.callbacks.delete(id);
    }
  }

  get size(): number {
    return this.callbacks.size;
  }

  flush(): void {
    const callbacks = [...this.callbacks.values()];
    this.callbacks.clear();
    callbacks.forEach((callback) => callback());
  }
}

class FakeObserver implements NativeSubtitleMutationObserver {
  readonly observedTargets: unknown[] = [];
  disconnectCount = 0;

  constructor(private readonly callback: () => void) {}

  observe(target: unknown): void {
    this.observedTargets.push(target);
  }

  disconnect(): void {
    this.disconnectCount += 1;
  }

  trigger(): void {
    this.callback();
  }
}

class FakeDocument implements NativeSubtitleDocument {
  readonly root = {};
  container: NativeSubtitleNode | null = null;

  querySelector(): NativeSubtitleNode | null {
    return this.container;
  }
}

function node(
  text: string,
): NativeSubtitleNode & { readonly innerHTML: string } {
  return {
    textContent: text,
    innerHTML: `<span data-secret="do-not-emit">${text}</span>`,
  };
}

function microtaskHarness(isGenerationCurrent?: (generation: number) => boolean) {
  const document = new FakeDocument();
  document.container = node('Initial subtitle');
  const observers: FakeObserver[] = [];
  const ticks: string[] = [];
  const queued: Array<() => void> = [];
  const scheduler = createNativeSubtitleMicrotaskScheduler((callback) => {
    queued.push(callback);
    queueMicrotask(callback);
  });
  const clock = createNativeSubtitleClock({
    document,
    scheduler,
    createObserver: (callback) => {
      const observer = new FakeObserver(callback);
      observers.push(observer);
      return observer;
    },
    sessionId: 'microtask-session',
    generation: 1,
    onTick: (tick) => ticks.push(tick.visibleText),
    ...(isGenerationCurrent === undefined ? {} : { isGenerationCurrent }),
  });
  return { document, observers, ticks, queued, clock };
}

describe('native subtitle microtask scheduling', () => {
  it('delivers the final text of a mutation burst in the current microtask checkpoint', async () => {
    expect(createNativeSubtitleMicrotaskScheduler).toBeTypeOf('function');
    const harness = microtaskHarness();
    harness.clock.start();
    const container = harness.document.container;
    if (container === null) throw new Error('Expected a subtitle container.');
    container.textContent = 'An incomplete';
    harness.observers[1]?.trigger();
    container.textContent = 'The complete native subtitle';
    harness.observers[1]?.trigger();
    harness.observers[1]?.trigger();
    expect(harness.ticks).toEqual([]);
    expect(harness.queued).toHaveLength(1);

    queueMicrotask(() => harness.ticks.push('checkpoint-marker'));
    await Promise.resolve();

    expect(harness.ticks).toEqual(['The complete native subtitle', 'checkpoint-marker']);
    harness.clock.dispose();
  });

  it('cancels queued work without suppressing the next real microtask', async () => {
    const scheduler = createNativeSubtitleMicrotaskScheduler(queueMicrotask);
    const calls: string[] = [];
    const cancelled = scheduler.schedule(() => calls.push('cancelled'));
    scheduler.cancel(cancelled);
    scheduler.cancel(cancelled);
    scheduler.schedule(() => calls.push('current'));
    expect(calls).toEqual([]);

    await Promise.resolve();

    expect(calls).toEqual(['current']);
  });

  it('ignores cancelled and repeated late delivery of the queued wrapper', () => {
    const queued: Array<() => void> = [];
    const scheduler = createNativeSubtitleMicrotaskScheduler((callback) => queued.push(callback));
    const calls: string[] = [];
    const cancelled = scheduler.schedule(() => calls.push('cancelled'));
    scheduler.cancel(cancelled);
    scheduler.schedule(() => calls.push('current'));

    queued[0]?.();
    queued[0]?.();
    queued[1]?.();
    queued[1]?.();

    expect(calls).toEqual(['current']);
  });

  it('cannot cancel another scheduler instance through a foreign handle', async () => {
    const first = createNativeSubtitleMicrotaskScheduler(queueMicrotask);
    const second = createNativeSubtitleMicrotaskScheduler(queueMicrotask);
    const calls: string[] = [];
    const foreign = second.schedule(() => calls.push('second'));
    first.cancel(foreign);
    first.cancel(undefined);
    first.cancel(1);
    await Promise.resolve();

    expect(calls).toEqual(['second']);
  });

  it('propagates enqueue failures and invalidates a partially queued callback', () => {
    const queued: Array<() => void> = [];
    const calls: string[] = [];
    let failEnqueue = true;
    const scheduler = createNativeSubtitleMicrotaskScheduler((callback) => {
      queued.push(callback);
      if (failEnqueue) throw new Error('Synthetic microtask enqueue failure.');
    });
    expect(() => scheduler.schedule(() => calls.push('failed')))
      .toThrow('Synthetic microtask enqueue failure.');
    failEnqueue = false;
    scheduler.schedule(() => calls.push('current'));
    queued[0]?.();
    queued[1]?.();

    expect(calls).toEqual(['current']);
  });

  it('cancels the old container microtask when rebinding before delivery', async () => {
    const harness = microtaskHarness();
    harness.clock.start();
    const staleObserver = harness.observers[1];
    harness.document.container = node('Replacement subtitle');
    harness.observers[0]?.trigger();
    staleObserver?.trigger();
    harness.observers[2]?.trigger();
    expect(harness.ticks).toEqual([]);
    await Promise.resolve();

    expect(harness.ticks).toEqual(['Replacement subtitle']);
    expect(staleObserver?.disconnectCount).toBe(1);
    harness.clock.dispose();
  });

  it.each(['generation-change', 'dispose'] as const)(
    'drops a pending microtask after %s',
    async (action) => {
      let currentGeneration = 1;
      const harness = microtaskHarness((generation) => generation === currentGeneration);
      harness.clock.start();
      if (action === 'generation-change') currentGeneration = 2;
      else harness.clock.dispose();
      await Promise.resolve();

      expect(harness.ticks).toEqual([]);
      harness.queued[0]?.();
      expect(harness.ticks).toEqual([]);
      harness.clock.dispose();
    },
  );
});

describe('native Netflix subtitle clock', () => {
  it('starts and disposes idempotently without modifying the native node', () => {
    const document = new FakeDocument();
    const nativeNode = node('  Hello   world  ');
    document.container = nativeNode;
    const scheduler = new FakeScheduler();
    const observers: FakeObserver[] = [];
    const ticks: unknown[] = [];
    const clock = createNativeSubtitleClock({
      document,
      scheduler,
      createObserver: (callback) => {
        const observer = new FakeObserver(callback);
        observers.push(observer);
        return observer;
      },
      sessionId: 'session-1',
      generation: 3,
      onTick: (tick) => ticks.push(tick),
      getCurrentTimeMs: () => 1_250,
    });

    expect(clock.start()).toEqual({ ok: true, value: undefined });
    expect(clock.start()).toEqual({ ok: true, value: undefined });
    expect(observers).toHaveLength(2);
    scheduler.flush();

    expect(ticks).toEqual([
      {
        sessionId: 'session-1',
        generation: 3,
        sequence: 1,
        visibleText: 'Hello world',
        currentTimeMs: 1_250,
      },
    ]);
    expect(Object.keys(ticks[0] as object).sort()).toEqual([
      'currentTimeMs',
      'generation',
      'sequence',
      'sessionId',
      'visibleText',
    ]);
    expect(nativeNode.textContent).toBe('  Hello   world  ');
    expect(nativeNode.innerHTML).toContain('data-secret');

    clock.dispose();
    clock.dispose();
    expect(observers.every((observer) => observer.disconnectCount === 1)).toBe(
      true,
    );
  });

  it('coalesces a burst of native subtitle mutations into one tick', () => {
    const document = new FakeDocument();
    document.container = node('First');
    const scheduler = new FakeScheduler();
    const observers: FakeObserver[] = [];
    const ticks: string[] = [];
    const clock = createNativeSubtitleClock({
      document,
      scheduler,
      createObserver: (callback) => {
        const observer = new FakeObserver(callback);
        observers.push(observer);
        return observer;
      },
      sessionId: 'session-1',
      generation: 1,
      onTick: (tick) => ticks.push(tick.visibleText),
    });

    clock.start();
    scheduler.flush();
    ticks.length = 0;
    const containerObserver = observers[1];
    expect(containerObserver).toBeDefined();
    document.container.textContent = 'Second';
    containerObserver?.trigger();
    containerObserver?.trigger();
    containerObserver?.trigger();

    expect(scheduler.size).toBe(1);
    scheduler.flush();
    expect(ticks).toEqual(['Second']);
  });

  it('returns a typed non-sensitive diagnostic when no container exists', () => {
    const document = new FakeDocument();
    const observers: FakeObserver[] = [];
    const diagnostics: unknown[] = [];
    const clock = createNativeSubtitleClock({
      document,
      scheduler: new FakeScheduler(),
      createObserver: (callback) => {
        const observer = new FakeObserver(callback);
        observers.push(observer);
        return observer;
      },
      sessionId: 'session-1',
      generation: 1,
      onTick: () => undefined,
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    });

    expect(clock.start()).toEqual({
      ok: false,
      error: {
        code: 'native_subtitle_container_missing',
        message: 'Netflix native subtitle container is not available.',
        retryable: true,
      },
    });
    expect(diagnostics).toEqual([
      {
        code: 'native_subtitle_container_missing',
        message: 'Netflix native subtitle container is not available.',
        retryable: true,
      },
    ]);
    expect(observers).toHaveLength(1);

    observers[0]?.trigger();
    observers[0]?.trigger();
    expect(diagnostics).toHaveLength(1);
  });

  it('rebinds after a container remount and ignores stale callbacks or generation', () => {
    const document = new FakeDocument();
    document.container = node('Old subtitle');
    const scheduler = new FakeScheduler();
    const observers: FakeObserver[] = [];
    const ticks: string[] = [];
    let activeGeneration = 5;
    const clock = createNativeSubtitleClock({
      document,
      scheduler,
      createObserver: (callback) => {
        const observer = new FakeObserver(callback);
        observers.push(observer);
        return observer;
      },
      sessionId: 'session-5',
      generation: 5,
      isGenerationCurrent: (generation) => generation === activeGeneration,
      onTick: (tick) => ticks.push(tick.visibleText),
    });

    clock.start();
    scheduler.flush();
    ticks.length = 0;
    const rootObserver = observers[0];
    const staleContainerObserver = observers[1];
    document.container = node('New subtitle');
    rootObserver?.trigger();
    const currentContainerObserver = observers[2];

    staleContainerObserver?.trigger();
    currentContainerObserver?.trigger();
    scheduler.flush();
    expect(ticks).toEqual(['New subtitle']);
    expect(staleContainerObserver?.disconnectCount).toBe(1);

    activeGeneration = 6;
    document.container.textContent = 'Too late';
    currentContainerObserver?.trigger();
    scheduler.flush();
    expect(ticks).toEqual(['New subtitle']);

    clock.dispose();
    currentContainerObserver?.trigger();
    scheduler.flush();
    expect(ticks).toEqual(['New subtitle']);
  });
});
