import { describe, expect, it } from 'vitest';

import {
  MemoryTranslationCacheStore,
  TranslationCache,
  createTranslationCacheKey,
  hashTranslationSource,
  type TranslationCacheRecord,
  type TranslationCacheStore,
} from '../../src/translation/cache';
import { DEEPSEEK_PROMPT_VERSION } from '../../src/translation/prompt';

const deepSeekKey = {
  episodeId: 'episode_hash_1',
  trackHash: 'track_hash_1',
  provider: 'deepseek',
  cueId: 'cue-1',
  sourceLanguage: 'en',
  sourceHash: hashTranslationSource('Hello.'),
  targetLanguage: 'zh-Hans',
  providerContractVersion: 'deepseek-v1',
  model: 'deepseek-v4-flash',
  promptVersion: DEEPSEEK_PROMPT_VERSION,
} as const;

interface DeferredPut {
  readonly record: TranslationCacheRecord;
  release(): void;
}

class DeferredTranslationCacheStore implements TranslationCacheStore {
  readonly records = new Map<string, TranslationCacheRecord>();
  readonly #started: DeferredPut[] = [];
  readonly #waiters: Array<(put: DeferredPut) => void> = [];

  async get(key: string): Promise<TranslationCacheRecord | null> {
    return this.records.get(key) ?? null;
  }

  async put(record: TranslationCacheRecord, _limits: unknown, signal?: AbortSignal): Promise<void> {
    await new Promise<void>((resolve) => {
      let released = false;
      const put: DeferredPut = {
        record,
        release: () => {
          if (released) return;
          released = true;
          if (!signal?.aborted) this.records.set(record.key, record);
          resolve();
        },
      };
      const waiter = this.#waiters.shift();
      if (waiter) waiter(put);
      else this.#started.push(put);
    });
  }

  async deleteEpisode(episodeId: string): Promise<void> {
    for (const [key, record] of this.records) {
      if (record.episodeId === episodeId) this.records.delete(key);
    }
  }

  async clear(): Promise<void> {
    this.records.clear();
  }

  nextPut(): Promise<DeferredPut> {
    const put = this.#started.shift();
    if (put) return Promise.resolve(put);
    return new Promise<DeferredPut>((resolve) => this.#waiters.push(resolve));
  }
}

describe('translation cache identity', () => {
  it('separates provider, source, model, and prompt contracts', () => {
    const baseline = createTranslationCacheKey(deepSeekKey);
    const keys = [
      createTranslationCacheKey({
        episodeId: deepSeekKey.episodeId,
        trackHash: deepSeekKey.trackHash,
        provider: 'google-free',
        cueId: deepSeekKey.cueId,
        sourceLanguage: 'en',
        sourceHash: deepSeekKey.sourceHash,
        targetLanguage: 'zh-Hans',
        providerContractVersion: 'google-free-v1',
      }),
      createTranslationCacheKey({ ...deepSeekKey, sourceHash: hashTranslationSource('Changed.') }),
      createTranslationCacheKey({ ...deepSeekKey, model: 'deepseek-v4-pro' }),
      createTranslationCacheKey({ ...deepSeekKey, promptVersion: 'prompt-v-next' }),
    ];

    expect(baseline).toMatch(/^trc_[0-9a-f]{16}$/u);
    expect(new Set([baseline, ...keys]).size).toBe(5);
    expect(JSON.stringify([baseline, ...keys])).not.toContain('Hello.');
  });

  it('does not collide when separate cues contain the same source text', () => {
    expect(createTranslationCacheKey(deepSeekKey)).not.toBe(
      createTranslationCacheKey({ ...deepSeekKey, cueId: 'cue-2' }),
    );
  });
});

describe('persistent TranslationCache', () => {
  it('survives a cache instance restart and resolves locally', async () => {
    const persistentStore = new MemoryTranslationCacheStore();
    const first = new TranslationCache({ store: persistentStore, debounceMs: 0 });
    const key = createTranslationCacheKey(deepSeekKey);

    expect(await first.set(deepSeekKey, { cueId: 'cue-1', text: '你好。' })).toBe(true);
    await first.flush();
    const afterRestart = new TranslationCache({ store: persistentStore, debounceMs: 0 });

    expect(await afterRestart.get(key)).toEqual({ cueId: 'cue-1', text: '你好。' });
  });

  it('enforces entry/byte caps and supports current-episode and global clearing', async () => {
    const store = new MemoryTranslationCacheStore();
    let now = 0;
    const cache = new TranslationCache({
      store,
      debounceMs: 0,
      maxEntries: 2,
      maxBytes: 1_000,
      now: () => now += 1,
    });
    const episodeTwo = { ...deepSeekKey, episodeId: 'episode_hash_2' } as const;
    const keys = [
      deepSeekKey,
      { ...deepSeekKey, sourceHash: hashTranslationSource('Second') },
      episodeTwo,
    ] as const;

    for (const [index, parts] of keys.entries()) {
      await cache.set(parts, { cueId: `cue-${index}`, text: `译文-${index}` });
    }
    await cache.flush();

    expect(store.size).toBe(2);
    await cache.clearEpisode('episode_hash_2');
    expect(await cache.get(createTranslationCacheKey(episodeTwo))).toBeNull();
    await cache.clearAll();
    expect(store.size).toBe(0);
  });

  it('does not revive pre-clear writes from a captured batch after clearing one episode', async () => {
    const store = new DeferredTranslationCacheStore();
    const cache = new TranslationCache({ store, debounceMs: 60_000 });
    const episodeOneFirst = deepSeekKey;
    const episodeTwo = {
      ...deepSeekKey,
      episodeId: 'episode_hash_2',
      cueId: 'cue-2',
      sourceHash: hashTranslationSource('Second.'),
    } as const;
    const episodeOneLast = {
      ...deepSeekKey,
      cueId: 'cue-3',
      sourceHash: hashTranslationSource('Third.'),
    } as const;
    const writes = [
      cache.set(episodeOneFirst, { cueId: 'cue-1', text: '第一条' }),
      cache.set(episodeTwo, { cueId: 'cue-2', text: '第二条' }),
      cache.set(episodeOneLast, { cueId: 'cue-3', text: '第三条' }),
    ];
    const flushing = cache.flush();

    const first = await store.nextPut();
    first.release();
    const second = await store.nextPut();
    const clearing = cache.clearEpisode(deepSeekKey.episodeId);
    second.release();
    const third = await store.nextPut();
    third.release();

    await Promise.all([...writes, flushing, clearing]);
    expect([...store.records.values()].map((record) => record.episodeId)).toEqual([
      episodeTwo.episodeId,
    ]);
  });

  it('does not revive any pre-clear writes from a captured batch after clearing globally', async () => {
    const store = new DeferredTranslationCacheStore();
    const cache = new TranslationCache({ store, debounceMs: 60_000 });
    const keys = [
      deepSeekKey,
      {
        ...deepSeekKey,
        cueId: 'cue-2',
        sourceHash: hashTranslationSource('Second.'),
      },
      {
        ...deepSeekKey,
        episodeId: 'episode_hash_2',
        cueId: 'cue-3',
        sourceHash: hashTranslationSource('Third.'),
      },
    ] as const;
    const writes = keys.map((parts, index) =>
      cache.set(parts, { cueId: parts.cueId, text: `译文-${index}` }),
    );
    const flushing = cache.flush();

    const first = await store.nextPut();
    first.release();
    const second = await store.nextPut();
    const clearing = cache.clearAll();
    second.release();
    const third = await store.nextPut();
    third.release();

    await Promise.all([...writes, flushing, clearing]);
    expect(store.records.size).toBe(0);
  });

  it('drops a debounced write when its generation guard becomes stale', async () => {
    const store = new MemoryTranslationCacheStore();
    const controller = new AbortController();
    let current = true;
    const cache = new TranslationCache({ store, debounceMs: 5 });

    const pending = cache.set(
      deepSeekKey,
      { cueId: 'cue-1', text: '不应写入' },
      { signal: controller.signal, isCurrent: () => current },
    );
    current = false;
    controller.abort();

    expect(await pending).toBe(false);
    await cache.flush();
    expect(store.size).toBe(0);
  });

  it('aborts a deferred store put before commit when generation changes', async () => {
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const records = new Map<string, TranslationCacheRecord>();
    const store: TranslationCacheStore = {
      get: async (key) => records.get(key) ?? null,
      put: async (record, _limits, signal) => {
        await gate;
        if (!signal?.aborted) records.set(record.key, record);
      },
      deleteEpisode: async () => undefined,
      clear: async () => records.clear(),
    };
    const cache = new TranslationCache({ store, debounceMs: 0 });
    const controller = new AbortController();
    let current = true;

    const pending = cache.set(
      deepSeekKey,
      { cueId: 'cue-1', text: '迟到' },
      { signal: controller.signal, isCurrent: () => current },
    );
    await Promise.resolve();
    current = false;
    controller.abort();
    release();

    expect(await pending).toBe(false);
    expect(records.size).toBe(0);
  });

  it('stores no credential fields or source text in records', async () => {
    const store = new MemoryTranslationCacheStore();
    const cache = new TranslationCache({ store, debounceMs: 0 });
    await cache.set(deepSeekKey, { cueId: 'cue-1', text: '翻译' });
    await cache.flush();

    const serialized = JSON.stringify(store.records);
    expect(serialized).not.toContain('apiKey');
    expect(serialized).not.toContain('Authorization');
    expect(serialized).not.toContain('Hello.');
    expect(serialized).not.toContain('deepseek-v4-flash');
  });

  it('treats a corrupt or oversized persisted record as a cache miss', async () => {
    const key = createTranslationCacheKey(deepSeekKey);
    const store: TranslationCacheStore = {
      get: async () => ({
        key,
        episodeId: deepSeekKey.episodeId,
        cueId: deepSeekKey.cueId,
        text: '损坏',
        byteSize: 999_999_999,
        lastAccessedAt: 1,
      }),
      put: async () => undefined,
      deleteEpisode: async () => undefined,
      clear: async () => undefined,
    };
    const cache = new TranslationCache({ store, maxBytes: 1_024 });

    expect(await cache.get(key)).toBeNull();
  });
});
