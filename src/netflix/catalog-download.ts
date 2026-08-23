import { normalizeNetflixLanguageTag } from './adapter';
import type {
  NetflixCatalogTrackDescriptor,
  NetflixTimedTextPayload,
} from './bridge';
import {
  canonicalizeNetflixTimedTextResource,
  sniffTimedText,
} from './probe';
import { err, ok, type AppError, type Result } from '../shared/result';

export const MAX_NETFLIX_CATALOG_TRACKS = 256;
export const MAX_NETFLIX_TIMED_TEXT_DOWNLOAD_BYTES = 10 * 1024 * 1024;

const MAX_METADATA_NODES = 2_048;
const MAX_METADATA_DEPTH = 8;
const MAX_CONTAINER_ENTRIES = 512;
const MAX_DOWNLOAD_NODES = 256;
const MAX_DOWNLOAD_DEPTH = 6;
const MAX_URL_CANDIDATES = 64;

const TRACK_ARRAY_KEYS = new Set([
  'timedtexttracks',
  'texttracks',
  'subtitletracks',
]);
const LANGUAGE_FIELDS = [
  'bcp47',
  'language',
  'languageCode',
  'bcp47Tag',
] as const;
const TRACK_ID_FIELDS = [
  'trackId',
  'id',
  'new_track_id',
  'downloadableId',
] as const;
const KIND_FIELDS = ['kind', 'trackType', 'rawTrackType', 'type'] as const;
const DOWNLOAD_ROOT_FIELDS = ['ttDownloadables', 'downloadables'] as const;
const DOWNLOAD_URL_KEYS = new Set(['downloadurls', 'urls']);
const NONE_FIELDS = ['isNoneTrack', 'isNone', 'none'] as const;
const FORCED_FIELDS = [
  'isForcedNarrative',
  'forcedNarrative',
  'isForced',
  'forced',
] as const;
const CLOSED_CAPTION_FIELDS = [
  'isClosedCaption',
  'isCC',
  'closedCaption',
] as const;
const SUBTITLE_FIELDS = ['isSubtitle'] as const;

export interface NetflixCatalogDownloadResource {
  /** Sensitive signed URL. Keep this object in the MAIN-world download path. */
  readonly url: string;
  readonly titleId: string;
  readonly resourceId: string;
  readonly trackId: string;
  readonly language: string;
  readonly kind: NetflixCatalogTrackDescriptor['kind'];
}

export type NetflixCatalogDownloadErrorCode =
  | 'netflix_catalog_metadata_failed'
  | 'netflix_catalog_metadata_invalid'
  | 'netflix_catalog_metadata_too_large'
  | 'netflix_timed_text_aborted'
  | 'netflix_timed_text_fetch_failed'
  | 'netflix_timed_text_http_error'
  | 'netflix_timed_text_invalid_body'
  | 'netflix_timed_text_limit_invalid'
  | 'netflix_timed_text_media_response'
  | 'netflix_timed_text_read_failed'
  | 'netflix_timed_text_resource_invalid'
  | 'netflix_timed_text_response_invalid'
  | 'netflix_timed_text_too_large';

export type NetflixCatalogDownloadError = AppError<NetflixCatalogDownloadErrorCode>;

export interface NetflixTimedTextHeadersLike {
  get(name: string): string | null;
}

export interface NetflixTimedTextReaderLike {
  read(): Promise<{ readonly done: boolean; readonly value?: Uint8Array }>;
  cancel?(reason?: unknown): Promise<unknown>;
}

export interface NetflixTimedTextResponseLike {
  readonly ok: boolean;
  readonly url?: string;
  readonly headers: NetflixTimedTextHeadersLike;
  readonly body?:
    | ReadableStream<Uint8Array>
    | { getReader(): NetflixTimedTextReaderLike }
    | null;
  arrayBuffer?(): Promise<ArrayBuffer>;
  text?(): Promise<string>;
}

export type NetflixTimedTextFetch = (
  input: string,
  init?: RequestInit,
) => Promise<NetflixTimedTextResponseLike>;

export interface NetflixTimedTextDownloadOptions {
  readonly maxBytes?: number;
  readonly signal?: AbortSignal;
}

type ResourceCategory = 'english' | 'simplified-chinese';

interface ResourceCandidate extends NetflixCatalogDownloadResource {
  readonly category: ResourceCategory;
  readonly order: number;
}

type CandidateResult =
  | { readonly kind: 'ignored' }
  | { readonly kind: 'invalid' }
  | { readonly kind: 'resources'; readonly values: readonly ResourceCandidate[] };

interface TrackArrayContext {
  readonly titleId: string;
  readonly tracks: unknown[];
}

/**
 * Conservatively discovers downloadable English and Simplified Chinese text
 * tracks in Netflix metadata. It never upgrades catalog authority.
 */
export function extractNetflixCatalogDownloadResources(
  metadata: unknown,
): Result<readonly NetflixCatalogDownloadResource[], NetflixCatalogDownloadError> {
  const contexts = findTrackArrays(metadata);
  if (!contexts.ok) return contexts;

  const candidates: ResourceCandidate[] = [];
  let order = 0;
  try {
    for (const { titleId, tracks } of contexts.value) {
      for (let index = 0; index < tracks.length; index += 1) {
        const parsed = extractTrackResources(tracks[index], order, titleId);
        order += 1;
        if (parsed.kind === 'ignored') continue;
        if (parsed.kind === 'invalid') {
          return catalogDownloadError('netflix_catalog_metadata_invalid');
        }
        candidates.push(...parsed.values);
      }
    }
  } catch {
    return catalogDownloadError('netflix_catalog_metadata_failed');
  }

  candidates.sort(compareResourceCandidates);
  const selected = new Map<string, NetflixCatalogDownloadResource>();
  for (const candidate of candidates) {
    const key = `${candidate.titleId}\u001f${candidate.category}`;
    if (selected.has(key)) continue;
    selected.set(key, {
      url: candidate.url,
      titleId: candidate.titleId,
      resourceId: candidate.resourceId,
      trackId: candidate.trackId,
      language: candidate.language,
      kind: candidate.kind,
    });
  }

  return ok([...selected.values()]);
}

export async function downloadNetflixTimedText(
  fetcher: NetflixTimedTextFetch,
  resource: NetflixCatalogDownloadResource,
  options: NetflixTimedTextDownloadOptions = {},
): Promise<Result<NetflixTimedTextPayload, NetflixCatalogDownloadError>> {
  const maxBytes = options.maxBytes ?? MAX_NETFLIX_TIMED_TEXT_DOWNLOAD_BYTES;
  if (
    !Number.isSafeInteger(maxBytes) ||
    maxBytes <= 0 ||
    maxBytes > MAX_NETFLIX_TIMED_TEXT_DOWNLOAD_BYTES
  ) {
    return catalogDownloadError('netflix_timed_text_limit_invalid');
  }
  if (!isValidDownloadResource(resource)) {
    return catalogDownloadError('netflix_timed_text_resource_invalid');
  }

  const signal = options.signal ?? new AbortController().signal;
  if (signal.aborted) {
    return catalogDownloadError('netflix_timed_text_aborted');
  }

  let response: NetflixTimedTextResponseLike;
  try {
    response = await fetcher(resource.url, {
      method: 'GET',
      credentials: 'omit',
      signal,
    });
  } catch {
    return catalogDownloadError(
      signal.aborted
        ? 'netflix_timed_text_aborted'
        : 'netflix_timed_text_fetch_failed',
    );
  }
  if (signal.aborted) {
    return catalogDownloadError('netflix_timed_text_aborted');
  }

  const prepared = prepareResponse(response, maxBytes);
  if (!prepared.ok) return prepared;

  const bytes = await readBoundedResponse(response, maxBytes, signal);
  if (!bytes.ok) return bytes;

  let body: string;
  try {
    body = new TextDecoder('utf-8', { fatal: true }).decode(bytes.value);
  } catch {
    return catalogDownloadError('netflix_timed_text_invalid_body');
  }
  const sniffed = sniffTimedText({
    contentType: prepared.value.contentType,
    contentLength: prepared.value.contentLength,
    firstChunk: bytes.value.subarray(0, 4096),
    maxBytes,
  });
  if (!sniffed.ok) {
    return catalogDownloadError(
      sniffed.error.code === 'body_too_large'
        ? 'netflix_timed_text_too_large'
        : sniffed.error.code === 'media_response'
          ? 'netflix_timed_text_media_response'
          : 'netflix_timed_text_invalid_body',
    );
  }

  return ok({
    type: 'timed-text',
    titleId: resource.titleId,
    resourceId: resource.resourceId,
    trackId: resource.trackId,
    language: resource.language,
    format: sniffed.value.format,
    body,
  });
}

function findTrackArrays(
  root: unknown,
): Result<readonly TrackArrayContext[], NetflixCatalogDownloadError> {
  const arrays: TrackArrayContext[] = [];
  const pending: Array<{
    readonly value: unknown;
    readonly depth: number;
    readonly inheritedTitleId: string | null;
  }> = [
    { value: root, depth: 0, inheritedTitleId: null },
  ];
  const visited = new Set<object>();
  let inspected = 0;

  try {
    while (pending.length > 0) {
      const current = pending.shift();
      if (current === undefined) break;
      if (current.depth > MAX_METADATA_DEPTH) continue;
      if (++inspected > MAX_METADATA_NODES) {
        return catalogDownloadError('netflix_catalog_metadata_too_large');
      }
      if (!isObject(current.value) || visited.has(current.value)) continue;
      visited.add(current.value);

      if (Array.isArray(current.value)) {
        if (current.value.length > MAX_CONTAINER_ENTRIES) {
          return catalogDownloadError('netflix_catalog_metadata_too_large');
        }
        for (let index = 0; index < current.value.length; index += 1) {
          pending.push({
            value: current.value[index],
            depth: current.depth + 1,
            inheritedTitleId: current.inheritedTitleId,
          });
        }
        continue;
      }

      const keys = Object.keys(current.value);
      if (keys.length > MAX_CONTAINER_ENTRIES) {
        return catalogDownloadError('netflix_catalog_metadata_too_large');
      }
      const ownTitleId = readOwnMetadataTitleId(
        current.value as Readonly<Record<string, unknown>>,
        keys,
      );
      const effectiveTitleId = ownTitleId.kind === 'title'
        ? ownTitleId.value
        : current.inheritedTitleId;
      for (const key of keys) {
        const descriptor = Object.getOwnPropertyDescriptor(current.value, key);
        if (descriptor === undefined || !('value' in descriptor)) continue;
        const value = descriptor.value as unknown;
        const normalizedKey = normalizeKey(key);
        if (TRACK_ARRAY_KEYS.has(normalizedKey)) {
          if (!Array.isArray(value)) {
            return catalogDownloadError('netflix_catalog_metadata_invalid');
          }
          if (value.length > MAX_NETFLIX_CATALOG_TRACKS) {
            return catalogDownloadError('netflix_catalog_metadata_too_large');
          }
          if (ownTitleId.kind === 'invalid' || effectiveTitleId === null) {
            return catalogDownloadError('netflix_catalog_metadata_invalid');
          }
          arrays.push({ titleId: effectiveTitleId, tracks: value });
          continue;
        }
        pending.push({
          value,
          depth: current.depth + 1,
          inheritedTitleId: effectiveTitleId,
        });
      }
    }
  } catch {
    return catalogDownloadError('netflix_catalog_metadata_failed');
  }

  return ok(arrays);
}

function extractTrackResources(
  value: unknown,
  order: number,
  titleId: string,
): CandidateResult {
  if (!isRecord(value)) return { kind: 'ignored' };

  const language = readTargetLanguage(value);
  if (language.kind === 'ignored') return language;
  if (language.kind === 'invalid') return language;

  const enums = ownStrings(value, KIND_FIELDS);
  const none = ownBooleanFlag(value, NONE_FIELDS);
  const forced = ownBooleanFlag(value, FORCED_FIELDS);
  if (enums === null || none === null || forced === null) return { kind: 'invalid' };
  const normalizedEnums = enums.map(normalizeEnum);
  if (
    none ||
    forced ||
    normalizedEnums.some(isNoneEnum) ||
    normalizedEnums.some((candidate) => candidate.includes('forced'))
  ) {
    return { kind: 'ignored' };
  }

  const kind = readTrackKind(value, normalizedEnums);
  const trackId = readSafeTrackId(value);
  if (kind === null || trackId === null) return { kind: 'invalid' };

  const urls = findDownloadUrls(value);
  if (!urls.ok) return { kind: 'invalid' };
  const resources: ResourceCandidate[] = [];
  const seen = new Set<string>();
  for (const url of urls.value) {
    const identity = canonicalizeNetflixTimedTextResource(url);
    if (!identity.ok || seen.has(identity.value.resourceId)) continue;
    seen.add(identity.value.resourceId);
    resources.push({
      url,
      titleId,
      resourceId: identity.value.resourceId,
      trackId,
      language: language.language,
      kind,
      category: language.category,
      order,
    });
  }
  return resources.length === 0
    ? { kind: 'ignored' }
    : { kind: 'resources', values: resources };
}

type TargetLanguageResult =
  | { readonly kind: 'ignored' }
  | { readonly kind: 'invalid' }
  | {
      readonly kind: 'language';
      readonly category: ResourceCategory;
      readonly language: string;
    };

function readTargetLanguage(
  value: Readonly<Record<string, unknown>>,
): TargetLanguageResult {
  const candidates: string[] = [];
  for (const field of LANGUAGE_FIELDS) {
    if (!Object.hasOwn(value, field)) continue;
    const raw = value[field];
    if (typeof raw !== 'string' || raw.trim().length === 0) {
      return { kind: 'invalid' };
    }
    candidates.push(raw.trim());
  }
  if (candidates.length === 0) return { kind: 'ignored' };

  const normalized = candidates.map(normalizeNetflixLanguageTag);
  if (normalized.some((candidate) => candidate === null)) {
    return { kind: 'invalid' };
  }
  const first = normalized[0];
  if (
    first === null ||
    first === undefined ||
    normalized.some((candidate) => candidate?.sourceTag !== first.sourceTag)
  ) {
    return { kind: 'invalid' };
  }
  if (
    first.category !== 'english' &&
    first.category !== 'simplified-chinese'
  ) {
    return { kind: 'ignored' };
  }
  return {
    kind: 'language',
    category: first.category,
    language: first.sourceTag,
  };
}

function readTrackKind(
  value: Readonly<Record<string, unknown>>,
  normalizedEnums: readonly string[],
): NetflixCatalogTrackDescriptor['kind'] | null {
  const kinds = new Set<NetflixCatalogTrackDescriptor['kind']>();
  for (const candidate of normalizedEnums) {
    if (candidate === 'subtitle' || candidate === 'subtitles') {
      kinds.add('subtitle');
    }
    if (
      candidate === 'caption' ||
      candidate === 'captions' ||
      candidate === 'cc' ||
      candidate === 'closecaption' ||
      candidate === 'closecaptions' ||
      candidate === 'closedcaption' ||
      candidate === 'closedcaptions'
    ) {
      kinds.add('closed-caption');
    }
  }
  const closedCaption = ownBooleanFlag(value, CLOSED_CAPTION_FIELDS);
  const subtitle = ownBooleanFlag(value, SUBTITLE_FIELDS);
  if (closedCaption === null || subtitle === null) return null;
  if (closedCaption) kinds.add('closed-caption');
  if (subtitle) kinds.add('subtitle');
  return kinds.size === 1 ? [...kinds][0] ?? null : null;
}

function readSafeTrackId(value: Readonly<Record<string, unknown>>): string | null {
  for (const field of TRACK_ID_FIELDS) {
    if (!Object.hasOwn(value, field)) continue;
    const raw = value[field];
    if (typeof raw === 'string') {
      const candidate = raw.trim();
      if (isOpaqueId(candidate)) return candidate;
    } else if (
      typeof raw === 'number' &&
      Number.isSafeInteger(raw) &&
      raw >= 0
    ) {
      return String(raw);
    }
  }
  return null;
}

function findDownloadUrls(
  track: Readonly<Record<string, unknown>>,
): Result<readonly string[], NetflixCatalogDownloadError> {
  const pending: Array<{ readonly value: unknown; readonly depth: number }> = [];
  for (const field of DOWNLOAD_ROOT_FIELDS) {
    const root = ownDataValue(track, field);
    if (root !== undefined) pending.push({ value: root, depth: 0 });
  }

  const urls: string[] = [];
  const visited = new Set<object>();
  let inspected = 0;
  while (pending.length > 0) {
    const current = pending.shift();
    if (current === undefined || current.depth > MAX_DOWNLOAD_DEPTH) continue;
    if (++inspected > MAX_DOWNLOAD_NODES) {
      return catalogDownloadError('netflix_catalog_metadata_too_large');
    }
    if (!isObject(current.value) || visited.has(current.value)) continue;
    visited.add(current.value);

    if (Array.isArray(current.value)) {
      if (current.value.length > MAX_CONTAINER_ENTRIES) {
        return catalogDownloadError('netflix_catalog_metadata_too_large');
      }
      for (let index = 0; index < current.value.length; index += 1) {
        pending.push({ value: current.value[index], depth: current.depth + 1 });
      }
      continue;
    }

    const keys = Object.keys(current.value);
    if (keys.length > MAX_CONTAINER_ENTRIES) {
      return catalogDownloadError('netflix_catalog_metadata_too_large');
    }
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(current.value, key);
      if (descriptor === undefined || !('value' in descriptor)) continue;
      const child = descriptor.value as unknown;
      if (DOWNLOAD_URL_KEYS.has(normalizeKey(key))) {
        collectUrlStrings(child, urls, 0);
        if (urls.length > MAX_URL_CANDIDATES) {
          return catalogDownloadError('netflix_catalog_metadata_too_large');
        }
      } else {
        pending.push({ value: child, depth: current.depth + 1 });
      }
    }
  }
  return ok(urls);
}

function collectUrlStrings(value: unknown, output: string[], depth: number): void {
  if (output.length > MAX_URL_CANDIDATES || depth > 3) return;
  if (typeof value === 'string') {
    output.push(value);
    return;
  }
  if (!isObject(value)) return;
  if (Array.isArray(value)) {
    for (const child of value.slice(0, MAX_URL_CANDIDATES + 1)) {
      collectUrlStrings(child, output, depth + 1);
    }
    return;
  }
  for (const key of Object.keys(value).slice(0, MAX_URL_CANDIDATES + 1)) {
    if (key.startsWith('https://')) output.push(key);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor !== undefined && 'value' in descriptor) {
      collectUrlStrings(descriptor.value, output, depth + 1);
    }
  }
}

function prepareResponse(
  response: NetflixTimedTextResponseLike,
  maxBytes: number,
): Result<
  { readonly contentLength: number | null; readonly contentType: string | null },
  NetflixCatalogDownloadError
> {
  try {
    if (!isObject(response) || response.ok !== true || !isObject(response.headers)) {
      return catalogDownloadError(
        isObject(response) && response.ok === false
          ? 'netflix_timed_text_http_error'
          : 'netflix_timed_text_response_invalid',
      );
    }
    if (typeof response.headers.get !== 'function') {
      return catalogDownloadError('netflix_timed_text_response_invalid');
    }
    if (
      typeof response.url === 'string' &&
      response.url.length > 0 &&
      !canonicalizeNetflixTimedTextResource(response.url).ok
    ) {
      return catalogDownloadError('netflix_timed_text_resource_invalid');
    }

    const contentType = response.headers.get('content-type');
    const normalizedType = (contentType ?? '').split(';', 1)[0]?.trim().toLowerCase() ?? '';
    if (normalizedType.startsWith('audio/') || normalizedType.startsWith('video/')) {
      return catalogDownloadError('netflix_timed_text_media_response');
    }

    const lengthHeader = response.headers.get('content-length');
    let contentLength: number | null = null;
    if (lengthHeader !== null) {
      if (!/^\d+$/u.test(lengthHeader.trim())) {
        return catalogDownloadError('netflix_timed_text_response_invalid');
      }
      contentLength = Number(lengthHeader);
      if (!Number.isSafeInteger(contentLength) || contentLength < 0) {
        return catalogDownloadError('netflix_timed_text_response_invalid');
      }
      if (contentLength > maxBytes) {
        return catalogDownloadError('netflix_timed_text_too_large');
      }
    }
    return ok({ contentLength, contentType });
  } catch {
    return catalogDownloadError('netflix_timed_text_response_invalid');
  }
}

async function readBoundedResponse(
  response: NetflixTimedTextResponseLike,
  maxBytes: number,
  signal: AbortSignal,
): Promise<Result<Uint8Array, NetflixCatalogDownloadError>> {
  try {
    if (response.body !== undefined && response.body !== null) {
      if (typeof response.body.getReader !== 'function') {
        return catalogDownloadError('netflix_timed_text_response_invalid');
      }
      const reader = (
        response.body as { getReader(): NetflixTimedTextReaderLike }
      ).getReader();
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      for (;;) {
        if (signal.aborted) {
          await cancelReader(reader);
          return catalogDownloadError('netflix_timed_text_aborted');
        }
        const next = await reader.read();
        if (signal.aborted) {
          await cancelReader(reader);
          return catalogDownloadError('netflix_timed_text_aborted');
        }
        if (next.done) break;
        if (next.value === undefined) continue;
        if (!(next.value instanceof Uint8Array)) {
          await cancelReader(reader);
          return catalogDownloadError('netflix_timed_text_invalid_body');
        }
        bytes += next.value.byteLength;
        if (bytes > maxBytes) {
          await cancelReader(reader);
          return catalogDownloadError('netflix_timed_text_too_large');
        }
        chunks.push(next.value);
      }
      return ok(concatenateBytes(chunks, bytes));
    }

    if (typeof response.arrayBuffer === 'function') {
      const buffer = await response.arrayBuffer();
      if (!(buffer instanceof ArrayBuffer)) {
        return catalogDownloadError('netflix_timed_text_invalid_body');
      }
      if (buffer.byteLength > maxBytes) {
        return catalogDownloadError('netflix_timed_text_too_large');
      }
      return ok(new Uint8Array(buffer));
    }
    if (typeof response.text === 'function') {
      const body = await response.text();
      if (typeof body !== 'string') {
        return catalogDownloadError('netflix_timed_text_invalid_body');
      }
      const bytes = new TextEncoder().encode(body);
      return bytes.byteLength <= maxBytes
        ? ok(bytes)
        : catalogDownloadError('netflix_timed_text_too_large');
    }
    return catalogDownloadError('netflix_timed_text_response_invalid');
  } catch {
    return catalogDownloadError(
      signal.aborted
        ? 'netflix_timed_text_aborted'
        : 'netflix_timed_text_read_failed',
    );
  }
}

async function cancelReader(reader: NetflixTimedTextReaderLike): Promise<void> {
  try {
    await reader.cancel?.('SubTwin timed-text read stopped');
  } catch {
    // Cancellation is best-effort and never exposes the signed resource URL.
  }
}

function isValidDownloadResource(resource: NetflixCatalogDownloadResource): boolean {
  if (
    !isRecord(resource) ||
    !isOpaqueId(resource.titleId) ||
    !isOpaqueId(resource.trackId)
  ) return false;
  if (resource.kind !== 'subtitle' && resource.kind !== 'closed-caption') return false;
  const language = normalizeNetflixLanguageTag(resource.language);
  if (
    language === null ||
    language.sourceTag !== resource.language ||
    (language.category !== 'english' &&
      language.category !== 'simplified-chinese')
  ) return false;
  if (!/^tt_[a-f0-9]{16}$/u.test(resource.resourceId)) return false;
  const identity = canonicalizeNetflixTimedTextResource(resource.url);
  return identity.ok && identity.value.resourceId === resource.resourceId;
}

function compareResourceCandidates(
  left: ResourceCandidate,
  right: ResourceCandidate,
): number {
  const title = compareCodeUnits(left.titleId, right.titleId);
  if (title !== 0) return title;
  const category = categoryOrder(left.category) - categoryOrder(right.category);
  if (category !== 0) return category;
  return (
    compareCodeUnits(left.trackId, right.trackId) ||
    compareCodeUnits(left.resourceId, right.resourceId) ||
    compareCodeUnits(left.language, right.language) ||
    compareCodeUnits(left.kind, right.kind) ||
    left.order - right.order
  );
}

type MetadataTitleResult =
  | { readonly kind: 'none' }
  | { readonly kind: 'invalid' }
  | { readonly kind: 'title'; readonly value: string };

function readOwnMetadataTitleId(
  value: Readonly<Record<string, unknown>>,
  keys: readonly string[],
): MetadataTitleResult {
  const candidates = new Set<string>();
  for (const key of keys) {
    const normalized = normalizeKey(key);
    if (
      normalized !== 'movieid' &&
      normalized !== 'titleid' &&
      normalized !== 'videoid'
    ) continue;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !('value' in descriptor)) continue;
    const candidate = sanitizeMetadataTitleId(descriptor.value);
    if (candidate === null) return { kind: 'invalid' };
    candidates.add(candidate);
  }
  if (candidates.size === 0) return { kind: 'none' };
  if (candidates.size !== 1) return { kind: 'invalid' };
  const candidate = [...candidates][0];
  return candidate === undefined
    ? { kind: 'invalid' }
    : { kind: 'title', value: candidate };
}

function sanitizeMetadataTitleId(value: unknown): string | null {
  if (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= 0
  ) return String(value);
  if (typeof value !== 'string') return null;
  const candidate = value.trim();
  if (candidate.length === 0 || candidate.length > 512) return null;
  return isOpaqueId(candidate) ? candidate : `title-${hash64(candidate)}`;
}

function categoryOrder(category: ResourceCategory): number {
  return category === 'english' ? 0 : 1;
}

function ownStrings(
  value: Readonly<Record<string, unknown>>,
  fields: readonly string[],
): readonly string[] | null {
  const output: string[] = [];
  for (const field of fields) {
    if (!Object.hasOwn(value, field)) continue;
    const candidate = value[field];
    if (typeof candidate !== 'string' || candidate.trim().length === 0) return null;
    output.push(candidate.trim());
  }
  return output;
}

function ownBooleanFlag(
  value: Readonly<Record<string, unknown>>,
  fields: readonly string[],
): boolean | null {
  let enabled = false;
  for (const field of fields) {
    if (!Object.hasOwn(value, field)) continue;
    const candidate = value[field];
    if (typeof candidate !== 'boolean') return null;
    enabled ||= candidate;
  }
  return enabled;
}

function ownDataValue(
  value: Readonly<Record<string, unknown>>,
  field: string,
): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, field);
  return descriptor !== undefined && 'value' in descriptor
    ? descriptor.value
    : undefined;
}

function normalizeKey(value: string): string {
  return value.replace(/[_-]/gu, '').toLowerCase();
}

function normalizeEnum(value: string): string {
  return value.replace(/[^A-Za-z]/gu, '').toLowerCase();
}

function isNoneEnum(value: string): boolean {
  return value === 'none' || value === 'off' || value === 'disabled';
}

function isOpaqueId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 128 &&
    /^[A-Za-z0-9._:-]+$/u.test(value)
  );
}

function isObject(value: unknown): value is object {
  return typeof value === 'object' && value !== null;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return isObject(value) && !Array.isArray(value);
}

function concatenateBytes(
  chunks: readonly Uint8Array[],
  totalBytes: number,
): Uint8Array {
  const output = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function hash64(value: string): string {
  return `${fnv1a(value, 0x811c9dc5)}${fnv1a(
    [...value].reverse().join(''),
    0x9e3779b9,
  )}`;
}

function fnv1a(value: string, seed: number): string {
  let hash = seed >>> 0;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

function catalogDownloadError(
  code: NetflixCatalogDownloadErrorCode,
): Result<never, NetflixCatalogDownloadError> {
  return err({
    code,
    message: 'Netflix timed-text metadata or download failed strict validation.',
    retryable: false,
  });
}
