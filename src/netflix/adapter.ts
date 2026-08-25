import { err, ok, type Result } from '../shared/result';
import type { SubtitleSchedulingScope } from '../subtitles/source';
import {
  NETFLIX_ADAPTER_VERSION,
  type NetflixAdapterError,
  type NetflixAdapterEvent,
  type NetflixAdapterOptions,
  type NetflixAdapterState,
  type NetflixCatalogTrack,
  type NetflixLanguage,
  type NetflixSession,
  type NetflixSessionSeed,
  type NetflixTimedTextPathCategory,
  type NetflixTimedTextResource,
  type NetflixTrack,
  type NetflixTrackCandidate,
} from './types';

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const LANGUAGE_TAG = /^[A-Za-z]{2,8}(?:[-_][A-Za-z0-9]{1,8})*$/u;
const NETFLIX_TIMED_TEXT_HOSTS = [
  'netflix.com',
  'nflximg.net',
  'nflxso.net',
  'nflxvideo.net',
] as const;

export function createNetflixAdapterState(
  seed: NetflixSessionSeed,
  options: NetflixAdapterOptions = {},
): NetflixAdapterState {
  const generation = 1;
  const identityNonce = options.nonceFactory?.() ?? createCryptographicNonce();
  const session = createSession(
    seed.contentId,
    seed.mountId,
    generation,
    identityNonce,
  );
  return freezeState({
    session,
    catalog: { authority: 'provisional', tracks: [] },
    tracks: [],
    externalTranslationAllowed: false,
    schedulingScope: 'none',
  });
}

export function normalizeNetflixLanguageTag(raw: unknown): NetflixLanguage | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!LANGUAGE_TAG.test(trimmed)) return null;

  const parts = trimmed.replaceAll('_', '-').split('-');
  const primary = parts[0]?.toLowerCase();
  if (primary === undefined) return null;
  const sourceTag = [primary, ...parts.slice(1).map(canonicalizeSubtag)].join('-');
  const lowerParts = sourceTag.toLowerCase().split('-');

  if (primary === 'en') {
    return Object.freeze({ category: 'english', sourceTag, tag: 'en' });
  }

  if (
    primary === 'zh' &&
    (lowerParts.includes('hans') ||
      (!lowerParts.includes('hant') &&
        (lowerParts.includes('cn') || lowerParts.includes('sg'))))
  ) {
    return Object.freeze({
      category: 'simplified-chinese',
      sourceTag,
      tag: 'zh-Hans',
    });
  }

  return Object.freeze({ category: 'other', sourceTag, tag: sourceTag });
}

export function canonicalizeTimedTextResource(
  rawUrl: unknown,
  explicitTrackId: unknown,
  languageTag: unknown,
): Result<NetflixTimedTextResource, NetflixAdapterError> {
  if (
    typeof rawUrl !== 'string' ||
    typeof explicitTrackId !== 'string' ||
    !SAFE_ID.test(explicitTrackId)
  ) {
    return invalidTimedTextResource();
  }

  const language = normalizeNetflixLanguageTag(languageTag);
  if (language === null) return invalidTimedTextResource();

  try {
    const url = new URL(rawUrl);
    const hostname = url.hostname.toLowerCase();
    if (
      url.protocol !== 'https:' ||
      url.username !== '' ||
      url.password !== '' ||
      (url.port !== '' && url.port !== '443') ||
      !isNetflixTimedTextHost(hostname)
    ) {
      return invalidTimedTextResource();
    }

    const canonicalPath = canonicalizeTimedTextPath(url.pathname);
    if (!isTimedTextPath(canonicalPath)) return invalidTimedTextResource();
    const pathCategory = categorizeTimedTextPath(canonicalPath);
    const identity = [
      'netflix-timed-text-v1',
      hostFamily(hostname),
      canonicalPath,
      explicitTrackId,
      language.sourceTag,
    ].join('\u001f');

    return ok(Object.freeze({
      resourceId: `ntr_${stableOpaqueHash(identity)}`,
      trackId: explicitTrackId,
      language,
      hostCategory: 'netflix-timed-text',
      pathCategory,
    }));
  } catch {
    return invalidTimedTextResource();
  }
}

export function applyNetflixAdapterEvent(
  state: NetflixAdapterState,
  input: unknown,
): Result<NetflixAdapterState, NetflixAdapterError> {
  if (!isRecord(input)) return unsupportedInput();
  if ('adapterVersion' in input && input.adapterVersion !== NETFLIX_ADAPTER_VERSION) {
    return adapterVersionMismatch();
  }
  if (!isNetflixAdapterEvent(input)) return unsupportedInput();

  if (input.sessionId !== state.session.sessionId) {
    return failure(
      'netflix_stale_session',
      'The Netflix adapter event belongs to an inactive session.',
    );
  }
  if (input.generation !== state.session.generation) {
    return failure(
      'netflix_stale_generation',
      'The Netflix adapter event belongs to an inactive generation.',
    );
  }

  switch (input.type) {
    case 'catalog-observed':
      return applyCatalog(state, input.authority, input.tracks);
    case 'track-observed':
      return applyTrackObservation(state, input.track);
    case 'track-activity-changed':
      return applyTrackActivity(state, input.trackId, input.active);
    case 'track-disposed':
      return applyTrackDisposal(state, input.trackId);
    case 'session-transition':
      return applySessionTransition(
        state,
        input.nextContentId,
        input.nextMountId,
      );
  }
}

function applyCatalog(
  state: NetflixAdapterState,
  authority: 'authoritative' | 'provisional',
  candidates: readonly NetflixTrackCandidate[],
): Result<NetflixAdapterState, NetflixAdapterError> {
  const normalized = normalizeCandidates(candidates);
  if (normalized === null) return unsupportedInput();

  const preservesAuthority =
    authority === 'provisional' &&
    state.catalog.authority === 'authoritative' &&
    normalized.every((candidate) => {
      const known = state.catalog.tracks.find(
        ({ trackId }) => trackId === candidate.trackId,
      );
      return known !== undefined && known.language.tag === candidate.language.tag;
    });
  const effectiveAuthority = authority === 'authoritative' || preservesAuthority
    ? 'authoritative'
    : 'provisional';

  const catalogTracks = authority === 'authoritative'
    ? normalized.map(toCatalogTrack)
    : mergeCatalogTracks(state.catalog.tracks, normalized.map(toCatalogTrack));
  const candidateIds = new Set(normalized.map(({ trackId }) => trackId));
  const previousById = new Map(state.tracks.map((track) => [track.trackId, track]));
  const tracks: NetflixTrack[] = [];

  for (const candidate of normalized) {
    const previous = previousById.get(candidate.trackId);
    tracks.push(Object.freeze({
      trackId: candidate.trackId,
      language: candidate.language,
      active: previous?.lifecycle === 'disposed' ? false : (previous?.active ?? false),
      lifecycle: authority === 'authoritative'
        ? 'confirmed'
        : previous?.lifecycle === 'disposed'
          ? 'disposed'
        : previous?.lifecycle === 'confirmed'
          ? 'confirmed'
          : 'provisional',
      ...(candidate.resource === undefined
        ? previous?.resource === undefined || previous.lifecycle === 'disposed'
          ? {}
          : { resource: previous.resource }
        : { resource: candidate.resource }),
    }));
  }

  for (const previous of state.tracks) {
    if (candidateIds.has(previous.trackId)) continue;
    tracks.push(authority === 'authoritative'
      ? Object.freeze({ ...previous, active: false, lifecycle: 'disposed' })
      : previous);
  }

  return ok(deriveState(
    state.session,
    effectiveAuthority,
    catalogTracks,
    tracks,
  ));
}

function applyTrackObservation(
  state: NetflixAdapterState,
  candidate: NetflixTrackCandidate,
): Result<NetflixAdapterState, NetflixAdapterError> {
  const normalized = normalizeCandidate(candidate);
  if (normalized === null) return unsupportedInput();
  const previous = state.tracks.find(({ trackId }) => trackId === normalized.trackId);
  const catalogTrack = state.catalog.tracks.find(
    ({ trackId }) => trackId === normalized.trackId,
  );
  const preservesAuthority =
    state.catalog.authority === 'authoritative' &&
    catalogTrack !== undefined &&
    catalogTrack.language.tag === normalized.language.tag;
  const observed: NetflixTrack = Object.freeze({
    trackId: normalized.trackId,
    language: normalized.language,
    active: previous?.lifecycle === 'disposed' ? false : (previous?.active ?? false),
    lifecycle: previous?.lifecycle === 'disposed'
      ? 'disposed'
      : previous?.lifecycle === 'confirmed'
        ? 'confirmed'
        : 'provisional',
    ...(previous?.lifecycle === 'disposed'
      ? {}
      : normalized.resource === undefined
        ? previous?.resource === undefined ? {} : { resource: previous.resource }
        : { resource: normalized.resource }),
  });
  const tracks = replaceByTrackId(state.tracks, observed);
  const catalogTracks = mergeCatalogTracks(
    state.catalog.tracks,
    [toCatalogTrack(normalized)],
  );

  return ok(deriveState(
    state.session,
    preservesAuthority ? 'authoritative' : 'provisional',
    catalogTracks,
    tracks,
  ));
}

function applyTrackActivity(
  state: NetflixAdapterState,
  trackId: string,
  active: boolean,
): Result<NetflixAdapterState, NetflixAdapterError> {
  if (!SAFE_ID.test(trackId)) return unsupportedInput();
  const selected = state.tracks.find((track) => track.trackId === trackId);
  if (selected === undefined || selected.lifecycle === 'disposed') {
    return failure(
      'netflix_track_missing',
      'The requested Netflix subtitle track is unavailable.',
    );
  }

  const tracks = state.tracks.map((track) => Object.freeze({
    ...track,
    active: active ? track.trackId === trackId : track.trackId === trackId
      ? false
      : track.active,
  }));
  return ok(deriveState(
    state.session,
    state.catalog.authority,
    state.catalog.tracks,
    tracks,
  ));
}

function applyTrackDisposal(
  state: NetflixAdapterState,
  trackId: string,
): Result<NetflixAdapterState, NetflixAdapterError> {
  if (!SAFE_ID.test(trackId)) return unsupportedInput();
  if (!state.tracks.some((track) => track.trackId === trackId)) {
    return failure(
      'netflix_track_missing',
      'The requested Netflix subtitle track is unavailable.',
    );
  }
  const tracks = state.tracks.map((track) => {
    if (track.trackId !== trackId) return track;
    const { resource: _resource, ...withoutResource } = track;
    return Object.freeze({
      ...withoutResource,
      active: false,
      lifecycle: 'disposed' as const,
    });
  });
  return ok(deriveState(
    state.session,
    state.catalog.authority,
    state.catalog.tracks,
    tracks,
  ));
}

function applySessionTransition(
  state: NetflixAdapterState,
  contentId: string,
  mountId: string,
): Result<NetflixAdapterState, NetflixAdapterError> {
  if (!SAFE_ID.test(contentId) || !SAFE_ID.test(mountId)) return unsupportedInput();
  const generation = state.session.generation + 1;
  const tracks = state.tracks.map((track) => {
    const { resource: _resource, ...withoutResource } = track;
    return Object.freeze({
      ...withoutResource,
      active: false,
      lifecycle: 'disposed' as const,
    });
  });
  return ok(freezeState({
    session: createSession(
      contentId,
      mountId,
      generation,
      state.session.sessionId,
    ),
    catalog: Object.freeze({ authority: 'provisional', tracks: Object.freeze([]) }),
    tracks: Object.freeze(tracks),
    externalTranslationAllowed: false,
    schedulingScope: 'none',
  }));
}

interface NormalizedCandidate {
  readonly trackId: string;
  readonly language: NetflixLanguage;
  readonly resource?: NetflixTimedTextResource;
}

function normalizeCandidates(
  candidates: readonly NetflixTrackCandidate[],
): readonly NormalizedCandidate[] | null {
  const normalized: NormalizedCandidate[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    const track = normalizeCandidate(candidate);
    if (track === null || seen.has(track.trackId)) return null;
    seen.add(track.trackId);
    normalized.push(track);
  }
  return normalized;
}

function normalizeCandidate(candidate: NetflixTrackCandidate): NormalizedCandidate | null {
  if (
    !isRecord(candidate) ||
    !hasOnlyKeys(candidate, ['languageTag', 'resource', 'trackId']) ||
    typeof candidate.trackId !== 'string' ||
    !SAFE_ID.test(candidate.trackId)
  ) {
    return null;
  }
  const language = normalizeNetflixLanguageTag(candidate.languageTag);
  if (language === null) return null;
  const trackId = candidate.trackId;
  const resource = candidate.resource === undefined
    ? undefined
    : sanitizeResource(candidate.resource, trackId, language);
  if (candidate.resource !== undefined && resource === null) return null;
  return Object.freeze({
    trackId,
    language,
    ...(resource === undefined || resource === null ? {} : { resource }),
  });
}

function deriveState(
  session: NetflixSession,
  authority: 'authoritative' | 'provisional',
  catalogTracks: readonly NetflixCatalogTrack[],
  tracks: readonly NetflixTrack[],
): NetflixAdapterState {
  const hasEnglish = catalogTracks.some(
    ({ language }) => language.category === 'english',
  );
  const activeEnglish = tracks.find(
    ({ active, language, lifecycle }) =>
      active && lifecycle !== 'disposed' && language.category === 'english',
  );
  const schedulingScope: SubtitleSchedulingScope =
    activeEnglish === undefined
    ? 'none'
    : authority === 'authoritative' &&
        hasEnglish &&
        activeEnglish.lifecycle === 'confirmed'
      ? 'bulk'
      : 'urgent-window';

  return freezeState({
    session,
    catalog: Object.freeze({
      authority,
      tracks: Object.freeze([...catalogTracks]),
    }),
    tracks: Object.freeze([...tracks]),
    externalTranslationAllowed: authority === 'authoritative' && hasEnglish,
    schedulingScope,
  });
}

function isNetflixAdapterEvent(input: unknown): input is NetflixAdapterEvent {
  if (!isRecord(input)) return false;
  if (
    input.adapterVersion !== NETFLIX_ADAPTER_VERSION ||
    typeof input.sessionId !== 'string' ||
    typeof input.generation !== 'number' ||
    !Number.isSafeInteger(input.generation) ||
    typeof input.type !== 'string'
  ) return false;

  switch (input.type) {
    case 'catalog-observed':
      return hasExactlyKeys(input, [
        'adapterVersion', 'authority', 'generation', 'sessionId', 'tracks', 'type',
      ]) &&
        (input.authority === 'authoritative' || input.authority === 'provisional') &&
        Array.isArray(input.tracks);
    case 'track-observed':
      return hasExactlyKeys(input, [
        'adapterVersion', 'generation', 'sessionId', 'track', 'type',
      ]) && isRecord(input.track);
    case 'track-activity-changed':
      return hasExactlyKeys(input, [
        'active', 'adapterVersion', 'generation', 'sessionId', 'trackId', 'type',
      ]) && typeof input.trackId === 'string' && typeof input.active === 'boolean';
    case 'track-disposed':
      return hasExactlyKeys(input, [
        'adapterVersion', 'generation', 'sessionId', 'trackId', 'type',
      ]) && typeof input.trackId === 'string';
    case 'session-transition':
      return hasExactlyKeys(input, [
        'adapterVersion', 'generation', 'nextContentId', 'nextMountId', 'reason',
        'sessionId', 'type',
      ]) &&
        (input.reason === 'episode-change' || input.reason === 'player-remount') &&
        typeof input.nextContentId === 'string' && typeof input.nextMountId === 'string';
    default:
      return false;
  }
}

function sanitizeResource(
  value: unknown,
  trackId: string,
  expectedLanguage: NetflixLanguage,
): NetflixTimedTextResource | null {
  if (
    !isRecord(value) ||
    !hasExactlyKeys(value, [
      'hostCategory', 'language', 'pathCategory', 'resourceId', 'trackId',
    ]) ||
    typeof value.resourceId !== 'string' ||
    !/^ntr_[0-9a-f]{16}$/u.test(value.resourceId) ||
    value.trackId !== trackId ||
    value.hostCategory !== 'netflix-timed-text' ||
    (value.pathCategory !== 'timed-text' &&
      value.pathCategory !== 'ttml' &&
      value.pathCategory !== 'webvtt') ||
    !isRecord(value.language) ||
    !hasExactlyKeys(value.language, ['category', 'sourceTag', 'tag'])
  ) return null;

  const language = normalizeNetflixLanguageTag(value.language.sourceTag);
  if (
    language === null ||
    language.category !== value.language.category ||
    language.sourceTag !== value.language.sourceTag ||
    language.tag !== value.language.tag ||
    language.category !== expectedLanguage.category ||
    language.tag !== expectedLanguage.tag ||
    language.sourceTag !== expectedLanguage.sourceTag
  ) return null;

  return Object.freeze({
    resourceId: value.resourceId,
    trackId,
    language,
    hostCategory: 'netflix-timed-text',
    pathCategory: value.pathCategory,
  });
}

function toCatalogTrack(candidate: NormalizedCandidate): NetflixCatalogTrack {
  return Object.freeze({ trackId: candidate.trackId, language: candidate.language });
}

function mergeCatalogTracks(
  current: readonly NetflixCatalogTrack[],
  observed: readonly NetflixCatalogTrack[],
): readonly NetflixCatalogTrack[] {
  const merged = new Map(current.map((track) => [track.trackId, track]));
  for (const track of observed) merged.set(track.trackId, track);
  return Object.freeze([...merged.values()]);
}

function replaceByTrackId(
  tracks: readonly NetflixTrack[],
  replacement: NetflixTrack,
): readonly NetflixTrack[] {
  const index = tracks.findIndex(({ trackId }) => trackId === replacement.trackId);
  if (index === -1) return Object.freeze([...tracks, replacement]);
  return Object.freeze(tracks.map((track, current) =>
    current === index ? replacement : track));
}

function createSession(
  contentId: string,
  mountId: string,
  generation: number,
  identityNonce: string,
): NetflixSession {
  const sanitizedContentId = sanitizeSessionPart(contentId, 'content');
  const sanitizedMountId = sanitizeSessionPart(mountId, 'mount');
  return Object.freeze({
    sessionId: `nfs_${stableOpaqueHash(`${sanitizedContentId}\u001f${sanitizedMountId}\u001f${generation}\u001f${identityNonce}`)}`,
    generation,
    contentId: sanitizedContentId,
    mountId: sanitizedMountId,
  });
}

function createCryptographicNonce(): string {
  const values = new Uint32Array(4);
  globalThis.crypto.getRandomValues(values);
  return [...values]
    .map((value) => value.toString(16).padStart(8, '0'))
    .join('');
}

function sanitizeSessionPart(value: string, category: 'content' | 'mount'): string {
  return SAFE_ID.test(value) ? value : `${category}_${stableOpaqueHash(value)}`;
}

function freezeState(state: NetflixAdapterState): NetflixAdapterState {
  return Object.freeze(state);
}

function canonicalizeSubtag(part: string): string {
  if (/^[A-Za-z]{4}$/u.test(part)) {
    return `${part[0]?.toUpperCase() ?? ''}${part.slice(1).toLowerCase()}`;
  }
  if (/^[A-Za-z]{2}$/u.test(part) || /^\d{3}$/u.test(part)) {
    return part.toUpperCase();
  }
  return part.toLowerCase();
}

function isNetflixTimedTextHost(hostname: string): boolean {
  return NETFLIX_TIMED_TEXT_HOSTS.some(
    (suffix) => hostname === suffix || hostname.endsWith(`.${suffix}`),
  );
}

function hostFamily(hostname: string): string {
  return NETFLIX_TIMED_TEXT_HOSTS.find(
    (suffix) => hostname === suffix || hostname.endsWith(`.${suffix}`),
  ) ?? 'unsupported';
}

function canonicalizeTimedTextPath(pathname: string): string {
  const normalized = pathname
    .replace(/\/{2,}/gu, '/')
    .replace(/\/range\/(?:\d+[-,]\d+|\d+)(?=\/|$)/giu, '/range/{range}')
    .replace(/\/(?:sig|signature|token|expires|hdnea)\/[^/]+/giu, '/{signed}');
  return normalized.length === 0 ? '/' : normalized;
}

function isTimedTextPath(pathname: string): boolean {
  return /(?:timed[-_]?text|subtitle|\.(?:dfxp|ttml|vtt)(?:\/|$))/iu.test(pathname);
}

function categorizeTimedTextPath(pathname: string): NetflixTimedTextPathCategory {
  const lower = pathname.toLowerCase();
  if (/\.(?:vtt|webvtt)(?:\/|$)/u.test(lower)) return 'webvtt';
  if (/\.(?:dfxp|ttml|xml)(?:\/|$)/u.test(lower)) return 'ttml';
  return 'timed-text';
}

function stableOpaqueHash(value: string): string {
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    first = Math.imul(first ^ code, 0x01000193) >>> 0;
    second = Math.imul(second ^ code, 0x85ebca6b) >>> 0;
  }
  return `${first.toString(16).padStart(8, '0')}${second.toString(16).padStart(8, '0')}`;
}

function invalidTimedTextResource(): Result<never, NetflixAdapterError> {
  return failure(
    'netflix_invalid_timed_text_resource',
    'The timed-text observation is not a supported Netflix resource.',
  );
}

function unsupportedInput(): Result<never, NetflixAdapterError> {
  return failure(
    'netflix_unsupported_input',
    'The Netflix adapter received an unsupported input.',
  );
}

function adapterVersionMismatch(): Result<never, NetflixAdapterError> {
  return failure(
    'netflix_adapter_version_mismatch',
    'The Netflix adapter event version is unsupported.',
  );
}

function failure(
  code: NetflixAdapterError['code'],
  message: string,
): Result<never, NetflixAdapterError> {
  return err({ code, message, retryable: false });
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

function hasOnlyKeys(
  value: Readonly<Record<string, unknown>>,
  allowed: readonly string[],
): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}
