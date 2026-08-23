import { err, ok, type AppError, type Result } from './result';
import type {
  TranslationErrorCode,
  TranslationProviderSelection,
} from '../translation/types';
import {
  isExactSubTwinSettings,
  normalizeSettings,
  type SubTwinSettings,
  type TranslationProviderSetting,
} from '../storage/schema';

export const MESSAGE_PROTOCOL = 'subtwin' as const;
export const MESSAGE_PROTOCOL_VERSION = 1 as const;

export type ExtensionContext =
  | 'background'
  | 'content'
  | 'options'
  | 'page'
  | 'popup';

export interface MessagePayloadMap {
  readonly 'settings/enabled-set': {
    readonly enabled: boolean;
  };
  readonly 'settings/enabled-set-result': {
    readonly status: 'error' | 'success';
    readonly errorCode: 'settings_unavailable' | null;
    readonly enabled: boolean;
    readonly provider: TranslationProviderSetting;
  };
  readonly 'settings/options-update': {
    readonly settings: SubTwinSettings;
    readonly updateEnabled: boolean;
  };
  readonly 'settings/options-update-result': {
    readonly status: 'error' | 'success';
    readonly errorCode: 'settings_unavailable' | null;
    readonly enabled: boolean;
  };
  readonly 'settings/private-get': Record<string, never>;
  readonly 'settings/private-get-result': {
    readonly settings: SubTwinSettings;
  };
  readonly 'settings/public-get': Record<string, never>;
  readonly 'settings/public-get-result': {
    readonly enabled: boolean;
    readonly provider: TranslationProviderSetting;
  };
  readonly 'settings/cache-clear': {
    readonly scope: 'all' | 'episode';
  };
  readonly 'settings/cache-clear-result': {
    readonly scope: 'all' | 'episode';
    readonly status: 'error' | 'success';
    readonly errorCode:
      | 'cache_unavailable'
      | 'current_episode_unavailable'
      | null;
  };
  readonly 'settings/deepseek-test': Record<string, never>;
  readonly 'settings/deepseek-test-result': {
    readonly status: 'error' | 'success';
    readonly errorCode: TranslationErrorCode | null;
    readonly retryable: boolean;
  };
  readonly 'translation/cancel': {
    readonly sessionId: string;
    readonly episodeGeneration: number;
    readonly providerGeneration: number;
    readonly reason:
      | 'disabled'
      | 'episode-change'
      | 'official-track'
      | 'player-disposed'
      | 'provider-change';
  };
  readonly 'translation/cancelled': {
    readonly sessionId: string;
    readonly episodeGeneration: number;
    readonly providerGeneration: number;
    readonly accepted: boolean;
  };
  readonly 'translation/request': {
    readonly taskId: string;
    readonly sessionId: string;
    readonly episodeId: string;
    readonly trackHash: string;
    readonly provider: TranslationProviderSelection;
    readonly sourceLanguage: 'en';
    readonly targetLanguage: 'zh-Hans';
    readonly episodeGeneration: number;
    readonly providerGeneration: number;
    readonly priority: 'bulk' | 'urgent';
    readonly cues: readonly TranslationMessageCue[];
    readonly context: readonly TranslationMessageCue[];
  };
  readonly 'translation/result': {
    readonly taskId: string;
    readonly sessionId: string;
    readonly provider: TranslationProviderSelection;
    readonly episodeGeneration: number;
    readonly providerGeneration: number;
    readonly status: 'error' | 'success';
    readonly translations: readonly {
      readonly cueId: string;
      readonly text: string;
    }[];
    readonly retryCueIds: readonly string[];
    readonly errorCode: TranslationErrorCode | null;
    readonly retryable: boolean;
  };
  readonly 'netflix/catalog-summary': {
    readonly sessionId: string;
    readonly generation: number;
    readonly authority: 'authoritative' | 'provisional';
    readonly tracks: readonly {
      readonly id: string;
      readonly language: string;
      readonly kind: 'closed-caption' | 'subtitle';
    }[];
  };
  readonly 'netflix/probe-status': {
    readonly sessionId: string;
    readonly generation: number;
    readonly status: 'connected' | 'disposed' | 'unsupported';
  };
  readonly 'system/health-check': {
    readonly sentAt: number;
  };
  readonly 'system/health-response': {
    readonly requestId: string;
    readonly ready: true;
  };
}

export interface TranslationMessageCue {
  readonly id: string;
  readonly startMs: number;
  readonly endMs: number;
  readonly text: string;
}

export type MessageType = keyof MessagePayloadMap;

export interface MessageEnvelope<Type extends MessageType> {
  readonly protocol: typeof MESSAGE_PROTOCOL;
  readonly version: typeof MESSAGE_PROTOCOL_VERSION;
  readonly id: string;
  readonly source: ExtensionContext;
  readonly type: Type;
  readonly payload: MessagePayloadMap[Type];
}

export type MessageFor<Type extends MessageType> = MessageEnvelope<Type>;

export type ExtensionMessage = {
  readonly [Type in MessageType]: MessageFor<Type>;
}[MessageType];

export type MessageValidationError = AppError<
  'invalid_message' | 'unsupported_message_version'
>;

export type MessageDraft<Type extends MessageType> = Omit<
  MessageFor<Type>,
  'protocol' | 'version'
>;

export function createMessage<Type extends MessageType>(
  draft: MessageDraft<Type>,
): MessageFor<Type> {
  return {
    protocol: MESSAGE_PROTOCOL,
    version: MESSAGE_PROTOCOL_VERSION,
    id: draft.id,
    source: draft.source,
    type: draft.type,
    payload: draft.payload,
  };
}

export function parseMessageEnvelope(
  input: unknown,
): Result<ExtensionMessage, MessageValidationError> {
  if (
    !isRecord(input) ||
    !hasExactlyKeys(input, ['id', 'payload', 'protocol', 'source', 'type', 'version']) ||
    input.protocol !== MESSAGE_PROTOCOL
  ) {
    return invalidMessage();
  }

  if (
    typeof input.version === 'number' &&
    input.version !== MESSAGE_PROTOCOL_VERSION
  ) {
    return err({
      code: 'unsupported_message_version',
      message: 'Unsupported SubTwin message protocol version.',
      retryable: false,
      details: {
        receivedVersion: input.version,
        supportedVersion: MESSAGE_PROTOCOL_VERSION,
      },
    });
  }

  if (
    input.version !== MESSAGE_PROTOCOL_VERSION ||
    !isNonEmptyString(input.id) ||
    !isExtensionContext(input.source)
  ) {
    return invalidMessage();
  }

  if (
    input.source === 'options' &&
    input.type === 'settings/private-get' &&
    isEmptyRecord(input.payload)
  ) {
    return ok(createMessage({
      id: input.id,
      source: input.source,
      type: input.type,
      payload: {},
    }));
  }

  if (
    input.source === 'popup' &&
    input.type === 'settings/public-get' &&
    isEmptyRecord(input.payload)
  ) {
    return ok(createMessage({
      id: input.id,
      source: input.source,
      type: input.type,
      payload: {},
    }));
  }

  if (
    (input.source === 'popup' || input.source === 'options') &&
    input.type === 'settings/enabled-set' &&
    isSettingsEnabledSetPayload(input.payload)
  ) {
    return ok(createMessage({
      id: input.id,
      source: input.source,
      type: input.type,
      payload: { enabled: input.payload.enabled },
    }));
  }

  if (
    input.source === 'options' &&
    input.type === 'settings/options-update' &&
    isSettingsOptionsUpdatePayload(input.payload)
  ) {
    return ok(createMessage({
      id: input.id,
      source: input.source,
      type: input.type,
      payload: {
        settings: normalizeSettings(input.payload.settings),
        updateEnabled: input.payload.updateEnabled,
      },
    }));
  }

  if (
    input.source === 'options' &&
    input.type === 'settings/deepseek-test' &&
    isEmptyRecord(input.payload)
  ) {
    return ok(createMessage({
      id: input.id,
      source: input.source,
      type: input.type,
      payload: {},
    }));
  }

  if (
    input.source === 'options' &&
    input.type === 'settings/cache-clear' &&
    isSettingsCacheClearPayload(input.payload)
  ) {
    return ok(createMessage({
      id: input.id,
      source: input.source,
      type: input.type,
      payload: { scope: input.payload.scope },
    }));
  }

  if (
    input.source === 'background' &&
    input.type === 'settings/private-get-result' &&
    isSettingsPrivateGetResultPayload(input.payload)
  ) {
    return ok(createMessage({
      id: input.id,
      source: input.source,
      type: input.type,
      payload: { settings: normalizeSettings(input.payload.settings) },
    }));
  }

  if (
    input.source === 'background' &&
    input.type === 'settings/public-get-result' &&
    isSettingsPublicGetResultPayload(input.payload)
  ) {
    return ok(createMessage({
      id: input.id,
      source: input.source,
      type: input.type,
      payload: { ...input.payload },
    }));
  }

  if (
    input.source === 'background' &&
    input.type === 'settings/enabled-set-result' &&
    isSettingsEnabledSetResultPayload(input.payload)
  ) {
    return ok(createMessage({
      id: input.id,
      source: input.source,
      type: input.type,
      payload: { ...input.payload },
    }));
  }

  if (
    input.source === 'background' &&
    input.type === 'settings/options-update-result' &&
    isSettingsOptionsUpdateResultPayload(input.payload)
  ) {
    return ok(createMessage({
      id: input.id,
      source: input.source,
      type: input.type,
      payload: { ...input.payload },
    }));
  }

  if (
    input.source === 'background' &&
    input.type === 'settings/deepseek-test-result' &&
    isSettingsDeepSeekTestResultPayload(input.payload)
  ) {
    return ok(createMessage({
      id: input.id,
      source: input.source,
      type: input.type,
      payload: { ...input.payload },
    }));
  }

  if (
    input.source === 'background' &&
    input.type === 'settings/cache-clear-result' &&
    isSettingsCacheClearResultPayload(input.payload)
  ) {
    return ok(createMessage({
      id: input.id,
      source: input.source,
      type: input.type,
      payload: { ...input.payload },
    }));
  }

  if (
    input.source === 'content' &&
    input.type === 'translation/cancel' &&
    isTranslationCancelPayload(input.payload)
  ) {
    return ok(createMessage({
      id: input.id,
      source: input.source,
      type: input.type,
      payload: { ...input.payload },
    }));
  }

  if (
    input.source === 'background' &&
    input.type === 'translation/cancelled' &&
    isTranslationCancelledPayload(input.payload)
  ) {
    return ok(createMessage({
      id: input.id,
      source: input.source,
      type: input.type,
      payload: { ...input.payload },
    }));
  }

  if (
    input.source === 'content' &&
    input.type === 'translation/request' &&
    isTranslationRequestPayload(input.payload)
  ) {
    return ok(createMessage({
      id: input.id,
      source: input.source,
      type: input.type,
      payload: snapshotTranslationRequestPayload(input.payload),
    }));
  }

  if (
    input.source === 'background' &&
    input.type === 'translation/result' &&
    isTranslationResultPayload(input.payload)
  ) {
    return ok(createMessage({
      id: input.id,
      source: input.source,
      type: input.type,
      payload: snapshotTranslationResultPayload(input.payload),
    }));
  }

  if (
    input.source === 'content' &&
    input.type === 'netflix/probe-status' &&
    isNetflixProbeStatusPayload(input.payload)
  ) {
    return ok(
      createMessage({
        id: input.id,
        source: input.source,
        type: input.type,
        payload: input.payload,
      }),
    );
  }

  if (
    input.source === 'content' &&
    input.type === 'netflix/catalog-summary' &&
    isNetflixCatalogSummaryPayload(input.payload)
  ) {
    return ok(
      createMessage({
        id: input.id,
        source: input.source,
        type: input.type,
        payload: input.payload,
      }),
    );
  }

  if (
    input.type === 'system/health-check' &&
    isHealthCheckPayload(input.payload)
  ) {
    return ok(
      createMessage({
        id: input.id,
        source: input.source,
        type: input.type,
        payload: input.payload,
      }),
    );
  }

  if (
    input.type === 'system/health-response' &&
    isHealthResponsePayload(input.payload)
  ) {
    return ok(
      createMessage({
        id: input.id,
        source: input.source,
        type: input.type,
        payload: input.payload,
      }),
    );
  }

  return invalidMessage();
}

function isEmptyRecord(value: unknown): value is Record<string, never> {
  return isRecord(value) && Object.keys(value).length === 0;
}

function isSettingsEnabledSetPayload(
  value: unknown,
): value is MessagePayloadMap['settings/enabled-set'] {
  return isRecord(value) &&
    hasExactlyKeys(value, ['enabled']) &&
    typeof value.enabled === 'boolean';
}

function isSettingsOptionsUpdatePayload(
  value: unknown,
): value is MessagePayloadMap['settings/options-update'] {
  return isRecord(value) &&
    hasExactlyKeys(value, ['settings', 'updateEnabled']) &&
    typeof value.updateEnabled === 'boolean' &&
    isExactSubTwinSettings(value.settings);
}

function isSettingsPublicGetResultPayload(
  value: unknown,
): value is MessagePayloadMap['settings/public-get-result'] {
  return isRecord(value) &&
    hasExactlyKeys(value, ['enabled', 'provider']) &&
    typeof value.enabled === 'boolean' &&
    isSettingsProvider(value.provider);
}

function isSettingsPrivateGetResultPayload(
  value: unknown,
): value is MessagePayloadMap['settings/private-get-result'] {
  return isRecord(value) &&
    hasExactlyKeys(value, ['settings']) &&
    isExactSubTwinSettings(value.settings);
}

function isSettingsEnabledSetResultPayload(
  value: unknown,
): value is MessagePayloadMap['settings/enabled-set-result'] {
  if (
    !isRecord(value) ||
    !hasExactlyKeys(value, ['enabled', 'errorCode', 'provider', 'status']) ||
    typeof value.enabled !== 'boolean' ||
    !isSettingsProvider(value.provider) ||
    (value.status !== 'error' && value.status !== 'success')
  ) return false;
  return value.status === 'success'
    ? value.errorCode === null
    : value.errorCode === 'settings_unavailable';
}

function isSettingsOptionsUpdateResultPayload(
  value: unknown,
): value is MessagePayloadMap['settings/options-update-result'] {
  if (
    !isRecord(value) ||
    !hasExactlyKeys(value, ['enabled', 'errorCode', 'status']) ||
    typeof value.enabled !== 'boolean' ||
    (value.status !== 'error' && value.status !== 'success')
  ) return false;
  return value.status === 'success'
    ? value.errorCode === null
    : value.errorCode === 'settings_unavailable';
}

function isSettingsProvider(value: unknown): value is TranslationProviderSetting {
  return value === 'unset' || value === 'google-free' || value === 'deepseek';
}

function isSettingsCacheClearPayload(
  value: unknown,
): value is MessagePayloadMap['settings/cache-clear'] {
  return isRecord(value) &&
    hasExactlyKeys(value, ['scope']) &&
    (value.scope === 'all' || value.scope === 'episode');
}

function isSettingsDeepSeekTestResultPayload(
  value: unknown,
): value is MessagePayloadMap['settings/deepseek-test-result'] {
  if (
    !isRecord(value) ||
    !hasExactlyKeys(value, ['errorCode', 'retryable', 'status']) ||
    (value.status !== 'error' && value.status !== 'success') ||
    typeof value.retryable !== 'boolean'
  ) return false;
  return value.status === 'success'
    ? value.errorCode === null && !value.retryable
    : isTranslationErrorCode(value.errorCode);
}

function isSettingsCacheClearResultPayload(
  value: unknown,
): value is MessagePayloadMap['settings/cache-clear-result'] {
  if (
    !isRecord(value) ||
    !hasExactlyKeys(value, ['errorCode', 'scope', 'status']) ||
    (value.scope !== 'all' && value.scope !== 'episode') ||
    (value.status !== 'error' && value.status !== 'success')
  ) return false;
  return value.status === 'success'
    ? value.errorCode === null
    : value.errorCode === 'cache_unavailable' ||
        value.errorCode === 'current_episode_unavailable';
}

function isTranslationCancelPayload(
  value: unknown,
): value is MessagePayloadMap['translation/cancel'] {
  return (
    isRecord(value) &&
    hasExactlyKeys(value, [
      'episodeGeneration',
      'providerGeneration',
      'reason',
      'sessionId',
    ]) &&
    isOpaqueId(value.sessionId) &&
    isGeneration(value.episodeGeneration) &&
    isGeneration(value.providerGeneration) &&
    (value.reason === 'disabled' ||
      value.reason === 'episode-change' ||
      value.reason === 'official-track' ||
      value.reason === 'player-disposed' ||
      value.reason === 'provider-change')
  );
}

function isTranslationCancelledPayload(
  value: unknown,
): value is MessagePayloadMap['translation/cancelled'] {
  return (
    isRecord(value) &&
    hasExactlyKeys(value, [
      'accepted',
      'episodeGeneration',
      'providerGeneration',
      'sessionId',
    ]) &&
    isOpaqueId(value.sessionId) &&
    isGeneration(value.episodeGeneration) &&
    isGeneration(value.providerGeneration) &&
    typeof value.accepted === 'boolean'
  );
}

const TRANSLATION_REQUEST_KEYS = [
  'context',
  'cues',
  'episodeGeneration',
  'episodeId',
  'priority',
  'provider',
  'providerGeneration',
  'sessionId',
  'sourceLanguage',
  'targetLanguage',
  'taskId',
  'trackHash',
] as const;

function isTranslationRequestPayload(
  value: unknown,
): value is MessagePayloadMap['translation/request'] {
  if (
    !isRecord(value) ||
    !hasExactlyKeys(value, TRANSLATION_REQUEST_KEYS) ||
    !isOpaqueId(value.taskId) ||
    !isOpaqueId(value.sessionId) ||
    !isOpaqueId(value.episodeId) ||
    !isOpaqueId(value.trackHash) ||
    !isTranslationProviderSelection(value.provider) ||
    value.sourceLanguage !== 'en' ||
    value.targetLanguage !== 'zh-Hans' ||
    !isGeneration(value.episodeGeneration) ||
    !isGeneration(value.providerGeneration) ||
    (value.priority !== 'bulk' && value.priority !== 'urgent') ||
    !Array.isArray(value.cues) ||
    !Array.isArray(value.context) ||
    value.context.length > 50 ||
    !value.cues.every(isTranslationMessageCue) ||
    !value.context.every(isTranslationMessageCue)
  ) return false;

  const cueIds = value.cues.map(({ id }) => id);
  if (new Set(cueIds).size !== cueIds.length) return false;

  if (value.provider === 'google-free' && value.cues.length !== 1) return false;
  if (value.provider !== 'google-free' && (value.cues.length < 1 || value.cues.length > 25)) {
    return false;
  }
  return boundedJsonBytes(value, 512 * 1024);
}

function isTranslationResultPayload(
  value: unknown,
): value is MessagePayloadMap['translation/result'] {
  if (
    !isRecord(value) ||
    !hasExactlyKeys(value, [
      'episodeGeneration',
      'errorCode',
      'provider',
      'providerGeneration',
      'retryCueIds',
      'retryable',
      'sessionId',
      'status',
      'taskId',
      'translations',
    ]) ||
    !isOpaqueId(value.taskId) ||
    !isOpaqueId(value.sessionId) ||
    !isTranslationProviderSelection(value.provider) ||
    !isGeneration(value.episodeGeneration) ||
    !isGeneration(value.providerGeneration) ||
    (value.status !== 'error' && value.status !== 'success') ||
    !Array.isArray(value.translations) ||
    value.translations.length > 25 ||
    !value.translations.every(isTranslationResultCue) ||
    !Array.isArray(value.retryCueIds) ||
    value.retryCueIds.length > 25 ||
    !value.retryCueIds.every(isOpaqueId) ||
    typeof value.retryable !== 'boolean'
  ) return false;

  if (value.status === 'success') {
    if (value.provider === 'unset' || value.errorCode !== null || value.retryable) return false;
  } else if (!isTranslationErrorCode(value.errorCode)) {
    return false;
  } else if (value.translations.length > 0 || value.retryCueIds.length > 0) {
    return false;
  }
  const translatedIds = value.translations.map(({ cueId }) => cueId);
  if (new Set(translatedIds).size !== translatedIds.length) return false;
  if (new Set(value.retryCueIds).size !== value.retryCueIds.length) return false;
  const translatedSet = new Set(translatedIds);
  if (value.retryCueIds.some((cueId) => translatedSet.has(cueId))) return false;
  return boundedJsonBytes(value, 512 * 1024);
}

function snapshotTranslationRequestPayload(
  payload: MessagePayloadMap['translation/request'],
): MessagePayloadMap['translation/request'] {
  return {
    taskId: payload.taskId,
    sessionId: payload.sessionId,
    episodeId: payload.episodeId,
    trackHash: payload.trackHash,
    provider: payload.provider,
    sourceLanguage: payload.sourceLanguage,
    targetLanguage: payload.targetLanguage,
    episodeGeneration: payload.episodeGeneration,
    providerGeneration: payload.providerGeneration,
    priority: payload.priority,
    cues: payload.cues.map(snapshotTranslationCue),
    context: payload.context.map(snapshotTranslationCue),
  };
}

function snapshotTranslationResultPayload(
  payload: MessagePayloadMap['translation/result'],
): MessagePayloadMap['translation/result'] {
  return {
    taskId: payload.taskId,
    sessionId: payload.sessionId,
    provider: payload.provider,
    episodeGeneration: payload.episodeGeneration,
    providerGeneration: payload.providerGeneration,
    status: payload.status,
    translations: payload.translations.map(({ cueId, text }) => ({ cueId, text })),
    retryCueIds: [...payload.retryCueIds],
    errorCode: payload.errorCode,
    retryable: payload.retryable,
  };
}

function snapshotTranslationCue(cue: TranslationMessageCue): TranslationMessageCue {
  return {
    id: cue.id,
    startMs: cue.startMs,
    endMs: cue.endMs,
    text: cue.text,
  };
}

function isTranslationMessageCue(value: unknown): value is TranslationMessageCue {
  return (
    isRecord(value) &&
    hasExactlyKeys(value, ['endMs', 'id', 'startMs', 'text']) &&
    isOpaqueId(value.id) &&
    isTimestamp(value.startMs) &&
    isTimestamp(value.endMs) &&
    value.endMs > value.startMs &&
    typeof value.text === 'string' &&
    value.text.trim().length > 0 &&
    value.text.length <= 32_768
  );
}

function isTranslationResultCue(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasExactlyKeys(value, ['cueId', 'text']) &&
    isOpaqueId(value.cueId) &&
    typeof value.text === 'string' &&
    value.text.trim().length > 0 &&
    value.text.length <= 16_384
  );
}

function isTranslationProviderSelection(value: unknown): boolean {
  return value === 'deepseek' || value === 'google-free' || value === 'unset';
}

const TRANSLATION_ERROR_CODES: readonly TranslationErrorCode[] = [
  'aborted',
  'authentication_failed',
  'insufficient_balance',
  'invalid_configuration',
  'invalid_request',
  'invalid_response',
  'provider_forbidden',
  'provider_unavailable',
  'provider_unset',
  'rate_limited',
  'stale_generation',
  'timeout',
];

function isTranslationErrorCode(value: unknown): value is TranslationErrorCode {
  return typeof value === 'string' && TRANSLATION_ERROR_CODES.some((code) => code === value);
}

function isTimestamp(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function boundedJsonBytes(value: unknown, maximum: number): boolean {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength <= maximum;
  } catch {
    return false;
  }
}

const EXTENSION_CONTEXTS: readonly ExtensionContext[] = [
  'background',
  'content',
  'options',
  'page',
  'popup',
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isExtensionContext(value: unknown): value is ExtensionContext {
  return EXTENSION_CONTEXTS.some((context) => context === value);
}

function isHealthCheckPayload(
  value: unknown,
): value is MessagePayloadMap['system/health-check'] {
  return (
    isRecord(value) &&
    hasExactlyKeys(value, ['sentAt']) &&
    typeof value.sentAt === 'number' &&
    Number.isFinite(value.sentAt) &&
    value.sentAt >= 0
  );
}

function isHealthResponsePayload(
  value: unknown,
): value is MessagePayloadMap['system/health-response'] {
  return (
    isRecord(value) &&
    hasExactlyKeys(value, ['ready', 'requestId']) &&
    value.ready === true &&
    isNonEmptyString(value.requestId)
  );
}

function isNetflixProbeStatusPayload(
  value: unknown,
): value is MessagePayloadMap['netflix/probe-status'] {
  return (
    isRecord(value) &&
    hasExactlyKeys(value, ['generation', 'sessionId', 'status']) &&
    isOpaqueId(value.sessionId) &&
    isGeneration(value.generation) &&
    (value.status === 'connected' ||
      value.status === 'disposed' ||
      value.status === 'unsupported')
  );
}

function isNetflixCatalogSummaryPayload(
  value: unknown,
): value is MessagePayloadMap['netflix/catalog-summary'] {
  return (
    isRecord(value) &&
    hasExactlyKeys(value, ['authority', 'generation', 'sessionId', 'tracks']) &&
    isOpaqueId(value.sessionId) &&
    isGeneration(value.generation) &&
    (value.authority === 'authoritative' || value.authority === 'provisional') &&
    Array.isArray(value.tracks) &&
    value.tracks.length <= 256 &&
    value.tracks.every(isNetflixCatalogTrack)
  );
}

function isNetflixCatalogTrack(
  value: unknown,
): value is MessagePayloadMap['netflix/catalog-summary']['tracks'][number] {
  return (
    isRecord(value) &&
    hasExactlyKeys(value, ['id', 'kind', 'language']) &&
    isOpaqueId(value.id) &&
    typeof value.language === 'string' &&
    value.language.length <= 35 &&
    /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/u.test(value.language) &&
    (value.kind === 'closed-caption' || value.kind === 'subtitle')
  );
}

function isOpaqueId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 128 &&
    /^[A-Za-z0-9._:-]+$/u.test(value)
  );
}

function isGeneration(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function hasExactlyKeys(
  value: Readonly<Record<string, unknown>>,
  expectedKeys: readonly string[],
): boolean {
  const actualKeys = Object.keys(value);

  return (
    actualKeys.length === expectedKeys.length &&
    actualKeys.every((key) => expectedKeys.includes(key))
  );
}

function invalidMessage(): Result<never, MessageValidationError> {
  return err({
    code: 'invalid_message',
    message: 'Invalid SubTwin message envelope.',
    retryable: false,
  });
}
