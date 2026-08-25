import { err, ok, type AppError, type Result } from '../shared/result';
import { normalizeNetflixLanguageTag } from './adapter';
import {
  NETFLIX_BRIDGE_PROTOCOL,
  NETFLIX_BRIDGE_VERSION,
  NETFLIX_PAGE_ORIGIN,
  createEarlyBridgeQueue,
  parseNetflixBridgeEvent,
  type NetflixCatalogPayload,
  type NetflixCatalogTrackDescriptor,
  type NetflixBridgePayload,
  type NetflixDiagnosticCode,
  type NetflixWindowMessageEvent,
} from './bridge';
import {
  installFetchProbe,
  installJsonParseProbe,
  installXhrProbe,
  canonicalizeNetflixUnboundOcaTimedTextResource,
  type FetchTargetLike,
  type JsonParseTargetLike,
  type NetworkProbeOptions,
  type ProbeInstallation,
  type XhrConstructorLike,
} from './probe';
import {
  prepareNetflixPlayerTrackCapture,
  readNetflixPlayerCatalog,
  type NetflixPlayerTrackCapture,
  type NetflixPlayerCatalogError,
} from './player-catalog';
import {
  bindNetflixCatalogDownloadResource,
  downloadNetflixEmbeddedLanguageTimedText,
  downloadNetflixTimedText,
  extractNetflixCatalogDownloadResources,
  type NetflixCatalogDownloadError,
  type NetflixCatalogDownloadResource,
  type NetflixTimedTextDownloadOptions,
  type NetflixTimedTextFetch,
} from './catalog-download';

export const NETFLIX_CONTROL_SOURCE =
  'subtwin-netflix-isolated-world' as const;

export type NetflixControlType = 'connect' | 'disconnect';

export interface NetflixControlEnvelope {
  readonly protocol: typeof NETFLIX_BRIDGE_PROTOCOL;
  readonly version: typeof NETFLIX_BRIDGE_VERSION;
  readonly source: typeof NETFLIX_CONTROL_SOURCE;
  readonly type: NetflixControlType;
  readonly nonce: string;
  readonly generation: number;
}

export type NetflixRuntimeError = AppError<
  'invalid_netflix_control' | 'netflix_runtime_unavailable'
>;

export interface NetflixRuntimeWindow {
  readonly location: {
    readonly origin: string;
    readonly pathname?: string;
  };
  fetch: FetchTargetLike['fetch'];
  readonly XMLHttpRequest: XhrConstructorLike;
  readonly JSON: JsonParseTargetLike;
  readonly performance?: {
    getEntriesByType(type: 'resource'): readonly { readonly name?: string }[];
  };
  addEventListener(
    type: 'message',
    listener: (event: MessageEvent) => void,
  ): void;
  removeEventListener(
    type: 'message',
    listener: (event: MessageEvent) => void,
  ): void;
  postMessage(data: unknown, targetOrigin: string): void;
}

export interface IsolatedNetflixBridge {
  start(): Result<undefined, NetflixRuntimeError>;
  dispose(): void;
}

export function parseNetflixControlEvent(
  event: NetflixWindowMessageEvent,
  expectedWindow: NetflixRuntimeWindow,
): Result<NetflixControlEnvelope, NetflixRuntimeError> {
  if (
    event.origin !== NETFLIX_PAGE_ORIGIN ||
    expectedWindow.location.origin !== NETFLIX_PAGE_ORIGIN ||
    event.source !== expectedWindow ||
    !isRecord(event.data) ||
    !hasExactlyKeys(event.data, [
      'generation',
      'nonce',
      'protocol',
      'source',
      'type',
      'version',
    ]) ||
    event.data.protocol !== NETFLIX_BRIDGE_PROTOCOL ||
    event.data.version !== NETFLIX_BRIDGE_VERSION ||
    event.data.source !== NETFLIX_CONTROL_SOURCE ||
    (event.data.type !== 'connect' && event.data.type !== 'disconnect') ||
    !isNonce(event.data.nonce) ||
    !isGeneration(event.data.generation)
  ) {
    return runtimeError('invalid_netflix_control');
  }

  return ok(event.data as unknown as NetflixControlEnvelope);
}

export function createIsolatedNetflixBridge(options: {
  readonly window: NetflixRuntimeWindow;
  readonly nonce: string;
  readonly generation: number;
  readonly onPayload: (payload: NetflixBridgePayload) => void;
}): IsolatedNetflixBridge {
  let started = false;
  let disposed = false;

  const onMessage = (event: MessageEvent): void => {
    if (!started || disposed) return;
    const parsed = parseNetflixBridgeEvent(event, {
      nonce: options.nonce,
      generation: options.generation,
      source: options.window,
    });
    if (!parsed.ok) return;
    try {
      options.onPayload(parsed.value.payload);
    } catch {
      // An isolated consumer must not feed exceptions back into Netflix's page.
    }
  };

  return {
    start() {
      if (started || disposed) return ok(undefined);
      if (
        options.window.location.origin !== NETFLIX_PAGE_ORIGIN ||
        !isNonce(options.nonce) ||
        !isGeneration(options.generation)
      ) {
        return runtimeError('netflix_runtime_unavailable');
      }

      started = true;
      options.window.addEventListener('message', onMessage);
      postControl(options.window, {
        type: 'connect',
        nonce: options.nonce,
        generation: options.generation,
      });
      return ok(undefined);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      if (!started) return;
      options.window.removeEventListener('message', onMessage);
      postControl(options.window, {
        type: 'disconnect',
        nonce: options.nonce,
        generation: options.generation,
      });
    },
  };
}

export interface MainWorldNetflixRuntime extends ProbeInstallation {}

export interface NetflixDownloadEvent {
  readonly state: 'failed' | 'started' | 'succeeded';
  readonly language: string;
  readonly code?: NetflixCatalogDownloadError['code'];
}

export interface NetflixTrackCaptureEvent {
  readonly state:
    | 'body_captured'
    | 'restored'
    | 'switch_failed'
    | 'switch_started'
    | 'timed_out';
  readonly language: string;
}

export interface NetflixTimedTextObservationEvent {
  readonly format: 'ttml' | 'webvtt';
  readonly language: string;
}

export type NetflixPerformanceTimedTextEvent =
  | { readonly state: 'candidate_started' }
  | { readonly state: 'failed'; readonly code: NetflixCatalogDownloadError['code'] }
  | { readonly state: 'scan'; readonly candidateCount: number; readonly entryCount: number }
  | { readonly state: 'succeeded'; readonly language: string };

export interface NetflixCatalogMatchDiagnostic {
  readonly source: CatalogMetadataSource;
  readonly resourceCount: number;
  readonly catalogTrackCount: number;
  readonly rejections: {
    readonly noAuthoritativeCatalog: number;
    readonly titleMismatch: number;
    readonly unsupportedLanguage: number;
    readonly languageCategoryMismatch: number;
    readonly kindMismatch: number;
    readonly ambiguousTrack: number;
    readonly bindingRejected: number;
  };
}

type FetchInstaller = (
  target: FetchTargetLike,
  options: NetworkProbeOptions,
) => ProbeInstallation;
type XhrInstaller = (
  target: XhrConstructorLike,
  options: NetworkProbeOptions,
) => ProbeInstallation;
type JsonParseInstaller = (
  target: JsonParseTargetLike,
  options: NetworkProbeOptions,
) => ProbeInstallation;

interface ActiveProbeSession {
  readonly nonce: string;
  readonly generation: number;
  readonly fetch: ProbeInstallation;
  readonly xhr: ProbeInstallation;
  readonly json: ProbeInstallation;
  readonly disposeQueue: () => void;
  readonly disposeCatalogPoll: () => void;
  readonly disposeCatalogDownloads: () => void;
  readonly disposeTrackCapture: () => void;
  readonly queue: ReturnType<typeof createEarlyBridgeQueue>;
}

type PlayerCatalogReader = (
  target: unknown,
  onMetadata?: (metadata: unknown) => void,
) => Result<NetflixCatalogPayload, NetflixPlayerCatalogError>;

type PlayerTrackCapturePreparer = (
  target: unknown,
  catalog: NetflixCatalogPayload,
) => Result<NetflixPlayerTrackCapture, NetflixPlayerCatalogError>;

type CatalogPollScheduler = (
  task: () => void,
  intervalMs: number,
) => () => void;

type TrackCaptureTimeoutScheduler = (
  task: () => void,
  timeoutMs: number,
) => () => void;

type CatalogResourceExtractor = (
  metadata: unknown,
) => Result<readonly NetflixCatalogDownloadResource[], NetflixCatalogDownloadError>;

type CatalogTimedTextDownloader = (
  fetcher: NetflixTimedTextFetch,
  resource: NetflixCatalogDownloadResource,
  options?: NetflixTimedTextDownloadOptions,
) => ReturnType<typeof downloadNetflixTimedText>;

type EmbeddedTimedTextDownloader = (
  fetcher: NetflixTimedTextFetch,
  url: string,
  options?: NetflixTimedTextDownloadOptions,
) => ReturnType<typeof downloadNetflixEmbeddedLanguageTimedText>;

type CatalogMetadataSource = 'network' | 'player';

const PLAYER_CATALOG_POLL_INTERVAL_MS = 1_500;
const TRACK_CAPTURE_TIMEOUT_MS = 3_000;
const CATALOG_DOWNLOAD_MAX_ATTEMPTS = 3;
const CATALOG_DOWNLOAD_RETRY_BASE_MS = 250;

function playerMetadataSignature(
  resources: readonly NetflixCatalogDownloadResource[],
): string {
  const entries = resources.map((resource) => [
    resource.titleId,
    resource.resourceId,
    resource.trackId,
    normalizeLanguageForMatch(resource.language),
    resource.kind,
    resource.url,
  ].join('\u001f')).sort();
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (const entry of entries) {
    for (let index = 0; index < entry.length; index += 1) {
      const code = entry.charCodeAt(index);
      first = Math.imul(first ^ code, 0x01000193);
      second = Math.imul(second ^ code, 0x85ebca6b);
    }
    first = Math.imul(first ^ 0xff, 0x01000193);
    second = Math.imul(second ^ 0xff, 0xc2b2ae35);
  }
  return `${entries.length}:${(first >>> 0).toString(16)}:${(second >>> 0).toString(16)}`;
}

const MAIN_RUNTIMES = new WeakMap<object, MainWorldNetflixRuntime>();
const MAIN_RUNTIME_SENTINEL = Symbol.for(
  'subtwin.netflix.main-world-runtime.v1',
);

interface MainRuntimeSentinel {
  readonly version: 1;
  readonly runtime: MainWorldNetflixRuntime;
}

export function installMainWorldNetflixRuntime(options: {
  readonly window: NetflixRuntimeWindow;
  readonly installFetch?: FetchInstaller;
  readonly installXhr?: XhrInstaller;
  readonly installJsonParse?: JsonParseInstaller;
  readonly readPlayerCatalog?: PlayerCatalogReader;
  readonly preparePlayerTrackCapture?: PlayerTrackCapturePreparer;
  readonly scheduleCatalogPoll?: CatalogPollScheduler;
  readonly scheduleTrackCaptureTimeout?: TrackCaptureTimeoutScheduler;
  readonly extractCatalogResources?: CatalogResourceExtractor;
  readonly downloadCatalogTimedText?: CatalogTimedTextDownloader;
  readonly downloadEmbeddedTimedText?: EmbeddedTimedTextDownloader;
  readonly onDownloadDiagnostic?: (
    code: NetflixCatalogDownloadError['code'],
  ) => void;
  readonly onDownloadEvent?: (event: NetflixDownloadEvent) => void;
  readonly onTrackCaptureEvent?: (event: NetflixTrackCaptureEvent) => void;
  readonly onTimedTextCandidate?: NetworkProbeOptions['onTimedTextCandidate'];
  readonly onTimedTextObservation?: (event: NetflixTimedTextObservationEvent) => void;
  readonly onPerformanceTimedTextEvent?: (event: NetflixPerformanceTimedTextEvent) => void;
  readonly onCatalogMatchDiagnostic?: (
    diagnostic: NetflixCatalogMatchDiagnostic,
  ) => void;
}): MainWorldNetflixRuntime {
  const globalRuntime = readMainRuntimeSentinel(options.window);
  if (globalRuntime !== undefined) return globalRuntime;
  const existing = MAIN_RUNTIMES.get(options.window);
  if (existing !== undefined) return existing;

  const installFetch = options.installFetch ?? installFetchProbe;
  const installXhr = options.installXhr ?? installXhrProbe;
  const installJsonParse = options.installJsonParse ?? installJsonParseProbe;
  const readPlayerCatalog = options.readPlayerCatalog ?? readNetflixPlayerCatalog;
  const preparePlayerTrackCapture =
    options.preparePlayerTrackCapture ?? prepareNetflixPlayerTrackCapture;
  const scheduleCatalogPoll = options.scheduleCatalogPoll ?? scheduleRepeating;
  const scheduleTrackCaptureTimeout =
    options.scheduleTrackCaptureTimeout ?? scheduleOnce;
  const extractCatalogResources =
    options.extractCatalogResources ?? extractNetflixCatalogDownloadResources;
  const downloadCatalogTimedText =
    options.downloadCatalogTimedText ?? downloadNetflixTimedText;
  const downloadEmbeddedTimedText =
    options.downloadEmbeddedTimedText ?? downloadNetflixEmbeddedLanguageTimedText;
  let disposed = false;
  let active: ActiveProbeSession | undefined;
  let highestGeneration = -1;

  const disposeActive = (): void => {
    const current = active;
    active = undefined;
    if (current === undefined) return;
    current.fetch.dispose();
    current.xhr.dispose();
    current.json.dispose();
    current.disposeCatalogPoll();
    current.disposeCatalogDownloads();
    current.disposeTrackCapture();
    current.disposeQueue();
    current.queue.dispose();
  };

  const connect = (control: NetflixControlEnvelope): void => {
    if (disposed) return;
    if (
      active?.generation === control.generation &&
      active.nonce === control.nonce
    ) {
      return;
    }
    if (control.generation <= highestGeneration) return;

    disposeActive();
    const previousHighestGeneration = highestGeneration;
    highestGeneration = control.generation;
    const queue = createEarlyBridgeQueue({
      nonce: control.nonce,
      generation: control.generation,
    });
    const disposeQueue = queue.attach((message) => {
      safePost(options.window, message);
    });
    const inFlightDownloads = new Map<string, {
      readonly controller: AbortController;
      readonly resource: NetflixCatalogDownloadResource;
    }>();
    const succeededDownloads = new Map<
      string,
      NetflixCatalogDownloadResource
    >();
    const failedDownloads = new Map<
      string,
      NetflixCatalogDownloadResource
    >();
    const approvedObservedResources = new Map<
      string,
      NetflixCatalogDownloadResource
    >();
    const observedBodyTrackIds = new Set<string>();
    const pendingEmbeddedTimedText = new Map<
      string,
      Parameters<NetworkProbeOptions['onTimedText']>[0]
    >();
    const performanceDownloadAttempts = new Map<string, number>();
    const inFlightPerformanceDownloads = new Map<string, AbortController>();
    const retryDownloads = new Map<string, {
      readonly cancel: () => void;
      readonly resource: NetflixCatalogDownloadResource;
    }>();
    let currentAuthoritativeCatalog: NetflixCatalogPayload | undefined;
    let trackCapture: NetflixPlayerTrackCapture | undefined;
    let activeCaptureBinding: {
      readonly titleId: string;
      readonly trackId: string;
    } | undefined;
    let pendingCaptureTrackIds: string[] = [];
    let cancelCaptureTimeout: () => void = () => undefined;
    let captureTitleId: string | undefined;
    const attemptedCaptureTrackIds = new Set<string>();
    let playerCatalogUnavailable = true;
    let downloadStartedPublished = false;
    let downloadSucceededPublished = false;
    let downloadFailurePublished = false;
    const publishedDiagnostics = new Set<NetflixDiagnosticCode>();
    let observedRouteTitleId = readWatchRouteTitleId(
      options.window.location.pathname,
    );
    let publishedTitleId = observedRouteTitleId ?? undefined;
    let lastCatalogSignature: string | undefined;
    let lastPlayerMetadataSignature: string | undefined;
    let nextActive: ActiveProbeSession | undefined;
    const stopTrackCapture = (): void => {
      cancelCaptureTimeout();
      cancelCaptureTimeout = () => undefined;
      activeCaptureBinding = undefined;
      pendingCaptureTrackIds = [];
      const current = trackCapture;
      trackCapture = undefined;
      if (current !== undefined) {
        const language = currentAuthoritativeCatalog?.tracks.find(
          (track) => track.id === current.originalTrackId,
        )?.language ?? 'und';
        current.restore();
        safeTrackCaptureEvent(options.onTrackCaptureEvent, {
          state: 'restored',
          language,
        });
      }
    };
    const publishAuthoritativeCatalog = (
      catalog: NetflixCatalogPayload,
    ): void => {
      const signature = JSON.stringify(catalog);
      if (signature === lastCatalogSignature) return;
      if (queue.publish(catalog, control.generation)) {
        lastCatalogSignature = signature;
      }
    };
    const resetPublishedStateForTitle = (titleId: string): void => {
      if (publishedTitleId !== undefined && publishedTitleId !== titleId) {
        publishedDiagnostics.clear();
        downloadStartedPublished = false;
        downloadSucceededPublished = false;
        downloadFailurePublished = false;
        lastPlayerMetadataSignature = undefined;
      }
      publishedTitleId = titleId;
    };
    const publishDiagnostic = (code: NetflixDiagnosticCode): boolean => {
      if (publishedDiagnostics.has(code)) return true;
      const published = queue.publish({ type: 'diagnostic', code }, control.generation);
      if (published) publishedDiagnostics.add(code);
      return published;
    };
    const downloadKey = (resource: NetflixCatalogDownloadResource): string =>
      `${resource.titleId}\u001f${resource.resourceId}`;
    const observedResourceKey = (resource: {
      readonly resourceId: string;
      readonly trackId: string;
      readonly language: string;
    }): string => [
      resource.resourceId,
      resource.trackId,
      normalizeLanguageForMatch(resource.language),
    ].join('\u001f');
    const cancelInvalidDownloads = (): void => {
      const catalog = currentAuthoritativeCatalog;
      for (const [key, state] of inFlightDownloads) {
        if (catalog !== undefined && resourceMatchesCatalog(state.resource, catalog)) continue;
        state.controller.abort();
        inFlightDownloads.delete(key);
      }
      for (const [key, state] of retryDownloads) {
        if (catalog !== undefined && resourceMatchesCatalog(state.resource, catalog)) continue;
        state.cancel();
        retryDownloads.delete(key);
      }
      for (const [key, resource] of succeededDownloads) {
        if (catalog === undefined || !resourceMatchesCatalog(resource, catalog)) {
          succeededDownloads.delete(key);
        }
      }
      for (const [key, resource] of failedDownloads) {
        if (catalog === undefined || !resourceMatchesCatalog(resource, catalog)) {
          failedDownloads.delete(key);
        }
      }
      for (const [key, resource] of approvedObservedResources) {
        if (catalog === undefined || !resourceMatchesCatalog(resource, catalog)) {
          approvedObservedResources.delete(key);
        }
      }
    };
    const setAuthoritativeCatalog = (
      catalog: NetflixCatalogPayload,
    ): void => {
      resetPublishedStateForTitle(catalog.titleId);
      if (captureTitleId !== undefined && captureTitleId !== catalog.titleId) {
        stopTrackCapture();
        attemptedCaptureTrackIds.clear();
      }
      captureTitleId = catalog.titleId;
      currentAuthoritativeCatalog = catalog;
      cancelInvalidDownloads();
      for (const [key, payload] of pendingEmbeddedTimedText) {
        if (publishEmbeddedTimedText(payload)) pendingEmbeddedTimedText.delete(key);
      }
    };
    const publishEmbeddedTimedText = (
      payload: Parameters<NetworkProbeOptions['onTimedText']>[0],
    ): boolean => {
      if (
        !/^oca_[a-f0-9]{16}$/u.test(payload.trackId) ||
        !/^tt_[a-f0-9]{16}$/u.test(payload.resourceId)
      ) return false;
      const catalog = currentAuthoritativeCatalog;
      if (catalog === undefined) return false;
      const observedLanguage = normalizeNetflixLanguageTag(payload.language);
      if (observedLanguage === null) return true;
      const matches = catalog.tracks.filter((track) => {
        const language = normalizeNetflixLanguageTag(track.language);
        return language !== null &&
          language.sourceTag.toLowerCase() ===
            observedLanguage.sourceTag.toLowerCase();
      });
      if (matches.length !== 1) return true;
      const track = matches[0];
      if (track === undefined) return true;
      if (queue.publish({
        ...payload,
        titleId: catalog.titleId,
        trackId: track.id,
        language: track.language,
      }, control.generation)) {
        observedBodyTrackIds.add(track.id);
      }
      if (activeCaptureBinding?.trackId === track.id) {
        activeCaptureBinding = undefined;
        safeTrackCaptureEvent(options.onTrackCaptureEvent, {
          state: 'body_captured',
          language: track.language,
        });
        startNextTrackCapture();
      }
      return true;
    };
    const startNextTrackCapture = (): void => {
      cancelCaptureTimeout();
      cancelCaptureTimeout = () => undefined;
      const controller = trackCapture;
      const catalog = currentAuthoritativeCatalog;
      if (
        disposed ||
        controller === undefined ||
        catalog === undefined ||
        controller.titleId !== catalog.titleId ||
        active !== nextActive
      ) {
        stopTrackCapture();
        return;
      }
      const trackId = pendingCaptureTrackIds.shift();
      if (trackId === undefined) {
        stopTrackCapture();
        return;
      }
      const track = catalog.tracks.find((candidate) => candidate.id === trackId);
      if (track === undefined) {
        startNextTrackCapture();
        return;
      }
      activeCaptureBinding = { titleId: catalog.titleId, trackId };
      if (!controller.switchTo(trackId)) {
        activeCaptureBinding = undefined;
        safeTrackCaptureEvent(options.onTrackCaptureEvent, {
          state: 'switch_failed',
          language: track.language,
        });
        startNextTrackCapture();
        return;
      }
      attemptedCaptureTrackIds.add(trackId);
      safeTrackCaptureEvent(options.onTrackCaptureEvent, {
        state: 'switch_started',
        language: track.language,
      });
      try {
        cancelCaptureTimeout = scheduleTrackCaptureTimeout(() => {
          if (activeCaptureBinding?.trackId !== trackId) return;
          activeCaptureBinding = undefined;
          safeTrackCaptureEvent(options.onTrackCaptureEvent, {
            state: 'timed_out',
            language: track.language,
          });
          startNextTrackCapture();
        }, TRACK_CAPTURE_TIMEOUT_MS);
      } catch {
        cancelCaptureTimeout = () => undefined;
      }
    };
    const maybeStartTrackCapture = (): void => {
      if (
        disposed ||
        trackCapture !== undefined ||
        currentAuthoritativeCatalog === undefined ||
        active !== nextActive
      ) return;
      const catalog = currentAuthoritativeCatalog;
      const selected = new Map<string, NetflixCatalogTrackDescriptor>();
      for (const track of catalog.tracks) {
        const language = normalizeNetflixLanguageTag(track.language);
        if (
          language === null ||
          (language.category !== 'english' &&
            language.category !== 'simplified-chinese') ||
          selected.has(language.category)
        ) continue;
        selected.set(language.category, track);
      }
      if (!selected.has('english') || !selected.has('simplified-chinese')) return;
      const missing = [...selected.values()].filter((track) =>
        !attemptedCaptureTrackIds.has(track.id) &&
        !observedBodyTrackIds.has(track.id) &&
        ![...approvedObservedResources.values()].some(
          (resource) => resource.trackId === track.id,
        )
      );
      if (missing.length === 0) return;
      const prepared = preparePlayerTrackCapture(options.window, catalog);
      if (!prepared.ok || prepared.value.titleId !== catalog.titleId) return;
      trackCapture = prepared.value;
      pendingCaptureTrackIds = missing
        .sort((left, right) =>
          left.id === prepared.value.originalTrackId
            ? 1
            : right.id === prepared.value.originalTrackId
              ? -1
              : 0,
        )
        .map((track) => track.id);
      startNextTrackCapture();
    };
    const refreshPlayerCatalog = (): void => {
      try {
        let observedMetadata: unknown;
        let hasObservedMetadata = false;
        const result = readPlayerCatalog(options.window, (metadata) => {
          observedMetadata = metadata;
          hasObservedMetadata = true;
        });
        if (!result.ok || result.value.authority !== 'authoritative') {
          playerCatalogUnavailable = true;
          return;
        }
        const routeTitleId = readWatchRouteTitleId(
          options.window.location.pathname,
        );
        if (
          routeTitleId !== null &&
          result.value.titleId !== routeTitleId
        ) return;
        if (result.value.tracks.length === 0) {
          playerCatalogUnavailable = true;
          return;
        }
        playerCatalogUnavailable = false;
        setAuthoritativeCatalog(result.value);
        publishAuthoritativeCatalog(result.value);
        if (hasObservedMetadata) onCatalogMetadata(observedMetadata, 'player');
        maybeStartTrackCapture();
      } catch {
        playerCatalogUnavailable = true;
        // A private Netflix API change keeps the conservative network gate locked.
      }
    };
    const alignRouteTitle = (): void => {
      const routeTitleId = readWatchRouteTitleId(options.window.location.pathname);
      if (routeTitleId === null || routeTitleId === observedRouteTitleId) return;
      observedRouteTitleId = routeTitleId;
      resetPublishedStateForTitle(routeTitleId);
      if (currentAuthoritativeCatalog?.titleId !== routeTitleId) {
        stopTrackCapture();
        currentAuthoritativeCatalog = undefined;
        cancelInvalidDownloads();
      }
      refreshPlayerCatalog();
    };
    const startCatalogDownload = (
      resource: NetflixCatalogDownloadResource,
      attempt = 1,
    ): void => {
      if (
        disposed ||
        nextActive === undefined ||
        active !== nextActive ||
        currentAuthoritativeCatalog === undefined ||
        !resourceMatchesCatalog(resource, currentAuthoritativeCatalog)
      ) return;
      const key = downloadKey(resource);
      if (
        inFlightDownloads.has(key) ||
        retryDownloads.has(key) ||
        succeededDownloads.has(key)
      ) return;
      const controller = new AbortController();
      inFlightDownloads.set(key, { controller, resource });
      safeDownloadEvent(options.onDownloadEvent, {
        state: 'started',
        language: resource.language,
      });
      if (!downloadStartedPublished) {
        downloadStartedPublished = queue.publish({
          type: 'diagnostic',
          code: 'download_started',
        }, control.generation);
      }
      const fetcher: NetflixTimedTextFetch = (input, init) =>
        options.window.fetch.call(options.window, input, init) as unknown as ReturnType<NetflixTimedTextFetch>;
      const reportFailure = (
        code: NetflixCatalogDownloadError['code'],
      ): void => {
        if (
          controller.signal.aborted ||
          disposed ||
          active !== nextActive
        ) return;
        try {
          options.onDownloadDiagnostic?.(code);
        } catch {
          // Diagnostics are advisory and must never affect playback.
        }
        safeDownloadEvent(options.onDownloadEvent, {
          state: 'failed',
          language: resource.language,
          code,
        });
        failedDownloads.set(key, resource);
        if (
          !downloadFailurePublished &&
          hasExhaustedRequiredTrack(
            currentAuthoritativeCatalog,
            approvedObservedResources,
            succeededDownloads,
            failedDownloads,
          )
        ) {
          downloadFailurePublished = queue.publish({
            type: 'diagnostic',
            code: 'display_unavailable',
          }, control.generation);
        }
      };
      const retry = (
        code: NetflixCatalogDownloadError['code'],
      ): void => {
        if (
          controller.signal.aborted ||
          disposed ||
          active !== nextActive
        ) return;
        if (attempt >= CATALOG_DOWNLOAD_MAX_ATTEMPTS) {
          reportFailure(code);
          return;
        }
        const handle = globalThis.setTimeout(() => {
          retryDownloads.delete(key);
          startCatalogDownload(resource, attempt + 1);
        }, CATALOG_DOWNLOAD_RETRY_BASE_MS * 2 ** (attempt - 1));
        retryDownloads.set(key, {
          resource,
          cancel: () => globalThis.clearTimeout(handle),
        });
      };
      void downloadCatalogTimedText(fetcher, resource, {
        signal: controller.signal,
      }).then(
        (result) => {
          const state = inFlightDownloads.get(key);
          if (state?.controller !== controller) return;
          inFlightDownloads.delete(key);
          if (
            controller.signal.aborted ||
            disposed ||
            active !== nextActive ||
            currentAuthoritativeCatalog === undefined ||
            !resourceMatchesCatalog(resource, currentAuthoritativeCatalog)
          ) return;
          if (!result.ok) {
            if (isTransientCatalogDownloadError(result.error.code)) {
              retry(result.error.code);
            } else {
              reportFailure(result.error.code);
            }
            return;
          }
          if (
            result.value.titleId === resource.titleId &&
            result.value.trackId === resource.trackId
          ) {
            if (queue.publish(result.value, control.generation)) {
              failedDownloads.delete(key);
              succeededDownloads.set(key, resource);
              safeDownloadEvent(options.onDownloadEvent, {
                state: 'succeeded',
                language: resource.language,
              });
              if (!downloadSucceededPublished) {
                downloadSucceededPublished = queue.publish({
                  type: 'diagnostic',
                  code: 'download_succeeded',
                }, control.generation);
              }
            } else {
              reportFailure('netflix_timed_text_too_large');
            }
          }
        },
        () => {
          const state = inFlightDownloads.get(key);
          if (state?.controller !== controller) return;
          inFlightDownloads.delete(key);
          retry('netflix_timed_text_fetch_failed');
        },
      );
    };
    const onCatalogMetadata = (
      metadata: unknown,
      source: CatalogMetadataSource = 'network',
    ): void => {
      if (disposed || nextActive === undefined || active !== nextActive) return;
      alignRouteTitle();
      let extracted: ReturnType<CatalogResourceExtractor>;
      try {
        extracted = extractCatalogResources(metadata);
      } catch {
        publishDiagnostic('metadata_resource_extract_failed');
        return;
      }
      if (!extracted.ok) {
        publishDiagnostic('metadata_resource_extract_failed');
        return;
      }
      if (extracted.value.length === 0) return;
      if (source === 'player') {
        const signature = playerMetadataSignature(extracted.value);
        if (signature === lastPlayerMetadataSignature) return;
        lastPlayerMetadataSignature = signature;
      }
      if (playerCatalogUnavailable) {
        const routeCatalog = createRouteMatchedDualCatalog(
          options.window.location.pathname,
          extracted.value,
        );
        if (
          routeCatalog !== null &&
          currentAuthoritativeCatalog?.titleId !== routeCatalog.titleId
        ) {
          setAuthoritativeCatalog(routeCatalog);
          publishAuthoritativeCatalog(routeCatalog);
        }
      }
      publishDiagnostic('metadata_resources_extracted');

      let approvedCount = 0;
      const rejections = emptyCatalogMatchRejections();
      for (const resource of extracted.value) {
        const catalog = currentAuthoritativeCatalog;
        const track = catalog === undefined
          ? null
          : resolveCatalogTrack(resource, catalog);
        if (track === null) {
          incrementCatalogMatchRejection(rejections, resource, catalog);
          continue;
        }
        const approvedResource = bindNetflixCatalogDownloadResource(resource, track);
        if (approvedResource === null) {
          rejections.bindingRejected += 1;
          continue;
        }
        approvedObservedResources.set(
          observedResourceKey(resource),
          approvedResource,
        );
        approvedCount += 1;
        publishDiagnostic('download_candidate_approved');
        startCatalogDownload(approvedResource);
      }
      if (approvedCount === 0) {
        publishDiagnostic('download_candidate_unmatched');
        safeCatalogMatchDiagnostic(options.onCatalogMatchDiagnostic, {
          source,
          resourceCount: extracted.value.length,
          catalogTrackCount: currentAuthoritativeCatalog?.tracks.length ?? 0,
          rejections,
        });
      }
    };
    const probeOptions: NetworkProbeOptions = {
      generation: control.generation,
      currentGeneration: () => active?.generation ?? highestGeneration,
      onTimedText: (payload) => {
        try {
          options.onTimedTextObservation?.({
            format: payload.format,
            language: payload.language,
          });
        } catch {
          // Diagnostics are advisory and must never affect playback.
        }
        const catalog = currentAuthoritativeCatalog;
        if (/^oca_[a-f0-9]{16}$/u.test(payload.trackId)) {
          if (!publishEmbeddedTimedText(payload)) {
            if (pendingEmbeddedTimedText.size >= 4) {
              const oldest = pendingEmbeddedTimedText.keys().next().value as string | undefined;
              if (oldest !== undefined) pendingEmbeddedTimedText.delete(oldest);
            }
            pendingEmbeddedTimedText.set(payload.resourceId, payload);
          }
          return;
        }
        const capture = activeCaptureBinding;
        if (
          catalog !== undefined &&
          capture !== undefined &&
          capture.titleId === catalog.titleId &&
          payload.trackId === capture.trackId
        ) {
          const track = catalog.tracks.find(
            (candidate) => candidate.id === capture.trackId,
          );
          if (track !== undefined) {
            queue.publish({
              ...payload,
              titleId: catalog.titleId,
              trackId: track.id,
              language: track.language,
            }, control.generation);
            activeCaptureBinding = undefined;
            safeTrackCaptureEvent(options.onTrackCaptureEvent, {
              state: 'body_captured',
              language: track.language,
            });
            startNextTrackCapture();
            return;
          }
        }
        const resource = approvedObservedResources.get(
          observedResourceKey(payload),
        );
        if (
          catalog === undefined ||
          resource === undefined ||
          !resourceMatchesCatalog(resource, catalog)
        ) {
          return;
        }
        queue.publish(
          {
            ...payload,
            titleId: resource.titleId,
            trackId: resource.trackId,
            language: resource.language,
          },
          control.generation,
        );
      },
      onCatalog: (payload) => {
        queue.publish(payload, control.generation);
      },
      onCatalogMetadata,
      currentTimedTextBinding: () => activeCaptureBinding,
      ...(options.onTimedTextCandidate === undefined
        ? {}
        : { onTimedTextCandidate: options.onTimedTextCandidate }),
      onDiagnostic: (code) => {
        alignRouteTitle();
        publishDiagnostic(code);
      },
    };
    const scanPerformanceTimedText = (): void => {
      const catalog = currentAuthoritativeCatalog;
      const performanceTarget = options.window.performance ??
        (globalThis.performance as unknown as NetflixRuntimeWindow['performance']);
      if (
        catalog === undefined ||
        disposed ||
        active !== nextActive ||
        performanceTarget === undefined
      ) return;
      let entries: readonly { readonly name?: string }[];
      try {
        entries = performanceTarget.getEntriesByType('resource').slice(-512);
      } catch {
        return;
      }
      let candidateCount = 0;
      for (const entry of entries) {
        if (typeof entry.name !== 'string') continue;
        const identity = canonicalizeNetflixUnboundOcaTimedTextResource(entry.name);
        if (!identity.ok) continue;
        candidateCount += 1;
        const key = identity.value.resourceId;
        const attempts = performanceDownloadAttempts.get(key) ?? 0;
        if (attempts >= 2 || inFlightPerformanceDownloads.has(key)) continue;
        performanceDownloadAttempts.set(key, attempts + 1);
        safePerformanceTimedTextEvent(options.onPerformanceTimedTextEvent, {
          state: 'candidate_started',
        });
        const controller = new AbortController();
        inFlightPerformanceDownloads.set(key, controller);
        const fetcher: NetflixTimedTextFetch = (input, init) =>
          options.window.fetch.call(options.window, input, init) as unknown as ReturnType<NetflixTimedTextFetch>;
        void downloadEmbeddedTimedText(fetcher, entry.name, {
          signal: controller.signal,
        }).then((result) => {
          if (inFlightPerformanceDownloads.get(key) !== controller) return;
          inFlightPerformanceDownloads.delete(key);
          if (
            controller.signal.aborted ||
            disposed ||
            active !== nextActive
          ) return;
          if (!result.ok) {
            safePerformanceTimedTextEvent(options.onPerformanceTimedTextEvent, {
              state: 'failed',
              code: result.error.code,
            });
            return;
          }
          safePerformanceTimedTextEvent(options.onPerformanceTimedTextEvent, {
            state: 'succeeded',
            language: result.value.language,
          });
          probeOptions.onTimedText(result.value);
        }, () => {
          if (inFlightPerformanceDownloads.get(key) === controller) {
            inFlightPerformanceDownloads.delete(key);
          }
        });
      }
      safePerformanceTimedTextEvent(options.onPerformanceTimedTextEvent, {
        state: 'scan',
        candidateCount,
        entryCount: entries.length,
      });
    };

    let fetch: ProbeInstallation | undefined;
    let xhr: ProbeInstallation | undefined;
    let json: ProbeInstallation | undefined;
    try {
      json = installJsonParse(options.window.JSON, probeOptions);
      fetch = installFetch(options.window, probeOptions);
      xhr = installXhr(options.window.XMLHttpRequest, probeOptions);
      let stopCatalogPoll: () => void = () => undefined;
      nextActive = {
        nonce: control.nonce,
        generation: control.generation,
        fetch,
        xhr,
        json,
        disposeCatalogPoll: () => stopCatalogPoll(),
        disposeCatalogDownloads: () => {
          for (const { controller } of inFlightDownloads.values()) {
            controller.abort();
          }
          for (const { cancel } of retryDownloads.values()) cancel();
          inFlightDownloads.clear();
          retryDownloads.clear();
          succeededDownloads.clear();
          failedDownloads.clear();
          approvedObservedResources.clear();
          observedBodyTrackIds.clear();
          pendingEmbeddedTimedText.clear();
          for (const controller of inFlightPerformanceDownloads.values()) {
            controller.abort();
          }
          inFlightPerformanceDownloads.clear();
          performanceDownloadAttempts.clear();
        },
        disposeTrackCapture: stopTrackCapture,
        disposeQueue,
        queue,
      };
      active = nextActive;

      const publishPlayerCatalog = (): void => {
        if (!disposed && active === nextActive) {
          refreshPlayerCatalog();
          scanPerformanceTimedText();
        }
      };
      publishPlayerCatalog();
      try {
        stopCatalogPoll = scheduleCatalogPoll(
          publishPlayerCatalog,
          PLAYER_CATALOG_POLL_INTERVAL_MS,
        );
      } catch {
        stopCatalogPoll = () => undefined;
      }
    } catch {
      for (const { controller } of inFlightDownloads.values()) controller.abort();
      for (const { cancel } of retryDownloads.values()) cancel();
      fetch?.dispose();
      xhr?.dispose();
      json?.dispose();
      disposeQueue();
      queue.dispose();
      highestGeneration = previousHighestGeneration;
    }
  };

  const onMessage = (event: MessageEvent): void => {
    if (disposed) return;
    const parsed = parseNetflixControlEvent(event, options.window);
    if (!parsed.ok) return;
    if (parsed.value.type === 'connect') {
      connect(parsed.value);
      return;
    }
    if (
      active?.nonce === parsed.value.nonce &&
      active.generation === parsed.value.generation
    ) {
      disposeActive();
    }
  };

  const runtime: MainWorldNetflixRuntime = {
    dispose() {
      if (disposed) return;
      disposed = true;
      disposeActive();
      options.window.removeEventListener('message', onMessage);
      if (MAIN_RUNTIMES.get(options.window) === runtime) {
        MAIN_RUNTIMES.delete(options.window);
      }
      clearMainRuntimeSentinel(options.window, runtime);
    },
  };

  options.window.addEventListener('message', onMessage);
  MAIN_RUNTIMES.set(options.window, runtime);
  writeMainRuntimeSentinel(options.window, runtime);
  return runtime;
}

function safeDownloadEvent(
  listener: ((event: NetflixDownloadEvent) => void) | undefined,
  event: NetflixDownloadEvent,
): void {
  try {
    listener?.(event);
  } catch {
    // Diagnostics are advisory and must never affect playback.
  }
}

function safeTrackCaptureEvent(
  listener: ((event: NetflixTrackCaptureEvent) => void) | undefined,
  event: NetflixTrackCaptureEvent,
): void {
  try {
    listener?.(event);
  } catch {
    // Diagnostics are advisory and must never affect playback.
  }
}

function safePerformanceTimedTextEvent(
  listener: ((event: NetflixPerformanceTimedTextEvent) => void) | undefined,
  event: NetflixPerformanceTimedTextEvent,
): void {
  try {
    listener?.(event);
  } catch {
    // Diagnostics are advisory and must never affect playback.
  }
}

interface CatalogMatchRejectionCounts {
  noAuthoritativeCatalog: number;
  titleMismatch: number;
  unsupportedLanguage: number;
  languageCategoryMismatch: number;
  kindMismatch: number;
  ambiguousTrack: number;
  bindingRejected: number;
}

function emptyCatalogMatchRejections(): CatalogMatchRejectionCounts {
  return {
    noAuthoritativeCatalog: 0,
    titleMismatch: 0,
    unsupportedLanguage: 0,
    languageCategoryMismatch: 0,
    kindMismatch: 0,
    ambiguousTrack: 0,
    bindingRejected: 0,
  };
}

function incrementCatalogMatchRejection(
  counts: CatalogMatchRejectionCounts,
  resource: NetflixCatalogDownloadResource,
  catalog: NetflixCatalogPayload | undefined,
): void {
  if (catalog === undefined || catalog.authority !== 'authoritative') {
    counts.noAuthoritativeCatalog += 1;
    return;
  }
  if (resource.titleId !== catalog.titleId) {
    counts.titleMismatch += 1;
    return;
  }
  const language = normalizeNetflixLanguageTag(resource.language);
  if (language === null || language.category === 'other') {
    counts.unsupportedLanguage += 1;
    return;
  }
  const sameCategory = catalog.tracks.filter((track) =>
    normalizeNetflixLanguageTag(track.language)?.category === language.category);
  if (sameCategory.length === 0) {
    counts.languageCategoryMismatch += 1;
    return;
  }
  if (!sameCategory.some((track) => track.kind === resource.kind)) {
    counts.kindMismatch += 1;
    return;
  }
  counts.ambiguousTrack += 1;
}

function safeCatalogMatchDiagnostic(
  listener: ((diagnostic: NetflixCatalogMatchDiagnostic) => void) | undefined,
  diagnostic: NetflixCatalogMatchDiagnostic,
): void {
  try {
    listener?.(diagnostic);
  } catch {
    // Aggregate diagnostics are advisory and never affect playback.
  }
}

function hasExhaustedRequiredTrack(
  catalog: NetflixCatalogPayload | undefined,
  approved: ReadonlyMap<string, NetflixCatalogDownloadResource>,
  succeeded: ReadonlyMap<string, NetflixCatalogDownloadResource>,
  failed: ReadonlyMap<string, NetflixCatalogDownloadResource>,
): boolean {
  if (catalog === undefined) return false;
  for (const track of catalog.tracks) {
    const category = normalizeNetflixLanguageTag(track.language)?.category;
    if (category !== 'english' && category !== 'simplified-chinese') continue;
    const candidates = [...approved.values()].filter((resource) =>
      resource.titleId === catalog.titleId && resource.trackId === track.id);
    if (candidates.length === 0) return false;
    if (candidates.some((resource) =>
      [...succeeded.values()].some((accepted) =>
        accepted.titleId === resource.titleId &&
        accepted.resourceId === resource.resourceId))) continue;
    if (candidates.every((resource) =>
      [...failed.values()].some((rejected) =>
        rejected.titleId === resource.titleId &&
        rejected.resourceId === resource.resourceId))) return true;
  }
  return false;
}

function createRouteMatchedDualCatalog(
  pathname: string | undefined,
  resources: readonly NetflixCatalogDownloadResource[],
): NetflixCatalogPayload | null {
  const routeTitleId = readWatchRouteTitleId(pathname);
  if (routeTitleId === null) return null;
  const matching = resources.filter(({ titleId }) => titleId === routeTitleId);
  let hasEnglish = false;
  let hasSimplifiedChinese = false;
  const tracks = new Map<string, NetflixCatalogTrackDescriptor>();
  for (const resource of matching) {
    const language = normalizeNetflixLanguageTag(resource.language);
    if (language === null) continue;
    if (language.category === 'english') hasEnglish = true;
    if (language.category === 'simplified-chinese') hasSimplifiedChinese = true;
    if (
      language.category !== 'english' &&
      language.category !== 'simplified-chinese'
    ) continue;
    const previous = tracks.get(resource.trackId);
    if (
      previous !== undefined &&
      (previous.language !== resource.language || previous.kind !== resource.kind)
    ) return null;
    tracks.set(resource.trackId, {
      id: resource.trackId,
      language: resource.language,
      kind: resource.kind,
    });
  }
  if (!hasEnglish || !hasSimplifiedChinese) return null;
  return {
    type: 'catalog',
    titleId: routeTitleId,
    authority: 'authoritative',
    tracks: [...tracks.values()],
  };
}

function readWatchRouteTitleId(pathname: string | undefined): string | null {
  if (typeof pathname !== 'string') return null;
  const match = /^\/watch\/([^/?#]+)(?:[/?#]|$)/u.exec(pathname);
  const candidate = match?.[1];
  return candidate !== undefined &&
      candidate.length > 0 &&
      candidate.length <= 128 &&
      /^[A-Za-z0-9._:-]+$/u.test(candidate)
    ? candidate
    : null;
}

function resourceMatchesCatalog(
  resource: NetflixCatalogDownloadResource,
  catalog: NetflixCatalogPayload,
): boolean {
  return resolveCatalogTrack(resource, catalog) !== null;
}

function resolveCatalogTrack(
  resource: NetflixCatalogDownloadResource,
  catalog: NetflixCatalogPayload,
): NetflixCatalogTrackDescriptor | null {
  if (
    catalog.authority !== 'authoritative' ||
    resource.titleId !== catalog.titleId
  ) return null;
  const exact = catalog.tracks.find((track) =>
    track.id === resource.trackId &&
    track.kind === resource.kind &&
    normalizeLanguageForMatch(track.language) ===
      normalizeLanguageForMatch(resource.language));
  if (exact !== undefined) return exact;

  const resourceLanguage = normalizeNetflixLanguageTag(resource.language);
  if (
    resourceLanguage === null ||
    resourceLanguage.category === 'other'
  ) return null;
  const sameKindAndCategory = catalog.tracks.filter((track) =>
    track.kind === resource.kind &&
    normalizeNetflixLanguageTag(track.language)?.category ===
      resourceLanguage.category);
  const sameTag = sameKindAndCategory.filter((track) =>
    normalizeLanguageForMatch(track.language) ===
      normalizeLanguageForMatch(resource.language));
  if (sameTag.length === 1) return sameTag[0] ?? null;
  if (sameTag.length > 1) return null;
  return sameKindAndCategory.length === 1
    ? sameKindAndCategory[0] ?? null
    : null;
}

function normalizeLanguageForMatch(language: string): string {
  return normalizeNetflixLanguageTag(language)?.tag ??
    language.replaceAll('_', '-').toLowerCase();
}

function isTransientCatalogDownloadError(
  code: NetflixCatalogDownloadError['code'],
): boolean {
  return code === 'netflix_timed_text_fetch_failed' ||
    code === 'netflix_timed_text_http_error' ||
    code === 'netflix_timed_text_read_failed' ||
    code === 'netflix_timed_text_response_invalid';
}

function readMainRuntimeSentinel(
  target: object,
): MainWorldNetflixRuntime | undefined {
  try {
    const candidate = Reflect.get(target, MAIN_RUNTIME_SENTINEL) as unknown;
    if (
      typeof candidate === 'object' &&
      candidate !== null &&
      Reflect.get(candidate, 'version') === 1
    ) {
      const runtime = Reflect.get(candidate, 'runtime') as unknown;
      if (
        typeof runtime === 'object' &&
        runtime !== null &&
        typeof Reflect.get(runtime, 'dispose') === 'function'
      ) return runtime as MainWorldNetflixRuntime;
    }
  } catch {
    // A hostile page property leaves the runtime on its module-local fallback.
  }
  return undefined;
}

function writeMainRuntimeSentinel(
  target: object,
  runtime: MainWorldNetflixRuntime,
): void {
  try {
    const sentinel: MainRuntimeSentinel = Object.freeze({ version: 1, runtime });
    Object.defineProperty(target, MAIN_RUNTIME_SENTINEL, {
      configurable: true,
      enumerable: false,
      value: sentinel,
      writable: false,
    });
  } catch {
    // The module-local WeakMap still prevents duplicate ownership in this bundle.
  }
}

function clearMainRuntimeSentinel(
  target: object,
  runtime: MainWorldNetflixRuntime,
): void {
  try {
    const candidate = Reflect.get(target, MAIN_RUNTIME_SENTINEL) as unknown;
    if (
      typeof candidate === 'object' &&
      candidate !== null &&
      Reflect.get(candidate, 'runtime') === runtime
    ) Reflect.deleteProperty(target, MAIN_RUNTIME_SENTINEL);
  } catch {
    // Cleanup remains best-effort on a page-owned global object.
  }
}

function scheduleRepeating(
  task: () => void,
  intervalMs: number,
): () => void {
  const handle = globalThis.setInterval(task, intervalMs);
  return () => globalThis.clearInterval(handle);
}

function scheduleOnce(task: () => void, timeoutMs: number): () => void {
  const handle = globalThis.setTimeout(task, timeoutMs);
  return () => globalThis.clearTimeout(handle);
}

function postControl(
  target: NetflixRuntimeWindow,
  input: {
    readonly type: NetflixControlType;
    readonly nonce: string;
    readonly generation: number;
  },
): void {
  safePost(target, {
    protocol: NETFLIX_BRIDGE_PROTOCOL,
    version: NETFLIX_BRIDGE_VERSION,
    source: NETFLIX_CONTROL_SOURCE,
    type: input.type,
    nonce: input.nonce,
    generation: input.generation,
  });
}

function safePost(target: NetflixRuntimeWindow, data: unknown): void {
  try {
    target.postMessage(data, NETFLIX_PAGE_ORIGIN);
  } catch {
    // Bridge failure must leave the page's native behavior untouched.
  }
}

function isNonce(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length >= 16 &&
    value.length <= 128 &&
    /^[A-Za-z0-9._:-]+$/u.test(value)
  );
}

function isGeneration(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactlyKeys(
  value: Readonly<Record<string, unknown>>,
  expected: readonly string[],
): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && keys.every((key) => expected.includes(key));
}

function runtimeError(
  code: NetflixRuntimeError['code'],
): Result<never, NetflixRuntimeError> {
  return err({
    code,
    message: 'The Netflix probe runtime rejected an invalid request.',
    retryable: false,
  });
}
