import { err, ok, type AppError, type Result } from '../shared/result';
import { normalizeNetflixLanguageTag } from './adapter';
import {
  NETFLIX_BRIDGE_PROTOCOL,
  NETFLIX_BRIDGE_VERSION,
  NETFLIX_PAGE_ORIGIN,
  createEarlyBridgeQueue,
  parseNetflixBridgeEvent,
  type NetflixCatalogPayload,
  type NetflixBridgePayload,
  type NetflixWindowMessageEvent,
} from './bridge';
import {
  installFetchProbe,
  installXhrProbe,
  type FetchTargetLike,
  type NetworkProbeOptions,
  type ProbeInstallation,
  type XhrConstructorLike,
} from './probe';
import {
  readNetflixPlayerCatalog,
  type NetflixPlayerCatalogError,
} from './player-catalog';
import {
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
  readonly location: { readonly origin: string };
  fetch: FetchTargetLike['fetch'];
  readonly XMLHttpRequest: XhrConstructorLike;
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

type FetchInstaller = (
  target: FetchTargetLike,
  options: NetworkProbeOptions,
) => ProbeInstallation;
type XhrInstaller = (
  target: XhrConstructorLike,
  options: NetworkProbeOptions,
) => ProbeInstallation;

interface ActiveProbeSession {
  readonly nonce: string;
  readonly generation: number;
  readonly fetch: ProbeInstallation;
  readonly xhr: ProbeInstallation;
  readonly disposeQueue: () => void;
  readonly disposeCatalogPoll: () => void;
  readonly disposeCatalogDownloads: () => void;
  readonly queue: ReturnType<typeof createEarlyBridgeQueue>;
}

type PlayerCatalogReader = (
  target: unknown,
) => Result<NetflixCatalogPayload, NetflixPlayerCatalogError>;

type CatalogPollScheduler = (
  task: () => void,
  intervalMs: number,
) => () => void;

type CatalogResourceExtractor = (
  metadata: unknown,
) => Result<readonly NetflixCatalogDownloadResource[], NetflixCatalogDownloadError>;

type CatalogTimedTextDownloader = (
  fetcher: NetflixTimedTextFetch,
  resource: NetflixCatalogDownloadResource,
  options?: NetflixTimedTextDownloadOptions,
) => ReturnType<typeof downloadNetflixTimedText>;

const PLAYER_CATALOG_POLL_INTERVAL_MS = 1_500;
const CATALOG_DOWNLOAD_MAX_ATTEMPTS = 3;
const CATALOG_DOWNLOAD_RETRY_BASE_MS = 250;

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
  readonly readPlayerCatalog?: PlayerCatalogReader;
  readonly scheduleCatalogPoll?: CatalogPollScheduler;
  readonly extractCatalogResources?: CatalogResourceExtractor;
  readonly downloadCatalogTimedText?: CatalogTimedTextDownloader;
}): MainWorldNetflixRuntime {
  const globalRuntime = readMainRuntimeSentinel(options.window);
  if (globalRuntime !== undefined) return globalRuntime;
  const existing = MAIN_RUNTIMES.get(options.window);
  if (existing !== undefined) return existing;

  const installFetch = options.installFetch ?? installFetchProbe;
  const installXhr = options.installXhr ?? installXhrProbe;
  const readPlayerCatalog = options.readPlayerCatalog ?? readNetflixPlayerCatalog;
  const scheduleCatalogPoll = options.scheduleCatalogPoll ?? scheduleRepeating;
  const extractCatalogResources =
    options.extractCatalogResources ?? extractNetflixCatalogDownloadResources;
  const downloadCatalogTimedText =
    options.downloadCatalogTimedText ?? downloadNetflixTimedText;
  let disposed = false;
  let active: ActiveProbeSession | undefined;
  let highestGeneration = -1;

  const disposeActive = (): void => {
    const current = active;
    active = undefined;
    if (current === undefined) return;
    current.fetch.dispose();
    current.xhr.dispose();
    current.disposeCatalogPoll();
    current.disposeCatalogDownloads();
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
    const approvedObservedResources = new Map<
      string,
      NetflixCatalogDownloadResource
    >();
    const retryDownloads = new Map<string, {
      readonly cancel: () => void;
      readonly resource: NetflixCatalogDownloadResource;
    }>();
    let currentAuthoritativeCatalog: NetflixCatalogPayload | undefined;
    let nextActive: ActiveProbeSession | undefined;
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
      for (const [key, resource] of approvedObservedResources) {
        if (catalog === undefined || !resourceMatchesCatalog(resource, catalog)) {
          approvedObservedResources.delete(key);
        }
      }
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
      const fetcher: NetflixTimedTextFetch = (input, init) =>
        options.window.fetch.call(options.window, input, init) as unknown as ReturnType<NetflixTimedTextFetch>;
      const retry = (): void => {
        if (
          controller.signal.aborted ||
          attempt >= CATALOG_DOWNLOAD_MAX_ATTEMPTS ||
          disposed ||
          active !== nextActive
        ) return;
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
            if (isTransientCatalogDownloadError(result.error.code)) retry();
            return;
          }
          if (
            result.value.titleId === resource.titleId &&
            result.value.trackId === resource.trackId &&
            queue.publish(result.value, control.generation)
          ) {
            succeededDownloads.set(key, resource);
          }
        },
        () => {
          const state = inFlightDownloads.get(key);
          if (state?.controller !== controller) return;
          inFlightDownloads.delete(key);
          retry();
        },
      );
    };
    const onCatalogMetadata = (metadata: unknown): void => {
      if (disposed || nextActive === undefined || active !== nextActive) return;
      let extracted: ReturnType<CatalogResourceExtractor>;
      try {
        extracted = extractCatalogResources(metadata);
      } catch {
        return;
      }
      if (!extracted.ok) return;

      for (const resource of extracted.value) {
        const catalog = currentAuthoritativeCatalog;
        if (catalog === undefined || !resourceMatchesCatalog(resource, catalog)) {
          continue;
        }
        approvedObservedResources.set(observedResourceKey(resource), resource);
        startCatalogDownload(resource);
      }
    };
    const probeOptions: NetworkProbeOptions = {
      generation: control.generation,
      currentGeneration: () => active?.generation ?? highestGeneration,
      onTimedText: (payload) => {
        const catalog = currentAuthoritativeCatalog;
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
          { ...payload, titleId: resource.titleId },
          control.generation,
        );
      },
      onCatalog: (payload) => {
        queue.publish(payload, control.generation);
      },
      onCatalogMetadata,
    };

    let fetch: ProbeInstallation | undefined;
    let xhr: ProbeInstallation | undefined;
    try {
      fetch = installFetch(options.window, probeOptions);
      xhr = installXhr(options.window.XMLHttpRequest, probeOptions);
      let stopCatalogPoll: () => void = () => undefined;
      let lastCatalogSignature: string | undefined;
      nextActive = {
        nonce: control.nonce,
        generation: control.generation,
        fetch,
        xhr,
        disposeCatalogPoll: () => stopCatalogPoll(),
        disposeCatalogDownloads: () => {
          for (const { controller } of inFlightDownloads.values()) {
            controller.abort();
          }
          for (const { cancel } of retryDownloads.values()) cancel();
          inFlightDownloads.clear();
          retryDownloads.clear();
          succeededDownloads.clear();
          approvedObservedResources.clear();
        },
        disposeQueue,
        queue,
      };
      active = nextActive;

      const publishPlayerCatalog = (): void => {
        if (disposed || active !== nextActive) return;
        try {
          const result = readPlayerCatalog(options.window);
          if (!result.ok || result.value.authority !== 'authoritative') return;
          currentAuthoritativeCatalog = result.value;
          cancelInvalidDownloads();
          const signature = JSON.stringify(result.value);
          if (signature === lastCatalogSignature) return;
          if (queue.publish(result.value, control.generation)) {
            lastCatalogSignature = signature;
          }
        } catch {
          // A private Netflix API change keeps the conservative network gate locked.
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

function resourceMatchesCatalog(
  resource: NetflixCatalogDownloadResource,
  catalog: NetflixCatalogPayload,
): boolean {
  if (
    catalog.authority !== 'authoritative' ||
    resource.titleId !== catalog.titleId
  ) return false;
  return catalog.tracks.some((track) =>
    track.id === resource.trackId &&
    track.kind === resource.kind &&
    normalizeLanguageForMatch(track.language) ===
      normalizeLanguageForMatch(resource.language));
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
