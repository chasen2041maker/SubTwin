import { err, ok, type AppError, type Result } from '../shared/result';
import {
  MAX_NETFLIX_BRIDGE_BYTES,
  type NetflixCatalogPayload,
  type NetflixCatalogTrackDescriptor,
} from './bridge';

export const MAX_TIMED_TEXT_BYTES = MAX_NETFLIX_BRIDGE_BYTES;
const MAX_TIMED_TEXT_SNIFF_PREFIX_BYTES = 4096;
const MAX_TIMED_TEXT_SNIFF_CHUNKS = 32;

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

export interface ProbeInstallation {
  dispose(): void;
}

export interface NetworkProbeOptions {
  readonly generation: number;
  readonly currentGeneration: () => number;
  readonly onTimedText: (payload: NetflixObservedTimedTextPayload) => void;
  readonly onCatalog?: (payload: NetflixCatalogPayload) => void;
  /** MAIN-world only. Raw metadata must never be bridged, logged, or persisted. */
  readonly onCatalogMetadata?: (metadata: unknown) => void;
  readonly maxBytes?: number;
  readonly schedule?: (task: () => void) => void;
}

interface ResolvedNetworkProbeOptions {
  readonly generation: number;
  readonly currentGeneration: () => number;
  readonly onTimedText: (payload: NetflixObservedTimedTextPayload) => void;
  readonly onCatalog: (payload: NetflixCatalogPayload) => void;
  readonly onCatalogMetadata: (metadata: unknown) => void;
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
    onCatalog: options.onCatalog ?? (() => undefined),
    onCatalogMetadata: options.onCatalogMetadata ?? (() => undefined),
    maxBytes: options.maxBytes ?? MAX_TIMED_TEXT_BYTES,
    schedule: options.schedule ?? queueMicrotask,
  };
}

interface FetchPatch {
  readonly handle: ProbeInstallation;
  readonly wrapped: FetchTargetLike['fetch'];
  update(options: NetworkProbeOptions): void;
}

const FETCH_PATCHES = new WeakMap<object, FetchPatch>();

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
    const originalPromise = originalFetch.apply(this, args);
    void originalPromise.then(
      (response) => {
        try {
          if (!isCurrent(observedOptions)) return;
          const candidate = candidateUrl(args[0], undefined);
          if (candidate === null) return;
          const prepared = prepareFetchResponse(
            response,
            candidate,
            response.url,
            observedOptions.maxBytes,
          );
          if (prepared === null) {
            const catalog = prepareCatalogFetchResponse(
              response,
              candidate,
              response.url,
              observedOptions.maxBytes,
            );
            if (catalog === null) return;
            observedOptions.schedule(() => {
              if (!isCurrent(observedOptions)) return;
              void inspectCatalogFetchResponse(
                catalog,
                observedOptions.maxBytes,
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
                () => undefined,
              );
            });
            return;
          }
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
}

function prepareFetchResponse(
  response: ProbeResponseLike,
  requestedCandidate: string,
  finalCandidate: string | undefined,
  maxBytes: number,
): PreparedFetchResponse | null {
  const requestedIdentity = canonicalizeNetflixTimedTextResource(requestedCandidate);
  if (!requestedIdentity.ok) return null;
  let identity = requestedIdentity.value;
  if (finalCandidate !== undefined && finalCandidate.length > 0) {
    const finalIdentity = canonicalizeNetflixTimedTextResource(finalCandidate);
    if (!finalIdentity.ok) return null;
    identity = finalIdentity.value;
  }

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

  return {
    type: 'timed-text',
    resourceId: response.resourceId,
    trackId: response.trackId,
    language: response.language,
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
): Promise<{
  readonly metadata: unknown;
  readonly payload: NetflixCatalogPayload;
} | null> {
  const body = await readBoundedUtf8(
    response.clone,
    response.contentLength,
    maxBytes,
  );
  if (!body.ok) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(body.value) as unknown;
  } catch {
    return null;
  }
  const catalog = extractCatalogObservation(parsed, {
    allowSyntheticAuthoritative: false,
  });
  return catalog.ok ? { metadata: parsed, payload: catalog.value } : null;
}

async function readBoundedUtf8(
  response: ProbeResponseLike,
  contentLength: number | null,
  maxBytes: number,
): Promise<Result<string, NetflixProbeError>> {
  if (response.body !== undefined && response.body !== null) {
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      if (next.value === undefined) continue;
      bytes += next.value.byteLength;
      if (bytes > maxBytes) {
        await cancelReader(reader, 'SubTwin metadata size limit');
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
    const body = await response.arrayBuffer();
    return body.byteLength <= maxBytes
      ? ok(new TextDecoder().decode(body))
      : probeError('body_too_large');
  }
  if (response.text !== undefined) {
    const body = await response.text();
    if (body.length > maxBytes) return probeError('body_too_large');
    return new TextEncoder().encode(body).byteLength <= maxBytes
      ? ok(body)
      : probeError('body_too_large');
  }
  return probeError('unsupported_payload');
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

async function cancelReader(
  reader: ReturnType<ProbeReadableStreamLike['getReader']>,
  reason: string,
): Promise<void> {
  try {
    await reader.cancel?.(reason);
  } catch {
    // Cancellation is best-effort and must not escape into the page.
  }
}

export interface XhrLike {
  readonly responseType: string;
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
    metadata.set(this, { candidate, listener: null });
    return originalOpen.apply(this, args);
  };
  const patchedSend: XhrPrototypeLike['send'] = function (this: object, ...args) {
    const xhr = this as unknown as XhrLike;
    const state = metadata.get(this);
    let entry: PendingXhrListener | null = null;
    if (state !== undefined && state.listener === null) {
      const observedOptions = currentOptions;
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
): void {
  if (xhr.responseType !== '' && xhr.responseType !== 'text') return;
  if (openedCandidate === null) return;
  const finalCandidate = candidateUrl(xhr.responseURL, undefined);
  const metadataCandidate = isNetflixMetadataCandidate(openedCandidate);
  const openedIdentity = metadataCandidate
    ? null
    : canonicalizeNetflixTimedTextResource(openedCandidate);
  if (!metadataCandidate && (openedIdentity === null || !openedIdentity.ok)) {
    return;
  }
  if (finalCandidate !== null) {
    if (metadataCandidate) {
      if (!isNetflixMetadataCandidate(finalCandidate)) return;
    } else if (!canonicalizeNetflixTimedTextResource(finalCandidate).ok) {
      return;
    }
  }

  const contentType = xhr.getResponseHeader('content-type');
  const normalizedType = normalizeContentType(contentType);
  if (normalizedType.startsWith('audio/') || normalizedType.startsWith('video/')) {
    return;
  }
  const contentLength = parseContentLength(xhr.getResponseHeader('content-length'));
  if (contentLength !== null && contentLength > maxBytes) return;
  let body: string;
  try {
    body = xhr.responseText;
  } catch {
    return;
  }
  if (
    body.length > maxBytes ||
    new TextEncoder().encode(body).byteLength > maxBytes
  ) return;

  if (metadataCandidate) {
    if (normalizedType !== 'application/json' && normalizedType !== 'text/json') {
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(body) as unknown;
    } catch {
      return;
    }
    const catalog = extractCatalogObservation(parsed, {
      allowSyntheticAuthoritative: false,
    });
    if (catalog.ok) {
      safeEmit(emitCatalogMetadata, parsed);
      safeEmit(emitCatalog, catalog.value);
    }
    return;
  }

  if (openedIdentity === null || !openedIdentity.ok) return;
  let identity = openedIdentity.value;
  if (finalCandidate !== null) {
    const finalIdentity = canonicalizeNetflixTimedTextResource(finalCandidate);
    if (!finalIdentity.ok) return;
    identity = finalIdentity.value;
  }

  const sniffed = sniffTimedText({
    contentType,
    contentLength,
    firstChunk: body.slice(0, 4096),
    maxBytes,
  });
  if (!sniffed.ok) return;
  safeEmit(emit, {
    type: 'timed-text',
    resourceId: identity.resourceId,
    trackId: identity.trackId,
    language: identity.language,
    format: sniffed.value.format,
    body,
  });
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
  return (
    url.protocol === 'https:' &&
    url.username === '' &&
    url.password === '' &&
    (url.port === '' || url.port === '443') &&
    isNetflixOwnedHost(url.hostname) &&
    /(?:manifest|metadata|playback|shakti)/iu.test(url.pathname)
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
