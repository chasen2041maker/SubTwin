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
  recordCatalog(
    tabId: number,
    message: MessageFor<'netflix/catalog-summary'>,
  ): TranslationRevocation | null;
  authorize(
    tabId: number,
    message: MessageFor<'translation/request'>,
  ): NetflixAuthorizationDecision;
  readCurrentEpisodeId(): string | undefined;
  removeTab(tabId: number): void;
  snapshot(): NetflixSessionRegistrySnapshot;
  restore(candidate: unknown): boolean;
}

export interface NetflixAuthorizationDecision {
  readonly allowed: boolean;
  readonly stateChanged: boolean;
}

export interface NetflixSessionRegistrySnapshot {
  readonly version: 1;
  readonly sessions: readonly {
    readonly tabId: number;
    readonly sessionId: string;
    readonly episodeId: string;
    readonly generation: number;
    readonly catalogAuthority: 'authoritative' | 'provisional' | 'unknown';
    readonly englishAvailable: boolean;
    readonly simplifiedChineseSeen: boolean;
    readonly latestAuthorizedProviderGeneration: number | null;
    readonly order: number;
  }[];
  readonly retiredSessions: readonly {
    readonly tabId: number;
    readonly sessionIds: readonly string[];
  }[];
  readonly pendingCatalogs: readonly {
    readonly tabId: number;
    readonly sessionId: string;
    readonly generation: number;
    readonly catalogAuthority: 'authoritative' | 'provisional';
    readonly englishAvailable: boolean;
    readonly simplifiedChineseSeen: boolean;
    readonly order: number;
  }[];
}

interface ActiveNetflixSession {
  sessionId: string;
  episodeId: string;
  generation: number;
  catalogAuthority: 'authoritative' | 'provisional' | 'unknown';
  englishAvailable: boolean;
  simplifiedChineseSeen: boolean;
  latestAuthorizedProviderGeneration: number | undefined;
  order: number;
}

interface TranslationRevocation {
  readonly sessionId: string;
  readonly episodeGeneration: number;
  readonly providerGeneration: number;
}

interface PendingNetflixCatalog {
  readonly sessionId: string;
  readonly generation: number;
  readonly catalogAuthority: 'authoritative' | 'provisional';
  readonly englishAvailable: boolean;
  readonly simplifiedChineseSeen: boolean;
  readonly order: number;
}

const MAX_ACTIVE_NETFLIX_TABS = 128;
const MAX_RETIRED_SESSIONS_PER_TAB = 32;
const MAX_RETIRED_NETFLIX_TABS = 1_024;

export function createNetflixSessionRegistry(): NetflixSessionRegistry {
  const sessions = new Map<number, ActiveNetflixSession>();
  const pendingCatalogs = new Map<number, PendingNetflixCatalog>();
  const retiredSessions = new Map<number, readonly string[]>();
  let order = 0;

  const retire = (tabId: number, sessionId: string): boolean => {
    const current = retiredSessions.get(tabId) ?? [];
    if (current.includes(sessionId)) return false;
    retiredSessions.set(tabId, [
      ...current,
      sessionId,
    ].slice(-MAX_RETIRED_SESSIONS_PER_TAB));
    if (retiredSessions.size > MAX_RETIRED_NETFLIX_TABS) {
      const oldestTabId = retiredSessions.keys().next().value as number | undefined;
      if (oldestTabId !== undefined) retiredSessions.delete(oldestTabId);
    }
    return true;
  };

  const prune = (): void => {
    if (sessions.size > MAX_ACTIVE_NETFLIX_TABS) {
      const oldest = [...sessions.entries()].sort(
        ([, left], [, right]) => left.order - right.order,
      )[0];
      if (oldest !== undefined) {
        sessions.delete(oldest[0]);
        retiredSessions.delete(oldest[0]);
      }
    }
    if (pendingCatalogs.size > MAX_ACTIVE_NETFLIX_TABS) {
      const oldest = [...pendingCatalogs.entries()].sort(
        ([, left], [, right]) => left.order - right.order,
      )[0];
      if (oldest !== undefined) pendingCatalogs.delete(oldest[0]);
    }
  };

  return {
    record(tabId, message) {
      const current = sessions.get(tabId);
      const next = message.payload;
      if (next.state === 'disposed') {
        const pending = pendingCatalogs.get(tabId);
        const removedPending =
          pending?.sessionId === next.sessionId &&
          next.generation >= pending.generation;
        if (removedPending) pendingCatalogs.delete(tabId);
        if (current?.sessionId === next.sessionId) {
          if (
            current.episodeId !== next.episodeId ||
            current.generation !== next.generation
          ) return false;
          retire(tabId, current.sessionId);
          sessions.delete(tabId);
          return true;
        }
        return retire(tabId, next.sessionId) || removedPending;
      }

      if (retiredSessions.get(tabId)?.includes(next.sessionId) === true) {
        return false;
      }
      if (
        current !== undefined &&
        current.sessionId === next.sessionId &&
        (next.generation < current.generation ||
          (next.generation === current.generation &&
            next.episodeId !== current.episodeId))
      ) return false;
      if (current !== undefined && current.sessionId !== next.sessionId) {
        retire(tabId, current.sessionId);
        const pending = pendingCatalogs.get(tabId);
        if (pending?.sessionId === current.sessionId) {
          pendingCatalogs.delete(tabId);
        }
      }
      const preserveCatalogEvidence = current?.sessionId === next.sessionId &&
        current.episodeId === next.episodeId &&
        current.generation === next.generation;
      const pending = pendingCatalogs.get(tabId);
      const pendingCatalog = pending?.sessionId === next.sessionId &&
        pending.generation === next.generation
        ? pending
        : undefined;
      if (pendingCatalog !== undefined) pendingCatalogs.delete(tabId);
      sessions.set(tabId, {
        sessionId: next.sessionId,
        episodeId: next.episodeId,
        generation: next.generation,
        catalogAuthority: preserveCatalogEvidence
          ? current.catalogAuthority
          : pendingCatalog?.catalogAuthority ?? 'unknown',
        englishAvailable: preserveCatalogEvidence
          ? current.englishAvailable
          : pendingCatalog?.englishAvailable ?? false,
        simplifiedChineseSeen: preserveCatalogEvidence
          ? current.simplifiedChineseSeen
          : pendingCatalog?.simplifiedChineseSeen ?? false,
        latestAuthorizedProviderGeneration: preserveCatalogEvidence
          ? current.latestAuthorizedProviderGeneration
          : undefined,
        order: ++order,
      });
      prune();
      return true;
    },
    recordCatalog(tabId, message) {
      const current = sessions.get(tabId);
      const next = message.payload;
      const categories = next.tracks.map(({ language }) =>
        normalizeNetflixLanguageTag(language)?.category ?? 'other');
      const englishAvailable = categories.includes('english');
      const sawSimplifiedChinese = categories.includes('simplified-chinese');
      if (
        current !== undefined &&
        current.sessionId === next.sessionId &&
        current.generation === next.generation
      ) {
        if (
          current.catalogAuthority === 'authoritative' &&
          next.authority === 'provisional'
        ) return null;
        const pending = pendingCatalogs.get(tabId);
        if (
          pending?.sessionId === next.sessionId &&
          pending.generation === next.generation
        ) pendingCatalogs.delete(tabId);
        const shouldRevoke = !current.simplifiedChineseSeen &&
          sawSimplifiedChinese &&
          current.latestAuthorizedProviderGeneration !== undefined;
        current.catalogAuthority = next.authority;
        current.englishAvailable = englishAvailable;
        current.simplifiedChineseSeen ||= sawSimplifiedChinese;
        current.order = ++order;
        if (!shouldRevoke) return null;
        return {
          sessionId: current.sessionId,
          episodeGeneration: current.generation,
          providerGeneration: current.latestAuthorizedProviderGeneration ?? 0,
        };
      }

      // Runtime messages are delivered independently. Quarantine catalog
      // evidence that arrives first until the exact tab/session/generation is
      // registered. The pending entry can never authorize translation alone.
      if (retiredSessions.get(tabId)?.includes(next.sessionId) === true) {
        return null;
      }
      if (
        current?.sessionId === next.sessionId &&
        current.generation > next.generation
      ) return null;
      const pending = pendingCatalogs.get(tabId);
      if (
        pending?.sessionId === next.sessionId &&
        pending.generation > next.generation
      ) return null;
      const samePendingGeneration = pending?.sessionId === next.sessionId &&
        pending.generation === next.generation;
      if (
        samePendingGeneration &&
        pending.catalogAuthority === 'authoritative' &&
        next.authority === 'provisional'
      ) return null;
      pendingCatalogs.set(tabId, {
        sessionId: next.sessionId,
        generation: next.generation,
        catalogAuthority: next.authority,
        englishAvailable,
        simplifiedChineseSeen: sawSimplifiedChinese ||
          (samePendingGeneration && pending.simplifiedChineseSeen),
        order: ++order,
      });
      prune();
      return null;
    },
    authorize(tabId, message) {
      const current = sessions.get(tabId);
      const request = message.payload;
      if (
        current === undefined ||
        current.sessionId !== request.sessionId ||
        current.episodeId !== request.episodeId ||
        current.generation !== request.episodeGeneration ||
        current.catalogAuthority !== 'authoritative' ||
        !current.englishAvailable ||
        current.simplifiedChineseSeen ||
        (current.latestAuthorizedProviderGeneration !== undefined &&
          request.providerGeneration < current.latestAuthorizedProviderGeneration)
      ) return { allowed: false, stateChanged: false };
      const stateChanged = current.latestAuthorizedProviderGeneration !==
        request.providerGeneration;
      current.latestAuthorizedProviderGeneration = request.providerGeneration;
      current.order = ++order;
      return { allowed: true, stateChanged };
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
      pendingCatalogs.delete(tabId);
      retiredSessions.delete(tabId);
    },
    snapshot() {
      return {
        version: 1,
        sessions: [...sessions.entries()].map(([tabId, session]) => ({
          tabId,
          sessionId: session.sessionId,
          episodeId: session.episodeId,
          generation: session.generation,
          catalogAuthority: session.catalogAuthority,
          englishAvailable: session.englishAvailable,
          simplifiedChineseSeen: session.simplifiedChineseSeen,
          latestAuthorizedProviderGeneration:
            session.latestAuthorizedProviderGeneration ?? null,
          order: session.order,
        })),
        retiredSessions: [...retiredSessions.entries()].map(
          ([tabId, sessionIds]) => ({ tabId, sessionIds: [...sessionIds] }),
        ),
        pendingCatalogs: [...pendingCatalogs.entries()].map(([tabId, pending]) => ({
          tabId,
          sessionId: pending.sessionId,
          generation: pending.generation,
          catalogAuthority: pending.catalogAuthority,
          englishAvailable: pending.englishAvailable,
          simplifiedChineseSeen: pending.simplifiedChineseSeen,
          order: pending.order,
        })),
      };
    },
    restore(candidate) {
      const restored = parseNetflixSessionRegistrySnapshot(candidate);
      if (restored === null) return false;
      sessions.clear();
      pendingCatalogs.clear();
      retiredSessions.clear();
      order = 0;
      for (const entry of restored.sessions) {
        sessions.set(entry.tabId, {
          sessionId: entry.sessionId,
          episodeId: entry.episodeId,
          generation: entry.generation,
          catalogAuthority: entry.catalogAuthority,
          englishAvailable: entry.englishAvailable,
          simplifiedChineseSeen: entry.simplifiedChineseSeen,
          latestAuthorizedProviderGeneration:
            entry.latestAuthorizedProviderGeneration ?? undefined,
          order: entry.order,
        });
        order = Math.max(order, entry.order);
      }
      for (const entry of restored.pendingCatalogs) {
        pendingCatalogs.set(entry.tabId, {
          sessionId: entry.sessionId,
          generation: entry.generation,
          catalogAuthority: entry.catalogAuthority,
          englishAvailable: entry.englishAvailable,
          simplifiedChineseSeen: entry.simplifiedChineseSeen,
          order: entry.order,
        });
        order = Math.max(order, entry.order);
      }
      for (const entry of restored.retiredSessions) {
        retiredSessions.set(entry.tabId, [...entry.sessionIds]);
      }
      return true;
    },
  };
}

export interface BackgroundMessageRouterOptions {
  readonly runtimeId: string;
  readonly extensionBaseUrl: string;
  readonly sessionRegistry: NetflixSessionRegistry;
  readonly loadSettings: () => Promise<SubTwinSettings>;
  readonly handleTranslation: (candidate: unknown, tabId: number) => Promise<unknown>;
  readonly handleSettingsAction: (candidate: unknown) => Promise<unknown>;
  readonly writeRuntimeStatus: (status: RuntimeStatus) => Promise<void>;
  readonly broadcastRuntimeSettings: (
    settings: RuntimeSettingsState,
    translationConfigurationChanged: boolean,
  ) => Promise<void>;
  readonly persistSessionRegistry?: () => Promise<void>;
}

export function createBackgroundMessageRouter(
  options: BackgroundMessageRouterOptions,
): (candidate: unknown, sender: SettingsMessageSender) => Promise<unknown> {
  let settingsCommitTail: Promise<void> = Promise.resolve();
  const serializeSettingsCommit = <Value>(
    work: () => Promise<Value>,
  ): Promise<Value> => {
    const current = settingsCommitTail.then(work, work);
    settingsCommitTail = current.then(() => undefined, () => undefined);
    return current;
  };
  const commitAndBroadcastSettings = async (
    message:
      | MessageFor<'settings/enabled-set'>
      | MessageFor<'settings/options-update'>
      | MessageFor<'settings/page-update'>,
  ): Promise<unknown> => {
    let beforeMutation: SubTwinSettings | undefined;
    try {
      beforeMutation = cloneSettings(await options.loadSettings());
    } catch {
      beforeMutation = undefined;
    }
    const response = await options.handleSettingsAction(message);
    if (isSuccessfulSettingsMutation(response)) {
      try {
        const afterMutation = await options.loadSettings();
        await options.broadcastRuntimeSettings(
          runtimeSettingsState(afterMutation),
          beforeMutation === undefined ||
            translationConfigurationChanged(beforeMutation, afterMutation),
        );
      } catch {
        // The response remains authoritative when the advisory push fails.
      }
    }
    return response;
  };
  const persistSessionRegistry = async (): Promise<void> => {
    try {
      await options.persistSessionRegistry?.();
    } catch {
      // Session storage is a liveness aid; current in-memory policy stays final.
    }
  };

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
      if (
        message.type === 'settings/enabled-set' ||
        message.type === 'settings/options-update'
      ) {
        return serializeSettingsCommit(() => commitAndBroadcastSettings(message));
      }
      return options.handleSettingsAction(message);
    }

    if (
      message.type === 'translation/request' ||
      message.type === 'translation/cancel' ||
      message.type === 'settings/page-update' ||
      message.type === 'runtime/settings-get' ||
      message.type === 'runtime/status-set' ||
      message.type === 'netflix/session-state' ||
      message.type === 'netflix/catalog-summary' ||
      message.type === 'netflix/probe-status'
    ) {
      const tabId = trustedNetflixContentTabId(sender, options.runtimeId);
      if (tabId === null) return undefined;

      if (message.type === 'settings/page-update') {
        return serializeSettingsCommit(() => commitAndBroadcastSettings(message));
      }

      if (message.type === 'translation/cancel') {
        return options.handleTranslation(message, tabId);
      }

      if (message.type === 'translation/request') {
        let settings: SubTwinSettings;
        try {
          settings = await options.loadSettings();
        } catch {
          return rejectedTranslation(message, 'invalid_configuration');
        }
        if (
          !settings.enabled ||
          settings.provider === 'unset' ||
          settings.provider !== message.payload.provider
        ) {
          return rejectedTranslation(message, 'invalid_configuration');
        }
        const authorization = options.sessionRegistry.authorize(tabId, message);
        if (!authorization.allowed) {
          return rejectedTranslation(message, 'stale_generation');
        }
        if (authorization.stateChanged) await persistSessionRegistry();
        return options.handleTranslation(message, tabId);
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
        if (options.sessionRegistry.record(tabId, message)) {
          await persistSessionRegistry();
        }
      } else if (message.type === 'netflix/catalog-summary') {
        const revocation = options.sessionRegistry.recordCatalog(tabId, message);
        await persistSessionRegistry();
        if (revocation !== null) {
          try {
            await options.handleTranslation(createMessage({
              id: `${message.id}:official-track`,
              source: 'content',
              type: 'translation/cancel',
              payload: {
                ...revocation,
                reason: 'official-track',
              },
            }), tabId);
          } catch {
            // The persisted policy latch still prevents any subsequent request.
          }
        }
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

function rejectedTranslation(
  request: MessageFor<'translation/request'>,
  errorCode: 'invalid_configuration' | 'stale_generation',
) {
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
      errorCode,
      retryable: false,
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
    parsed.value.type === 'settings/options-update-result' ||
    parsed.value.type === 'settings/page-update-result'
  ) && parsed.value.payload.status === 'success';
}

function parseNetflixSessionRegistrySnapshot(
  value: unknown,
): NetflixSessionRegistrySnapshot | null {
  if (!isRecord(value)) return null;
  const hasCurrentKeys = hasExactlyKeys(value, [
    'pendingCatalogs',
    'retiredSessions',
    'sessions',
    'version',
  ]);
  const hasLegacyKeys = hasExactlyKeys(value, [
    'retiredSessions',
    'sessions',
    'version',
  ]);
  const pendingCandidates = hasCurrentKeys ? value.pendingCatalogs : [];
  if (
    (!hasCurrentKeys && !hasLegacyKeys) ||
    value.version !== 1 ||
    !Array.isArray(value.sessions) ||
    !Array.isArray(value.retiredSessions) ||
    !Array.isArray(pendingCandidates) ||
    value.sessions.length > MAX_ACTIVE_NETFLIX_TABS ||
    value.retiredSessions.length > MAX_RETIRED_NETFLIX_TABS ||
    pendingCandidates.length > MAX_ACTIVE_NETFLIX_TABS
  ) return null;

  const sessions: NetflixSessionRegistrySnapshot['sessions'][number][] = [];
  const sessionTabs = new Set<number>();
  for (const candidate of value.sessions) {
    if (
      !isRecord(candidate) ||
      !hasExactlyKeys(candidate, [
        'catalogAuthority',
        'englishAvailable',
        'episodeId',
        'generation',
        'latestAuthorizedProviderGeneration',
        'order',
        'sessionId',
        'simplifiedChineseSeen',
        'tabId',
      ]) ||
      !isTabId(candidate.tabId) ||
      sessionTabs.has(candidate.tabId) ||
      !isRegistryId(candidate.sessionId) ||
      !isRegistryId(candidate.episodeId) ||
      !isPositiveSafeInteger(candidate.generation) ||
      !(
        candidate.catalogAuthority === 'authoritative' ||
        candidate.catalogAuthority === 'provisional' ||
        candidate.catalogAuthority === 'unknown'
      ) ||
      typeof candidate.englishAvailable !== 'boolean' ||
      typeof candidate.simplifiedChineseSeen !== 'boolean' ||
      !(
        candidate.latestAuthorizedProviderGeneration === null ||
        isPositiveSafeInteger(candidate.latestAuthorizedProviderGeneration)
      ) ||
      !isPositiveSafeInteger(candidate.order)
    ) return null;
    sessionTabs.add(candidate.tabId);
    sessions.push({
      tabId: candidate.tabId,
      sessionId: candidate.sessionId,
      episodeId: candidate.episodeId,
      generation: candidate.generation,
      catalogAuthority: candidate.catalogAuthority,
      englishAvailable: candidate.englishAvailable,
      simplifiedChineseSeen: candidate.simplifiedChineseSeen,
      latestAuthorizedProviderGeneration:
        candidate.latestAuthorizedProviderGeneration,
      order: candidate.order,
    });
  }

  const pendingCatalogs: NetflixSessionRegistrySnapshot['pendingCatalogs'][number][] = [];
  const pendingTabs = new Set<number>();
  for (const candidate of pendingCandidates) {
    if (
      !isRecord(candidate) ||
      !hasExactlyKeys(candidate, [
        'catalogAuthority',
        'englishAvailable',
        'generation',
        'order',
        'sessionId',
        'simplifiedChineseSeen',
        'tabId',
      ]) ||
      !isTabId(candidate.tabId) ||
      pendingTabs.has(candidate.tabId) ||
      !isRegistryId(candidate.sessionId) ||
      !isPositiveSafeInteger(candidate.generation) ||
      !(
        candidate.catalogAuthority === 'authoritative' ||
        candidate.catalogAuthority === 'provisional'
      ) ||
      typeof candidate.englishAvailable !== 'boolean' ||
      typeof candidate.simplifiedChineseSeen !== 'boolean' ||
      !isPositiveSafeInteger(candidate.order)
    ) return null;
    pendingTabs.add(candidate.tabId);
    pendingCatalogs.push({
      tabId: candidate.tabId,
      sessionId: candidate.sessionId,
      generation: candidate.generation,
      catalogAuthority: candidate.catalogAuthority,
      englishAvailable: candidate.englishAvailable,
      simplifiedChineseSeen: candidate.simplifiedChineseSeen,
      order: candidate.order,
    });
  }

  const retiredSessions: NetflixSessionRegistrySnapshot['retiredSessions'][number][] = [];
  const retiredTabs = new Set<number>();
  for (const candidate of value.retiredSessions) {
    if (
      !isRecord(candidate) ||
      !hasExactlyKeys(candidate, ['sessionIds', 'tabId']) ||
      !isTabId(candidate.tabId) ||
      retiredTabs.has(candidate.tabId) ||
      !Array.isArray(candidate.sessionIds) ||
      candidate.sessionIds.length > MAX_RETIRED_SESSIONS_PER_TAB ||
      !candidate.sessionIds.every(isRegistryId) ||
      new Set(candidate.sessionIds).size !== candidate.sessionIds.length
    ) return null;
    retiredTabs.add(candidate.tabId);
    retiredSessions.push({
      tabId: candidate.tabId,
      sessionIds: [...candidate.sessionIds],
    });
  }

  return { version: 1, sessions, retiredSessions, pendingCatalogs };
}

function hasExactlyKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length &&
    actual.every((key, index) => key === expected[index]);
}

function isRegistryId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function isTabId(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
