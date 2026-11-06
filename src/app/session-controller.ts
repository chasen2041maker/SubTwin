import type { LanguageRoute } from './language-router';
import { createCueDisplayPolicy } from './cue-display-policy';
import {
  type RuntimeErrorCode,
  type RuntimeStatus,
} from './status';
import type {
  NormalizedActiveCueState,
  SubtitleOverlayAppearance,
} from '../renderer/SubtitleOverlay';
import type { MessagePayloadMap } from '../shared/messages';
import { alignOfficialTracks } from '../subtitles/align';
import type { SubtitleCue, SubtitleTrack } from '../subtitles/types';
import type {
  ScheduledTranslationTask,
  SchedulerGeneration,
} from '../translation/scheduler';
import type {
  TranslatedCue,
  TranslationBatch,
  TranslationCueInput,
  TranslationError,
  TranslationProviderId,
} from '../translation/types';

// 在线翻译往返常为数秒；只预取前后两句会让每句译文都比字幕晚到。
// 预取当前句之后的多句，使译文在字幕出现前就绪。
const URGENT_LOOKAHEAD = 6;
const URGENT_LOOKBEHIND = 1;
const CONTEXT_RADIUS = 3;
const DEEPSEEK_URGENT_BATCH_SIZE = 4;
const DEEPSEEK_BULK_BATCH_SIZE = 20;
const RATE_LIMIT_COOLDOWN_MS = 30_000;

export interface SubtitleSessionTick {
  readonly visibleText?: string;
  readonly currentTimeMs?: number;
  readonly seeking?: boolean;
}

export interface SubtitleSessionTickSource {
  currentTimeMs(): number | undefined;
  subscribe(listener: (tick: SubtitleSessionTick) => void): () => void;
}

export interface TranslationTaskCallbacks {
  /**
   * The task client must check this immediately before committing a cache
   * write as well as before delivering a cached or provider result.
   */
  isCurrent(): boolean;
  onCache(batch: TranslationBatch): void;
  onResult(batch: TranslationBatch): void;
  onError(error: TranslationError): void;
}

export type SessionCancellationReason =
  MessagePayloadMap['translation/cancel']['reason'];

export interface ProviderNeutralTaskClient {
  enqueue(
    task: ScheduledTranslationTask,
    callbacks: TranslationTaskCallbacks,
  ): void;
  cancel(
    generation: SchedulerGeneration,
    reason: SessionCancellationReason,
  ): void;
}

export interface SessionOverlaySink {
  render(
    state: NormalizedActiveCueState,
    appearance: SubtitleOverlayAppearance,
  ): boolean;
  clear(): void;
  waitForTranslation?(): void;
  subscribeRenderFailure?(listener: () => void): () => void;
}

export interface SessionStatusSink {
  publish(status: RuntimeStatus): void;
}

export interface SubtitleSessionControllerOptions {
  readonly sessionId: string;
  readonly episodeId: string;
  readonly trackHash: string;
  readonly episodeGeneration: number;
  readonly enabled: boolean;
  readonly englishTrack: SubtitleTrack | null;
  readonly officialChineseTrack?: SubtitleTrack;
  readonly route: LanguageRoute;
  readonly appearance: SubtitleOverlayAppearance;
  readonly tickSource: SubtitleSessionTickSource;
  readonly taskClient: ProviderNeutralTaskClient;
  readonly overlay: SessionOverlaySink;
  readonly status: SessionStatusSink;
}

export interface SessionTrackUpdate {
  readonly englishTrack: SubtitleTrack | null;
  readonly officialChineseTrack: SubtitleTrack | null;
  readonly trackHash?: string;
}

export interface SessionEpisodeChange {
  readonly sessionId: string;
  readonly episodeId: string;
  readonly trackHash: string;
  readonly englishTrack: SubtitleTrack | null;
  readonly officialChineseTrack?: SubtitleTrack;
  readonly route: LanguageRoute;
}

export interface SubtitleSessionController {
  tick(tick: SubtitleSessionTick): void;
  seek(currentTimeMs: number): void;
  appendEnglishCue(trackId: string, cue: SubtitleCue): void;
  updateRoute(route: LanguageRoute): void;
  updateTracks(update: SessionTrackUpdate): void;
  updateRouteAndTracks(route: LanguageRoute, update: SessionTrackUpdate): void;
  updateAppearance(appearance: SubtitleOverlayAppearance): void;
  refreshProviderConfiguration(): void;
  setEnabled(enabled: boolean): void;
  playerRemounted(sessionId: string, trackHash?: string): void;
  changeEpisode(change: SessionEpisodeChange): void;
  dispose(): void;
}

/**
 * Owns one content-script subtitle session. Netflix discovery, selectors,
 * credentials, provider implementations, and persistence stay behind the
 * injected route/task/tick boundaries.
 */
export function createSubtitleSessionController(
  options: SubtitleSessionControllerOptions,
): SubtitleSessionController {
  let sessionId = options.sessionId;
  let episodeId = options.episodeId;
  let trackHash = options.trackHash;
  let episodeGeneration = normalizeGeneration(options.episodeGeneration);
  let providerGeneration = 1;
  let enabled = options.enabled;
  let englishTrack = options.englishTrack;
  let officialChineseTrack = options.officialChineseTrack ?? null;
  let route = options.route;
  let appearance = options.appearance;
  let disposed = false;
  let generationInvalidating = false;
  let unsubscribe: (() => void) | undefined;
  let unsubscribeRenderFailure: (() => void) | undefined;
  let activeCueIndex: number | null = null;
  let lastTimeMs: number | undefined;
  let lastRenderSignature: string | null = null;
  let nativeGap = false;
  let appearanceRevision = 0;
  let taskSequence = 0;
  let sortedEnglishCues: readonly SubtitleCue[] = sortCues(englishTrack?.cues ?? []);
  let officialTranslations = createOfficialTranslations(
    englishTrack,
    officialChineseTrack,
  );
  let providerTranslations = new Map<string, string>();
  let promotedCueIds = new Set<string>();
  let blockedProvider: TranslationProviderId | null = null;
  const providerCooldownUntil = new Map<TranslationProviderId, number>();

  const currentGeneration = (): SchedulerGeneration => ({
    episodeGeneration,
    providerGeneration,
  });

  const safeClearOverlay = (): void => {
    lastRenderSignature = null;
    try {
      options.overlay.clear();
    } catch {
      // A failing custom overlay must never interfere with Netflix playback.
    }
  };
  const cueDisplay = createCueDisplayPolicy({
    onWait: () => { lastRenderSignature = null; options.overlay.waitForTranslation?.(); },
    onFallback: safeClearOverlay,
  });

  const publish = (status: RuntimeStatus): void => {
    try {
      options.status.publish(status);
    } catch {
      // Runtime status is informational and must not control playback.
    }
  };

  const isSessionEnabled = (): boolean => enabled && route.mode !== 'disabled';

  const effectiveOfficial = (): boolean =>
    isSessionEnabled() &&
    route.sourceMode === 'official-alignment' &&
    englishTrack !== null &&
    officialChineseTrack !== null;

  const effectiveProvider = (): TranslationProviderId | null => {
    if (
      disposed ||
      !isSessionEnabled() ||
      englishTrack === null ||
      (blockedProvider !== null && route.provider === blockedProvider) ||
      !route.externalCallsAllowed ||
      route.sourceMode !== 'external-translation' ||
      route.schedulingScope === 'none' ||
      (route.mode !== 'deepseek' && route.mode !== 'google-free') ||
      route.provider !== route.mode
    ) {
      return null;
    }
    return route.provider;
  };

  const schedulableProvider = (): TranslationProviderId | null => {
    const provider = effectiveProvider();
    if (provider === null) return null;
    const cooldownUntil = providerCooldownUntil.get(provider) ?? 0;
    if (Date.now() < cooldownUntil) return null;
    if (cooldownUntil > 0) providerCooldownUntil.delete(provider);
    return provider;
  };

  const publishRouteStatus = (): void => {
    if (effectiveOfficial()) {
      publish({ mode: 'official' });
      return;
    }
    if (!isSessionEnabled() || route.mode === 'provider-unset') {
      publish({ mode: 'unset' });
      return;
    }
    switch (route.mode) {
      case 'deepseek':
        publish({ mode: 'deepseek' });
        return;
      case 'discovering':
        publish({ mode: 'discovering' });
        return;
      case 'google-free':
        publish({ mode: 'google-free' });
        return;
      case 'missing-English':
        publish({ mode: 'error', code: 'missing_english' });
        return;
      case 'missing-key':
        publish({ mode: 'error', code: 'invalid_configuration' });
        return;
      case 'official':
        // Catalog authority is enough to close the external-provider gate.
        // Until both bodies arrive, rendering stays native but the mode is
        // still correctly reported as official.
        publish({ mode: 'official' });
        return;
    }
  };

  const currentCue = (): SubtitleCue | null =>
    activeCueIndex === null ? null : (sortedEnglishCues[activeCueIndex] ?? null);

  const chineseForCue = (cue: SubtitleCue): string | null => {
    if (effectiveOfficial()) return officialTranslations.get(cue.id) ?? null;
    if (effectiveProvider() !== null) return providerTranslations.get(cue.id) ?? null;
    return null;
  };

  const renderActiveCue = (force = false): void => {
    if (disposed || !isSessionEnabled()) return;
    const cue = currentCue();
    if (cue === null) {
      if (cueDisplay.reset() || lastRenderSignature !== null) safeClearOverlay();
      return;
    }

    const state: NormalizedActiveCueState = {
      english: normalizeDisplayText(cue.text),
      chinese: chineseForCue(cue),
    };
    if (options.overlay.waitForTranslation !== undefined && appearance.chinese.visible &&
      route.provider !== null && route.provider === blockedProvider) return;
    const online = effectiveProvider() !== null;
    const boundedWait = online && appearance.chinese.visible &&
      options.overlay.waitForTranslation !== undefined;
    if (boundedWait) {
      if (!cueDisplay.shouldRender(cue.id, state.chinese !== null)) return;
    } else {
      cueDisplay.reset();
    }
    if (
      (effectiveOfficial() && state.chinese === null) ||
      (online && appearance.chinese.visible && state.chinese === null) ||
      (route.sourceMode === 'official-alignment' && !effectiveOfficial())
    ) {
      if (force || lastRenderSignature !== null) safeClearOverlay();
      return;
    }
    const signature = [
      providerGeneration,
      cue.id,
      state.english ?? '',
      state.chinese ?? '',
      appearanceRevision,
    ].join('\u001f');
    if (!force && signature === lastRenderSignature) return;
    lastRenderSignature = signature;
    try {
      if (!options.overlay.render(state, appearance)) {
        cueDisplay.fail(cue.id);
        lastRenderSignature = null;
      }
    } catch {
      cueDisplay.fail(cue.id);
      safeClearOverlay();
    }
  };

  const isTaskCurrent = (task: ScheduledTranslationTask): boolean =>
    !disposed &&
    !generationInvalidating &&
    task.sessionId === sessionId &&
    task.episodeId === episodeId &&
    task.trackHash === trackHash &&
    task.episodeGeneration === episodeGeneration &&
    task.providerGeneration === providerGeneration &&
    task.provider === effectiveProvider();

  const acceptBatch = (
    task: ScheduledTranslationTask,
    batch: TranslationBatch,
  ): void => {
    if (!isTaskCurrent(task)) return;
    const requestedIds = new Set(task.cues.map(({ id }) => id));
    let activeChanged = false;
    for (const translation of batch.translations) {
      if (!isAcceptableTranslation(translation, requestedIds)) continue;
      const text = translation.text.trim();
      if (providerTranslations.get(translation.cueId) === text) continue;
      providerTranslations.set(translation.cueId, text);
      if (currentCue()?.id === translation.cueId) activeChanged = true;
    }
    if (activeChanged) {
      publishRouteStatus();
      renderActiveCue();
    }
  };

  const handleTaskError = (
    task: ScheduledTranslationTask,
    error: TranslationError,
  ): void => {
    if (!isTaskCurrent(task) || error.code === 'aborted' || error.code === 'stale_generation') {
      return;
    }
    const active = currentCue();
    if (active !== null && !providerTranslations.has(active.id) &&
      task.cues.some(({ id }) => id === active.id)) cueDisplay.fail(active.id);
    publish({ mode: 'error', code: runtimeErrorForTranslation(error) });
    if (isTerminalProviderError(error)) {
      invalidate('provider-change', false);
      blockedProvider = task.provider;
      return;
    }
    for (const cue of task.cues) promotedCueIds.delete(cue.id);
    if (error.code === 'rate_limited') {
      providerCooldownUntil.set(task.provider, Math.max(
        providerCooldownUntil.get(task.provider) ?? 0,
        Date.now() + RATE_LIMIT_COOLDOWN_MS,
      ));
    }
  };

  const enqueueTask = (task: ScheduledTranslationTask): boolean => {
    const callbacks: TranslationTaskCallbacks = {
      isCurrent: () => isTaskCurrent(task),
      onCache: (batch) => acceptBatch(task, batch),
      onResult: (batch) => acceptBatch(task, batch),
      onError: (error) => handleTaskError(task, error),
    };
    try {
      options.taskClient.enqueue(task, callbacks);
      return true;
    } catch {
      const active = currentCue();
      if (active !== null) cueDisplay.fail(active.id);
      publish({ mode: 'error', code: 'provider_unavailable' });
      renderActiveCue();
      return false;
    }
  };

  const createTasks = (
    provider: TranslationProviderId,
    cues: readonly SubtitleCue[],
    priority: ScheduledTranslationTask['priority'],
  ): readonly ScheduledTranslationTask[] => {
    if (cues.length === 0) return [];
    const batches = provider === 'google-free'
      ? cues.map((cue) => [cue])
      : priority === 'urgent'
        ? chunk(cues, DEEPSEEK_URGENT_BATCH_SIZE)
        : chunk(cues, DEEPSEEK_BULK_BATCH_SIZE);
    return batches.map((batch) => {
      const inputs = batch.map(toTranslationCue);
      const sequence = ++taskSequence;
      return {
        taskId: `session-task-${providerGeneration}-${sequence}`,
        sessionId,
        episodeId,
        trackHash,
        provider,
        sourceLanguage: 'en',
        targetLanguage: 'zh-Hans',
        episodeGeneration,
        providerGeneration,
        cues: inputs,
        context: provider === 'google-free'
          ? []
          : contextFor(batch, sortedEnglishCues).map(toTranslationCue),
        priority,
      };
    });
  };

  const enqueueCues = (
    provider: TranslationProviderId,
    cues: readonly SubtitleCue[],
    priority: ScheduledTranslationTask['priority'],
  ): boolean => {
    for (const task of createTasks(provider, cues, priority)) {
      if (!isTaskCurrent(task) || schedulableProvider() !== provider) return false;
      if (!enqueueTask(task)) return false;
    }
    return true;
  };

  const urgentCuesAt = (index: number): readonly SubtitleCue[] => {
    // 当前句与即将出现的句子排在最前，保证第一批请求最先返回当前句。
    const indexes = [index];
    for (let distance = 1; distance <= URGENT_LOOKAHEAD; distance += 1) {
      indexes.push(index + distance);
    }
    for (let distance = 1; distance <= URGENT_LOOKBEHIND; distance += 1) {
      indexes.push(index - distance);
    }
    return indexes
      .map((candidate) => sortedEnglishCues[candidate])
      .filter((cue): cue is SubtitleCue => cue !== undefined);
  };

  const promoteNeighborhood = (index: number): void => {
    const provider = schedulableProvider();
    if (provider === null) return;
    const urgent = urgentCuesAt(index).filter(
      ({ id }) => !promotedCueIds.has(id),
    );
    if (urgent.length === 0) return;
    for (const cue of urgent) promotedCueIds.add(cue.id);
    enqueueCues(provider, urgent, 'urgent');
  };

  const scheduleInitialWork = (): void => {
    const provider = schedulableProvider();
    if (provider === null || sortedEnglishCues.length === 0) return;
    const initialIndex = activeCueIndex ?? upcomingCueIndex(sortedEnglishCues, lastTimeMs);
    const urgent = urgentCuesAt(initialIndex);
    for (const cue of urgent) promotedCueIds.add(cue.id);
    if (!enqueueCues(provider, urgent, 'urgent')) return;
    if (route.schedulingScope !== 'bulk') return;

    // 从当前播放位置向后批量翻译，再回头补前面的句子；
    // 中途续播时不必先翻译已经看过的整段开头。
    const urgentIds = new Set(urgent.map(({ id }) => id));
    const bulk = [
      ...sortedEnglishCues.slice(initialIndex),
      ...sortedEnglishCues.slice(0, initialIndex),
    ].filter(({ id }) => !urgentIds.has(id));
    enqueueCues(provider, bulk, 'bulk');
  };

  const locateCue = (tick: SubtitleSessionTick): number | null => {
    const clockTime = validTime(tick.currentTimeMs)
      ? tick.currentTimeMs
      : readCurrentTime(options.tickSource);
    if (clockTime !== undefined) lastTimeMs = clockTime;
    const visible = normalizeDisplayText(tick.visibleText ?? '');
    if (tick.visibleText !== undefined) nativeGap = visible === null;
    if (nativeGap) return null;
    if (visible !== null) {
      const nativeIndex = findCueByVisibleText(
        sortedEnglishCues,
        visible,
        clockTime,
        activeCueIndex,
      );
      if (nativeIndex !== null) return nativeIndex;
    }
    return clockTime === undefined
      ? null
      : findCueAtTime(sortedEnglishCues, clockTime);
  };

  const handleTick = (tick: SubtitleSessionTick, promote: boolean): void => {
    if (disposed) return;
    let displayRevoked = false;
    if (tick.seeking) {
      displayRevoked = cueDisplay.reset();
      nativeGap = false;
      activeCueIndex = null;
    }
    const nextIndex = locateCue(tick);
    if (tick.seeking && nextIndex === null &&
      (displayRevoked || lastRenderSignature !== null)) safeClearOverlay();
    if (nextIndex === activeCueIndex) return;
    activeCueIndex = nextIndex;
    renderActiveCue();
    if (promote && nextIndex !== null) promoteNeighborhood(nextIndex);
  };

  const restartCurrentState = (): void => {
    sortedEnglishCues = sortCues(englishTrack?.cues ?? []);
    officialTranslations = createOfficialTranslations(
      englishTrack,
      officialChineseTrack,
    );
    activeCueIndex = lastTimeMs === undefined || nativeGap
      ? null
      : findCueAtTime(sortedEnglishCues, lastTimeMs);
    publishRouteStatus();
    renderActiveCue(true);
    scheduleInitialWork();
  };

  // Netflix 常从不同资源地址重复下发同一份字幕；内容哈希相同就不是新轨道，
  // 不能因此取消在途翻译、清空已到的译文并让字幕闪一下。
  const tracksDiffer = (update: SessionTrackUpdate): boolean => {
    const sameEnglish = englishTrack === update.englishTrack || (
      englishTrack !== null &&
      update.englishTrack !== null &&
      englishTrack.id === update.englishTrack.id &&
      update.trackHash !== undefined &&
      update.trackHash === trackHash
    );
    return !(
      sameEnglish &&
      officialChineseTrack === update.officialChineseTrack &&
      (update.trackHash === undefined || update.trackHash === trackHash)
    );
  };

  const invalidate = (
    reason: SessionCancellationReason,
    episodeChanged: boolean,
    clearBlockedProvider = false,
  ): void => {
    const staleGeneration = currentGeneration();
    cueDisplay.reset();
    generationInvalidating = true;
    try {
      options.taskClient.cancel(staleGeneration, reason);
    } catch {
      // Cancellation is best-effort; callback generation guards remain final.
    } finally {
      providerGeneration += 1;
      if (episodeChanged) episodeGeneration += 1;
      generationInvalidating = false;
    }
    providerTranslations = new Map();
    promotedCueIds = new Set();
    if (clearBlockedProvider) {
      blockedProvider = null;
      providerCooldownUntil.clear();
    }
    activeCueIndex = null;
    safeClearOverlay();
  };

  try {
    unsubscribeRenderFailure = options.overlay.subscribeRenderFailure?.(() => {
      if (disposed) return;
      const cue = currentCue();
      if (cue !== null) cueDisplay.fail(cue.id);
    });
  } catch {
    // 订阅失败时仍由字幕层自己的错误边界恢复原生字幕，不影响 Netflix 播放。
    unsubscribeRenderFailure = undefined;
  }
  lastTimeMs = readCurrentTime(options.tickSource);
  restartCurrentState();
  try {
    unsubscribe = options.tickSource.subscribe((tick) => {
      handleTick(tick, true);
    });
  } catch {
    unsubscribe = undefined;
  }

  return {
    tick(tick) {
      handleTick(tick, true);
    },

    seek(currentTimeMs) {
      if (disposed || !validTime(currentTimeMs)) return;
      const displayRevoked = cueDisplay.reset();
      nativeGap = false;
      lastTimeMs = currentTimeMs;
      const nextIndex = findCueAtTime(sortedEnglishCues, currentTimeMs);
      if (nextIndex === null && (displayRevoked || lastRenderSignature !== null)) safeClearOverlay();
      activeCueIndex = nextIndex;
      renderActiveCue();
      if (nextIndex !== null) promoteNeighborhood(nextIndex);
    },

    appendEnglishCue(trackId, cue) {
      if (disposed || trackId.length === 0) return;
      const existingCues = englishTrack?.id === trackId
        ? englishTrack.cues
        : [];
      if (existingCues.some(({ id }) => id === cue.id)) return;
      englishTrack = {
        id: trackId,
        format: 'webvtt',
        language: { tag: 'en', kind: 'subtitles' },
        cues: [...existingCues, cue],
      };
      sortedEnglishCues = sortCues(englishTrack.cues);
      officialTranslations = createOfficialTranslations(
        englishTrack,
        officialChineseTrack,
      );
      publishRouteStatus();
    },

    updateRoute(nextRoute) {
      if (disposed || sameRoute(route, nextRoute)) return;
      invalidate(
        cancellationReasonForRoute(nextRoute),
        false,
        routeChangeClearsProviderBlock(route, nextRoute, blockedProvider),
      );
      route = nextRoute;
      restartCurrentState();
    },

    updateTracks(update) {
      if (disposed || !tracksDiffer(update)) return;
      invalidate(
        update.officialChineseTrack === null
          ? 'provider-change'
          : 'official-track',
        false,
      );
      englishTrack = update.englishTrack;
      officialChineseTrack = update.officialChineseTrack;
      if (update.trackHash !== undefined) trackHash = update.trackHash;
      restartCurrentState();
    },

    updateRouteAndTracks(nextRoute, update) {
      const routeChanged = !sameRoute(route, nextRoute);
      const tracksChanged = tracksDiffer(update);
      if (disposed || (!routeChanged && !tracksChanged)) return;
      invalidate(
        routeChanged
          ? cancellationReasonForRoute(nextRoute)
          : update.officialChineseTrack === null
            ? 'provider-change'
            : 'official-track',
        false,
        routeChanged && routeChangeClearsProviderBlock(route, nextRoute, blockedProvider),
      );
      route = nextRoute;
      englishTrack = update.englishTrack;
      officialChineseTrack = update.officialChineseTrack;
      if (update.trackHash !== undefined) trackHash = update.trackHash;
      restartCurrentState();
    },

    updateAppearance(nextAppearance) {
      if (disposed || appearance === nextAppearance) return;
      if (appearance.chinese.visible !== nextAppearance.chinese.visible) cueDisplay.reset();
      appearance = nextAppearance;
      appearanceRevision += 1;
      renderActiveCue(true);
    },

    refreshProviderConfiguration() {
      if (disposed) return;
      invalidate('provider-change', false, true);
      restartCurrentState();
    },

    setEnabled(nextEnabled) {
      if (disposed || enabled === nextEnabled) return;
      invalidate(nextEnabled ? 'provider-change' : 'disabled', false, true);
      enabled = nextEnabled;
      restartCurrentState();
    },

    playerRemounted(nextSessionId, nextTrackHash) {
      if (disposed) return;
      invalidate('player-disposed', true, true);
      sessionId = nextSessionId;
      if (nextTrackHash !== undefined) trackHash = nextTrackHash;
      restartCurrentState();
    },

    changeEpisode(change) {
      if (disposed) return;
      invalidate('episode-change', true, true);
      sessionId = change.sessionId;
      episodeId = change.episodeId;
      trackHash = change.trackHash;
      englishTrack = change.englishTrack;
      officialChineseTrack = change.officialChineseTrack ?? null;
      route = change.route;
      nativeGap = false;
      lastTimeMs = readCurrentTime(options.tickSource);
      restartCurrentState();
    },

    dispose() {
      if (disposed) return;
      try {
        unsubscribeRenderFailure?.();
      } catch {
        // 即使解除订阅失败，disposed 守卫仍会阻止遗留回调操作字幕层。
      }
      unsubscribeRenderFailure = undefined;
      invalidate('player-disposed', true);
      disposed = true;
      try {
        unsubscribe?.();
      } catch {
        // Listener cleanup must not prevent the rest of disposal.
      }
      unsubscribe = undefined;
    },
  };
}

function createOfficialTranslations(
  englishTrack: SubtitleTrack | null,
  officialChineseTrack: SubtitleTrack | null,
): ReadonlyMap<string, string> {
  if (englishTrack === null || officialChineseTrack === null) return new Map();
  return new Map(
    alignOfficialTracks(englishTrack, officialChineseTrack)
      .filter(({ targetText }) => targetText !== null)
      .map(({ source, targetText }) => [source.id, targetText ?? '']),
  );
}

function sortCues(cues: readonly SubtitleCue[]): readonly SubtitleCue[] {
  return [...cues].sort((left, right) =>
    left.startMs - right.startMs ||
    left.endMs - right.endMs ||
    compareText(left.id, right.id));
}

function findCueByVisibleText(
  cues: readonly SubtitleCue[],
  visibleText: string,
  currentTimeMs: number | undefined,
  activeIndex: number | null,
): number | null {
  const visibleKey = compactText(visibleText);
  const activeCue = activeIndex === null ? undefined : cues[activeIndex];
  if (
    activeIndex !== null &&
    activeCue !== undefined &&
    compactText(activeCue.text) === visibleKey &&
    (currentTimeMs === undefined ||
      (activeCue.startMs <= currentTimeMs && currentTimeMs < activeCue.endMs))
  ) return activeIndex;

  const matches: number[] = [];
  for (let index = 0; index < cues.length; index += 1) {
    if (compactText(cues[index]?.text ?? '') === visibleKey) {
      matches.push(index);
    }
  }
  if (matches.length === 0) return null;
  if (currentTimeMs === undefined) return matches[0] ?? null;
  const active = matches.find((index) => {
    const cue = cues[index];
    return cue !== undefined && cue.startMs <= currentTimeMs && currentTimeMs < cue.endMs;
  });
  if (active !== undefined) return active;
  return matches.reduce((best, candidate) => {
    const bestCue = cues[best];
    const candidateCue = cues[candidate];
    if (bestCue === undefined || candidateCue === undefined) return best;
    return Math.abs(candidateCue.startMs - currentTimeMs) <
      Math.abs(bestCue.startMs - currentTimeMs)
      ? candidate
      : best;
  });
}

/** Binary-searches the last cue starting at/before the playback time. */
function findCueAtTime(
  cues: readonly SubtitleCue[],
  currentTimeMs: number,
): number | null {
  let low = 0;
  let high = cues.length - 1;
  let candidate = -1;
  while (low <= high) {
    const middle = low + Math.floor((high - low) / 2);
    const cue = cues[middle];
    if (cue !== undefined && cue.startMs <= currentTimeMs) {
      candidate = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  for (let index = candidate; index >= 0; index -= 1) {
    const cue = cues[index];
    if (cue !== undefined && currentTimeMs < cue.endMs) return index;
  }
  return null;
}

/** 播放停在两句之间时，返回下一句；没有可用时间时从头开始。 */
function upcomingCueIndex(
  cues: readonly SubtitleCue[],
  currentTimeMs: number | undefined,
): number {
  if (currentTimeMs === undefined) return 0;
  const index = cues.findIndex((cue) => cue.endMs > currentTimeMs);
  return index < 0 ? 0 : index;
}

function contextFor(
  taskCues: readonly SubtitleCue[],
  allCues: readonly SubtitleCue[],
): readonly SubtitleCue[] {
  const taskIds = new Set(taskCues.map(({ id }) => id));
  const indexes = taskCues
    .map((cue) => allCues.findIndex(({ id }) => id === cue.id))
    .filter((index) => index >= 0);
  if (indexes.length === 0) return [];
  const first = Math.max(0, Math.min(...indexes) - CONTEXT_RADIUS);
  const last = Math.min(allCues.length, Math.max(...indexes) + CONTEXT_RADIUS + 1);
  return allCues.slice(first, last).filter(({ id }) => !taskIds.has(id));
}

function toTranslationCue(cue: SubtitleCue): TranslationCueInput {
  return {
    id: cue.id,
    startMs: cue.startMs,
    endMs: cue.endMs,
    text: cue.text,
  };
}

function chunk<T>(values: readonly T[], size: number): readonly (readonly T[])[] {
  const batches: T[][] = [];
  for (let offset = 0; offset < values.length; offset += size) {
    batches.push(values.slice(offset, offset + size));
  }
  return batches;
}

function isTerminalProviderError(error: TranslationError): boolean {
  switch (error.code) {
    case 'authentication_failed':
    case 'insufficient_balance':
    case 'invalid_configuration':
    case 'provider_forbidden':
    case 'provider_unset':
      return true;
    case 'aborted':
    case 'invalid_request':
    case 'invalid_response':
    case 'provider_unavailable':
    case 'rate_limited':
    case 'stale_generation':
    case 'timeout':
      return false;
  }
}

function runtimeErrorForTranslation(error: TranslationError): RuntimeErrorCode {
  switch (error.code) {
    case 'authentication_failed':
    case 'insufficient_balance':
    case 'invalid_configuration':
    case 'provider_forbidden':
    case 'provider_unavailable':
    case 'rate_limited':
    case 'timeout':
      return error.code;
    case 'aborted':
    case 'invalid_request':
    case 'invalid_response':
    case 'provider_unset':
    case 'stale_generation':
      return 'provider_unavailable';
  }
}

function isAcceptableTranslation(
  translation: TranslatedCue,
  requestedIds: ReadonlySet<string>,
): boolean {
  return requestedIds.has(translation.cueId) && translation.text.trim().length > 0;
}

function sameRoute(left: LanguageRoute, right: LanguageRoute): boolean {
  return left.mode === right.mode &&
    left.externalCallsAllowed === right.externalCallsAllowed &&
    left.provider === right.provider &&
    left.schedulingScope === right.schedulingScope &&
    left.sourceMode === right.sourceMode;
}

function cancellationReasonForRoute(
  route: LanguageRoute,
): SessionCancellationReason {
  if (route.mode === 'disabled') return 'disabled';
  if (route.mode === 'official' || route.sourceMode === 'official-alignment') {
    return 'official-track';
  }
  return 'provider-change';
}

function routeChangeClearsProviderBlock(
  current: LanguageRoute,
  next: LanguageRoute,
  blockedProvider: TranslationProviderId | null,
): boolean {
  if (blockedProvider === null) return false;
  const explicitResetModes: ReadonlySet<LanguageRoute['mode']> = new Set([
    'disabled',
    'missing-key',
    'provider-unset',
  ]);
  return explicitResetModes.has(current.mode) ||
    explicitResetModes.has(next.mode) ||
    (next.provider !== null && next.provider !== blockedProvider);
}

function readCurrentTime(source: SubtitleSessionTickSource): number | undefined {
  try {
    const value = source.currentTimeMs();
    return validTime(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function validTime(value: number | undefined): value is number {
  return value !== undefined && Number.isFinite(value) && value >= 0;
}

function normalizeDisplayText(value: string): string | null {
  const normalized = value.replace(/\s+/gu, ' ').trim();
  return normalized.length === 0 ? null : normalized;
}

/** 原字幕匹配忽略空白：Netflix 的换行和字幕文件的空格不保证一致。 */
function compactText(value: string): string {
  return value.replace(/\s+/gu, '');
}

function normalizeGeneration(value: number): number {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function compareText(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}
