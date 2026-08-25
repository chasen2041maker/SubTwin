import {
  createMessage,
  parseMessageEnvelope,
  type MessageFor,
} from '../shared/messages';
import { ok, type AppError, type Result } from '../shared/result';
import { PersonalDeepSeekProvider } from '../translation/deepseek';
import type { TranslationErrorCode, TranslationRequest } from '../translation/types';
import type { SubTwinSettings } from './schema';

interface SettingsActionCache {
  clearAll(): Promise<void>;
  clearEpisode(episodeId: string): Promise<void>;
}

interface SettingsActionStore {
  load(): Promise<SubTwinSettings>;
  save(candidate: unknown): Promise<SubTwinSettings>;
}

export interface SettingsActionHandlerOptions {
  readonly fetch: typeof globalThis.fetch;
  readonly settingsStore: SettingsActionStore;
  readonly cache: SettingsActionCache;
  readonly readCurrentEpisodeId: () => Promise<unknown>;
}

type SettingsActionResponse =
  | MessageFor<'settings/cache-clear-result'>
  | MessageFor<'settings/deepseek-test-result'>
  | MessageFor<'settings/enabled-set-result'>
  | MessageFor<'settings/options-update-result'>
  | MessageFor<'settings/page-update-result'>
  | MessageFor<'settings/private-get-result'>
  | MessageFor<'settings/public-get-result'>;

type SettingsActionResult = Result<SettingsActionResponse, AppError<string>>;

const OPAQUE_EPISODE_ID = /^[A-Za-z0-9._:-]{1,128}$/u;

export function createSettingsActionHandler(
  options: SettingsActionHandlerOptions,
): (candidate: unknown) => Promise<SettingsActionResult | undefined> {
  let mutationTail: Promise<void> = Promise.resolve();
  const serializeMutation = <Value>(work: () => Promise<Value>): Promise<Value> => {
    const current = mutationTail.then(work, work);
    mutationTail = current.then(() => undefined, () => undefined);
    return current;
  };

  return async (candidate) => {
    const parsed = parseMessageEnvelope(candidate);
    if (!parsed.ok) return parsed;
    if (parsed.value.type === 'settings/private-get') {
      await mutationTail;
      return readPrivateSettings(parsed.value, options);
    }
    if (parsed.value.type === 'settings/public-get') {
      await mutationTail;
      return readPublicSettings(parsed.value, options);
    }
    if (parsed.value.type === 'settings/enabled-set') {
      const message = parsed.value;
      return serializeMutation(() => setEnabled(message, options));
    }
    if (parsed.value.type === 'settings/options-update') {
      const message = parsed.value;
      return serializeMutation(() => updateOptionsSettings(message, options));
    }
    if (parsed.value.type === 'settings/page-update') {
      const message = parsed.value;
      return serializeMutation(() => updatePageSettings(message, options));
    }
    if (parsed.value.type === 'settings/deepseek-test') {
      await mutationTail;
      return testStoredDeepSeekConfiguration(parsed.value, options);
    }
    if (parsed.value.type === 'settings/cache-clear') {
      return clearTranslationCache(parsed.value, options);
    }
    return undefined;
  };
}

async function testStoredDeepSeekConfiguration(
  message: MessageFor<'settings/deepseek-test'>,
  options: SettingsActionHandlerOptions,
): Promise<SettingsActionResult> {
  let settings: StoredDeepSeekSettings | null = null;
  try {
    const stored = await options.settingsStore.load();
    settings = parseStoredDeepSeekSettings({
      deepseekApiKey: stored.deepseek.apiKey,
      deepseekModel: stored.deepseek.model,
    });
  } catch {
    // Storage details must never cross the background boundary.
  }
  if (!settings) {
    return deepseekTestResult(message, 'invalid_configuration', false);
  }

  const provider = new PersonalDeepSeekProvider({
    fetch: options.fetch,
    apiKey: settings.apiKey,
    model: settings.model,
  });
  const request: TranslationRequest = {
    taskId: 'settings-connection-test',
    sessionId: 'settings',
    episodeId: 'settings-connection-test',
    trackHash: 'settings-connection-test',
    provider: 'deepseek',
    sourceLanguage: 'en',
    targetLanguage: 'zh-Hans',
    episodeGeneration: 0,
    providerGeneration: 0,
    cues: [{
      id: 'connection-test',
      startMs: 0,
      endMs: 1_000,
      text: 'Connection test.',
    }],
    context: [],
  };
  const result = await provider.translate(request, new AbortController().signal);
  return result.ok
    ? deepseekTestSuccess(message)
    : deepseekTestResult(message, result.error.code, result.error.retryable);
}

async function readPrivateSettings(
  message: MessageFor<'settings/private-get'>,
  options: SettingsActionHandlerOptions,
): Promise<SettingsActionResult> {
  try {
    const settings = await options.settingsStore.load();
    return ok(createMessage({
      id: `${message.id}:background`,
      source: 'background',
      type: 'settings/private-get-result',
      payload: { settings },
    }));
  } catch {
    return settingsUnavailable();
  }
}

async function readPublicSettings(
  message: MessageFor<'settings/public-get'>,
  options: SettingsActionHandlerOptions,
): Promise<SettingsActionResult> {
  try {
    const settings = await options.settingsStore.load();
    return ok(createMessage({
      id: `${message.id}:background`,
      source: 'background',
      type: 'settings/public-get-result',
      payload: { enabled: settings.enabled, provider: settings.provider },
    }));
  } catch {
    return settingsUnavailable();
  }
}

async function setEnabled(
  message: MessageFor<'settings/enabled-set'>,
  options: SettingsActionHandlerOptions,
): Promise<SettingsActionResult> {
  try {
    const current = await options.settingsStore.load();
    const saved = await options.settingsStore.save({
      ...current,
      enabled: message.payload.enabled,
    });
    return ok(createMessage({
      id: `${message.id}:background`,
      source: 'background',
      type: 'settings/enabled-set-result',
      payload: {
        status: 'success',
        errorCode: null,
        enabled: saved.enabled,
        provider: saved.provider,
      },
    }));
  } catch {
    return ok(createMessage({
      id: `${message.id}:background`,
      source: 'background',
      type: 'settings/enabled-set-result',
      payload: {
        status: 'error',
        errorCode: 'settings_unavailable',
        enabled: message.payload.enabled,
        provider: 'unset',
      },
    }));
  }
}

async function updateOptionsSettings(
  message: MessageFor<'settings/options-update'>,
  options: SettingsActionHandlerOptions,
): Promise<SettingsActionResult> {
  try {
    const current = await options.settingsStore.load();
    const saved = await options.settingsStore.save({
      ...current,
      ...message.payload.patch,
    });
    return ok(createMessage({
      id: `${message.id}:background`,
      source: 'background',
      type: 'settings/options-update-result',
      payload: { status: 'success', errorCode: null, enabled: saved.enabled },
    }));
  } catch {
    return ok(createMessage({
      id: `${message.id}:background`,
      source: 'background',
      type: 'settings/options-update-result',
      payload: {
        status: 'error',
        errorCode: 'settings_unavailable',
        enabled: message.payload.patch.enabled ?? false,
      },
    }));
  }
}

async function updatePageSettings(
  message: MessageFor<'settings/page-update'>,
  options: SettingsActionHandlerOptions,
): Promise<SettingsActionResult> {
  try {
    const current = await options.settingsStore.load();
    const saved = await options.settingsStore.save({
      ...current,
      enabled: message.payload.updateEnabled
        ? message.payload.enabled
        : current.enabled,
      provider: message.payload.updateProvider
        ? message.payload.provider
        : current.provider,
      appearance: message.payload.updateAppearance
        ? message.payload.appearance
        : current.appearance,
    });
    return ok(createMessage({
      id: `${message.id}:background`,
      source: 'background',
      type: 'settings/page-update-result',
      payload: {
        status: 'success',
        errorCode: null,
        enabled: saved.enabled,
        provider: saved.provider,
        appearance: saved.appearance,
      },
    }));
  } catch {
    return ok(createMessage({
      id: `${message.id}:background`,
      source: 'background',
      type: 'settings/page-update-result',
      payload: {
        status: 'error',
        errorCode: 'settings_unavailable',
        enabled: message.payload.enabled,
        provider: message.payload.provider,
        appearance: message.payload.appearance,
      },
    }));
  }
}

function settingsUnavailable(): SettingsActionResult {
  return {
    ok: false,
    error: {
      code: 'invalid_message',
      message: 'Settings are unavailable.',
      retryable: false,
    },
  };
}

async function clearTranslationCache(
  message: MessageFor<'settings/cache-clear'>,
  options: SettingsActionHandlerOptions,
): Promise<SettingsActionResult> {
  if (message.payload.scope === 'all') {
    try {
      await options.cache.clearAll();
      return cacheClearResult(message, null);
    } catch {
      return cacheClearResult(message, 'cache_unavailable');
    }
  }

  let episodeId: unknown;
  try {
    episodeId = await options.readCurrentEpisodeId();
  } catch {
    return cacheClearResult(message, 'current_episode_unavailable');
  }
  if (typeof episodeId !== 'string' || !OPAQUE_EPISODE_ID.test(episodeId)) {
    return cacheClearResult(message, 'current_episode_unavailable');
  }
  try {
    await options.cache.clearEpisode(episodeId);
    return cacheClearResult(message, null);
  } catch {
    return cacheClearResult(message, 'cache_unavailable');
  }
}

interface StoredDeepSeekSettings {
  readonly apiKey: string;
  readonly model: 'deepseek-v4-flash' | 'deepseek-v4-pro';
}

function parseStoredDeepSeekSettings(value: unknown): StoredDeepSeekSettings | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const apiKey = record.deepseekApiKey;
  const model = record.deepseekModel ?? 'deepseek-v4-flash';
  if (typeof apiKey !== 'string' || !apiKey.trim() || apiKey.length > 512) return null;
  if (model !== 'deepseek-v4-flash' && model !== 'deepseek-v4-pro') return null;
  return { apiKey: apiKey.trim(), model };
}

function deepseekTestSuccess(
  request: MessageFor<'settings/deepseek-test'>,
): SettingsActionResult {
  return ok(createMessage({
    id: `${request.id}:background`,
    source: 'background',
    type: 'settings/deepseek-test-result',
    payload: { status: 'success', errorCode: null, retryable: false },
  }));
}

function deepseekTestResult(
  request: MessageFor<'settings/deepseek-test'>,
  errorCode: TranslationErrorCode,
  retryable: boolean,
): SettingsActionResult {
  return ok(createMessage({
    id: `${request.id}:background`,
    source: 'background',
    type: 'settings/deepseek-test-result',
    payload: { status: 'error', errorCode, retryable },
  }));
}

function cacheClearResult(
  request: MessageFor<'settings/cache-clear'>,
  errorCode: 'cache_unavailable' | 'current_episode_unavailable' | null,
): SettingsActionResult {
  return ok(createMessage({
    id: `${request.id}:background`,
    source: 'background',
    type: 'settings/cache-clear-result',
    payload: {
      scope: request.payload.scope,
      status: errorCode === null ? 'success' : 'error',
      errorCode,
    },
  }));
}
