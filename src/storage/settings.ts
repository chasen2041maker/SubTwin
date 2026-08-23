import {
  SETTINGS_STORAGE_KEY,
  cloneSettings,
  migrateSettings,
  normalizeSettings,
  toPublicSettings,
  type PublicSubTwinSettings,
  type SubTwinSettings,
} from './schema';

export {
  DEFAULT_SETTINGS,
  SETTINGS_SCHEMA_VERSION,
  SETTINGS_STORAGE_KEY,
  migrateSettings,
  normalizeSettings,
  toPublicSettings,
} from './schema';
export type {
  DeepSeekModelSetting,
  PublicSubTwinSettings,
  SubtitleAppearanceSettings,
  SubtitleLanguageAppearance,
  SubtitleOrder,
  SubtitleShadow,
  SubTwinSettings,
  TranslationProviderSetting,
} from './schema';

const COMPATIBILITY_KEYS = [
  'translationProvider',
  'deepseekApiKey',
  'deepseekModel',
] as const;
const READ_KEYS = [SETTINGS_STORAGE_KEY, ...COMPATIBILITY_KEYS] as const;

export interface SettingsStorageAdapter {
  get(keys: readonly string[]): Promise<Record<string, unknown>>;
  set(values: Readonly<Record<string, unknown>>): Promise<void>;
}

export class SettingsStore {
  readonly #providedStorage: SettingsStorageAdapter | undefined;
  #resolvedStorage: SettingsStorageAdapter | undefined;

  constructor(storage?: SettingsStorageAdapter) {
    this.#providedStorage = storage;
  }

  async load(): Promise<SubTwinSettings> {
    const storage = this.#storage();
    const stored = await storage.get(READ_KEYS);
    const canonical = Object.hasOwn(stored, SETTINGS_STORAGE_KEY)
      ? stored[SETTINGS_STORAGE_KEY]
      : compatibilityCandidate(stored);
    const settings = migrateSettings(canonical);
    if (!storedSettingsAreCurrent(stored, canonical, settings)) {
      await persist(storage, settings);
    }
    return cloneSettings(settings);
  }

  async save(candidate: unknown): Promise<SubTwinSettings> {
    const settings = normalizeSettings(candidate);
    await persist(this.#storage(), settings);
    return cloneSettings(settings);
  }

  async loadPublic(): Promise<PublicSubTwinSettings> {
    return toPublicSettings(await this.load());
  }

  #storage(): SettingsStorageAdapter {
    if (this.#resolvedStorage) return this.#resolvedStorage;
    this.#resolvedStorage = this.#providedStorage ?? createBrowserStorageAdapter();
    return this.#resolvedStorage;
  }
}

export async function loadSettings(
  storage?: SettingsStorageAdapter,
): Promise<SubTwinSettings> {
  return new SettingsStore(storage).load();
}

export async function saveSettings(
  next: unknown,
  storage?: SettingsStorageAdapter,
): Promise<SubTwinSettings> {
  return new SettingsStore(storage).save(next);
}

export function exportSettings(settings: SubTwinSettings): PublicSubTwinSettings {
  return toPublicSettings(settings);
}

function compatibilityCandidate(stored: Record<string, unknown>): unknown {
  return {
    provider: stored.translationProvider,
    deepseekApiKey: stored.deepseekApiKey,
    deepseekModel: stored.deepseekModel,
  };
}

function storedSettingsAreCurrent(
  stored: Record<string, unknown>,
  canonical: unknown,
  settings: SubTwinSettings,
): boolean {
  if (!Object.hasOwn(stored, SETTINGS_STORAGE_KEY)) return false;
  try {
    if (JSON.stringify(canonical) !== JSON.stringify(settings)) return false;
  } catch {
    return false;
  }
  return stored.translationProvider === settings.provider &&
    stored.deepseekApiKey === settings.deepseek.apiKey &&
    stored.deepseekModel === settings.deepseek.model;
}

async function persist(
  storage: SettingsStorageAdapter,
  settings: SubTwinSettings,
): Promise<void> {
  const canonical = cloneSettings(settings);
  await storage.set({
    [SETTINGS_STORAGE_KEY]: canonical,
    translationProvider: canonical.provider,
    deepseekApiKey: canonical.deepseek.apiKey,
    deepseekModel: canonical.deepseek.model,
  });
}

interface ExtensionStorageArea {
  get(keys: readonly string[]): Promise<unknown> | unknown;
  set(values: Readonly<Record<string, unknown>>): Promise<unknown> | unknown;
}

interface ExtensionGlobal {
  browser?: {
    storage?: { local?: ExtensionStorageArea };
  };
  chrome?: {
    storage?: { local?: ExtensionStorageArea };
  };
}

function createBrowserStorageAdapter(): SettingsStorageAdapter {
  const extensionGlobal = globalThis as typeof globalThis & ExtensionGlobal;
  const local = extensionGlobal.browser?.storage?.local ??
    extensionGlobal.chrome?.storage?.local;
  if (!local) {
    throw new Error('Extension local storage is unavailable');
  }
  return {
    async get(keys) {
      const result = await local.get([...keys]);
      return isRecord(result) ? result : {};
    },
    async set(values) {
      await local.set(values);
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
