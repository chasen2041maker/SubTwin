export type TranslationCacheKeyParts =
  | {
      readonly episodeId: string;
      readonly trackHash: string;
      readonly provider: 'google-free';
      readonly cueId: string;
      readonly sourceLanguage: 'en';
      readonly sourceHash: string;
      readonly targetLanguage: 'zh-Hans';
      readonly providerContractVersion: string;
    }
  | {
      readonly episodeId: string;
      readonly trackHash: string;
      readonly provider: 'deepseek';
      readonly cueId: string;
      readonly sourceLanguage: 'en';
      readonly sourceHash: string;
      readonly targetLanguage: 'zh-Hans';
      readonly providerContractVersion: string;
      readonly model: string;
      readonly promptVersion: string;
    };

export interface TranslationCacheValue {
  readonly cueId: string;
  readonly text: string;
}

export interface TranslationCacheRecord extends TranslationCacheValue {
  readonly key: string;
  readonly episodeId: string;
  readonly byteSize: number;
  readonly lastAccessedAt: number;
}

export interface TranslationCacheLimits {
  readonly maxEntries: number;
  readonly maxBytes: number;
}

export interface TranslationCacheStore {
  get(key: string): Promise<TranslationCacheRecord | null>;
  put(
    record: TranslationCacheRecord,
    limits: TranslationCacheLimits,
    signal?: AbortSignal,
  ): Promise<void>;
  deleteEpisode(episodeId: string): Promise<void>;
  clear(): Promise<void>;
}

export interface TranslationCacheGuard {
  readonly signal: AbortSignal;
  readonly isCurrent: () => boolean;
}

export interface TranslationCacheOptions {
  readonly store?: TranslationCacheStore;
  readonly indexedDB?: IDBFactory;
  readonly debounceMs?: number;
  readonly maxEntries?: number;
  readonly maxBytes?: number;
  readonly now?: () => number;
}

interface PendingWrite {
  readonly record: TranslationCacheRecord;
  readonly guard?: TranslationCacheGuard;
  readonly resolve: (committed: boolean) => void;
}

const OPAQUE_PART = /^[A-Za-z0-9._:-]{1,256}$/u;
const MAX_CACHED_TRANSLATION_LENGTH = 16_384;
export const TRANSLATION_CACHE_SCHEMA_VERSION = 'translation-cache-v1' as const;

export class TranslationCache {
  readonly #store: TranslationCacheStore;
  readonly #debounceMs: number;
  readonly #limits: TranslationCacheLimits;
  readonly #now: () => number;
  readonly #pending = new Map<string, PendingWrite>();
  #timer: ReturnType<typeof setTimeout> | undefined;
  #flushPromise: Promise<void> | undefined;

  constructor(options: TranslationCacheOptions = {}) {
    this.#store = options.store ?? new IndexedDbTranslationCacheStore(
      options.indexedDB ? { indexedDB: options.indexedDB } : {},
    );
    this.#debounceMs = Math.max(0, options.debounceMs ?? 50);
    this.#limits = {
      maxEntries: clamp(options.maxEntries ?? 5_000, 1, 100_000),
      maxBytes: clamp(options.maxBytes ?? 25 * 1024 * 1024, 1_024, 250 * 1024 * 1024),
    };
    this.#now = options.now ?? (() => Date.now());
  }

  async get(key: string): Promise<TranslationCacheValue | null> {
    if (!/^trc_[0-9a-f]{16}$/u.test(key)) return null;
    const pending = this.#pending.get(key);
    if (pending && isGuardCurrent(pending.guard)) {
      return { cueId: pending.record.cueId, text: pending.record.text };
    }
    const record = await this.#store.get(key);
    if (!record || !isValidRecord(record, key, this.#limits.maxBytes)) return null;
    const touched = { ...record, lastAccessedAt: this.#now() };
    try {
      await this.#store.put(touched, this.#limits);
    } catch {
      // A cache hit remains usable when only the access-time update fails.
    }
    return { cueId: record.cueId, text: record.text };
  }

  set(
    parts: TranslationCacheKeyParts,
    value: TranslationCacheValue,
    guard?: TranslationCacheGuard,
  ): Promise<boolean> {
    if (!isValidKeyParts(parts) || !isValidValue(value) || !isGuardCurrent(guard)) {
      return Promise.resolve(false);
    }

    const key = createTranslationCacheKey(parts);
    const now = this.#now();
    const record: TranslationCacheRecord = {
      key,
      episodeId: parts.episodeId,
      cueId: value.cueId,
      text: value.text.trim(),
      byteSize: recordByteSize(key, parts.episodeId, value.cueId, value.text.trim()),
      lastAccessedAt: now,
    };

    return new Promise<boolean>((resolve) => {
      this.#pending.get(key)?.resolve(false);
      const pending: PendingWrite = guard
        ? { record, guard, resolve }
        : { record, resolve };
      this.#pending.set(key, pending);
      this.#scheduleFlush();
    });
  }

  async flush(): Promise<void> {
    if (this.#flushPromise) return this.#flushPromise;
    if (this.#timer !== undefined) {
      clearTimeout(this.#timer);
      this.#timer = undefined;
    }
    if (this.#pending.size === 0) return;

    const writes = [...this.#pending.values()];
    this.#pending.clear();
    this.#flushPromise = (async () => {
      for (const pending of writes) {
        if (!isGuardCurrent(pending.guard)) {
          pending.resolve(false);
          continue;
        }
        try {
          await this.#store.put(
            pending.record,
            this.#limits,
            pending.guard?.signal,
          );
          pending.resolve(isGuardCurrent(pending.guard));
        } catch {
          pending.resolve(false);
        }
      }
    })().finally(() => {
      this.#flushPromise = undefined;
      if (this.#pending.size > 0) this.#scheduleFlush();
    });
    return this.#flushPromise;
  }

  async clearEpisode(episodeId: string): Promise<void> {
    for (const [key, pending] of this.#pending) {
      if (pending.record.episodeId === episodeId) {
        this.#pending.delete(key);
        pending.resolve(false);
      }
    }
    const capturedFlush = this.#flushPromise;
    if (capturedFlush) await capturedFlush;
    await this.#store.deleteEpisode(episodeId);
  }

  async clearAll(): Promise<void> {
    if (this.#timer !== undefined) {
      clearTimeout(this.#timer);
      this.#timer = undefined;
    }
    for (const pending of this.#pending.values()) pending.resolve(false);
    this.#pending.clear();
    const capturedFlush = this.#flushPromise;
    if (capturedFlush) await capturedFlush;
    await this.#store.clear();
  }

  #scheduleFlush(): void {
    if (this.#timer !== undefined || this.#flushPromise) return;
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      void this.flush();
    }, this.#debounceMs);
  }
}

export class MemoryTranslationCacheStore implements TranslationCacheStore {
  readonly #records = new Map<string, TranslationCacheRecord>();

  get size(): number {
    return this.#records.size;
  }

  get records(): readonly TranslationCacheRecord[] {
    return [...this.#records.values()];
  }

  async get(key: string): Promise<TranslationCacheRecord | null> {
    return this.#records.get(key) ?? null;
  }

  async put(
    record: TranslationCacheRecord,
    limits: TranslationCacheLimits,
    signal?: AbortSignal,
  ): Promise<void> {
    if (signal?.aborted) return;
    this.#records.set(record.key, record);
    pruneRecords(this.#records, limits);
  }

  async deleteEpisode(episodeId: string): Promise<void> {
    for (const [key, record] of this.#records) {
      if (record.episodeId === episodeId) this.#records.delete(key);
    }
  }

  async clear(): Promise<void> {
    this.#records.clear();
  }
}

export interface IndexedDbTranslationCacheStoreOptions {
  readonly indexedDB?: IDBFactory;
  readonly databaseName?: string;
}

export class IndexedDbTranslationCacheStore implements TranslationCacheStore {
  readonly #indexedDB: IDBFactory;
  readonly #databaseName: string;
  #database: Promise<IDBDatabase> | undefined;

  constructor(options: IndexedDbTranslationCacheStoreOptions = {}) {
    const factory = options.indexedDB ?? globalThis.indexedDB;
    if (!factory) throw new Error('IndexedDB is unavailable.');
    this.#indexedDB = factory;
    this.#databaseName = options.databaseName ?? 'subtwin-translation-cache-v1';
  }

  async get(key: string): Promise<TranslationCacheRecord | null> {
    const database = await this.#open();
    const transaction = database.transaction('records', 'readonly');
    const request = transaction.objectStore('records').get(key);
    const value = await requestResult<TranslationCacheRecord | undefined>(request);
    await transactionDone(transaction);
    return value ?? null;
  }

  async put(
    record: TranslationCacheRecord,
    limits: TranslationCacheLimits,
    signal?: AbortSignal,
  ): Promise<void> {
    if (signal?.aborted) return;
    const database = await this.#open();
    if (signal?.aborted) return;
    const transaction = database.transaction('records', 'readwrite');
    const abort = () => {
      try {
        transaction.abort();
      } catch {
        // A completed transaction no longer needs cancellation.
      }
    };
    signal?.addEventListener('abort', abort, { once: true });
    try {
      const store = transaction.objectStore('records');
      store.put(record);
      const records = await requestResult<TranslationCacheRecord[]>(store.getAll());
      const retained = new Map(records.map((candidate) => [candidate.key, candidate]));
      pruneRecords(retained, limits);
      for (const candidate of records) {
        if (!retained.has(candidate.key)) store.delete(candidate.key);
      }
      await transactionDone(transaction);
    } finally {
      signal?.removeEventListener('abort', abort);
    }
  }

  async deleteEpisode(episodeId: string): Promise<void> {
    const database = await this.#open();
    const transaction = database.transaction('records', 'readwrite');
    const store = transaction.objectStore('records');
    const index = store.index('episodeId');
    const keys = await requestResult<IDBValidKey[]>(index.getAllKeys(episodeId));
    for (const key of keys) store.delete(key);
    await transactionDone(transaction);
  }

  async clear(): Promise<void> {
    const database = await this.#open();
    const transaction = database.transaction('records', 'readwrite');
    transaction.objectStore('records').clear();
    await transactionDone(transaction);
  }

  #open(): Promise<IDBDatabase> {
    if (this.#database) return this.#database;
    this.#database = new Promise<IDBDatabase>((resolve, reject) => {
      const request = this.#indexedDB.open(this.#databaseName, 1);
      request.onupgradeneeded = () => {
        const database = request.result;
        const store = database.createObjectStore('records', { keyPath: 'key' });
        store.createIndex('episodeId', 'episodeId');
        store.createIndex('lastAccessedAt', 'lastAccessedAt');
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(new Error('Unable to open translation cache.'));
      request.onblocked = () => reject(new Error('Translation cache upgrade is blocked.'));
    });
    return this.#database;
  }
}

export function createTranslationCacheKey(parts: TranslationCacheKeyParts): string {
  const material = parts.provider === 'deepseek'
    ? [
        parts.episodeId,
        parts.trackHash,
        parts.provider,
        parts.cueId,
        parts.sourceLanguage,
        parts.sourceHash,
        parts.targetLanguage,
        parts.providerContractVersion,
        parts.model,
        parts.promptVersion,
        TRANSLATION_CACHE_SCHEMA_VERSION,
      ]
    : [
        parts.episodeId,
        parts.trackHash,
        parts.provider,
        parts.cueId,
        parts.sourceLanguage,
        parts.sourceHash,
        parts.targetLanguage,
        parts.providerContractVersion,
        TRANSLATION_CACHE_SCHEMA_VERSION,
      ];
  return `trc_${hash64(material.join('\u001f'))}`;
}

export function hashTranslationSource(sourceText: string): string {
  return `src_${hash64(sourceText)}`;
}

function pruneRecords(
  records: Map<string, TranslationCacheRecord>,
  limits: TranslationCacheLimits,
): void {
  const ordered = [...records.values()].sort((left, right) =>
    left.lastAccessedAt - right.lastAccessedAt || left.key.localeCompare(right.key),
  );
  let totalBytes = ordered.reduce((total, record) => total + record.byteSize, 0);
  while (
    ordered.length > limits.maxEntries ||
    totalBytes > limits.maxBytes
  ) {
    const oldest = ordered.shift();
    if (!oldest) break;
    records.delete(oldest.key);
    totalBytes -= oldest.byteSize;
  }
}

function isValidKeyParts(parts: TranslationCacheKeyParts): boolean {
  return (
    OPAQUE_PART.test(parts.episodeId) &&
    OPAQUE_PART.test(parts.trackHash) &&
    OPAQUE_PART.test(parts.cueId) &&
    parts.sourceLanguage === 'en' &&
    OPAQUE_PART.test(parts.sourceHash) &&
    OPAQUE_PART.test(parts.providerContractVersion) &&
    parts.targetLanguage === 'zh-Hans' &&
    (parts.provider === 'google-free' ||
      OPAQUE_PART.test(parts.model) && OPAQUE_PART.test(parts.promptVersion))
  );
}

function isValidRecord(
  record: TranslationCacheRecord,
  expectedKey: string,
  maxBytes: number,
): boolean {
  return (
    Object.keys(record).length === 6 &&
    record.key === expectedKey &&
    OPAQUE_PART.test(record.episodeId) &&
    OPAQUE_PART.test(record.cueId) &&
    typeof record.text === 'string' &&
    record.text.trim().length > 0 &&
    record.text.length <= MAX_CACHED_TRANSLATION_LENGTH &&
    Number.isSafeInteger(record.lastAccessedAt) &&
    record.lastAccessedAt >= 0 &&
    Number.isSafeInteger(record.byteSize) &&
    record.byteSize > 0 &&
    record.byteSize <= maxBytes &&
    record.byteSize === recordByteSize(
      record.key,
      record.episodeId,
      record.cueId,
      record.text,
    )
  );
}

function isValidValue(value: TranslationCacheValue): boolean {
  return (
    OPAQUE_PART.test(value.cueId) &&
    value.text.trim().length > 0 &&
    value.text.length <= MAX_CACHED_TRANSLATION_LENGTH
  );
}

function isGuardCurrent(guard: TranslationCacheGuard | undefined): boolean {
  return !guard || !guard.signal.aborted && guard.isCurrent();
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function recordByteSize(
  key: string,
  episodeId: string,
  cueId: string,
  text: string,
): number {
  return byteLength(`${key}\n${episodeId}\n${cueId}\n${text}`);
}

function hash64(value: string): string {
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    first = Math.imul(first ^ code, 0x01000193) >>> 0;
    second = Math.imul(second ^ code, 0x85ebca6b) >>> 0;
  }
  return `${first.toString(16).padStart(8, '0')}${second.toString(16).padStart(8, '0')}`;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, Math.floor(value)));
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error('Translation cache request failed.'));
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(new Error('Translation cache transaction failed.'));
    transaction.onabort = () => reject(new Error('Translation cache transaction aborted.'));
  });
}
