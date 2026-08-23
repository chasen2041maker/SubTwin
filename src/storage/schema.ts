export const SETTINGS_SCHEMA_VERSION = 1 as const;
export const SETTINGS_STORAGE_KEY = 'subtwinSettings' as const;

export type TranslationProviderSetting = 'unset' | 'google-free' | 'deepseek';
export type DeepSeekModelSetting = 'deepseek-v4-flash' | 'deepseek-v4-pro';
export type SubtitleOrder = 'english-first' | 'chinese-first';
export type SubtitleShadow = 'none' | 'soft' | 'strong';

export interface SubtitleLanguageAppearance {
  visible: boolean;
  color: string;
  fontSizePx: number;
  fontWeight: number;
}

export interface SubtitleAppearanceSettings {
  english: SubtitleLanguageAppearance;
  chinese: SubtitleLanguageAppearance;
  order: SubtitleOrder;
  lineSpacingPx: number;
  verticalOffsetPercent: number;
  backgroundOpacity: number;
  shadow: SubtitleShadow;
}

export interface SubTwinSettings {
  schemaVersion: typeof SETTINGS_SCHEMA_VERSION;
  enabled: boolean;
  provider: TranslationProviderSetting;
  deepseek: {
    apiKey: string;
    model: DeepSeekModelSetting;
  };
  appearance: SubtitleAppearanceSettings;
}

export interface PublicSubTwinSettings {
  schemaVersion: typeof SETTINGS_SCHEMA_VERSION;
  enabled: boolean;
  provider: TranslationProviderSetting;
  deepseek: {
    model: DeepSeekModelSetting;
  };
  appearance: SubtitleAppearanceSettings;
}

const mutableDefaults: SubTwinSettings = {
  schemaVersion: SETTINGS_SCHEMA_VERSION,
  enabled: true,
  provider: 'unset',
  deepseek: {
    apiKey: '',
    model: 'deepseek-v4-flash',
  },
  appearance: {
    english: {
      visible: true,
      color: '#FFFFFF',
      fontSizePx: 28,
      fontWeight: 600,
    },
    chinese: {
      visible: true,
      color: '#FFFFFF',
      fontSizePx: 32,
      fontWeight: 600,
    },
    order: 'english-first',
    lineSpacingPx: 8,
    verticalOffsetPercent: 8,
    backgroundOpacity: 0.55,
    shadow: 'soft',
  },
};

export const DEFAULT_SETTINGS: SubTwinSettings = freezeSettings(mutableDefaults);

export function normalizeSettings(input: unknown): SubTwinSettings {
  return normalizeCandidate(input);
}

export function isExactSubTwinSettings(input: unknown): input is SubTwinSettings {
  return jsonValuesEqual(input, normalizeCandidate(input));
}

export function migrateSettings(input: unknown): SubTwinSettings {
  return normalizeCandidate(input);
}

export function cloneSettings(settings: SubTwinSettings): SubTwinSettings {
  return {
    schemaVersion: SETTINGS_SCHEMA_VERSION,
    enabled: settings.enabled,
    provider: settings.provider,
    deepseek: {
      apiKey: settings.deepseek.apiKey,
      model: settings.deepseek.model,
    },
    appearance: cloneAppearance(settings.appearance),
  };
}

export function toPublicSettings(settings: SubTwinSettings): PublicSubTwinSettings {
  return {
    schemaVersion: SETTINGS_SCHEMA_VERSION,
    enabled: settings.enabled,
    provider: settings.provider,
    deepseek: { model: settings.deepseek.model },
    appearance: cloneAppearance(settings.appearance),
  };
}

function normalizeCandidate(input: unknown): SubTwinSettings {
  const record = asRecord(input);
  const deepseek = asRecord(record?.deepseek);
  const appearance = asRecord(record?.appearance);
  const english = asRecord(appearance?.english);
  const chinese = asRecord(appearance?.chinese);

  return {
    schemaVersion: SETTINGS_SCHEMA_VERSION,
    enabled: booleanOrDefault(record?.enabled, DEFAULT_SETTINGS.enabled),
    provider: normalizeProvider(record?.provider),
    deepseek: {
      apiKey: normalizeApiKey(deepseek?.apiKey ?? record?.deepseekApiKey),
      model: normalizeDeepSeekModel(deepseek?.model ?? record?.deepseekModel),
    },
    appearance: {
      english: normalizeLanguageAppearance(
        english,
        DEFAULT_SETTINGS.appearance.english,
      ),
      chinese: normalizeLanguageAppearance(
        chinese,
        DEFAULT_SETTINGS.appearance.chinese,
      ),
      order: normalizeOrder(appearance?.order),
      lineSpacingPx: finiteNumberInRange(
        appearance?.lineSpacingPx ?? appearance?.lineSpacing,
        0,
        48,
        DEFAULT_SETTINGS.appearance.lineSpacingPx,
        true,
      ),
      verticalOffsetPercent: finiteNumberInRange(
        appearance?.verticalOffsetPercent ?? appearance?.verticalOffset,
        0,
        40,
        DEFAULT_SETTINGS.appearance.verticalOffsetPercent,
        false,
      ),
      backgroundOpacity: finiteNumberInRange(
        appearance?.backgroundOpacity,
        0,
        1,
        DEFAULT_SETTINGS.appearance.backgroundOpacity,
        false,
      ),
      shadow: normalizeShadow(appearance?.shadow),
    },
  };
}

function normalizeLanguageAppearance(
  input: Record<string, unknown> | null,
  defaults: SubtitleLanguageAppearance,
): SubtitleLanguageAppearance {
  return {
    visible: booleanOrDefault(input?.visible, defaults.visible),
    color: normalizeColor(input?.color, defaults.color),
    fontSizePx: finiteNumberInRange(
      input?.fontSizePx ?? input?.fontSize,
      12,
      72,
      defaults.fontSizePx,
      true,
    ),
    fontWeight: finiteNumberInRange(
      input?.fontWeight,
      100,
      900,
      defaults.fontWeight,
      true,
    ),
  };
}

function normalizeProvider(value: unknown): TranslationProviderSetting {
  return value === 'google-free' || value === 'deepseek' || value === 'unset'
    ? value
    : DEFAULT_SETTINGS.provider;
}

function normalizeDeepSeekModel(value: unknown): DeepSeekModelSetting {
  return value === 'deepseek-v4-pro' || value === 'deepseek-v4-flash'
    ? value
    : DEFAULT_SETTINGS.deepseek.model;
}

function normalizeApiKey(value: unknown): string {
  if (typeof value !== 'string') return DEFAULT_SETTINGS.deepseek.apiKey;
  const trimmed = value.trim();
  return trimmed.length <= 512 ? trimmed : DEFAULT_SETTINGS.deepseek.apiKey;
}

function normalizeOrder(value: unknown): SubtitleOrder {
  return value === 'english-first' || value === 'chinese-first'
    ? value
    : DEFAULT_SETTINGS.appearance.order;
}

function normalizeShadow(value: unknown): SubtitleShadow {
  if (value === true) return 'soft';
  if (value === false) return 'none';
  return value === 'none' || value === 'soft' || value === 'strong'
    ? value
    : DEFAULT_SETTINGS.appearance.shadow;
}

function normalizeColor(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback;
  if (/^#[\da-f]{6}$/i.test(value)) return value.toUpperCase();
  const shorthand = /^#([\da-f])([\da-f])([\da-f])$/i.exec(value);
  if (!shorthand) return fallback;
  return `#${shorthand.slice(1).map((part) => `${part}${part}`).join('')}`.toUpperCase();
}

function booleanOrDefault(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function finiteNumberInRange(
  value: unknown,
  minimum: number,
  maximum: number,
  fallback: number,
  integer: boolean,
): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  const clamped = Math.min(maximum, Math.max(minimum, value));
  return integer ? Math.round(clamped) : clamped;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function jsonValuesEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => jsonValuesEqual(value, right[index]));
  }
  const leftRecord = asRecord(left);
  const rightRecord = asRecord(right);
  if (leftRecord === null || rightRecord === null) return false;
  const leftKeys = Object.keys(leftRecord).sort();
  const rightKeys = Object.keys(rightRecord).sort();
  return leftKeys.length === rightKeys.length &&
    leftKeys.every((key, index) => (
      key === rightKeys[index] && jsonValuesEqual(leftRecord[key], rightRecord[key])
    ));
}

function cloneAppearance(
  appearance: SubtitleAppearanceSettings,
): SubtitleAppearanceSettings {
  return {
    english: { ...appearance.english },
    chinese: { ...appearance.chinese },
    order: appearance.order,
    lineSpacingPx: appearance.lineSpacingPx,
    verticalOffsetPercent: appearance.verticalOffsetPercent,
    backgroundOpacity: appearance.backgroundOpacity,
    shadow: appearance.shadow,
  };
}

function freezeSettings(settings: SubTwinSettings): SubTwinSettings {
  Object.freeze(settings.deepseek);
  Object.freeze(settings.appearance.english);
  Object.freeze(settings.appearance.chinese);
  Object.freeze(settings.appearance);
  return Object.freeze(settings);
}
