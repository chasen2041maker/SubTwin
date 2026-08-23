import { describe, expect, it } from 'vitest';

import {
  DEFAULT_SETTINGS,
  isExactPublicSubTwinSettings,
  isExactRuntimeSettingsState,
  isExactSubtitleAppearanceSettings,
  toPublicSettings,
} from '../../src/storage/schema';

describe('strict public settings schema', () => {
  it('accepts the canonical public appearance and rejects extra or malformed fields', () => {
    expect(isExactSubtitleAppearanceSettings(DEFAULT_SETTINGS.appearance)).toBe(true);
    expect(isExactSubtitleAppearanceSettings({
      ...DEFAULT_SETTINGS.appearance,
      apiKey: 'secret',
    })).toBe(false);
    expect(isExactSubtitleAppearanceSettings({
      ...DEFAULT_SETTINGS.appearance,
      english: {
        ...DEFAULT_SETTINGS.appearance.english,
        diagnostic: 'free-form text',
      },
    })).toBe(false);
    expect(isExactSubtitleAppearanceSettings({
      ...DEFAULT_SETTINGS.appearance,
      backgroundOpacity: 2,
    })).toBe(false);
  });

  it('accepts exported public settings but rejects credentials and unknown fields', () => {
    const settings = toPublicSettings(DEFAULT_SETTINGS);

    expect(isExactPublicSubTwinSettings(settings)).toBe(true);
    expect(isExactPublicSubTwinSettings({
      ...settings,
      deepseek: { ...settings.deepseek, apiKey: 'secret' },
    })).toBe(false);
    expect(isExactPublicSubTwinSettings({ ...settings, model: 'secret-model' })).toBe(false);
  });

  it('accepts only the credential-free runtime settings state', () => {
    const state = {
      enabled: true,
      provider: 'google-free',
      deepseekKeyReady: false,
      appearance: DEFAULT_SETTINGS.appearance,
    } as const;

    expect(isExactRuntimeSettingsState(state)).toBe(true);
    expect(isExactRuntimeSettingsState({ ...state, apiKey: 'secret' })).toBe(false);
    expect(isExactRuntimeSettingsState({
      ...state,
      model: 'deepseek-v4-pro',
    })).toBe(false);
    expect(isExactRuntimeSettingsState({
      ...state,
      deepseekKeyReady: 'yes',
    })).toBe(false);
  });
});
