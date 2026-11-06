import {
  applyNetflixAdapterEvent,
  createNetflixAdapterState,
  isChineseOriginalLanguage,
  normalizeNetflixLanguageTag,
} from '../netflix/adapter';
import type {
  NetflixBridgePayload,
  NetflixCatalogPayload,
  NetflixCatalogTrackDescriptor,
  NetflixTimedTextPayload,
} from '../netflix/bridge';
import { parseNetflixTimedTextPayload } from '../netflix/ingest';
import {
  NETFLIX_ADAPTER_VERSION,
  type NetflixAdapterEvent,
  type NetflixAdapterState,
} from '../netflix/types';
import type { RuntimeSettingsState } from '../storage/schema';
import type { SubtitleCue, SubtitleTrack } from '../subtitles/types';
import { hashTranslationSource } from '../translation/cache';
import { routeLanguages, type LanguageRoute } from './language-router';
import {
  createSubtitleSessionController,
  type ProviderNeutralTaskClient,
  type SessionOverlaySink,
  type SessionStatusSink,
  type SubtitleSessionController,
  type SubtitleSessionTick,
  type SubtitleSessionTickSource,
} from './session-controller';

const MAX_BUFFERED_TIMED_TEXTS = 16;
const MAX_FAILED_TIMED_TEXT_BODIES_PER_RESOURCE = 3;
const NATIVE_MATCH_TOLERANCE_MS = 2_000;
// Netflix 原字幕不是英文（中文、其他语言或关闭）时，无法靠画面文字确认英文轨。
// 连续看到这么多句对不上英文的原字幕，或这么多句英文字幕时间内原字幕一直为空，
// 就直接选用首选英文轨，保证无论进入时选了什么字幕都默认显示中英双语。
const DEFAULT_ENGLISH_EVIDENCE = 2;
const CJK_TEXT = /[぀-ヿ㐀-鿿가-힯]/u;
const SILENT_NATIVE_SETTLE_MS = 600;

export type NetflixContentRestartReason = 'episode-change' | 'player-remount';

type OfficialChineseCategory = 'simplified-chinese' | 'traditional-chinese';
type SelectableTrackCategory = 'english' | OfficialChineseCategory;

export interface NetflixContentSessionState {
  readonly sessionId: string;
  readonly episodeId: string;
  readonly generation: number;
  readonly state: 'active' | 'disposed';
}

export interface NetflixContentCatalogSummary {
  readonly sessionId: string;
  readonly generation: number;
  readonly authority: NetflixCatalogPayload['authority'];
  readonly tracks: NetflixCatalogPayload['tracks'];
}

export interface NetflixContentDiagnostic {
  readonly code:
    | 'route_changed'
    | 'timed_text_accepted'
    | 'timed_text_descriptor_missing'
    | 'timed_text_ignored'
    | 'timed_text_parse_failed'
    | 'timed_text_received';
  readonly detail?: string;
}

export interface NetflixContentSessionOptions {
  readonly settings: RuntimeSettingsState;
  readonly tickSource: SubtitleSessionTickSource;
  readonly taskClient: ProviderNeutralTaskClient;
  readonly overlay: SessionOverlaySink;
  readonly status: SessionStatusSink;
  readonly nonceFactory?: () => string;
  readonly onSessionState?: (state: NetflixContentSessionState) => void;
  readonly onCatalogSummary?: (summary: NetflixContentCatalogSummary) => void;
  readonly onBridgeRestart?: (reason: NetflixContentRestartReason) => void;
  readonly onDiagnostic?: (diagnostic: NetflixContentDiagnostic) => void;
}

export interface NetflixContentSession {
  handlePayload(payload: NetflixBridgePayload): void;
  updateSettings(
    settings: RuntimeSettingsState,
    options?: { readonly translationConfigurationChanged?: boolean },
  ): void;
  playerRemounted(watchTitleId: string | null): void;
  dispose(): void;
}

export function bufferEarlyCatalogPayload(
  current: readonly NetflixBridgePayload[],
  payload: NetflixCatalogPayload,
  capacity: number,
): NetflixBridgePayload[] {
  const limit = Number.isSafeInteger(capacity) && capacity > 0
    ? capacity
    : 1;
  const catalogs = current.filter(
    (candidate): candidate is NetflixCatalogPayload => candidate.type === 'catalog',
  );
  const remaining = current.filter(({ type }) => type !== 'catalog');
  const previous = catalogs.find(({ titleId }) => titleId === payload.titleId);
  if (
    previous?.authority === 'authoritative' &&
    payload.authority === 'provisional'
  ) {
    return [...catalogs, ...remaining];
  }

  const candidates = [
    ...catalogs.filter(({ titleId }) => titleId !== payload.titleId),
    payload,
  ];
  const authoritativeIndexes = candidates
    .map((candidate, index) => candidate.authority === 'authoritative' ? index : -1)
    .filter((index) => index >= 0)
    .slice(-limit);
  const slots = Math.max(0, limit - authoritativeIndexes.length);
  const provisionalIndexes = slots === 0
    ? []
    : candidates
        .map((candidate, index) => candidate.authority === 'provisional' ? index : -1)
        .filter((index) => index >= 0)
        .slice(-slots);
  const selected = new Set([...authoritativeIndexes, ...provisionalIndexes]);
  return [
    ...candidates.filter((_candidate, index) => selected.has(index)),
    ...remaining,
  ];
}

export function bufferNetflixTimedTextPayload(
  current: readonly NetflixTimedTextPayload[],
  payload: NetflixTimedTextPayload,
): NetflixTimedTextPayload[] {
  return [
    ...current.filter((candidate) => !(
      candidate.titleId === payload.titleId &&
      candidate.resourceId === payload.resourceId
    )),
    payload,
  ].slice(-MAX_BUFFERED_TIMED_TEXTS);
}

interface AcceptedTimedTextResource {
  readonly fingerprint: string;
  readonly cueCount: number;
  readonly coverageMs: number;
}

/**
 * Owns the isolated-world state machine. Raw Netflix metadata and signed URLs
 * deliberately do not appear in this API.
 */
export function createNetflixContentSession(
  options: NetflixContentSessionOptions,
): NetflixContentSession {
  let settings = options.settings;
  let adapter: NetflixAdapterState | null = null;
  let titleId: string | null = null;
  let episodeId: string | null = null;
  let mountSequence = 0;
  let descriptors: readonly NetflixCatalogTrackDescriptor[] = [];
  let parsedTracks = new Map<string, SubtitleTrack>();
  let acceptedResources = new Map<string, AcceptedTimedTextResource>();
  let failedResourceFingerprints = new Map<string, Set<string>>();
  let nativeEvidenceByTrack = new Map<string, Set<string>>();
  let stronglyConfirmedTrackId: string | null = null;
  let lastRouteSignature: string | null = null;
  let foreignNativeTexts = new Set<string>();
  let silentNativeCueIds = new Set<string>();
  let pendingTimedText: NetflixTimedTextPayload[] = [];
  let pendingWatchTitleId: string | null = null;
  let controller: SubtitleSessionController | undefined;
  let liveCueSequence = 0;
  let lastLiveCueText: string | null = null;
  // 只由权威目录确认；之后同一部影片的目录没带原声语言时不推翻（视为未知）。
  let chineseOriginal = false;
  let disposed = false;

  const safeStatus = (status: Parameters<SessionStatusSink['publish']>[0]): void => {
    try {
      options.status.publish(status);
    } catch {
      // Status is advisory and must never affect playback.
    }
  };

  const route = (): LanguageRoute =>
    routeFor(settings, adapter, stronglyConfirmedTrackId, chineseOriginal);

  const applyEvent = (event: NetflixAdapterEvent): boolean => {
    if (adapter === null) return false;
    const next = applyNetflixAdapterEvent(adapter, event);
    if (!next.ok) return false;
    adapter = next.value;
    return true;
  };

  const eventBase = () => adapter === null ? null : ({
    adapterVersion: NETFLIX_ADAPTER_VERSION,
    sessionId: adapter.session.sessionId,
    generation: adapter.session.generation,
  } as const);

  // 官方中文行优先用简体中文；目录里没有简体中文时才用繁体中文。
  const officialChineseCategory = (): OfficialChineseCategory =>
    descriptors.some((descriptor) =>
      normalizeNetflixLanguageTag(descriptor.language)?.category === 'simplified-chinese')
      ? 'simplified-chinese'
      : 'traditional-chinese';

  const parsedTrackCandidates = (
    category: SelectableTrackCategory,
  ): SubtitleTrack[] => descriptors
    .filter((descriptor) =>
      normalizeNetflixLanguageTag(descriptor.language)?.category === category)
    .sort(compareTrackDescriptors)
    .flatMap((descriptor) => {
      const parsed = parsedTracks.get(descriptor.id);
      return parsed === undefined ? [] : [parsed];
    });

  const selectParsedTrack = (
    category: SelectableTrackCategory,
  ): SubtitleTrack | null => {
    const candidates = descriptors
      .filter((descriptor) =>
        normalizeNetflixLanguageTag(descriptor.language)?.category === category)
      .sort(compareTrackDescriptors);
    if (category === 'english') {
      if (stronglyConfirmedTrackId !== null) {
        const confirmed = parsedTracks.get(stronglyConfirmedTrackId);
        if (confirmed !== undefined && candidates.some(
          ({ id }) => id === stronglyConfirmedTrackId,
        )) return confirmed;
      }
      const activeIds = new Set(
        (adapter?.tracks ?? [])
          .filter(({ active, language, lifecycle }) =>
            active &&
            lifecycle !== 'disposed' &&
            language.category === 'english')
          .map(({ trackId }) => trackId),
      );
      const active = candidates.find(({ id }) => activeIds.has(id));
      if (active !== undefined) return parsedTracks.get(active.id) ?? null;
      if (candidates.length !== 1) return null;
    }
    const selected = candidates.find(({ id }) => parsedTracks.has(id));
    return selected === undefined ? null : (parsedTracks.get(selected.id) ?? null);
  };
  const safeDiagnostic = (diagnostic: NetflixContentDiagnostic): void => {
    try {
      options.onDiagnostic?.(diagnostic);
    } catch {
      // Diagnostics are advisory and must never affect playback.
    }
  };

  const currentTrackHash = (englishTrack: SubtitleTrack | null): string =>
    englishTrack === null
      ? 'track_pending'
      : hashTranslationSource([
          englishTrack.id,
          ...englishTrack.cues.flatMap((cue) => [
            cue.id,
            String(cue.startMs),
            String(cue.endMs),
            cue.text,
          ]),
        ].join('\u001f'));

  const controllerTickSource: SubtitleSessionTickSource = {
    currentTimeMs: () => options.tickSource.currentTimeMs(),
    subscribe(listener) {
      return options.tickSource.subscribe((tick) => {
        confirmActiveTrack(tick);
        captureLiveEnglishCue(tick);
        listener(tick);
      });
    },
  };

  const reconcile = (): void => {
    if (disposed || adapter === null || episodeId === null) return;
    const englishTrack = selectParsedTrack('english');
    const officialChineseTrack = selectParsedTrack(officialChineseCategory());
    const decision = route();
    const trackHash = currentTrackHash(englishTrack);
    const routeSignature = [
      decision.mode,
      decision.schedulingScope,
      englishTrack?.id ?? 'no-english',
      officialChineseTrack === null ? 'no-zh' : 'zh',
    ].join(' ');
    if (routeSignature !== lastRouteSignature) {
      lastRouteSignature = routeSignature;
      safeDiagnostic({ code: 'route_changed', detail: routeSignature });
    }
    if (controller === undefined) {
      controller = createSubtitleSessionController({
        sessionId: adapter.session.sessionId,
        episodeId,
        trackHash,
        episodeGeneration: adapter.session.generation,
        // Enablement is represented by the route so it can be changed atomically.
        enabled: true,
        englishTrack,
        ...(officialChineseTrack === null
          ? {}
          : { officialChineseTrack }),
        route: decision,
        appearance: settings.appearance,
        tickSource: controllerTickSource,
        taskClient: options.taskClient,
        overlay: options.overlay,
        status: options.status,
      });
      return;
    }
    // Route and track ownership must change atomically: either ordering alone
    // can briefly schedule the old track or apply the old scheduling scope.
    controller.updateRouteAndTracks(decision, {
      englishTrack,
      officialChineseTrack,
      trackHash,
    });
  };

  const reportSession = (state: 'active' | 'disposed'): void => {
    if (adapter === null || episodeId === null) return;
    safeCall(options.onSessionState, {
      sessionId: adapter.session.sessionId,
      episodeId,
      generation: adapter.session.generation,
      state,
    });
  };

  const beginTitle = (catalog: NetflixCatalogPayload): void => {
    const initialPending = adapter === null ? pendingTimedText : [];
    const previousEventBase = eventBase();
    if (previousEventBase !== null) reportSession('disposed');
    titleId = catalog.titleId;
    episodeId = episodeIdentity(catalog.titleId);
    const mountId = `mount_${++mountSequence}`;
    if (previousEventBase === null) {
      adapter = createNetflixAdapterState(
        { contentId: episodeId, mountId },
        options.nonceFactory === undefined
          ? {}
          : { nonceFactory: options.nonceFactory },
      );
    } else if (!applyEvent({
      ...previousEventBase,
      type: 'session-transition',
      nextContentId: episodeId,
      nextMountId: mountId,
      reason: 'episode-change',
    })) {
      return;
    }
    descriptors = [];
    parsedTracks = new Map();
    acceptedResources = new Map();
    failedResourceFingerprints = new Map();
    nativeEvidenceByTrack = new Map();
    stronglyConfirmedTrackId = null;
    foreignNativeTexts = new Set();
    silentNativeCueIds = new Set();
    liveCueSequence = 0;
    lastLiveCueText = null;
    chineseOriginal = false;
    pendingTimedText = initialPending;
    applyCatalog(catalog);
    drainPendingTimedText();
    if (adapter === null) return;

    const decision = route();
    if (controller === undefined) {
      reconcile();
    } else {
      controller.changeEpisode({
        sessionId: adapter.session.sessionId,
        episodeId,
        trackHash: 'track_pending',
        englishTrack: null,
        route: decision,
      });
      reconcile();
    }
    reportSession('active');
  };

  const applyCatalog = (catalog: NetflixCatalogPayload): void => {
    if (adapter === null) return;
    if (
      adapter.catalog.authority === 'authoritative' &&
      catalog.authority === 'provisional'
    ) {
      return;
    }
    if (
      catalog.authority === 'authoritative' &&
      catalog.originalLanguage !== undefined
    ) {
      chineseOriginal = isChineseOriginalLanguage(catalog.originalLanguage);
    }
    descriptors = catalog.authority === 'authoritative'
      ? [...catalog.tracks]
      : mergeDescriptors(descriptors, catalog.tracks);
    const allowedIds = new Set(descriptors.map(({ id }) => id));
    if (catalog.authority === 'authoritative') {
      parsedTracks = new Map(
        [...parsedTracks].filter(([trackId]) => allowedIds.has(trackId)),
      );
    }
    const base = eventBase();
    if (base === null) return;
    applyEvent({
      ...base,
      type: 'catalog-observed',
      authority: catalog.authority,
      tracks: descriptors.map(({ id, language }) => ({
        trackId: id,
        languageTag: language,
      })),
    });
  };

  const handleCatalog = (catalog: NetflixCatalogPayload): void => {
    if (
      pendingWatchTitleId !== null &&
      catalog.titleId !== pendingWatchTitleId
    ) return;
    const changedTitle = titleId !== null && titleId !== catalog.titleId;
    if (
      changedTitle &&
      adapter?.catalog.authority === 'authoritative' &&
      catalog.authority === 'provisional'
    ) {
      return;
    }
    if (titleId === null || changedTitle) {
      beginTitle(catalog);
    } else {
      applyCatalog(catalog);
      drainPendingTimedText();
      reconcile();
    }
    if (
      pendingWatchTitleId === catalog.titleId &&
      catalog.authority === 'authoritative'
    ) {
      pendingWatchTitleId = null;
    }
    if (adapter !== null) {
      safeCall(options.onCatalogSummary, {
        sessionId: adapter.session.sessionId,
        generation: adapter.session.generation,
        authority: adapter.catalog.authority,
        tracks: descriptors,
      });
    }
  };

  const resolveDescriptor = (
    payload: NetflixTimedTextPayload,
  ): NetflixCatalogTrackDescriptor | null => {
    const exact = descriptors.find(({ id }) => id === payload.trackId);
    if (exact !== undefined) return exact;
    const language = normalizeNetflixLanguageTag(payload.language);
    if (language === null || language.category === 'other') return null;
    const candidates = descriptors.filter((descriptor) =>
      normalizeNetflixLanguageTag(descriptor.language)?.category === language.category);
    return candidates.length === 1 ? candidates[0] ?? null : null;
  };

  const ingestTimedText = (payload: NetflixTimedTextPayload): boolean => {
    if (adapter === null || titleId === null) return false;
    if (payload.titleId !== titleId) {
      safeDiagnostic({ code: 'timed_text_ignored', detail: `other-title ${payload.language}` });
      return false;
    }
    const descriptor = resolveDescriptor(payload);
    if (descriptor === null) {
      safeDiagnostic({ code: 'timed_text_descriptor_missing' });
      return false;
    }
    const bodyFingerprint = hashTranslationSource(
      `${payload.format}\u001f${payload.body}`,
    );
    // 资源 ID 由 CDN 地址推导，不同语言的字幕可能落到同一个 ID 上；
    // "是否更完整"只在同一条字幕轨内比较，否则中文正文会把英文正文挤掉。
    const resourceKey = `${payload.resourceId}\u001f${descriptor.id}`;
    const failures = failedResourceFingerprints.get(resourceKey);
    const accepted = acceptedResources.get(resourceKey);
    if (accepted?.fingerprint === bodyFingerprint) {
      safeDiagnostic({ code: 'timed_text_ignored', detail: `duplicate ${descriptor.language}` });
      return false;
    }
    if (
      failures?.has(bodyFingerprint) === true ||
      (failures?.size ?? 0) >= MAX_FAILED_TIMED_TEXT_BODIES_PER_RESOURCE
    ) {
      safeDiagnostic({ code: 'timed_text_ignored', detail: `known-failure ${descriptor.language}` });
      return false;
    }
    const canonicalPayload: NetflixTimedTextPayload = {
      ...payload,
      trackId: descriptor.id,
      language: descriptor.language,
    };
    const parsed = parseNetflixTimedTextPayload(canonicalPayload, {
      titleId,
      resourceId: payload.resourceId,
      trackId: descriptor.id,
      languageTag: descriptor.language,
      kind: descriptor.kind,
    });
    if (!parsed.ok) {
      const category = normalizeNetflixLanguageTag(descriptor.language)?.category;
      if (
        (category === 'english' || category === officialChineseCategory()) &&
        parsedTrackCandidates(category).length === 0
      ) {
        safeDiagnostic({
          code: 'timed_text_parse_failed',
          detail: parsed.error.code,
        });
      }
      const nextFailures = failures ?? new Set<string>();
      nextFailures.add(bodyFingerprint);
      failedResourceFingerprints.set(resourceKey, nextFailures);
      return false;
    }
    const candidate = timedTextResourceQuality(parsed.value, bodyFingerprint);
    if (accepted !== undefined && !isBetterTimedTextResource(candidate, accepted)) {
      safeDiagnostic({
        code: 'timed_text_ignored',
        detail: `not-better ${descriptor.language} ${candidate.cueCount}<=${accepted.cueCount}`,
      });
      return false;
    }
    acceptedResources.set(resourceKey, candidate);
    failedResourceFingerprints.delete(resourceKey);
    parsedTracks.set(descriptor.id, parsed.value);
    safeDiagnostic({
      code: 'timed_text_accepted',
      detail:
        parsedTrackCandidates('english').length > 0 &&
          parsedTrackCandidates(officialChineseCategory()).length > 0
          ? 'dual'
          : 'partial',
    });
    const base = eventBase();
    if (base !== null) {
      applyEvent({
        ...base,
        type: 'track-observed',
        track: {
          trackId: descriptor.id,
          languageTag: descriptor.language,
        },
      });
    }
    reconcile();
    return true;
  };

  const handleTimedText = (payload: NetflixTimedTextPayload): void => {
    if (
      pendingWatchTitleId !== null &&
      payload.titleId !== pendingWatchTitleId
    ) return;
    safeDiagnostic({ code: 'timed_text_received' });
    if (ingestTimedText(payload)) return;
    if (adapter !== null && resolveDescriptor(payload) !== null) return;
    pendingTimedText = bufferNetflixTimedTextPayload(pendingTimedText, payload);
  };

  const drainPendingTimedText = (): void => {
    const pending = pendingTimedText;
    pendingTimedText = [];
    for (const payload of pending) handleTimedText(payload);
  };

  const hasActiveEnglishTrack = (): boolean =>
    adapter?.tracks.some(({ active, language, lifecycle }) =>
      active && lifecycle !== 'disposed' && language.category === 'english') === true;

  /** 原字幕无法证明英文轨时，选用首选英文轨（普通字幕优先于 CC）。 */
  function activateDefaultEnglishTrack(): void {
    const preferred = parsedTrackCandidates('english')[0];
    const base = eventBase();
    if (preferred === undefined || base === null) return;
    foreignNativeTexts = new Set();
    silentNativeCueIds = new Set();
    if (!applyEvent({
      ...base,
      type: 'track-activity-changed',
      trackId: preferred.id,
      active: true,
    })) return;
    // 双语都由 SubTwin 用这条轨渲染，画面与译文必然一致，可直接整集预翻译。
    stronglyConfirmedTrackId = preferred.id;
    reconcile();
  }

  function noteForeignNative(visibleText: string): void {
    if (hasActiveEnglishTrack() || parsedTrackCandidates('english').length === 0) return;
    silentNativeCueIds = new Set();
    foreignNativeTexts.add(visibleText);
    if (foreignNativeTexts.size >= DEFAULT_ENGLISH_EVIDENCE) activateDefaultEnglishTrack();
  }

  function noteSilentNative(tick: SubtitleSessionTick): void {
    if (hasActiveEnglishTrack()) return;
    const preferred = parsedTrackCandidates('english')[0];
    const currentTimeMs = tick.currentTimeMs ?? options.tickSource.currentTimeMs();
    if (preferred === undefined || currentTimeMs === undefined) return;
    const cue = preferred.cues.find((candidate) =>
      candidate.startMs + SILENT_NATIVE_SETTLE_MS <= currentTimeMs &&
      currentTimeMs < candidate.endMs);
    if (cue === undefined) return;
    silentNativeCueIds.add(cue.id);
    if (silentNativeCueIds.size >= DEFAULT_ENGLISH_EVIDENCE) activateDefaultEnglishTrack();
  }

  function confirmActiveTrack(tick: SubtitleSessionTick): void {
    if (adapter === null || chineseOriginal) return;
    const visibleText = normalizeVisibleText(tick.visibleText);
    if (visibleText === null) {
      noteSilentNative(tick);
      return;
    }
    silentNativeCueIds = new Set();

    const matches = parsedTrackCandidates('english').flatMap((track) => {
      const cue = findNativeCueMatch(track, visibleText, tick.currentTimeMs);
      return cue === null ? [] : [{ track, cue }];
    });
    if (matches.length === 0) {
      noteForeignNative(visibleText);
      return;
    }
    foreignNativeTexts = new Set();
    // If two tracks display the same line at the same time, that line does not
    // identify the user's selection. Waiting is safer than translating a track
    // that may not be the one Netflix is showing.
    if (matches.length !== 1) return;
    const match = matches[0];
    if (match === undefined) return;
    const englishTrack = match.track;
    const matchedCue = match.cue;
    const activeEnglish = adapter.tracks.find(
      ({ active, language, lifecycle }) =>
        active && lifecycle !== 'disposed' && language.category === 'english',
    );
    if (activeEnglish?.trackId !== englishTrack.id) {
      nativeEvidenceByTrack = new Map();
      stronglyConfirmedTrackId = null;
    }
    let becameStronglyConfirmed = false;
    if (isDistinctiveNativeCueEvidence(englishTrack, matchedCue, visibleText)) {
      const evidence = nativeEvidenceByTrack.get(englishTrack.id) ?? new Set<string>();
      evidence.add(matchedCue.id);
      nativeEvidenceByTrack.set(englishTrack.id, evidence);
      if (evidence.size >= 2 && stronglyConfirmedTrackId !== englishTrack.id) {
        stronglyConfirmedTrackId = englishTrack.id;
        becameStronglyConfirmed = true;
      }
    }
    const current = adapter.tracks.find(({ trackId }) => trackId === englishTrack.id);
    if (current?.active === true) {
      if (becameStronglyConfirmed) reconcile();
      return;
    }
    const base = eventBase();
    if (base === null) return;
    if (applyEvent({
      ...base,
      type: 'track-activity-changed',
      trackId: englishTrack.id,
      active: true,
    })) {
      reconcile();
    }
  }

  function captureLiveEnglishCue(tick: SubtitleSessionTick): void {
    if (
      controller === undefined ||
      adapter === null ||
      chineseOriginal ||
      adapter.catalog.authority !== 'authoritative' ||
      (settings.provider !== 'google-free' && settings.provider !== 'deepseek') ||
      parsedTrackCandidates('english').length > 0
    ) return;
    const visibleText = normalizeVisibleText(tick.visibleText);
    if (visibleText === null) {
      lastLiveCueText = null;
      return;
    }
    if (visibleText === lastLiveCueText) return;
    // 原字幕是中日韩文字时不是英文源，不能当作英文送去翻译。
    if (CJK_TEXT.test(visibleText)) return;

    const englishDescriptors = descriptors
      .filter((descriptor) =>
        normalizeNetflixLanguageTag(descriptor.language)?.category === 'english')
      .sort(compareTrackDescriptors);
    const activeEnglishIds = new Set(
      adapter.tracks
        .filter(({ active, language, lifecycle }) =>
          active && lifecycle !== 'disposed' && language.category === 'english')
        .map(({ trackId }) => trackId),
    );
    // Live fallback translates the text Netflix is visibly rendering, so the
    // exact catalog variant (for example English vs English CC) does not alter
    // the translation source. Prefer the active descriptor when known and use
    // the stable catalog ordering otherwise.
    const descriptor = englishDescriptors.find(({ id }) => activeEnglishIds.has(id)) ??
      englishDescriptors[0];
    if (descriptor === undefined) return;

    const current = adapter.tracks.find(({ trackId }) => trackId === descriptor.id);
    if (current?.active !== true) {
      const base = eventBase();
      if (base === null || !applyEvent({
        ...base,
        type: 'track-activity-changed',
        trackId: descriptor.id,
        active: true,
      })) return;
    }
    stronglyConfirmedTrackId = descriptor.id;
    controller.updateRoute(route());

    const currentTimeMs = tick.currentTimeMs ?? options.tickSource.currentTimeMs();
    if (
      currentTimeMs === undefined ||
      !Number.isFinite(currentTimeMs) ||
      currentTimeMs < 0
    ) return;
    lastLiveCueText = visibleText;
    liveCueSequence += 1;
    controller.appendEnglishCue(descriptor.id, {
      id: `native-live-${liveCueSequence}`,
      startMs: Math.max(0, currentTimeMs - 250),
      endMs: currentTimeMs + 6_000,
      text: visibleText,
    });
  }

  if (!settings.enabled || settings.provider === 'unset') {
    safeStatus({ mode: 'unset' });
  } else {
    safeStatus({ mode: 'discovering' });
  }

  return {
    handlePayload(payload) {
      if (disposed) return;
      if (payload.type === 'diagnostic') {
        // 只是某条辅助字幕（如官方中文）捕获超时；英文轨已经可用时不算故障。
        if (
          payload.code === 'display_unavailable' &&
          !chineseOriginal &&
          parsedTrackCandidates('english').length === 0
        ) {
          safeStatus({ mode: 'error', code: 'netflix_unavailable' });
        }
      } else if (payload.type === 'catalog') handleCatalog(payload);
      else if (payload.type === 'timed-text') handleTimedText(payload);
    },

    updateSettings(nextSettings, updateOptions = {}) {
      if (disposed) return;
      const previous = settings;
      settings = nextSettings;
      controller?.updateAppearance(nextSettings.appearance);
      const before = routeFor(previous, adapter, stronglyConfirmedTrackId, chineseOriginal);
      const after = route();
      controller?.updateRoute(after);
      if (
        updateOptions.translationConfigurationChanged === true &&
        sameRoute(before, after) &&
        after.externalCallsAllowed
      ) {
        controller?.refreshProviderConfiguration();
      }
      if (controller === undefined) {
        safeStatus(
          !nextSettings.enabled || nextSettings.provider === 'unset'
            ? { mode: 'unset' }
            : { mode: 'discovering' },
        );
      }
    },

    playerRemounted(watchTitleId) {
      // Netflix may replace the DOM video node without changing the title.
      // The tick source and native clock already rebind independently, so this
      // must not invalidate the page-lifetime bridge or discard parsed tracks.
      if (
        disposed ||
        watchTitleId === null ||
        titleId === null ||
        watchTitleId === titleId
      ) return;
      pendingWatchTitleId = watchTitleId;
      beginTitle({
        type: 'catalog',
        titleId: watchTitleId,
        authority: 'provisional',
        tracks: [],
      });
    },

    dispose() {
      if (disposed) return;
      reportSession('disposed');
      disposed = true;
      controller?.dispose();
      controller = undefined;
      parsedTracks.clear();
      acceptedResources.clear();
      failedResourceFingerprints.clear();
      nativeEvidenceByTrack.clear();
      stronglyConfirmedTrackId = null;
      foreignNativeTexts.clear();
      silentNativeCueIds.clear();
      pendingTimedText = [];
      pendingWatchTitleId = null;
      try {
        options.overlay.clear();
      } catch {
        // Native subtitle restoration is owned by the overlay boundary.
      }
    },
  };
}

function routeFor(
  settings: RuntimeSettingsState,
  adapter: NetflixAdapterState | null,
  stronglyConfirmedTrackId: string | null,
  chineseOriginal: boolean,
): LanguageRoute {
  const catalog = adapter?.catalog.tracks ?? [];
  const decision = routeLanguages({
    enabled: settings.enabled,
    catalogAuthority: adapter?.catalog.authority ?? 'provisional',
    englishAvailable: catalog.some(({ language }) => language.category === 'english'),
    // 繁体中文官方字幕同样可以作为原生双语的中文行（只在没有简体中文时选用）。
    simplifiedChineseAvailable: catalog.some(
      ({ language }) =>
        language.category === 'simplified-chinese' ||
        language.category === 'traditional-chinese',
    ),
    provider: settings.provider,
    deepseekKeyReady: settings.deepseekKeyReady,
    schedulingScope: effectiveSchedulingScope(adapter, stronglyConfirmedTrackId),
    chineseOriginal,
  });
  return decision.externalCallsAllowed && adapter?.externalTranslationAllowed !== true
    ? routeLanguages({
        enabled: settings.enabled,
        catalogAuthority: 'provisional',
        englishAvailable: false,
        simplifiedChineseAvailable: false,
        provider: settings.provider,
        deepseekKeyReady: settings.deepseekKeyReady,
        schedulingScope: 'none',
      })
    : decision;
}

function episodeIdentity(titleId: string): string {
  return `episode_${hashTranslationSource(titleId).slice(4)}`;
}

function mergeDescriptors(
  current: readonly NetflixCatalogTrackDescriptor[],
  observed: readonly NetflixCatalogTrackDescriptor[],
): readonly NetflixCatalogTrackDescriptor[] {
  const merged = new Map(current.map((track) => [track.id, track]));
  for (const track of observed) merged.set(track.id, track);
  return [...merged.values()];
}

function compareTrackDescriptors(
  left: NetflixCatalogTrackDescriptor,
  right: NetflixCatalogTrackDescriptor,
): number {
  if (left.kind !== right.kind) return left.kind === 'subtitle' ? -1 : 1;
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

function effectiveSchedulingScope(
  adapter: NetflixAdapterState | null,
  stronglyConfirmedTrackId: string | null,
): NetflixAdapterState['schedulingScope'] {
  if (adapter === null || adapter.schedulingScope !== 'bulk') {
    return adapter?.schedulingScope ?? 'none';
  }
  const activeEnglish = adapter.tracks.find(
    ({ active, language, lifecycle }) =>
      active && lifecycle !== 'disposed' && language.category === 'english',
  );
  return activeEnglish?.trackId === stronglyConfirmedTrackId
    ? 'bulk'
    : 'urgent-window';
}

function findNativeCueMatch(
  track: SubtitleTrack,
  visibleText: string,
  currentTimeMs: number | undefined,
): SubtitleCue | null {
  const visibleKey = compactText(visibleText);
  return track.cues.find((cue) => {
    if (compactText(cue.text) !== visibleKey) return false;
    if (currentTimeMs === undefined || !Number.isFinite(currentTimeMs)) return true;
    return cue.startMs - NATIVE_MATCH_TOLERANCE_MS <= currentTimeMs &&
      currentTimeMs < cue.endMs + NATIVE_MATCH_TOLERANCE_MS;
  }) ?? null;
}

function isDistinctiveNativeCueEvidence(
  track: SubtitleTrack,
  cue: SubtitleCue,
  visibleText: string,
): boolean {
  if ([...visibleText].length < 4) return false;
  const visibleKey = compactText(visibleText);
  return track.cues.filter(
    (candidate) => compactText(candidate.text) === visibleKey,
  ).length === 1 && cue.text.trim().length > 0;
}

/** 忽略空白差异比较原字幕：Netflix 换行与字幕文件的空格并不总一致。 */
function compactText(value: string): string {
  return value.replace(/\s+/gu, '');
}

function timedTextResourceQuality(
  track: SubtitleTrack,
  fingerprint: string,
): AcceptedTimedTextResource {
  if (track.cues.length === 0) {
    return { fingerprint, cueCount: 0, coverageMs: 0 };
  }
  let firstStart = Number.POSITIVE_INFINITY;
  let lastEnd = 0;
  for (const cue of track.cues) {
    firstStart = Math.min(firstStart, cue.startMs);
    lastEnd = Math.max(lastEnd, cue.endMs);
  }
  return {
    fingerprint,
    cueCount: track.cues.length,
    coverageMs: Math.max(0, lastEnd - firstStart),
  };
}

function isBetterTimedTextResource(
  candidate: AcceptedTimedTextResource,
  current: AcceptedTimedTextResource,
): boolean {
  return candidate.cueCount > current.cueCount ||
    (candidate.cueCount === current.cueCount &&
      candidate.coverageMs > current.coverageMs);
}

function normalizeVisibleText(value: string | undefined): string | null {
  const normalized = (value ?? '').replace(/\s+/gu, ' ').trim();
  return normalized.length === 0 ? null : normalized;
}

function sameRoute(left: LanguageRoute, right: LanguageRoute): boolean {
  return left.mode === right.mode &&
    left.externalCallsAllowed === right.externalCallsAllowed &&
    left.provider === right.provider &&
    left.schedulingScope === right.schedulingScope &&
    left.sourceMode === right.sourceMode;
}

function safeCall<Value>(
  callback: ((value: Value) => void) | undefined,
  value: Value,
): void {
  try {
    callback?.(value);
  } catch {
    // Integration callbacks are fail-safe by design.
  }
}
