import { createMessage, parseMessageEnvelope, type MessageFor, type MessageType } from '../shared/messages';
import { err, ok } from '../shared/result';
import { normalizeNetflixLanguageTag } from '../netflix/adapter';
import {
  cloneSettings,
  type RuntimeSettingsState,
  type SubTwinSettings,
} from '../storage/schema';
import {
  isTrustedSettingsSender,
  trustedNetflixContentTabId,
  type SettingsMessageSender,
  type SettingsPageAudience,
} from '../storage/trusted-sender';
import type { RuntimeStatus } from './status';

export interface NetflixSessionRegistry {
  record(tabId: number, message: MessageFor<'netflix/session-state'>): boolean;
  recordCatalog(tabId: number, message: MessageFor<'netflix/catalog-summary'>): boolean;
  authorizeTranslation(tabId: number, message: MessageFor<'translation/request'>): boolean;
  readCurrentEpisodeId(): string | undefined;
  removeTab(tabId: number): void;
}

interface RegisteredNetflixCatalog {
  readonly authority: 'authoritative' | 'provisional';
  readonly englishAvailable: boolean;
  readonly simplifiedChineseAvailable: boolean;
  readonly generation: number;
}

interface ActiveNetflixSession {
  readonly sessionId: string;
  readonly episodeId: string;
  readonly generation: number;
  readonly order: number;
  readonly catalog?: RegisteredNetflixCatalog;
}

const MAX_ACTIVE_NETFLIX_TABS = 128;

export function createNetflixSessionRegistry(): NetflixSessionRegistry {
  const sessions = new Map<number, ActiveNetflixSession>();
  let order = 0;

  const prune = (): void => {
    if (sessions.size <= MAX_ACTIVE_NETFLIX_TABS) return;
    const oldest = [...sessions.entries()].sort(
      ([, left], [, right]) => left.order - right.order,
    )[0];
    if (oldest !== undefined) sessions.delete(oldest[0]);
  };

  return {
    record(tabId, message) {
      const current = sessions.get(tabId);
      const next = message.payload;
      if (next.state === 'disposed') {
        if (
          current === undefined ||
          current.sessionId !== next.sessionId ||
          next.generation < current.generation
        ) return false;
        sessions.delete(tabId);
        return true;
      }

      if (
        current !== undefined &&
        current.sessionId === next.sessionId &&
        next.generation < current.generation
      ) return false;
      const preserveCatalog =
        current?.sessionId === next.sessionId &&
        current.generation === next.generation
          ? current.catalog
          : undefined;
      sessions.set(tabId, {
        sessionId: next.sessionId,
        episodeId: next.episodeId,
        generation: next.generation,
        order: ++order,
        ...(preserveCatalog === undefined ? {} : { catalog: preserveCatalog }),
      });
      prune();
      return true;
    },

    recordCatalog(tabId, message) {
      const current = sessions.get(tabId);
      const next = message.payload;
      if (
        current === undefined ||
        current.sessionId !== next.sessionId ||
        current.generation !== next.generation
      ) return false;
      if (
        current.catalog?.authority === 'authoritative' &&
        next.authority === 'provisional'
      ) return false;

      let englishAvailable = false;
      let simplifiedChineseAvailable = false;
      for (const track of next.tracks) {
        const language = normalizeNetflixLanguageTag(track.language);
        if (language?.category === 'english') englishAvailable = true;
        if (language?.category === 'simplified-chinese') {
          simplifiedChineseAvailable = true;
        }
      }
      sessions.set(tabId, {
        ...current,
        order: ++order,
        catalog: {
          authority: next.authority,
          englishAvailable,
          simplifiedChineseAvailable,
          generation: next.generation,
        },
      });
      return true;
    },

    authorizeTranslation(tabId, message) {
      const current = sessions.get(tabId);
      const catalog = current?.catalog;
      return current !== undefined &&
        catalog !== undefined &&
        current.sessionId === message.payload.sessionId &&
        current.episodeId === message.payload.episodeId &&
        catalog.generation === current.generation &&
        catalog.authority === 'authoritative' &&
        catalog.englishAvailable &&
        !catalog.simplifiedChineseAvailable;
    },

    readCurrentEpisodeId() {
      let latest: ActiveNetflixSession | undefined;
      for (const session of sessions.values()) {
        if (latest === undefined || session.order > latest.order) latest = session;
      }
      return latest?.episodeId;
    },

    removeTab(tabId) {
      sessions.delete(tabId);
    },
  };
}

export interface BackgroundMessageRouterOptions {
  readonly runtimeId: string;
  readonly extensionBaseUrl: string;
  readonly sessionRegistry: NetflixSessionRegistry;
  readonly loadSettings: () => Promise<SubTwinSettings>;
  readonly handleTranslation: (candidate: unknown) => Promise<unknown>;
  readonly handleSettingsAction: (candidate: unknown) => Promise<unknown>;
  readonly writeRuntimeStatus: (status: RuntimeStatus) => Promise<void>;
  readonly broadcastRuntimeSettings: (
    settings: RuntimeSettingsState,
    translationConfigurationChanged: boolean,
  ) => Promise<void>;
}

export function createBackgroundMessageRouter(
  options: BackgroundMessageRouterOptions,
): (candidate: unknown, sender: SettingsMessageSender) => Promise<unknown> {
  return async (candidate, sender) => {
    const parsed = parseMessageEnvelope(candidate);
    if (!parsed.ok) return parsed;
    const message = parsed.value;

    const settingsAudience = settingsActionAudience(message.type, message.source);
    if (settingsAudience !== null) {
      if (!isTrustedSettingsSender(
        sender,
        settingsAudience,
        options.runtimeId,
        options.extensionBaseUrl,
      )) return undefined;
      let beforeMutation: SubTwinSettings | undefined;
      if (
        message.type === 'settings/enabled-set' ||
        message.type === 'settings/options-update'
      ) {
        try {
          beforeMutation = cloneSettings(await options.loadSettings());
        } catch {
          beforeMutation = undefined;
        }
      }
      const response = await options.handleSettingsAction(message);
      if (
        isSuccessfulSettingsMutation(response) &&
        (message.type === 'settings/enabled-set' ||
          message.type === 'settings/options-update')
      ) {
        try {
          const afterMutation = await options.loadSettings();
          await options.broadcastRuntimeSettings(
            runtimeSettingsState(afterMutation),
            beforeMutation === undefined ||
              translationConfigurationChanged(beforeMutation, afterMutation),
          );
        } catch {
          // A settings push is best-effort; content requests a fresh snapshot on start.
        }
      }
      return response;
    }

    if (
      message.type === 'translation/request' ||
      message.type === 'translation/cancel' ||
      message.type === 'runtime/settings-get' ||
      message.type === 'runtime/status-set' ||
      message.type === 'netflix/session-state' ||
      message.type === 'netflix/catalog-summary' ||
      message.type === 'netflix/probe-status'
    ) {
      const tabId = trustedNetflixContentTabId(sender, options.runtimeId);
      if (tabId === null) return undefined;

      if (message.type === 'translation/request') {
        // This is the final policy-enforcement point before a subtitle can
        // reach an external provider. Content-world routing remains the first
        // line of defence, but a stale or regressed content script cannot
        // bypass the official-subtitle privacy rule.
        if (!options.sessionRegistry.authorizeTranslation(tabId, message)) {
          return retryableTranslationGateRejection(message);
        }
        return options.handleTranslation(message);
      }
      if (message.type === 'translation/cancel') {
        // Always allow cancellation so stale provider work can be torn down
        // even after the catalog gate has closed.
        return options.handleTranslation(message);
      }

      if (message.type === 'runtime/settings-get') {
        try {
          return ok(createMessage({
            id: `${message.id}:background`,
            source: 'background',
            type: 'runtime/settings-state',
            payload: runtimeSettingsState(await options.loadSettings()),
          }));
        } catch {
          return err({
            code: 'invalid_message',
            message: 'Runtime settings are unavailable.',
            retryable: false,
          });
        }
      }

      if (message.type === 'runtime/status-set') {
        try {
          await options.writeRuntimeStatus(message.payload);
        } catch {
          // Runtime status is diagnostic-only and must never affect playback.
        }
        return undefined;
      }

      if (message.type === 'netflix/session-state') {
        options.sessionRegistry.record(tabId, message);
      } else if (message.type === 'netflix/catalog-summary') {
        options.sessionRegistry.recordCatalog(tabId, message);
      }
      return undefined;
    }

    if (
      message.type === 'system/health-check' &&
      sender.id === options.runtimeId
    ) {
      return ok(createMessage({
        id: `${message.id}:background`,
        source: 'background',
        type: 'system/health-response',
        payload: { requestId: message.id, ready: true },
      }));
    }

    return undefined;
  };
}

function retryableTranslationGateRejection(
  request: MessageFor<'translation/request'>,
): ReturnType<typeof ok<MessageFor<'translation/result'>>> {
  return ok(createMessage({
    id: `${request.id}:background`,
    source: 'background',
    type: 'translation/result',
    payload: {
      taskId: request.payload.taskId,
      sessionId: request.payload.sessionId,
      provider: request.payload.provider,
      episodeGeneration: request.payload.episodeGeneration,
      providerGeneration: request.payload.providerGeneration,
      status: 'error',
      translations: [],
      retryCueIds: [],
      errorCode: 'provider_unavailable',
      retryable: true,
    },
  }));
}

function translationConfigurationChanged(
  before: SubTwinSettings,
  after: SubTwinSettings,
): boolean {
  return before.provider !== after.provider ||
    before.deepseek.model !== after.deepseek.model ||
    before.deepseek.apiKey !== after.deepseek.apiKey;
}

export function runtimeSettingsState(
  settings: SubTwinSettings,
): RuntimeSettingsState {
  const snapshot = cloneSettings(settings);
  return {
    enabled: snapshot.enabled,
    provider: snapshot.provider,
    deepseekKeyReady: snapshot.deepseek.apiKey.trim().length > 0,
    appearance: snapshot.appearance,
  };
}

function settingsActionAudience(
  type: MessageType,
  source: string,
): SettingsPageAudience | null {
  if (
    type === 'settings/cache-clear' ||
    type === 'settings/deepseek-test' ||
    type === 'settings/options-update' ||
    type === 'settings/private-get'
  ) return source === 'options' ? 'options' : null;
  if (type === 'settings/enabled-set' && (source === 'options' || source === 'popup')) {
    return source;
  }
  if (type === 'settings/public-get') return source === 'popup' ? 'popup' : null;
  return null;
}

function isSuccessfulSettingsMutation(value: unknown): boolean {
  if (!isRecord(value) || value.ok !== true) return false;
  const parsed = parseMessageEnvelope(value.value);
  if (!parsed.ok) return false;
  return (
    parsed.value.type === 'settings/enabled-set-result' ||
    parsed.value.type === 'settings/options-update-result'
  ) && parsed.value.payload.status === 'success';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
