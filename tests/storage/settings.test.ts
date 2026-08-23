import { describe, expect, test } from 'vitest';

import {
  DEFAULT_SETTINGS,
  SETTINGS_SCHEMA_VERSION,
  SETTINGS_STORAGE_KEY,
  SettingsStore,
  exportSettings,
  loadSettings,
  migrateSettings,
  normalizeSettings,
  saveSettings,
  toPublicSettings,
  type SettingsStorageAdapter,
} from '../../src/storage/settings';

class MemoryStorage implements SettingsStorageAdapter {
  readonly values: Record<string, unknown>;
  setCalls = 0;

  constructor(initial: Record<string, unknown> = {}) {
    this.values = structuredClone(initial);
  }

  async get(keys: readonly string[]): Promise<Record<string, unknown>> {
    return Object.fromEntries(
      keys
        .filter((key) => Object.hasOwn(this.values, key))
        .map((key) => [key, structuredClone(this.values[key])]),
    );
  }

  async set(values: Readonly<Record<string, unknown>>): Promise<void> {
    this.setCalls += 1;
    Object.assign(this.values, structuredClone(values));
  }
}

describe('versioned settings', () => {
  test('uses an enabled but provider-unset privacy-safe first-run default', async () => {
    const storage = new MemoryStorage();

    const settings = await loadSettings(storage);

    expect(settings).toEqual(DEFAULT_SETTINGS);
    expect(settings.schemaVersion).toBe(SETTINGS_SCHEMA_VERSION);
    expect(settings.enabled).toBe(true);
    expect(settings.provider).toBe('unset');
    expect(storage.values[SETTINGS_STORAGE_KEY]).toEqual(DEFAULT_SETTINGS);
    expect(storage.values).toMatchObject({
      translationProvider: 'unset',
      deepseekApiKey: '',
      deepseekModel: 'deepseek-v4-flash',
    });
  });

  test('migrates unversioned legacy values while keeping valid preferences', () => {
    const migrated = migrateSettings({
      enabled: false,
      provider: 'deepseek',
      deepseekApiKey: '  legacy-secret  ',
      deepseekModel: 'deepseek-v4-pro',
      appearance: {
        english: {
          visible: false,
          color: '#abc',
          fontSize: 34,
          fontWeight: 500,
        },
        chinese: {
          visible: true,
          color: '#12abEF',
          fontSize: 38,
          fontWeight: 700,
        },
        order: 'chinese-first',
        lineSpacing: 12,
        verticalOffset: 14,
        backgroundOpacity: 0.7,
        shadow: true,
      },
      ignoredLegacyField: 'drop-me',
    });

    expect(migrated).toEqual({
      schemaVersion: SETTINGS_SCHEMA_VERSION,
      enabled: false,
      provider: 'deepseek',
      deepseek: {
        apiKey: 'legacy-secret',
        model: 'deepseek-v4-pro',
      },
      appearance: {
        english: {
          visible: false,
          color: '#AABBCC',
          fontSizePx: 34,
          fontWeight: 500,
        },
        chinese: {
          visible: true,
          color: '#12ABEF',
          fontSizePx: 38,
          fontWeight: 700,
        },
        order: 'chinese-first',
        lineSpacingPx: 12,
        verticalOffsetPercent: 14,
        backgroundOpacity: 0.7,
        shadow: 'soft',
      },
    });
    expect(migrated).not.toHaveProperty('ignoredLegacyField');
  });

  test('normalizes current values strictly, clamps ranges, and drops unknown fields', () => {
    const normalized = normalizeSettings({
      schemaVersion: SETTINGS_SCHEMA_VERSION,
      enabled: 'yes',
      provider: 'surprise-provider',
      deepseek: {
        apiKey: 42,
        model: 'deepseek-chat',
        extra: 'drop-me',
      },
      appearance: {
        english: {
          visible: 'yes',
          color: 'red',
          fontSizePx: -300,
          fontWeight: 5000,
          extra: true,
        },
        chinese: {
          visible: false,
          color: '#010203',
          fontSizePx: 900,
          fontWeight: -1,
        },
        order: 'side-by-side',
        lineSpacingPx: 999,
        verticalOffsetPercent: -999,
        backgroundOpacity: 5,
        shadow: 'glow',
        extra: 'drop-me',
      },
      unknown: 'drop-me',
    });

    expect(normalized).toEqual({
      schemaVersion: SETTINGS_SCHEMA_VERSION,
      enabled: DEFAULT_SETTINGS.enabled,
      provider: 'unset',
      deepseek: DEFAULT_SETTINGS.deepseek,
      appearance: {
        english: {
          ...DEFAULT_SETTINGS.appearance.english,
          fontSizePx: 12,
          fontWeight: 900,
        },
        chinese: {
          visible: false,
          color: '#010203',
          fontSizePx: 72,
          fontWeight: 100,
        },
        order: DEFAULT_SETTINGS.appearance.order,
        lineSpacingPx: 48,
        verticalOffsetPercent: 0,
        backgroundOpacity: 1,
        shadow: DEFAULT_SETTINGS.appearance.shadow,
      },
    });
    expect(normalized).not.toHaveProperty('unknown');
    expect(normalized.deepseek).not.toHaveProperty('extra');
    expect(normalized.appearance).not.toHaveProperty('extra');
    expect(normalized.appearance.english).not.toHaveProperty('extra');
  });

  test.each([
    ['deepseek-v4-flash', 'deepseek-v4-flash'],
    ['deepseek-v4-pro', 'deepseek-v4-pro'],
    ['deepseek-chat', 'deepseek-v4-flash'],
    ['deepseek-reasoner', 'deepseek-v4-flash'],
  ] as const)('accepts only current DeepSeek model %s', (candidate, expected) => {
    const settings = normalizeSettings({
      ...DEFAULT_SETTINGS,
      deepseek: { apiKey: '', model: candidate },
    });

    expect(settings.deepseek.model).toBe(expected);
  });

  test('persists explicit provider choice and mirrors background compatibility keys', async () => {
    const storage = new MemoryStorage();
    const next = {
      ...DEFAULT_SETTINGS,
      provider: 'deepseek' as const,
      deepseek: {
        apiKey: '  private-test-key  ',
        model: 'deepseek-v4-pro' as const,
      },
    };

    const saved = await saveSettings(next, storage);

    expect(saved.provider).toBe('deepseek');
    expect(saved.deepseek.apiKey).toBe('private-test-key');
    expect(storage.values[SETTINGS_STORAGE_KEY]).toEqual(saved);
    expect(storage.values).toMatchObject({
      translationProvider: 'deepseek',
      deepseekApiKey: 'private-test-key',
      deepseekModel: 'deepseek-v4-pro',
    });
  });

  test('survives a new store instance using the same storage adapter', async () => {
    const storage = new MemoryStorage();
    await new SettingsStore(storage).save({
      ...DEFAULT_SETTINGS,
      enabled: false,
      provider: 'google-free',
      appearance: {
        ...DEFAULT_SETTINGS.appearance,
        order: 'chinese-first',
        backgroundOpacity: 0.25,
      },
    });

    const restarted = await new SettingsStore(storage).load();

    expect(restarted.enabled).toBe(false);
    expect(restarted.provider).toBe('google-free');
    expect(restarted.appearance.order).toBe('chinese-first');
    expect(restarted.appearance.backgroundOpacity).toBe(0.25);
  });

  test('does not rewrite an already-normalized record during an idempotent reload', async () => {
    const storage = new MemoryStorage();
    await new SettingsStore(storage).load();
    const callsAfterFirstRun = storage.setCalls;

    await new SettingsStore(storage).load();

    expect(callsAfterFirstRun).toBe(1);
    expect(storage.setCalls).toBe(callsAfterFirstRun);
  });

  test('imports legacy compatibility keys when the canonical value is absent', async () => {
    const storage = new MemoryStorage({
      translationProvider: 'deepseek',
      deepseekApiKey: 'legacy-background-key',
      deepseekModel: 'deepseek-v4-pro',
    });

    const loaded = await new SettingsStore(storage).load();

    expect(loaded.provider).toBe('deepseek');
    expect(loaded.deepseek).toEqual({
      apiKey: 'legacy-background-key',
      model: 'deepseek-v4-pro',
    });
    expect(storage.values[SETTINGS_STORAGE_KEY]).toEqual(loaded);
  });

  test('public and exported settings cannot expose the API key', async () => {
    const secret = 'never-export-this-secret';
    const settings = normalizeSettings({
      ...DEFAULT_SETTINGS,
      provider: 'deepseek',
      deepseek: { apiKey: secret, model: 'deepseek-v4-pro' },
    });
    const storage = new MemoryStorage();
    await new SettingsStore(storage).save(settings);

    const publicSettings = toPublicSettings(settings);
    const exported = exportSettings(settings);
    const loadedPublic = await new SettingsStore(storage).loadPublic();

    expect(publicSettings.deepseek).toEqual({ model: 'deepseek-v4-pro' });
    expect(JSON.stringify(publicSettings)).not.toContain(secret);
    expect(JSON.stringify(exported)).not.toContain(secret);
    expect(JSON.stringify(loadedPublic)).not.toContain(secret);
    expect(publicSettings.deepseek).not.toHaveProperty('apiKey');
  });

  test('returns independent objects and never mutates the frozen defaults', async () => {
    const before = structuredClone(DEFAULT_SETTINGS);
    const first = normalizeSettings({});
    first.appearance.english.color = '#123456';
    const storage = new MemoryStorage();
    const loaded = await loadSettings(storage);
    loaded.deepseek.apiKey = 'local-change';

    expect(DEFAULT_SETTINGS).toEqual(before);
    expect(DEFAULT_SETTINGS.appearance.english.color).toBe('#FFFFFF');
    expect((await loadSettings(storage)).deepseek.apiKey).toBe('');
  });

  test('does not require the browser storage global until a default store is used', () => {
    expect(() => new SettingsStore()).not.toThrow();
  });
});
