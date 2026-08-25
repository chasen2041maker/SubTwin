import { err, ok, type AppError, type Result } from '../shared/result';
import {
  MAX_NETFLIX_BRIDGE_BYTES,
  type NetflixCatalogPayload,
  type NetflixCatalogTrackDescriptor,
} from './bridge';

export const MAX_TIMED_TEXT_BYTES = MAX_NETFLIX_BRIDGE_BYTES;
const MAX_TIMED_TEXT_SNIFF_PREFIX_BYTES = 4096;
const MAX_TIMED_TEXT_SNIFF_CHUNKS = 32;
const DEFAULT_METADATA_READ_TIMEOUT_MS = 5_000;
const MAX_METADATA_READ_TIMEOUT_MS = 30_000;
const READ_TIMEOUT = Symbol('subtwin-metadata-read-timeout');

const NETFLIX_HOST_SUFFIXES = [
  'netflix.com',
  'nflximg.net',
  'nflxso.net',
  'nflxvideo.net',
] as const;

const STABLE_RESOURCE_QUERY_KEYS = new Set([
  'lang',
  'language',
  'profile',
  'tlang',
  'trackid',
  'type',
]);

export type NetflixProbeError = AppError<
  | 'body_too_large'
  | 'body_read_timeout'
  | 'candidate_not_netflix'
  | 'candidate_not_timed_text'
  | 'media_response'
  | 'unsupported_content_type'
  | 'unsupported_payload'
  | 'unsupported_timed_text'
>;

export interface TimedTextResourceIdentity {
  readonly resourceId: string;
  readonly trackId: string;
  readonly language: string;
}

export interface NetflixCatalogTimedTextBinding {
  readonly titleId: string;
  readonly trackId: string;
  /** MAIN-world-only opaque profile discriminator. Never bridge the raw
   * Netflix text-profile name or a signed URL. */
  readonly variantId?: string;
}

/** A page-observed body is not bridge-ready until runtime binds it to an
 * authoritative Player title and matching track. */
export interface NetflixObservedTimedTextPayload {
  readonly type: 'timed-text';
  readonly resourceId: string;
  readonly trackId: string;
  readonly language: string;
  readonly format: 'ttml' | 'webvtt';
  readonly body: string;
}

export function canonicalizeNetflixTimedTextResource(
  input: string,
): Result<TimedTextResourceIdentity, NetflixProbeError> {
  let url: URL;
  try {
    url = new URL(input, 'https://www.netflix.com');
  } catch {
    return probeError('candidate_not_netflix');
  }

  if (
    url.protocol !== 'https:' ||
    url.username !== '' ||
    url.password !== '' ||
    (url.port !== '' && url.port !== '443') ||
    !isNetflixOwnedHost(url.hostname)
  ) {
    return probeError('candidate_not_netflix');
  }

  const path = url.pathname.toLowerCase();
  if (!/(?:timed[\-_]?text|subtitle|\.(?:dfxp|ttml|vtt)(?:$|\/))/.test(path)) {
    return probeError('candidate_not_timed_text');
  }

  const canonicalPath = url.pathname
    .replace(
      /\/(?:expires|hdnea|sig|signature|token)\/[^/]+/gi,
      '/{signed}',
    )
    .replace(
      /\/range\/(?:\d+[-,]\d+|\d+)(?=\/|$)/gi,
      '/range/{segment}',
    );
  const stableQuery = [...url.searchParams.entries()]
    .filter(([key, value]) => {
      const normalizedKey = key.toLowerCase();
      return (
        STABLE_RESOURCE_QUERY_KEYS.has(normalizedKey) &&
        value.length > 0 &&
        value.length <= 128 &&
        /^[A-Za-z0-9._:-]+$/.test(value)
      );
    })
    .map(([key, value]) => [key.toLowerCase(), value] as const)
    .sort(([leftKey, leftValue], [rightKey, rightValue]) =>
      compareCodeUnits(`${leftKey}=${leftValue}`, `${rightKey}=${rightValue}`),
    )
    .map(([key, value]) => `${key}=${value}`)
    .join('&');
  const canonical = `${netflixHostFamily(url.hostname)}${canonicalPath}${
    stableQuery === '' ? '' : `?${stableQuery}`
  }`;

  const resourceId = `tt_${hash64(canonical)}`;
  const languageHint = firstQueryValue(url, ['lang', 'language', 'tlang']);
  const normalizedLanguage = languageHint?.replaceAll('_', '-');
  const language = normalizedLanguage !== undefined &&
      /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/u.test(normalizedLanguage)
    ? normalizedLanguage
    : 'und';
  const trackHint = firstQueryValue(url, ['trackid']);
  const trackId = trackHint !== null && isOpaqueId(trackHint)
    ? trackHint
    : resourceId;

  return ok({ resourceId, trackId, language });
}

/** Accepts Netflix's opaque OCA root URL only after a validated text-track
 * catalog has bound it to a title and logical track. Direct network probing
 * intentionally continues to use the stricter path-based function above. */
export function canonicalizeNetflixCatalogTimedTextResource(
  input: string,
  binding: NetflixCatalogTimedTextBinding,
): Result<TimedTextResourceIdentity, NetflixProbeError> {
  if (
    !isOpaqueId(binding.titleId) ||
    !isOpaqueId(binding.trackId) ||
    (binding.variantId !== undefined && !isOpaqueId(binding.variantId))
  ) {
    return probeError('candidate_not_timed_text');
  }
  const strict = canonicalizeNetflixTimedTextResource(input);
  if (strict.ok) return strict;
  const oca = parseNetflixOcaTimedTextResource(input);
  if (oca === null) {
    return probeError('candidate_not_timed_text');
  }

  const resourceId = `tt_${hash64(
    `oca\u001f${binding.titleId}\u001f${binding.trackId}\u001f${
      binding.variantId ?? 'profile_default'
    }`,
  )}`;
  return ok({ resourceId, trackId: binding.trackId, language: 'und' });
}

/** Verifies that a response URL is still the approved resource without
 * retaining or exposing its signed URL. Strict path resources compare their
 * canonical IDs. OCA redirects may renew node/signature/expiry, but o/v are
 * the immutable media identity and must remain unique and equal. */
export function areEquivalentNetflixCatalogTimedTextResources(
  requested: string,
  final: string,
  binding: NetflixCatalogTimedTextBinding,
): boolean {
  if (
    !isOpaqueId(binding.titleId) ||
    !isOpaqueId(binding.trackId) ||
    (binding.variantId !== undefined && !isOpaqueId(binding.variantId))
  ) return false;

  const requestedStrict = canonicalizeNetflixTimedTextResource(requested);
  const finalStrict = canonicalizeNetflixTimedTextResource(final);
  if (requestedStrict.ok || finalStrict.ok) {
    return requestedStrict.ok &&
      finalStrict.ok &&
      requestedStrict.value.resourceId === finalStrict.value.resourceId;
  }

  const requestedOca = parseNetflixOcaTimedTextResource(requested);
  const finalOca = parseNetflixOcaTimedTextResource(final);
  return requestedOca !== null &&
    finalOca !== null &&
    requestedOca.objectId === finalOca.objectId &&
    requestedOca.videoId === finalOca.videoId;
}

function resolveObservedTimedTextIdentity(
  requested: string,
  final: string | undefined | null,
  binding?: NetflixCatalogTimedTextBinding,
): TimedTextResourceIdentity | null {
  if (binding === undefined) {
    const requestedIdentity = canonicalizeNetflixTimedTextResource(requested);
    if (requestedIdentity.ok) {
      if (final === undefined || final === null || final.length === 0) {
        return requestedIdentity.value;
      }
      const finalIdentity = canonicalizeNetflixTimedTextResource(final);
      return finalIdentity.ok ? finalIdentity.value : null;
    }
    const requestedOca = parseNetflixOcaTimedTextResource(requested);
    if (requestedOca === null) return null;
    if (final !== undefined && final !== null && final.length > 0) {
      const finalOca = parseNetflixOcaTimedTextResource(final);
      if (
        finalOca === null ||
        finalOca.objectId !== requestedOca.objectId ||
        finalOca.videoId !== requestedOca.videoId
      ) return null;
    }
    const identity = canonicalizeNetflixUnboundOcaTimedTextResource(requested);
    return identity.ok ? identity.value : null;
  }

  const requestedIdentity = canonicalizeNetflixCatalogTimedTextResource(
    requested,
    binding,
  );
  if (!requestedIdentity.ok) return null;
  if (
    final !== undefined &&
    final !== null &&
    final.length > 0 &&
    !areEquivalentNetflixCatalogTimedTextResources(requested, final, binding)
  ) return null;
  return {
    resourceId: requestedIdentity.value.resourceId,
    trackId: binding.trackId,
    language: 'und',
  };
}

interface NetflixOcaTimedTextIdentity {
  readonly objectId: string;
  readonly videoId: string;
}

function parseNetflixOcaTimedTextResource(
  input: string,
): NetflixOcaTimedTextIdentity | null {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return null;
  }
  const normalizedHost = url.hostname.toLowerCase().replace(/\.$/u, '');
  if (
    input.length > 8_192 ||
    url.protocol !== 'https:' ||
    url.username !== '' ||
    url.password !== '' ||
    (url.port !== '' && url.port !== '443') ||
    (normalizedHost !== 'oca.nflxvideo.net' &&
      !normalizedHost.endsWith('.oca.nflxvideo.net')) ||
    url.pathname !== '/' ||
    url.hash !== '' ||
    [...url.searchParams].length > 16
  ) return null;

  const objectId = uniqueBoundedQueryValue(url, 'o');
  const videoId = uniqueBoundedQueryValue(url, 'v');
  const expiry = boundedQueryValue(url, 'e');
  return objectId === null || videoId === null || expiry === null
    ? null
    : { objectId, videoId };
}

export function canonicalizeNetflixUnboundOcaTimedTextResource(
  input: string,
): Result<TimedTextResourceIdentity, NetflixProbeError> {
  const identity = parseNetflixOcaTimedTextResource(input);
  if (identity === null) return probeError('candidate_not_timed_text');
  const digest = hash64(
    `oca-unbound\u001f${identity.objectId}\u001f${identity.videoId}`,
  );
  return ok({
    resourceId: `tt_${digest}`,
    trackId: `oca_${digest}`,
    language: 'und',
  });
}

function uniqueBoundedQueryValue(url: URL, key: string): string | null {
  const values = url.searchParams.getAll(key);
  return values.length === 1 && isBoundedQueryValue(values[0])
    ? values[0] ?? null
    : null;
}

function boundedQueryValue(url: URL, key: string): string | null {
  const value = url.searchParams.get(key);
  return isBoundedQueryValue(value) ? value : null;
}

function isBoundedQueryValue(value: string | null | undefined): value is string {
  return value !== null &&
    value !== undefined &&
    value.length > 0 &&
    value.length <= 2_048;
}

export function sniffTimedText(input: {
  readonly contentType: string | null;
  readonly contentLength: number | null;
  readonly firstChunk: string | Uint8Array;
  readonly maxBytes?: number;
}): Result<{ readonly format: 'ttml' | 'webvtt' }, NetflixProbeError> {
  const maxBytes = input.maxBytes ?? MAX_TIMED_TEXT_BYTES;
  const contentType = normalizeContentType(input.contentType);
  if (contentType.startsWith('audio/') || contentType.startsWith('video/')) {
    return probeError('media_response');
  }
  if (
    input.contentLength !== null &&
    (!Number.isSafeInteger(input.contentLength) ||
      input.contentLength < 0 ||
      input.contentLength > maxBytes)
  ) {
    return probeError('body_too_large');
  }
  if (!isInspectableContentType(contentType)) {
    return probeError('unsupported_content_type');
  }

  const firstChunk =
    typeof input.firstChunk === 'string'
      ? input.firstChunk
      : new TextDecoder().decode(input.firstChunk);
  if (new TextEncoder().encode(firstChunk).byteLength > maxBytes) {
    return probeError('body_too_large');
  }
  const prefix = firstChunk.replace(/^\uFEFF/, '').trimStart();
  if (/^WEBVTT(?:[\t \r\n]|$)/.test(prefix)) {
    return ok({ format: 'webvtt' });
  }
  if (/^(?:<\?xml[^>]*>\s*)?<(?:[A-Za-z][\w.-]*:)?tt(?:\s|>)/i.test(prefix)) {
    return ok({ format: 'ttml' });
  }
  return probeError('unsupported_timed_text');
}

export interface ProbeHeadersLike {
  get(name: string): string | null;
}

export interface ProbeReadableStreamLike {
  getReader(): {
    read(): Promise<{ readonly done: boolean; readonly value?: Uint8Array }>;
    cancel?(reason?: unknown): Promise<unknown>;
  };
}

export interface ProbeResponseLike {
  readonly url?: string;
  readonly headers: ProbeHeadersLike;
  readonly body?: ProbeReadableStreamLike | null;
  clone(): ProbeResponseLike;
  text?(): Promise<string>;
  arrayBuffer?(): Promise<ArrayBuffer>;
}

export interface FetchTargetLike {
  fetch(this: FetchTargetLike, ...args: unknown[]): Promise<ProbeResponseLike>;
}

export interface JsonParseTargetLike {
  parse: JSON['parse'];
}

export interface ProbeInstallation {
  dispose(): void;
}

export type NetflixCatalogProbeDiagnosticCode =
  | 'metadata_candidate_observed'
  | 'metadata_body_read_failed'
  | 'metadata_body_timeout'
  | 'metadata_body_too_large'
  | 'metadata_body_unsupported'
  | 'metadata_catalog_recognized'
  | 'metadata_catalog_unrecognized'
  | 'metadata_json_parsed'
  | 'metadata_json_invalid'
  | 'metadata_response_accepted'
  | 'metadata_xhr_json_unsupported';

export interface NetworkProbeOptions {
  readonly generation: number;
  readonly currentGeneration: () => number;
  readonly onTimedText: (payload: NetflixObservedTimedTextPayload) => void;
  /** Snapshotted when a request starts. Only supplied while runtime is
   * intentionally switching to an authoritative Player text track. */
  readonly currentTimedTextBinding?: () => NetflixCatalogTimedTextBinding | undefined;
  readonly onTimedTextCandidate?: (event: {
    readonly bound: boolean;
    readonly outcome: string;
    readonly responseType: string;
    readonly stage: 'loaded' | 'request';
    readonly transport: 'fetch' | 'xhr';
  }) => void;
  readonly onCatalog?: (payload: NetflixCatalogPayload) => void;
  /** MAIN-world only. Raw metadata must never be bridged, logged, or persisted. */
  readonly onCatalogMetadata?: (metadata: unknown) => void;
  readonly onDiagnostic?: (code: NetflixCatalogProbeDiagnosticCode) => void;
  readonly metadataReadTimeoutMs?: number;
  readonly maxBytes?: number;
  readonly schedule?: (task: () => void) => void;
}

interface ResolvedNetworkProbeOptions {
  readonly generation: number;
  readonly currentGeneration: () => number;
  readonly onTimedText: (payload: NetflixObservedTimedTextPayload) => void;
  readonly currentTimedTextBinding: () => NetflixCatalogTimedTextBinding | undefined;
  readonly onTimedTextCandidate: (event: {
    readonly bound: boolean;
    readonly outcome: string;
    readonly responseType: string;
    readonly stage: 'loaded' | 'request';
    readonly transport: 'fetch' | 'xhr';
  }) => void;
  readonly onCatalog: (payload: NetflixCatalogPayload) => void;
  readonly onCatalogMetadata: (metadata: unknown) => void;
  readonly onDiagnostic: (code: NetflixCatalogProbeDiagnosticCode) => void;
  readonly metadataReadTimeoutMs: number;
  readonly maxBytes: number;
  readonly schedule: (task: () => void) => void;
}

function snapshotProbeOptions(
  options: NetworkProbeOptions,
): ResolvedNetworkProbeOptions {
  return {
    generation: options.generation,
    currentGeneration: options.currentGeneration,
    onTimedText: options.onTimedText,
    currentTimedTextBinding: options.currentTimedTextBinding ?? (() => undefined),
    onTimedTextCandidate: options.onTimedTextCandidate ?? (() => undefined),
    onCatalog: options.onCatalog ?? (() => undefined),
    onCatalogMetadata: options.onCatalogMetadata ?? (() => undefined),
    onDiagnostic: options.onDiagnostic ?? (() => undefined),
    metadataReadTimeoutMs: normalizeMetadataReadTimeout(
      options.metadataReadTimeoutMs,
    ),
    maxBytes: options.maxBytes ?? MAX_TIMED_TEXT_BYTES,
    schedule: options.schedule ?? queueMicrotask,
  };
}

function readCurrentTimedTextBinding(
  options: ResolvedNetworkProbeOptions,
): NetflixCatalogTimedTextBinding | undefined {
  try {
    return options.currentTimedTextBinding();
  } catch {
    return undefined;
  }
}

interface FetchPatch {
  readonly handle: ProbeInstallation;
  readonly wrapped: FetchTargetLike['fetch'];
  update(options: NetworkProbeOptions): void;
}

const FETCH_PATCHES = new WeakMap<object, FetchPatch>();

interface JsonParsePatch {
  readonly handle: ProbeInstallation;
  readonly wrapped: JSON['parse'];
  update(options: NetworkProbeOptions): void;
}

const JSON_PARSE_PATCHES = new WeakMap<object, JsonParsePatch>();

/** Observes only Netflix's decrypted, manifest-shaped JSON result. */
export function installJsonParseProbe(
  target: JsonParseTargetLike,
  options: NetworkProbeOptions,
): ProbeInstallation {
  const existing = JSON_PARSE_PATCHES.get(target);
  if (existing !== undefined && target.parse === existing.wrapped) {
    existing.update(options);
    return existing.handle;
  }

  const originalParse = target.parse;
  let currentOptions = snapshotProbeOptions(options);
  let active = true;
  const wrapped: JSON['parse'] = function parse(this: unknown, text, reviver) {
    const parsed = Reflect.apply(originalParse, this, [text, reviver]) as unknown;
    try {
      if (!isLikelyDecryptedNetflixManifest(parsed)) return parsed;
      const observedOptions = currentOptions;
      observedOptions.schedule(() => {
        if (!isCurrent(observedOptions)) return;
        try {
          safeEmit(observedOptions.onDiagnostic, 'metadata_json_parsed');
          const catalog = extractCatalogObservation(parsed, {
            allowSyntheticAuthoritative: false,
          });
          if (!catalog.ok) {
            safeEmit(
              observedOptions.onDiagnostic,
              'metadata_catalog_unrecognized',
            );
            return;
          }
          safeEmit(
            observedOptions.onDiagnostic,
            'metadata_catalog_recognized',
          );
          safeEmit(observedOptions.onCatalogMetadata, parsed);
          safeEmit(observedOptions.onCatalog, catalog.value);
        } catch {
          // Parsed metadata observation must never alter Netflix's JSON result.
        }
      });
    } catch {
      // Detection is advisory and must never alter JSON.parse semantics.
    }
    return parsed;
  };

  const handle: ProbeInstallation = {
    dispose() {
      if (!active) return;
      active = false;
      if (target.parse === wrapped) target.parse = originalParse;
      if (JSON_PARSE_PATCHES.get(target)?.handle === handle) {
        JSON_PARSE_PATCHES.delete(target);
      }
    },
  };
  function isCurrent(observedOptions: ResolvedNetworkProbeOptions): boolean {
    if (!active || observedOptions !== currentOptions) return false;
    try {
      return observedOptions.currentGeneration() === observedOptions.generation;
    } catch {
      return false;
    }
  }

  JSON_PARSE_PATCHES.set(target, {
    handle,
    wrapped,
    update(nextOptions) {
      currentOptions = snapshotProbeOptions(nextOptions);
    },
  });
  target.parse = wrapped;
  return handle;
}

export function installFetchProbe(
  target: FetchTargetLike,
  options: NetworkProbeOptions,
): ProbeInstallation {
  const existing = FETCH_PATCHES.get(target);
  if (existing !== undefined && target.fetch === existing.wrapped) {
    existing.update(options);
    return existing.handle;
  }

  const originalFetch = target.fetch;
  let currentOptions = snapshotProbeOptions(options);
  let active = true;

  const wrapped: FetchTargetLike['fetch'] = function (
    this: FetchTargetLike,
    ...args
  ) {
    const observedOptions = currentOptions;
    const candidate = candidateUrl(args[0], undefined);
    const binding = readCurrentTimedTextBinding(observedOptions);
    const originalPromise = originalFetch.apply(this, args);
    void originalPromise.then(
      (response) => {
        try {
          if (!isCurrent(observedOptions)) return;
          if (candidate === null) return;
          const metadataCandidate = isNetflixMetadataCandidate(candidate);
          if (metadataCandidate) {
            safeEmit(
              observedOptions.onDiagnostic,
              'metadata_candidate_observed',
            );
          }
          const prepared = prepareFetchResponse(
            response,
            candidate,
            response.url,
            observedOptions.maxBytes,
            binding,
          );
          if (prepared === null) {
            const catalog = prepareCatalogFetchResponse(
              response,
              candidate,
              response.url,
              observedOptions.maxBytes,
            );
            if (catalog === null) return;
            safeEmit(
              observedOptions.onDiagnostic,
              'metadata_response_accepted',
            );
            observedOptions.schedule(() => {
              if (!isCurrent(observedOptions)) return;
              void inspectCatalogFetchResponse(
                catalog,
                observedOptions.maxBytes,
                observedOptions.metadataReadTimeoutMs,
                observedOptions.onDiagnostic,
              ).then(
                (inspected) => {
                  if (inspected !== null && isCurrent(observedOptions)) {
                    safeEmit(
                      observedOptions.onCatalogMetadata,
                      inspected.metadata,
                    );
                    safeEmit(observedOptions.onCatalog, inspected.payload);
                  }
                },
                () => {
                  safeEmit(
                    observedOptions.onDiagnostic,
                    'metadata_body_read_failed',
                  );
                },
              );
            });
            return;
          }
          safeEmit(observedOptions.onTimedTextCandidate, {
            bound: binding !== undefined,
            outcome: 'pending',
            responseType: 'response',
            stage: 'request',
            transport: 'fetch',
          });
          observedOptions.schedule(() => {
            if (!isCurrent(observedOptions)) return;
            void inspectFetchResponse(prepared, observedOptions.maxBytes).then(
              (payload) => {
                if (payload !== null && isCurrent(observedOptions)) {
                  safeEmit(observedOptions.onTimedText, payload);
                }
              },
              () => undefined,
            );
          });
        } catch {
          // Observation failures must never reject or alter Netflix's fetch.
        }
      },
      () => undefined,
    );
    return originalPromise;
  };

  const handle: ProbeInstallation = {
    dispose() {
      if (!active) return;
      active = false;
      if (target.fetch === wrapped) target.fetch = originalFetch;
      if (FETCH_PATCHES.get(target)?.handle === handle) FETCH_PATCHES.delete(target);
    },
  };
  function isCurrent(observedOptions: ResolvedNetworkProbeOptions): boolean {
    if (!active || observedOptions !== currentOptions) return false;
    try {
      return observedOptions.currentGeneration() === observedOptions.generation;
    } catch {
      return false;
    }
  }

  FETCH_PATCHES.set(target, {
    handle,
    wrapped,
    update(nextOptions) {
      currentOptions = snapshotProbeOptions(nextOptions);
    },
  });
  target.fetch = wrapped;
  return handle;
}

interface PreparedFetchResponse {
  readonly clone: ProbeResponseLike;
  readonly contentLength: number | null;
  readonly contentType: string | null;
  readonly resourceId: string;
  readonly trackId: string;
  readonly language: string;
  readonly requiresEmbeddedLanguage: boolean;
}

function prepareFetchResponse(
  response: ProbeResponseLike,
  requestedCandidate: string,
  finalCandidate: string | undefined,
  maxBytes: number,
  binding?: NetflixCatalogTimedTextBinding,
): PreparedFetchResponse | null {
  const identity = resolveObservedTimedTextIdentity(
    requestedCandidate,
    finalCandidate,
    binding,
  );
  if (identity === null) return null;
  const requiresEmbeddedLanguage = binding === undefined &&
    !canonicalizeNetflixTimedTextResource(requestedCandidate).ok;

  const contentType = response.headers.get('content-type');
  const normalizedType = normalizeContentType(contentType);
  if (
    normalizedType.startsWith('audio/') ||
    normalizedType.startsWith('video/') ||
    !isInspectableContentType(normalizedType)
  ) {
    return null;
  }
  const contentLength = parseContentLength(response.headers.get('content-length'));
  if (contentLength !== null && contentLength > maxBytes) return null;

  try {
    return {
      clone: response.clone(),
      contentLength,
      contentType,
      resourceId: identity.resourceId,
      trackId: identity.trackId,
      language: identity.language,
      requiresEmbeddedLanguage,
    };
  } catch {
    return null;
  }
}

async function inspectFetchResponse(
  response: PreparedFetchResponse,
  maxBytes: number,
): Promise<NetflixObservedTimedTextPayload | null> {
  const timedText = await readBoundedTimedText(
    response.clone,
    response.contentType,
    response.contentLength,
    maxBytes,
  );
  if (!timedText.ok) return null;
  const language = response.requiresEmbeddedLanguage
    ? extractNetflixTimedTextEmbeddedLanguage(timedText.value.body, timedText.value.format)
    : response.language;
  if (language === null) return null;

  return {
    type: 'timed-text',
    resourceId: response.resourceId,
    trackId: response.trackId,
    language,
    format: timedText.value.format,
    body: timedText.value.body,
  };
}

interface PreparedCatalogFetchResponse {
  readonly clone: ProbeResponseLike;
  readonly contentLength: number | null;
}

function prepareCatalogFetchResponse(
  response: ProbeResponseLike,
  requestedCandidate: string,
  finalCandidate: string | undefined,
  maxBytes: number,
): PreparedCatalogFetchResponse | null {
  if (!isNetflixMetadataCandidate(requestedCandidate)) return null;
  if (
    finalCandidate !== undefined &&
    finalCandidate.length > 0 &&
    !isNetflixMetadataCandidate(finalCandidate)
  ) {
    return null;
  }

  const contentType = normalizeContentType(response.headers.get('content-type'));
  if (contentType !== 'application/json' && contentType !== 'text/json') {
    return null;
  }
  const contentLength = parseContentLength(response.headers.get('content-length'));
  if (contentLength !== null && contentLength > maxBytes) return null;

  try {
    return { clone: response.clone(), contentLength };
  } catch {
    return null;
  }
}

async function inspectCatalogFetchResponse(
  response: PreparedCatalogFetchResponse,
  maxBytes: number,
  metadataReadTimeoutMs: number,
  emitDiagnostic: (code: NetflixCatalogProbeDiagnosticCode) => void,
): Promise<{
  readonly metadata: unknown;
  readonly payload: NetflixCatalogPayload;
} | null> {
  let body: Result<string, NetflixProbeError>;
  try {
    body = await readBoundedUtf8(
      response.clone,
      response.contentLength,
      maxBytes,
      metadataReadTimeoutMs,
    );
  } catch {
    safeEmit(emitDiagnostic, 'metadata_body_read_failed');
    return null;
  }
  if (!body.ok) {
    safeEmit(
      emitDiagnostic,
      body.error.code === 'body_read_timeout'
        ? 'metadata_body_timeout'
        : body.error.code === 'body_too_large'
          ? 'metadata_body_too_large'
          : 'metadata_body_unsupported',
    );
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(body.value) as unknown;
  } catch {
    safeEmit(emitDiagnostic, 'metadata_json_invalid');
    return null;
  }
  safeEmit(emitDiagnostic, 'metadata_json_parsed');
  const catalog = extractCatalogObservation(parsed, {
    allowSyntheticAuthoritative: false,
  });
  if (!catalog.ok) {
    safeEmit(emitDiagnostic, 'metadata_catalog_unrecognized');
    return null;
  }
  safeEmit(emitDiagnostic, 'metadata_catalog_recognized');
  return { metadata: parsed, payload: catalog.value };
}

async function readBoundedUtf8(
  response: ProbeResponseLike,
  contentLength: number | null,
  maxBytes: number,
  readTimeoutMs: number,
): Promise<Result<string, NetflixProbeError>> {
  if (response.body !== undefined && response.body !== null) {
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    const deadline = Date.now() + readTimeoutMs;
    for (;;) {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        void cancelReader(reader, 'SubTwin metadata read timeout');
        return probeError('body_read_timeout');
      }
      const next = await withReadTimeout(reader.read(), remainingMs);
      if (next === READ_TIMEOUT) {
        void cancelReader(reader, 'SubTwin metadata read timeout');
        return probeError('body_read_timeout');
      }
      if (next.done) break;
      if (next.value === undefined) continue;
      bytes += next.value.byteLength;
      if (bytes > maxBytes) {
        void cancelReader(reader, 'SubTwin metadata size limit');
        return probeError('body_too_large');
      }
      chunks.push(next.value);
    }
    const joined = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) {
      joined.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return ok(new TextDecoder().decode(joined));
  }

  if (contentLength === null || contentLength > maxBytes) {
    return probeError('body_too_large');
  }
  if (response.arrayBuffer !== undefined) {
    const body = await withReadTimeout(response.arrayBuffer(), readTimeoutMs);
    if (body === READ_TIMEOUT) return probeError('body_read_timeout');
    return body.byteLength <= maxBytes
      ? ok(new TextDecoder().decode(body))
      : probeError('body_too_large');
  }
  if (response.text !== undefined) {
    const body = await withReadTimeout(response.text(), readTimeoutMs);
    if (body === READ_TIMEOUT) return probeError('body_read_timeout');
    if (body.length > maxBytes) return probeError('body_too_large');
    return new TextEncoder().encode(body).byteLength <= maxBytes
      ? ok(body)
      : probeError('body_too_large');
  }
  return probeError('unsupported_payload');
}

async function withReadTimeout<Value>(
  operation: Promise<Value>,
  timeoutMs: number,
): Promise<Value | typeof READ_TIMEOUT> {
  let handle: ReturnType<typeof globalThis.setTimeout> | undefined;
  const timeout = new Promise<typeof READ_TIMEOUT>((resolve) => {
    handle = globalThis.setTimeout(() => resolve(READ_TIMEOUT), timeoutMs);
  });
  try {
    return await Promise.race([operation, timeout]);
  } finally {
    if (handle !== undefined) globalThis.clearTimeout(handle);
  }
}

async function readBoundedTimedText(
  response: ProbeResponseLike,
  contentType: string | null,
  contentLength: number | null,
  maxBytes: number,
): Promise<
  Result<
    { readonly body: string; readonly format: 'ttml' | 'webvtt' },
    NetflixProbeError
  >
> {
  if (response.body !== undefined && response.body !== null) {
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    const prefixChunks: Uint8Array[] = [];
    let bytes = 0;
    let prefixBytes = 0;
    let sniffReads = 0;
    let format: 'ttml' | 'webvtt' | undefined;

    while (format === undefined) {
      if (sniffReads >= MAX_TIMED_TEXT_SNIFF_CHUNKS) {
        await cancelReader(reader, 'SubTwin timed-text sniff limit');
        return probeError('unsupported_timed_text');
      }
      const next = await reader.read();
      sniffReads += 1;
      if (next.done) return probeError('unsupported_timed_text');
      if (next.value !== undefined) {
        bytes += next.value.byteLength;
        if (bytes > maxBytes) {
          await cancelReader(reader, 'SubTwin timed-text size limit');
          return probeError('body_too_large');
        }
        chunks.push(next.value);
        const remainingPrefix = MAX_TIMED_TEXT_SNIFF_PREFIX_BYTES - prefixBytes;
        if (remainingPrefix > 0) {
          const prefixPart = next.value.subarray(0, remainingPrefix);
          prefixChunks.push(prefixPart);
          prefixBytes += prefixPart.byteLength;
        }
      }

      const classification = classifyTimedTextPrefix(
        concatenateBytes(prefixChunks, prefixBytes),
        contentType,
        contentLength,
        maxBytes,
      );
      if (classification.state === 'matched') {
        format = classification.format;
      } else if (
        classification.state === 'unsupported' ||
        prefixBytes >= MAX_TIMED_TEXT_SNIFF_PREFIX_BYTES
      ) {
        await cancelReader(reader, 'SubTwin unsupported timed-text body');
        return probeError('unsupported_timed_text');
      }
    }

    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      if (next.value === undefined) continue;
      bytes += next.value.byteLength;
      if (bytes > maxBytes) {
        await cancelReader(reader, 'SubTwin timed-text size limit');
        return probeError('body_too_large');
      }
      chunks.push(next.value);
    }
    const body = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return ok({ body: new TextDecoder().decode(body), format });
  }

  if (contentLength === null) return probeError('unsupported_timed_text');

  if (response.arrayBuffer !== undefined) {
    const body = await response.arrayBuffer();
    if (body.byteLength > maxBytes) return probeError('body_too_large');
    const bytes = new Uint8Array(body);
    const sniffed = sniffTimedText({
      contentType,
      contentLength,
      firstChunk: bytes.subarray(0, 4096),
      maxBytes,
    });
    if (!sniffed.ok) return sniffed;
    return ok({ body: new TextDecoder().decode(bytes), format: sniffed.value.format });
  }
  if (response.text !== undefined) {
    const body = await response.text();
    if (new TextEncoder().encode(body).byteLength > maxBytes) {
      return probeError('body_too_large');
    }
    const sniffed = sniffTimedText({
      contentType,
      contentLength,
      firstChunk: body.slice(0, 4096),
      maxBytes,
    });
    if (!sniffed.ok) return sniffed;
    return ok({ body, format: sniffed.value.format });
  }
  return probeError('unsupported_timed_text');
}

type PrefixClassification =
  | { readonly state: 'incomplete' }
  | { readonly state: 'matched'; readonly format: 'ttml' | 'webvtt' }
  | { readonly state: 'unsupported' };

function classifyTimedTextPrefix(
  prefixBytes: Uint8Array,
  contentType: string | null,
  contentLength: number | null,
  maxBytes: number,
): PrefixClassification {
  const sniffed = sniffTimedText({
    contentType,
    contentLength,
    firstChunk: prefixBytes,
    maxBytes,
  });
  if (sniffed.ok) return { state: 'matched', format: sniffed.value.format };
  if (sniffed.error.code !== 'unsupported_timed_text') {
    return { state: 'unsupported' };
  }

  if (
    (prefixBytes.byteLength === 1 && prefixBytes[0] === 0xef) ||
    (prefixBytes.byteLength === 2 &&
      prefixBytes[0] === 0xef &&
      prefixBytes[1] === 0xbb)
  ) {
    return { state: 'incomplete' };
  }
  const prefix = new TextDecoder().decode(prefixBytes).replace(/^\uFEFF/, '').trimStart();
  if (prefix === '') return { state: 'incomplete' };
  const upper = prefix.toUpperCase();
  if ('WEBVTT'.startsWith(upper)) return { state: 'incomplete' };
  if ('<?XML'.startsWith(upper)) return { state: 'incomplete' };
  if (upper.startsWith('<?XML')) {
    const declarationEnd = prefix.indexOf('?>');
    if (declarationEnd === -1) return { state: 'incomplete' };
    return isPotentialTtmlRoot(prefix.slice(declarationEnd + 2))
      ? { state: 'incomplete' }
      : { state: 'unsupported' };
  }
  return isPotentialTtmlRoot(prefix)
    ? { state: 'incomplete' }
    : { state: 'unsupported' };
}

function isPotentialTtmlRoot(input: string): boolean {
  const prefix = input.trimStart();
  if (prefix === '') return true;
  if ('<TT'.startsWith(prefix.toUpperCase())) return true;
  return /^<[A-Za-z][\w.-]*:(?:t|tt)?$/i.test(prefix);
}

function concatenateBytes(chunks: readonly Uint8Array[], bytes: number): Uint8Array {
  const combined = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return combined;
}

function cancelReader(
  reader: ReturnType<ProbeReadableStreamLike['getReader']>,
  reason: string,
): void {
  try {
    const cancellation = reader.cancel?.(reason);
    if (cancellation !== undefined) {
      void cancellation.catch(() => undefined);
    }
  } catch {
    // Cancellation is best-effort and must not escape into the page.
  }
}

export interface XhrLike {
  readonly responseType: string;
  readonly response?: unknown;
  readonly responseText: string;
  readonly responseURL: string;
  addEventListener(type: string, listener: () => void, options?: unknown): void;
  removeEventListener?(type: string, listener: () => void): void;
  getResponseHeader(name: string): string | null;
}

export interface XhrPrototypeLike {
  open(this: object, ...args: unknown[]): unknown;
  send(this: object, ...args: unknown[]): unknown;
}

export interface XhrConstructorLike {
  readonly prototype: XhrPrototypeLike;
}

interface XhrPatch {
  readonly handle: ProbeInstallation;
  readonly open: XhrPrototypeLike['open'];
  readonly send: XhrPrototypeLike['send'];
  update(options: NetworkProbeOptions): void;
}

interface XhrRequestState {
  readonly candidate: string | null;
  binding: NetflixCatalogTimedTextBinding | undefined;
  listener: PendingXhrListener | null;
}

interface PendingXhrListener {
  readonly xhr: XhrLike;
  readonly state: XhrRequestState;
  readonly listener: () => void;
}

const XHR_PATCHES = new WeakMap<object, XhrPatch>();

export function installXhrProbe(
  constructor: XhrConstructorLike,
  options: NetworkProbeOptions,
): ProbeInstallation {
  const prototype = constructor.prototype;
  const existing = XHR_PATCHES.get(prototype);
  if (
    existing !== undefined &&
    prototype.open === existing.open &&
    prototype.send === existing.send
  ) {
    existing.update(options);
    return existing.handle;
  }

  const originalOpen = prototype.open;
  const originalSend = prototype.send;
  let currentOptions = snapshotProbeOptions(options);
  const metadata = new WeakMap<object, XhrRequestState>();
  const pendingListeners = new Set<PendingXhrListener>();
  let active = true;

  const patchedOpen: XhrPrototypeLike['open'] = function (this: object, ...args) {
    const previous = metadata.get(this);
    if (previous?.listener !== null && previous?.listener !== undefined) {
      detachListener(previous.listener);
    }
    const candidate = candidateUrl(args[1], undefined);
    metadata.set(this, { binding: undefined, candidate, listener: null });
    return originalOpen.apply(this, args);
  };
  const patchedSend: XhrPrototypeLike['send'] = function (this: object, ...args) {
    const xhr = this as unknown as XhrLike;
    const state = metadata.get(this);
    if (state !== undefined) {
      state.binding = readCurrentTimedTextBinding(currentOptions);
    }
    let entry: PendingXhrListener | null = null;
    const shouldObserve = state?.candidate !== null && state?.candidate !== undefined && (
      isNetflixMetadataCandidate(state.candidate) ||
      resolveObservedTimedTextIdentity(
        state.candidate,
        undefined,
        state.binding,
      ) !== null
    );
    if (state !== undefined && state.listener === null && shouldObserve) {
      const observedOptions = currentOptions;
      if (!isNetflixMetadataCandidate(state.candidate ?? '')) {
        safeEmit(observedOptions.onTimedTextCandidate, {
          bound: state.binding !== undefined,
          outcome: 'pending',
          responseType: xhr.responseType === '' ? 'text' : xhr.responseType,
          stage: 'request',
          transport: 'xhr',
        });
      }
      const listener = () => {
        if (entry !== null) detachListener(entry);
        try {
          observedOptions.schedule(() => {
            if (metadata.get(xhr as unknown as object) !== state) return;
            if (!isCurrent(observedOptions)) return;
            try {
              inspectLoadedXhr(
                xhr,
                state.candidate,
                observedOptions.maxBytes,
                observedOptions.onTimedText,
                observedOptions.onCatalog,
                observedOptions.onCatalogMetadata,
                observedOptions.onDiagnostic,
                state.binding,
                observedOptions.onTimedTextCandidate,
              );
            } catch {
              // Observation failures must never escape into Netflix callbacks.
            }
          });
        } catch {
          // A custom scheduler is untrusted page state; ignore its failure.
        }
      };
      entry = { xhr, state, listener };
      state.listener = entry;
      pendingListeners.add(entry);
      xhr.addEventListener('load', listener, { once: true });
    }
    try {
      return originalSend.apply(this, args);
    } catch (error) {
      if (entry !== null) detachListener(entry);
      throw error;
    }
  };

  const handle: ProbeInstallation = {
    dispose() {
      if (!active) return;
      active = false;
      for (const entry of [...pendingListeners]) detachListener(entry);
      if (prototype.open === patchedOpen) prototype.open = originalOpen;
      if (prototype.send === patchedSend) prototype.send = originalSend;
      if (XHR_PATCHES.get(prototype)?.handle === handle) XHR_PATCHES.delete(prototype);
    },
  };
  function detachListener(entry: PendingXhrListener): void {
    pendingListeners.delete(entry);
    if (entry.state.listener === entry) entry.state.listener = null;
    try {
      entry.xhr.removeEventListener?.('load', entry.listener);
    } catch {
      // Listener cleanup is best-effort; the active/token checks still discard it.
    }
  }
  function isCurrent(observedOptions: ResolvedNetworkProbeOptions): boolean {
    if (!active || observedOptions !== currentOptions) return false;
    try {
      return observedOptions.currentGeneration() === observedOptions.generation;
    } catch {
      return false;
    }
  }

  XHR_PATCHES.set(prototype, {
    handle,
    open: patchedOpen,
    send: patchedSend,
    update(nextOptions) {
      currentOptions = snapshotProbeOptions(nextOptions);
    },
  });
  prototype.open = patchedOpen;
  prototype.send = patchedSend;
  return handle;
}

function inspectLoadedXhr(
  xhr: XhrLike,
  openedCandidate: string | null,
  maxBytes: number,
  emit: (payload: NetflixObservedTimedTextPayload) => void,
  emitCatalog: (payload: NetflixCatalogPayload) => void,
  emitCatalogMetadata: (metadata: unknown) => void,
  emitDiagnostic: (code: NetflixCatalogProbeDiagnosticCode) => void,
  binding?: NetflixCatalogTimedTextBinding,
  emitTimedTextCandidate: ResolvedNetworkProbeOptions['onTimedTextCandidate'] = () => undefined,
): void {
  if (openedCandidate === null) return;
  const finalCandidate = candidateUrl(xhr.responseURL, undefined);
  const metadataCandidate = isNetflixMetadataCandidate(openedCandidate);
  if (metadataCandidate) {
    safeEmit(emitDiagnostic, 'metadata_candidate_observed');
  }
  const openedIdentity = metadataCandidate
    ? null
    : resolveObservedTimedTextIdentity(openedCandidate, finalCandidate, binding);
  if (!metadataCandidate && openedIdentity === null) {
    safeEmit(emitTimedTextCandidate, {
      bound: binding !== undefined,
      outcome: 'identity_rejected',
      responseType: xhr.responseType === '' ? 'text' : xhr.responseType,
      stage: 'loaded',
      transport: 'xhr',
    });
    return;
  }
  if (finalCandidate !== null) {
    if (metadataCandidate) {
      if (!isNetflixMetadataCandidate(finalCandidate)) return;
    } else if (resolveObservedTimedTextIdentity(
      openedCandidate,
      finalCandidate,
      binding,
    ) === null) {
      safeEmit(emitTimedTextCandidate, {
        bound: binding !== undefined,
        outcome: 'redirect_rejected',
        responseType: xhr.responseType === '' ? 'text' : xhr.responseType,
        stage: 'loaded',
        transport: 'xhr',
      });
      return;
    }
  }

  const contentType = xhr.getResponseHeader('content-type');
  const normalizedType = normalizeContentType(contentType);
  if (normalizedType.startsWith('audio/') || normalizedType.startsWith('video/')) {
    if (metadataCandidate) {
      safeEmit(emitDiagnostic, 'metadata_body_unsupported');
    }
    if (!metadataCandidate) safeEmit(emitTimedTextCandidate, {
      bound: binding !== undefined,
      outcome: 'media_rejected',
      responseType: xhr.responseType === '' ? 'text' : xhr.responseType,
      stage: 'loaded',
      transport: 'xhr',
    });
    return;
  }
  const contentLength = parseContentLength(xhr.getResponseHeader('content-length'));
  if (contentLength !== null && contentLength > maxBytes) {
    if (metadataCandidate) {
      safeEmit(emitDiagnostic, 'metadata_body_too_large');
    }
    if (!metadataCandidate) safeEmit(emitTimedTextCandidate, {
      bound: binding !== undefined,
      outcome: 'size_rejected',
      responseType: xhr.responseType === '' ? 'text' : xhr.responseType,
      stage: 'loaded',
      transport: 'xhr',
    });
    return;
  }

  if (metadataCandidate && xhr.responseType === 'json') {
    if (normalizedType !== 'application/json' && normalizedType !== 'text/json') {
      safeEmit(emitDiagnostic, 'metadata_body_unsupported');
      return;
    }
    safeEmit(emitDiagnostic, 'metadata_response_accepted');
    let parsed: unknown;
    try {
      parsed = xhr.response;
    } catch {
      safeEmit(emitDiagnostic, 'metadata_body_read_failed');
      return;
    }
    safeEmit(emitDiagnostic, 'metadata_json_parsed');
    const catalog = extractCatalogObservation(parsed, {
      allowSyntheticAuthoritative: false,
    });
    if (catalog.ok) {
      safeEmit(emitDiagnostic, 'metadata_catalog_recognized');
      safeEmit(emitCatalogMetadata, parsed);
      safeEmit(emitCatalog, catalog.value);
    } else {
      safeEmit(emitDiagnostic, 'metadata_catalog_unrecognized');
    }
    return;
  }
  if (!metadataCandidate && xhr.responseType === 'arraybuffer') {
    if (openedIdentity === null) return;
    let rawBody: unknown;
    try {
      rawBody = xhr.response;
    } catch {
      return;
    }
    if (!(rawBody instanceof ArrayBuffer) || rawBody.byteLength > maxBytes) return;
    const bytes = new Uint8Array(rawBody);
    const sniffed = sniffTimedText({
      contentType,
      contentLength,
      firstChunk: bytes.subarray(0, MAX_TIMED_TEXT_SNIFF_PREFIX_BYTES),
      maxBytes,
    });
    if (!sniffed.ok) return;
    const body = new TextDecoder().decode(bytes);
    const language = binding === undefined &&
        !canonicalizeNetflixTimedTextResource(openedCandidate).ok
      ? extractNetflixTimedTextEmbeddedLanguage(body, sniffed.value.format)
      : openedIdentity.language;
    if (language === null) return;
    safeEmit(emitTimedTextCandidate, {
      bound: binding !== undefined,
      outcome: 'accepted',
      responseType: 'arraybuffer',
      stage: 'loaded',
      transport: 'xhr',
    });
    safeEmit(emit, {
      type: 'timed-text',
      resourceId: openedIdentity.resourceId,
      trackId: openedIdentity.trackId,
      language,
      format: sniffed.value.format,
      body,
    });
    return;
  }
  if (xhr.responseType !== '' && xhr.responseType !== 'text') {
    if (!metadataCandidate) safeEmit(emitTimedTextCandidate, {
      bound: binding !== undefined,
      outcome: 'response_type_rejected',
      responseType: xhr.responseType,
      stage: 'loaded',
      transport: 'xhr',
    });
    return;
  }

  let body: string;
  try {
    body = xhr.responseText;
  } catch {
    if (metadataCandidate) {
      safeEmit(emitDiagnostic, 'metadata_body_read_failed');
    }
    return;
  }
  if (
    body.length > maxBytes ||
    new TextEncoder().encode(body).byteLength > maxBytes
  ) {
    if (metadataCandidate) {
      safeEmit(emitDiagnostic, 'metadata_body_too_large');
    }
    return;
  }

  if (metadataCandidate) {
    if (normalizedType !== 'application/json' && normalizedType !== 'text/json') {
      safeEmit(emitDiagnostic, 'metadata_body_unsupported');
      return;
    }
    safeEmit(emitDiagnostic, 'metadata_response_accepted');
    let parsed: unknown;
    try {
      parsed = JSON.parse(body) as unknown;
    } catch {
      safeEmit(emitDiagnostic, 'metadata_json_invalid');
      return;
    }
    safeEmit(emitDiagnostic, 'metadata_json_parsed');
    const catalog = extractCatalogObservation(parsed, {
      allowSyntheticAuthoritative: false,
    });
    if (catalog.ok) {
      safeEmit(emitDiagnostic, 'metadata_catalog_recognized');
      safeEmit(emitCatalogMetadata, parsed);
      safeEmit(emitCatalog, catalog.value);
    } else {
      safeEmit(emitDiagnostic, 'metadata_catalog_unrecognized');
    }
    return;
  }

  if (openedIdentity === null) return;
  const identity = openedIdentity;

  const sniffed = sniffTimedText({
    contentType,
    contentLength,
    firstChunk: body.slice(0, 4096),
    maxBytes,
  });
  if (!sniffed.ok) {
    safeEmit(emitTimedTextCandidate, {
      bound: binding !== undefined,
      outcome: sniffed.error.code,
      responseType: 'text',
      stage: 'loaded',
      transport: 'xhr',
    });
    return;
  }
  const language = binding === undefined &&
      !canonicalizeNetflixTimedTextResource(openedCandidate).ok
    ? extractNetflixTimedTextEmbeddedLanguage(body, sniffed.value.format)
    : identity.language;
  if (language === null) {
    safeEmit(emitTimedTextCandidate, {
      bound: binding !== undefined,
      outcome: 'language_rejected',
      responseType: 'text',
      stage: 'loaded',
      transport: 'xhr',
    });
    return;
  }
  safeEmit(emitTimedTextCandidate, {
    bound: binding !== undefined,
    outcome: 'accepted',
    responseType: 'text',
    stage: 'loaded',
    transport: 'xhr',
  });
  safeEmit(emit, {
    type: 'timed-text',
    resourceId: identity.resourceId,
    trackId: identity.trackId,
    language,
    format: sniffed.value.format,
    body,
  });
}

export function extractNetflixTimedTextEmbeddedLanguage(
  body: string,
  format: 'ttml' | 'webvtt',
): string | null {
  if (format !== 'ttml') return null;
  const prefix = body.replace(/^\uFEFF/u, '').trimStart().slice(0, 8_192);
  const root = /^(?:<\?xml[^>]*>\s*)?<(?:[A-Za-z][\w.-]*:)?tt\b([^>]*)>/iu.exec(prefix);
  if (root === null) return null;
  const attributes = root[1] ?? '';
  const languages = [...attributes.matchAll(
    /(?:^|\s)xml:lang\s*=\s*(["'])([^"']+)\1/giu,
  )].map((match) => match[2]?.trim().replaceAll('_', '-'));
  const language = languages.length === 1 ? languages[0] : undefined;
  return language !== undefined &&
      language.length <= 35 &&
      /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/u.test(language)
    ? language
    : null;
}

export function extractCatalogObservation(
  input: unknown,
  options: { readonly allowSyntheticAuthoritative?: boolean } = {},
): Result<NetflixCatalogPayload, NetflixProbeError> {
  if (!isRecord(input)) {
    return probeError('unsupported_payload');
  }

  if (
    options.allowSyntheticAuthoritative !== false &&
    input.kind === 'subtwin-synthetic-catalog-v1' &&
    hasExactlyKeys(input, ['complete', 'kind', 'titleId', 'tracks']) &&
    typeof input.complete === 'boolean' &&
    isOpaqueId(input.titleId) &&
    Array.isArray(input.tracks) &&
    input.tracks.length <= 256 &&
    input.tracks.every(isTrackDescriptor)
  ) {
    return ok({
      type: 'catalog',
      titleId: input.titleId,
      authority: input.complete ? 'authoritative' : 'provisional',
      tracks: input.tracks as NetflixCatalogTrackDescriptor[],
    });
  }

  if (
    options.allowSyntheticAuthoritative !== false &&
    input.kind === 'subtwin-synthetic-track-v1' &&
    hasExactlyKeys(input, ['kind', 'titleId', 'track']) &&
    isOpaqueId(input.titleId) &&
    isTrackDescriptor(input.track)
  ) {
    return ok({
      type: 'catalog',
      titleId: input.titleId,
      authority: 'provisional',
      tracks: [input.track],
    });
  }

  const candidateArrays = findTrackCandidateArrays(input);
  const tracks = new Map<string, NetflixCatalogTrackDescriptor>();
  let candidateIndex = 0;
  for (const candidates of candidateArrays) {
    for (const candidate of candidates) {
      const descriptor = sanitizeObservedTrack(candidate, candidateIndex);
      candidateIndex += 1;
      if (descriptor === null) continue;
      const existing = tracks.get(descriptor.id);
      if (
        existing !== undefined &&
        (existing.language !== descriptor.language || existing.kind !== descriptor.kind)
      ) {
        const distinctId =
          `${descriptor.id}:${hash64(`${descriptor.language}\u001f${descriptor.kind}`).slice(0, 8)}`;
        tracks.set(distinctId, { ...descriptor, id: distinctId });
      } else {
        tracks.set(descriptor.id, descriptor);
      }
    }
  }

  if (tracks.size > 0) {
    return ok({
      type: 'catalog',
      titleId: findObservedTitleId(input) ?? 'unknown-title',
      // Unverified Netflix response shapes can establish presence, never absence.
      authority: 'provisional',
      tracks: [...tracks.values()].slice(0, 256),
    });
  }

  return probeError('unsupported_payload');
}

const TRACK_ARRAY_KEYS = new Set([
  'subtitletracks',
  'texttracks',
  'timedtexttracks',
]);

function findTrackCandidateArrays(root: unknown): readonly unknown[][] {
  const found: unknown[][] = [];
  const pending: Array<{ readonly value: unknown; readonly depth: number }> = [
    { value: root, depth: 0 },
  ];
  const visited = new Set<object>();
  let inspected = 0;

  while (pending.length > 0 && inspected < 2_048 && found.length < 16) {
    const current = pending.shift();
    if (current === undefined) break;
    inspected += 1;
    if (
      typeof current.value !== 'object' ||
      current.value === null ||
      visited.has(current.value) ||
      current.depth > 8
    ) continue;
    visited.add(current.value);

    if (Array.isArray(current.value)) {
      for (const entry of current.value.slice(0, 512)) {
        pending.push({ value: entry, depth: current.depth + 1 });
      }
      continue;
    }

    for (const [key, value] of Object.entries(current.value)) {
      const normalizedKey = key.replace(/[_-]/gu, '').toLowerCase();
      if (TRACK_ARRAY_KEYS.has(normalizedKey) && Array.isArray(value)) {
        found.push(value.slice(0, 256));
      } else {
        pending.push({ value, depth: current.depth + 1 });
      }
    }
  }
  return found;
}

function sanitizeObservedTrack(
  value: unknown,
  index: number,
): NetflixCatalogTrackDescriptor | null {
  if (!isRecord(value)) return null;
  const language = firstString(value, [
    'bcp47',
    'lang',
    'language',
    'languageCode',
  ]);
  if (
    language === null ||
    language.length > 35 ||
    !/^[A-Za-z]{2,8}(?:[-_][A-Za-z0-9]{1,8})*$/u.test(language)
  ) return null;
  const normalizedLanguage = language.replaceAll('_', '-');

  const rawId = firstStringOrSafeNumber(value, [
    'downloadableId',
    'id',
    'new_track_id',
    'trackId',
  ]);
  const id = rawId !== null && isOpaqueId(rawId)
    ? rawId
    : `observed-${hash64(`${normalizedLanguage}\u001f${index}`)}`;
  const rawKind = firstString(value, [
    'kind',
    'rawTrackType',
    'trackType',
    'type',
  ])?.toLowerCase();
  const kind = rawKind !== undefined &&
      (rawKind.includes('caption') || rawKind === 'cc')
    ? 'closed-caption'
    : 'subtitle';

  return { id, language: normalizedLanguage, kind };
}

function findObservedTitleId(value: unknown): string | null {
  if (!isRecord(value)) return null;
  const direct = firstStringOrSafeNumber(value, [
    'movieId',
    'titleId',
    'videoId',
  ]);
  if (direct !== null) {
    return isOpaqueId(direct) ? direct : `title-${hash64(direct)}`;
  }
  for (const child of Object.values(value).slice(0, 64)) {
    if (!isRecord(child)) continue;
    const nested = firstStringOrSafeNumber(child, [
      'movieId',
      'titleId',
      'videoId',
    ]);
    if (nested !== null) {
      return isOpaqueId(nested) ? nested : `title-${hash64(nested)}`;
    }
  }
  return null;
}

function firstString(
  value: Readonly<Record<string, unknown>>,
  keys: readonly string[],
): string | null {
  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === 'string' && candidate.trim().length > 0) {
      return candidate.trim();
    }
  }
  return null;
}

function firstStringOrSafeNumber(
  value: Readonly<Record<string, unknown>>,
  keys: readonly string[],
): string | null {
  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === 'string' && candidate.trim().length > 0) {
      return candidate.trim();
    }
    if (typeof candidate === 'number' && Number.isSafeInteger(candidate)) {
      return String(candidate);
    }
  }
  return null;
}

function isTrackDescriptor(value: unknown): value is NetflixCatalogTrackDescriptor {
  return (
    isRecord(value) &&
    hasExactlyKeys(value, ['id', 'kind', 'language']) &&
    isOpaqueId(value.id) &&
    typeof value.language === 'string' &&
    /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(value.language) &&
    (value.kind === 'subtitle' || value.kind === 'closed-caption')
  );
}

function candidateUrl(input: unknown, responseUrl: string | undefined): string | null {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return typeof responseUrl === 'string' && responseUrl.length > 0 ? responseUrl : null;
}

function firstQueryValue(
  url: URL,
  names: readonly string[],
): string | null {
  for (const [key, value] of url.searchParams) {
    if (
      names.includes(key.toLowerCase()) &&
      value.length > 0 &&
      value.length <= 128 &&
      /^[A-Za-z0-9._:-]+$/u.test(value)
    ) {
      return value;
    }
  }
  return null;
}

function isNetflixMetadataCandidate(input: string): boolean {
  let url: URL;
  try {
    url = new URL(input, 'https://www.netflix.com');
  } catch {
    return false;
  }
  const hasManifestSegment = url.pathname
    .split('/')
    .some((segment) =>
      /^(?:licensedmanifest|manifests?|metadata)(?:\.json)?$/iu.test(segment),
    );
  return (
    url.protocol === 'https:' &&
    url.username === '' &&
    url.password === '' &&
    (url.port === '' || url.port === '443') &&
    isNetflixOwnedHost(url.hostname) &&
    hasManifestSegment
  );
}

function isNetflixOwnedHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/\.$/, '');
  return NETFLIX_HOST_SUFFIXES.some(
    (suffix) => normalized === suffix || normalized.endsWith(`.${suffix}`),
  );
}

function netflixHostFamily(hostname: string): string {
  const normalized = hostname.toLowerCase().replace(/\.$/u, '');
  return NETFLIX_HOST_SUFFIXES.find(
    (suffix) => normalized === suffix || normalized.endsWith(`.${suffix}`),
  ) ?? normalized;
}

function normalizeContentType(value: string | null): string {
  return (value ?? '').split(';', 1)[0]?.trim().toLowerCase() ?? '';
}

function isInspectableContentType(value: string): boolean {
  return (
    value === '' ||
    value === 'application/octet-stream' ||
    value === 'application/ttml+xml' ||
    value === 'application/xml' ||
    value === 'text/plain' ||
    value === 'text/vtt' ||
    value === 'text/xml'
  );
}

function parseContentLength(value: string | null): number | null {
  if (value === null || !/^\d+$/.test(value.trim())) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function normalizeMetadataReadTimeout(value: number | undefined): number {
  return Number.isSafeInteger(value) &&
      value !== undefined &&
      value > 0 &&
      value <= MAX_METADATA_READ_TIMEOUT_MS
    ? value
    : DEFAULT_METADATA_READ_TIMEOUT_MS;
}

function isLikelyDecryptedNetflixManifest(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const resultDescriptor = Object.getOwnPropertyDescriptor(value, 'result');
  let candidate: unknown = resultDescriptor !== undefined && 'value' in resultDescriptor
    ? resultDescriptor.value
    : value;
  if (candidate === value) {
    const dataDescriptor = Object.getOwnPropertyDescriptor(value, 'data');
    const data = dataDescriptor !== undefined && 'value' in dataDescriptor
      ? dataDescriptor.value
      : undefined;
    if (isRecord(data)) {
      const nestedResultDescriptor = Object.getOwnPropertyDescriptor(data, 'result');
      if (nestedResultDescriptor !== undefined && 'value' in nestedResultDescriptor) {
        candidate = nestedResultDescriptor.value;
      }
    }
  }
  if (!isRecord(candidate)) return false;
  const tracksDescriptor = Object.getOwnPropertyDescriptor(
    candidate,
    'timedtexttracks',
  );
  if (
    tracksDescriptor === undefined ||
    !('value' in tracksDescriptor) ||
    !Array.isArray(tracksDescriptor.value)
  ) return false;
  return ['movieId', 'titleId', 'videoId'].some((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(candidate, key);
    return descriptor !== undefined && 'value' in descriptor;
  });
}

function isOpaqueId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 128 &&
    /^[A-Za-z0-9._:-]+$/.test(value)
  );
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

function hash64(value: string): string {
  return `${fnv1a(value, 0x811c9dc5)}${fnv1a([...value].reverse().join(''), 0x9e3779b9)}`;
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function fnv1a(value: string, seed: number): string {
  let hash = seed >>> 0;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

function safeEmit<Payload>(
  emit: (payload: Payload) => void,
  payload: Payload,
): void {
  try {
    emit(payload);
  } catch {
    // Page instrumentation must never affect Netflix playback.
  }
}

function probeError(code: NetflixProbeError['code']): Result<never, NetflixProbeError> {
  return err({
    code,
    message: 'The Netflix probe rejected an unsupported or unsafe candidate.',
    retryable: false,
  });
}
